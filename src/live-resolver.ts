/**
 * Design v4 — Post-bootstrap live resolver (contract B).
 *
 * A small, private state machine that performs the ONLY live
 * `client.provider.list()` calls the plugin makes at runtime. The
 * config hook (contract A) NEVER calls provider.list; instead, every
 * live authorisation — initial candidate pipeline (C) and fallback
 * dispatch (D) — consults this resolver.
 *
 * State: unknown | in_flight | ready | transient_unavailable | permanent_unavailable
 *
 * Truthful rules (see task contract B):
 *   1. First eligible task launches ONE single-flight provider.list({signal}).
 *   2. Concurrent tasks share it.
 *   3. 5s bound; the AbortController aborts the underlying fetch BEFORE the
 *      keep-default path returns. No retained in-flight request after settle.
 *   4. A synchronous defensive rejection handler is attached at creation.
 *      Ownership is cleared through observed fulfillment/rejection handlers;
 *      no ignored promise-returning `finally()` chain is created.
 *   5. timeout/rejected => 30s cooldown. During cooldown resolve() fail-fasts
 *      with `cooldown_active` and makes NO request. The clock is injectable.
 *   6. After cooldown, exactly ONE half-open probe is permitted. There is NO
 *      max-attempt permanent exhaustion: under continued transient failure the
 *      resolver issues at most one request per cooldown window.
 *   7. no_client / provider_api_missing / invalid connected payload =>
 *      permanent until the plugin (resolver) is reloaded.
 *   8. Strict connected: the SDK `ProviderListResponse.connected` provider-ID
 *      array must be present, non-empty, and all IDs must resolve through
 *      matching `all[].models`. The ready snapshot exposes expanded exact
 *      provider/model IDs as a FROZEN readonly array.
 *   9. Only safe codes/counts are surfaced; raw provider exception text or
 *      payloads are never logged or returned.
 */
import type { Logger } from "./logger.js";

/** Outcome: ready (frozen readonly model IDs) or unavailable (safe code). */
export type LiveResolverOutcome =
  | Readonly<{ status: "ready"; models: readonly string[] }>
  | Readonly<{ status: "unavailable"; safeCode: LiveUnavailableCode; retryable: boolean }>;

/**
 * Safe, credential-free unavailability codes. Never carries raw exception
 * text — consumers may log/store these verbatim.
 */
export type LiveUnavailableCode =
  | "no_client"
  | "provider_api_missing"
  | "invalid_connected_payload"
  | "timeout"
  | "request_rejected"
  | "cooldown_active";

/** Structural client shape consumed by the resolver. */
export interface LiveResolverClient {
  provider?: {
    list?: (opts?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
  };
}

export interface LiveResolverDeps {
  client?: LiveResolverClient;
  /** Monotonic clock in ms. Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Live call bound. Default 5000ms. */
  timeoutMs?: number;
  /** Cooldown after a transient failure. Default 30000ms. */
  cooldownMs?: number;
  logger?: Logger;
}

/** Internal state machine. Exposed read-only via `peekState()` for tests. */
export type LiveResolverState =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "in_flight"; promise: Promise<LiveResolverOutcome> }>
  | Readonly<{ kind: "ready"; models: readonly string[] }>
  | Readonly<{ kind: "transient_unavailable"; nextRetryAt: number; safeCode: LiveUnavailableCode }>
  | Readonly<{ kind: "permanent_unavailable"; safeCode: LiveUnavailableCode }>;

export interface LiveResolver {
  /** Returns the current live outcome, launching at most one shared request. */
  resolve(): Promise<LiveResolverOutcome>;
  /** Read-only internal-state probe for tests/diagnostics. */
  peekState(): LiveResolverState;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;

function isAbortLike(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return (
    record.name === "AbortError" ||
    record.code === "ABORT_ERR" ||
    record.code === 20 // DOMException.ABORT_ERR
  );
}

/**
 * Strict extraction of the SDK provider-list response. `connected` contains
 * provider IDs, while exact model keys live under matching `all[].models`.
 * Every connected provider must be valid and resolvable through `all`; an
 * empty expansion fails closed.
 */
function extractConnectedModels(result: unknown): string[] | null {
  if (result === null || result === undefined) return null;
  const envelope = (result as { data?: unknown }).data;
  const source = envelope !== undefined ? envelope : result;
  if (source === null || typeof source !== "object") return null;
  const connected = (source as { connected?: unknown }).connected;
  if (!Array.isArray(connected) || connected.length === 0) return null;
  const connectedProviders: string[] = [];
  for (const entry of connected) {
    if (typeof entry !== "string" || entry.trim().length === 0) return null;
    connectedProviders.push(entry);
  }

  const all = (source as { all?: unknown }).all;
  if (!Array.isArray(all)) return null;

  const models: string[] = [];
  for (const providerID of connectedProviders) {
    const matchingProviders = all.filter((entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === providerID
    );
    if (matchingProviders.length === 0) return null;

    let expanded = 0;
    for (const provider of matchingProviders) {
      const providerModels = (provider as { models?: unknown }).models;
      if (
        providerModels === null ||
        typeof providerModels !== "object" ||
        Array.isArray(providerModels)
      ) {
        return null;
      }
      for (const modelKey of Object.keys(providerModels)) {
        if (modelKey.trim().length === 0) return null;
        models.push(`${providerID}/${modelKey}`);
        expanded += 1;
      }
    }
    if (expanded === 0) return null;
  }
  return models;
}

export function createLiveResolver(deps: LiveResolverDeps = {}): LiveResolver {
  const nowFn = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const logger = deps.logger;

  let state: LiveResolverState = Object.freeze({ kind: "unknown" });

  const setState = (next: LiveResolverState): LiveResolverState => {
    const frozen: LiveResolverState = Object.freeze(next);
    state = frozen;
    return frozen;
  };

  const unavailable = (
    safeCode: LiveUnavailableCode,
    retryable: boolean,
  ): LiveResolverOutcome => Object.freeze({ status: "unavailable", safeCode, retryable });

  const safeInfo = (message: string): void => {
    try {
      logger?.info("liveResolver", message);
    } catch {
      // Diagnostics must never alter dispatch authorization or promise ownership.
    }
  };

  function launchRequest(): Promise<LiveResolverOutcome> {
    const client = deps.client;
    if (client === undefined) {
      setState({ kind: "permanent_unavailable", safeCode: "no_client" });
      return Promise.resolve(unavailable("no_client", false));
    }
    const provider = client.provider;
    const listFn = provider?.list;
    if (typeof listFn !== "function") {
      setState({ kind: "permanent_unavailable", safeCode: "provider_api_missing" });
      return Promise.resolve(unavailable("provider_api_missing", false));
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Bound the underlying fetch. this-binding: the SDK exposes provider.list
    // as a class method; call it bound to the provider instance. The signal is
    // forwarded so a well-behaved provider aborts its in-flight fetch; the
    // race below guarantees the resolver settles at the bound EVEN IF a
    // misbehaving provider ignores the signal.
    const requestPromise = Promise.resolve()
      .then(() => listFn.call(provider, { signal: controller.signal }));
    void requestPromise.then(undefined, () => undefined);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Abort the underlying fetch BEFORE the keep-default path returns.
        controller.abort();
        reject(new Error("live resolver timeout"));
      }, timeoutMs);
    });

    const outcome: Promise<LiveResolverOutcome> = Promise.race([
      requestPromise,
      timeoutPromise,
    ]).then(
      (result) => {
        if (timer !== undefined) clearTimeout(timer);
        const models = extractConnectedModels(result);
        if (models === null) {
          setState({
            kind: "permanent_unavailable",
            safeCode: "invalid_connected_payload",
          });
          safeInfo("unavailable: invalid connected payload");
          return unavailable("invalid_connected_payload", false);
        }
        const frozen = Object.freeze(models) as readonly string[];
        setState({ kind: "ready", models: frozen });
        safeInfo(`ready models=${frozen.length}`);
        return Object.freeze({ status: "ready", models: frozen });
      },
      (err: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        const safeCode: LiveUnavailableCode = isAbortLike(err) ||
          (err instanceof Error && /timeout/i.test(err.message))
          ? "timeout"
          : "request_rejected";
        setState({
          kind: "transient_unavailable",
          nextRetryAt: nowFn() + cooldownMs,
          safeCode,
        });
        safeInfo(`unavailable: ${safeCode}; cooldown ${cooldownMs}ms`);
        return unavailable(safeCode, true);
      },
    );

    // B-4: synchronous defensive rejection handler so a late rejection can
    // NEVER surface as an unhandled rejection.
    outcome.then(undefined, () => {
      /* defensive: outcome always settles via the handlers above */
    });
    setState({ kind: "in_flight", promise: outcome });
    return outcome;
  }

  async function resolve(): Promise<LiveResolverOutcome> {
    switch (state.kind) {
      case "ready":
        return Object.freeze({ status: "ready", models: state.models });
      case "permanent_unavailable":
        return unavailable(state.safeCode, false);
      case "in_flight":
        return state.promise;
      case "transient_unavailable": {
        if (nowFn() < state.nextRetryAt) {
          return unavailable("cooldown_active", true);
        }
        // Half-open probe: permit exactly one request for this window.
        return launchRequest();
      }
      case "unknown":
      default:
        return launchRequest();
    }
  }

  return {
    resolve,
    peekState: () => state,
  };
}
