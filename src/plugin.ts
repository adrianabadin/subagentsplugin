/**
 * OpenCode plugin entry.
 *
 * NOTE (loader compatibility): This module holds the plugin implementation
 * and its programmatic surface (`modelForecastPlugin`, `refreshCache`, and
 * the associated option types). The package-root entry (`src/index.ts`)
 * re-exports ONLY the default plugin function so OpenCode's plugin loader —
 * which iterates every runtime export of the package root and requires each
 * to be a Plugin function — accepts the package. The public/programmatic API
 * barrel lives in `src/api.ts` (package export `./api`).
 *
 * Mode behaviour:
 *   - "advisory" / "off" (default) — returns `{}` (no hooks registered).
 *   - "auto" — registers `config`, `tool.execute.before`, and
 *     (when quarantine is enabled) `tool.execute.after` hooks.
 *
 * `refreshCache()` is exported as a standalone function for the CLI,
 * programmatic callers, and unit tests. It is NOT called at plugin init
 * (the config hook drives profile generation from the live provider list
 * or the on-disk cache directly).
 *
 * Cache format follows `ModelDataCache` from src/types.ts. Never throws —
 * best-effort by design.
 */

import {
  readCache,
  writeCache,
  defaultCachePath,
} from "./cache.js";
import { existsSync, readFileSync, watch } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";
import {
  readGentleAiVariantsCache,
  readOpenCodeModelsCache,
  buildProvidersCache,
  discoverLiveModels,
  extractProviderList,
  extractVariantsFromProviderList,
} from "./models.js";
import type { Discovery } from "./models.js";
import {
  connectedModelsFromCache,
  connectedModelsFromProviderList,
  createGeneratedProfileResolver,
  generateProfilesForConfig,
  type GeneratedProfileCatalog,
} from "./profiles.js";
import { PHASE_DIFFICULTY, normalizePhase } from "./phases.js";
import { createAfterHook, createTaskHook, toolID, type TaskHook, type TrackedCall } from "./hooks.js";
import { QuarantineStore, setSharedQuarantineStore } from "./quarantine.js";
import { loadQuarantineFile } from "./cli-quarantine.js";
import { loadEffectiveBenchmarks } from "./repo-data.js";
import { DEFAULT_LADDER } from "./policy.js";
import type { HooksConfig, ModelDataCache, SelectionMode } from "./types.js";
import type { LiveAvailabilityState } from "./types.js";
import type { ResolveCandidates } from "./hooks.js";
import {
  createInterruptionAuditSink,
  type InterruptionAuditDependencies,
} from "./interruption-audit.js";

/**
 * Module-level dedupe state. Tracks the in-flight refresh keyed by
 * (effective cache path × client presence). Multiple concurrent
 * `refreshCache` calls that target the same destination share the
 * same Promise instead of racing on the file.
 */
let inflightRefresh: { key: string; promise: Promise<void> } | null = null;

/**
 * Optional plugin input argument. OpenCode plugins receive an `input`
 * object with `client`, `directory`, etc. We accept it but only use the
 * directory for cache-path discovery in future expansions. The MVP uses
 * the default cache path so the CLI, which lives in a separate process,
 * can find the same cache without IPC.
 *
 * The shape is intentionally loose (`unknown`) to avoid leaking the
 * `@opencode-ai/plugin` type into the runtime contract before the
 * plugin is registered against OpenCode itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type PluginInput = Record<string, unknown>;

/**
 * Optional OpenCode-style client. When supplied, `refreshCache` calls
 * `client.provider.list()` synchronously or asynchronously and merges
 * the result into the cache as the **primary** data source (the gentle-ai
 * variants cache and OpenCode models cache act as fallbacks). Either
 * throw path (sync or async) is absorbed — the cache is still written
 * with the static phase rubric.
 *
 * This shape mirrors the OpenCode SDK at runtime; we do not import the
 * SDK type to keep the plugin entry free of plugin-SDK types.
 */
export interface PluginClient {
  provider?: {
    list?: () => Promise<unknown> | unknown;
  };
  /**
   * OpenCode TUI surface. When present, `tui.showToast` renders an
   * on-screen notification. Optional and best-effort — never required.
   */
  tui?: {
    showToast?: (options: {
      body: {
        title?: string;
        message: string;
        variant: ToastVariant;
        duration?: number;
      };
    }) => Promise<unknown> | unknown;
  };
  /**
   * model-fallback-error-classification (SDD change) — Slice 3, task 22.
   * Design #1623 "Client wiring": loose structural surface for the
   * recursive fallback engine (`src/fallback.ts`). Mirrors
   * `client.session.create({body:{parentID?,title?}})` (sdk.gen.d.ts:114)
   * and `client.session.prompt({path:{id}, body:{model:{providerID,
   * modelID}, agent, parts}})` (sdk.gen.d.ts:174), plus optional
   * `client.session.abort({path:{id}})` (sdk.gen.d.ts:150). Deliberately
   * loose/optional — no SDK type import — so a client missing create/prompt
   * degrades the fallback engine to a graceful no-op instead of a crash.
   */
  session?: {
    create?: (opts: {
      body: { parentID?: string; title?: string };
    }) => Promise<unknown> | unknown;
    prompt?: (opts: {
      path: { id: string };
      body: {
        model: { providerID: string; modelID: string };
        agent: string;
        parts: Array<{ type: string; text: string }>;
      };
    }) => Promise<unknown> | unknown;
    abort?: (opts: {
      path: { id: string };
    }) => Promise<unknown> | unknown;
  };
}

/** Toast severity as accepted by OpenCode's `tui.showToast`. */
export type ToastVariant = "info" | "success" | "warning" | "error";

import { Logger, extractProjectInfo, logLegacy } from "./logger.js";

/**
 * Best-effort transition log. Writes ONE prefixed line per call to both
 * stderr and the plugin log file (legacy path — no project context).
 *
 * Exported for direct unit-testability; NOT re-exported by `src/api.ts`
 * so the public API surface is unchanged. Production callers inside
 * the plugin should use `Logger` instance methods instead.
 */
export function logTransition(message: string): void {
  logLegacy(message);
}

/**
 * Safe, non-throwing TUI toast. Renders an on-screen notification via
 * `client.tui.showToast` when the surface is available. Every failure
 * path — a missing client, a missing TUI, a synchronous throw, or a
 * rejected async call — is swallowed so a toast can NEVER break plugin
 * startup or a hook. Returns nothing; visibility is best-effort.
 */
function showToastSafely(
  client: PluginClient | undefined,
  message: string,
  variant: ToastVariant = "info",
): void {
  try {
    const showToast = client?.tui?.showToast;
    if (typeof showToast !== "function") return;
    const result = showToast({ body: { message, variant } });
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // Absorb async rejections; the toast is fire-and-forget.
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // Best-effort: a toast must never surface an error to the caller.
  }
}

/** Options accepted by `refreshCache` for testability. */
export interface RefreshCacheOptions {
  /** Override the destination cache path. Defaults to `defaultCachePath()`. */
  cachePath?: string;
  /** Override the gentle-ai variants cache path. */
  gentleAiPath?: string;
  /** Override the OpenCode models cache path. */
  openCodePath?: string;
  /**
   * Optional OpenCode client. When supplied, `client.provider.list()` is
   * called and merged as the primary data source. Sync and async throws
   * are absorbed (best-effort).
   */
  client?: PluginClient;
  /** Optional logger for per-step tracing. */
  logger?: Logger;
  /**
   * PR1 — pending-queue data layer. Optional callback invoked once per
   * refresh with a `Discovery` describing the live catalog. The default
   * is a no-op so the public signature is additive. Sink errors are
   * absorbed and never propagate to the refresh.
   */
  discoverySink?: (discovery: Discovery) => void;
}

export interface ModelForecastPluginOptions {
  mode?: SelectionMode;
  verbose?: boolean;
  confidenceThreshold?: number;
  allowlist?: string[];
  denylist?: string[];
  resolveCandidates?: ResolveCandidates;
  generatedProfiles?: {
    enabled?: boolean;
    phasePrefixes?: string[];
  };
  /**
   * 429-fallback — rate-limit quarantine layer. When omitted, the
   * after hook is registered with default settings (`enabled: true`,
   * `ttlMs: 3_600_000`). Setting `{ enabled: false }` disables the
   * after hook and resolver filter (restores pre-change behaviour).
   */
  quarantine?: {
    enabled?: boolean;
    ttlMs?: number;
    /**
     * Override the quarantine persistence file path. Defaults to
     * `~/.cache/opencode-model-forecast/quarantine.json`. Inject a
     * custom path (e.g. temp dir) in tests to avoid contaminating
     * the real global quarantine file.
     */
    filePath?: string;
  };
  /**
   * model-fallback-error-classification (SDD change) — Slice 3, task 22.
   * Recursive fallback layer (design #1623 "Fallback mechanism"). Gated
   * by `enabled !== false` AND the client actually exposing
   * `session.create`/`session.prompt` — the default is ON when a usable
   * client is present, and disabling it restores pre-Slice-3 audit-only
   * behavior (rollback plan, design #1623 "Migration / Rollout").
   */
  fallback?: {
    enabled?: boolean;
  };
  /**
   * Integration seam for the real repository-local interruption sink.
   * Production omits this and uses filesystem/stderr defaults; tests and
   * embedders may inject individual dependencies without replacing the sink.
   */
  interruptionAudit?: {
    dependencies?: Partial<InterruptionAuditDependencies>;
  };
  /**
   * Override the model-data cache path for the config hook fallback
   * read. Defaults to `~/.cache/opencode-model-forecast/model-data.json`.
   * Inject a custom path (e.g. temp dir) in tests to avoid reading the
   * real global cache file.
   */
  cachePath?: string;
  benchmarks?: {
    rootDir?: string;
    globalPath?: string;
  };
}

function pluginHooksConfig(options?: ModelForecastPluginOptions): HooksConfig {
  return {
    mode: options?.mode ?? readModeFromOpenCodeConfig() ?? "advisory",
    confidenceThreshold: options?.confidenceThreshold ?? 0.6,
    ladder: DEFAULT_LADDER,
    allowlist: options?.allowlist ?? [],
    denylist: options?.denylist ?? [],
  };
}

function isSelectionMode(value: unknown): value is SelectionMode {
  return value === "auto" || value === "advisory" || value === "off";
}

function readModeFromOpenCodeConfig(): SelectionMode | undefined {
  // Unit tests must stay hermetic; never let the developer's real
  // ~/.config/opencode/opencode.json change default plugin behavior.
  if (process.env.VITEST !== undefined || process.env.NODE_ENV === "test") return undefined;

  const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
  let parsed: unknown;
  try {
    if (!existsSync(configPath)) return undefined;
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const plugins = (parsed as { plugin?: unknown }).plugin;
  if (!Array.isArray(plugins)) return undefined;

  for (const entry of plugins) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [spec, options] = entry as [unknown, unknown];
    if (typeof spec !== "string") continue;
    const normalized = spec.replace(/\\/g, "/");
    const isThisPlugin = normalized.includes("subagentsplugin/dist/index.js") ||
      normalized.includes("@aabadin/opencode-model-forecast");
    if (!isThisPlugin) continue;
    if (options === null || typeof options !== "object") continue;
    const mode = (options as { mode?: unknown }).mode;
    return isSelectionMode(mode) ? mode : undefined;
  }

  return undefined;
}

function watchQuarantineFile(
  filePath: string,
  quarantine: QuarantineStore,
  logger: Logger,
): void {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath).toLowerCase();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async () => {
    try {
      const entries = await loadQuarantineFile(filePath, Date.now());
      const { added, removed } = quarantine.syncPersistentEntries(entries);
      logger.info("quarantine", `watched reload file=${filePath} added=${added} removed=${removed}`);
    } catch (err) {
      logger.warn("quarantine", `watched reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void mkdir(dir, { recursive: true }).then(() => {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, changed) => {
        if (changed !== null && changed !== undefined && String(changed).toLowerCase() !== fileName) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 150);
      });
      watcher.unref?.();
      logger.info("quarantine", `watching quarantine file: ${filePath}`);
    } catch (err) {
      logger.warn("quarantine", `watch setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }).catch((err: unknown) => {
    logger.warn("quarantine", `watch mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Races a promise against a timer so that a hung async operation (e.g. an
 * OpenCode provider call when another plugin has failed) cannot block startup.
 * The timer is always cleared when the promise settles.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return Promise.race([
    promise.then(
      (value) => {
        clear();
        return value;
      },
      (err) => {
        clear();
        throw err;
      },
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

/**
 * Default timeout for the session-scoped live availability call. Mirrors
 * the existing config-hook timeout so behaviour stays consistent across
 * the two live SDK consumers in this module.
 */
const LIVE_AVAILABILITY_TIMEOUT_MS = 5_000;

function unavailableLiveAvailabilityState(reason: string): LiveAvailabilityState {
  return {
    ready: false,
    models: new Set<string>(),
    reason,
    source: "none",
  };
}

/**
 * Task 1.5 — pure derivation helper used by the config hook.
 *
 * Given the outcome of the config hook's bound, timeout-protected
 * `client.provider.list()` call (or the absence of a call when the
 * client / provider / list is missing), returns a fresh
 * `LiveAvailabilityState`. Does NOT make any SDK call itself.
 *
 * Truthful rules:
 *   - `ready: true` with a case-preserving `Set<provider/model>` ONLY
 *     after a successful, parseable live call (`source: "provider-list"`).
 *   - `ready: false` with a `reason` on every other path
 *     (`source: "none"`): no client, missing provider, missing list,
 *     sync throw, rejected promise, timeout, malformed / empty result.
 *   - The cache (gentle-ai / opencode file) is intentionally NOT
 *     consulted — readiness is the live session's signal only.
 *   - Never throws.
 */
export function deriveLiveAvailabilityState(args: {
  client: PluginClient | undefined;
  listResult?: unknown;
  listError?: unknown;
  listCallNotMade?: boolean;
}): LiveAvailabilityState {
  if (args.client === undefined) {
    return unavailableLiveAvailabilityState("no client at config time");
  }
  const provider = args.client.provider;
  if (provider === undefined || provider === null) {
    return unavailableLiveAvailabilityState("client.provider missing");
  }
  const listFn = provider.list;
  if (typeof listFn !== "function") {
    return unavailableLiveAvailabilityState("client.provider.list missing");
  }
  if (args.listCallNotMade === true) {
    return unavailableLiveAvailabilityState("provider.list not invoked");
  }
  if (args.listError !== undefined) {
    const msg = args.listError instanceof Error ? args.listError.message : String(args.listError);
    if (/timed out/i.test(msg)) {
      return unavailableLiveAvailabilityState(`provider.list timed out: ${msg}`);
    }
    return unavailableLiveAvailabilityState(`provider.list threw: ${msg}`);
  }
  if (args.listResult === undefined) {
    return unavailableLiveAvailabilityState("provider.list returned no result");
  }

  const providerList = extractProviderList(args.listResult);
  if (!Array.isArray(providerList) || providerList.length === 0) {
    return unavailableLiveAvailabilityState("provider.list returned no models");
  }

  const models = new Set<string>();
  for (const prov of providerList) {
    if (!prov || typeof prov !== "object") continue;
    const providerId = (prov as { id?: unknown }).id;
    if (typeof providerId !== "string" || providerId.length === 0) continue;
    const provModels = (prov as { models?: unknown }).models;
    if (!provModels || typeof provModels !== "object") continue;
    for (const modelId of Object.keys(provModels as Record<string, unknown>)) {
      if (modelId.length === 0) continue;
      // CASE-PRESERVING — match exactly what the live SDK returned so
      // downstream consumers can stay defensive about casing.
      models.add(`${providerId}/${modelId}`);
    }
  }

  if (models.size === 0) {
    return unavailableLiveAvailabilityState("provider.list had no usable provider/model entries");
  }

  return {
    ready: true,
    models,
    reason: "",
    source: "provider-list",
  };
}

/**
 * Task 1 — captures the session-scoped live availability state.
 *
 * Convenience wrapper that MAKES the bound, timeout-protected
 * `client.provider.list()` call itself (same this-binding + timeout
 * pattern the config hook uses), then delegates to
 * `deriveLiveAvailabilityState`. Useful for callers that do NOT
 * already have a live call in flight — the plugin entry's config
 * hook has its own live call and should use the pure derivation
 * helper directly instead.
 *
 * Never throws. Cache (gentle-ai / opencode file) is NOT consulted.
 *
 * Kept exported for direct unit-testability (Task 1 test surface).
 */
export async function computeLiveAvailabilityState(args: {
  client?: PluginClient;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<LiveAvailabilityState> {
  const timeoutMs = args.timeoutMs ?? LIVE_AVAILABILITY_TIMEOUT_MS;

  if (args.client === undefined) {
    args.logger?.info("liveAvailability", "unavailable: no client");
    return deriveLiveAvailabilityState({ client: args.client });
  }
  const provider = args.client.provider;
  if (provider === undefined || provider === null) {
    args.logger?.info("liveAvailability", "unavailable: client.provider missing");
    return deriveLiveAvailabilityState({ client: args.client });
  }
  const listFn = provider.list;
  if (typeof listFn !== "function") {
    args.logger?.info("liveAvailability", "unavailable: client.provider.list missing");
    return deriveLiveAvailabilityState({ client: args.client });
  }

  let providerListResult: unknown;
  try {
    // this-binding: the SDK's `provider.list` is a class method that
    // reads `this._client`. We invoke it bound to the provider instance
    // so an unbound `this` does not throw — same pattern as the
    // config-hook consumer below.
    providerListResult = await withTimeout(
      Promise.resolve(listFn.call(provider)),
      timeoutMs,
      "provider.list",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(msg)) {
      args.logger?.info("liveAvailability", `unavailable: timeout after ${timeoutMs}ms`);
    } else {
      args.logger?.info("liveAvailability", `unavailable: ${msg}`);
    }
    return deriveLiveAvailabilityState({ client: args.client, listError: err });
  }

  const state = deriveLiveAvailabilityState({
    client: args.client,
    listResult: providerListResult,
  });
  args.logger?.info(
    "liveAvailability",
    state.ready
      ? `ready models=${state.models.size} source=provider-list`
      : `unavailable: ${state.reason}`,
  );
  return state;
}

/**
 * Reads variant sources, merges with the static rubric, writes the result
 * cache atomically. Returns a Promise that resolves when the cache file
 * is on disk; never rejects — best-effort by design (plugin init must
 * not fail the session).
 *
 * Pure I/O: writes to disk. Read failures (missing/invalid sources)
 * produce an empty providers map; the rubric is always present from
 * `PHASE_DIFFICULTY`.
 */
export async function refreshCache(
  options: RefreshCacheOptions = {},
): Promise<void> {
  // De-duplicate concurrent refreshes that target the SAME effective cache
  // path. The plugin init path calls `void refreshCache()` synchronously,
  // so a single OpenCode session that pulls the plugin twice (or a CLI
  // invocation that runs while init is still pending) must NOT race on
  // the same cache file. We dedupe on the effective path so:
  //   - two default-path calls share the in-flight refresh
  //   - a custom-path call gets its own refresh
  //   - two custom-path calls sharing the same target ALSO share the
  //     refresh (so a CLI invocation racing the plugin init does not
  //     collide on the same file).
  const effectiveCachePath = options.cachePath ?? defaultCachePath();
  const inflightKey = `${effectiveCachePath}|${options.client === undefined ? "no-client" : "client"}`;
  if (inflightRefresh !== null && (inflightRefresh as { key?: string }).key === inflightKey) {
    options.logger?.trace("refreshCache", `deduped (in-flight): ${effectiveCachePath}`);
    return (inflightRefresh as { promise: Promise<void> }).promise;
  }

  const logger = options.logger;

  const work = (async (): Promise<void> => {
    try {
      logger?.info("refreshCache", `starting: ${effectiveCachePath}`);
      const gentleAiVariants = await readGentleAiVariantsCache(options.gentleAiPath, logger);
      const openCodeModels = await readOpenCodeModelsCache(options.openCodePath, logger);

      // Optionally call client.provider.list() as the primary live source.
      // Spec: "cache refresh MUST NOT fail when sources are absent" — any
      // throw here is absorbed and the cache is still written with whatever
      // the file-based sources + static rubric provide.
      let liveVariants: Record<string, Record<string, string[]>> = {};
      // PR1 — keep a reference to the raw provider.list() result so the
      // discovery sink can emit a `Discovery` (PR2 consumes the snapshot
      // to compute the canonical pending delta). When the SDK throws or
      // is absent, we feed an explicit `undefined` so the sink sees an
      // `unavailable` discovery from the opencode cache fallback.
      let providerListResult: unknown = undefined;
      // this-binding: the SDK's `provider.list` is a class method that
      // reads `this._client`; call it bound to the provider instance so an
      // unbound `this` does not throw. See the config hook for detail.
      const provider = options.client?.provider;
      const listFn = provider?.list;
      if (typeof listFn === "function") {
        try {
          providerListResult = await Promise.resolve(listFn.call(provider));
          liveVariants = extractVariantsFromProviderList(extractProviderList(providerListResult));
        } catch {
          // Best-effort: SDK may not be available in test/CLI paths.
          liveVariants = {};
          providerListResult = undefined;
        }
      }

      // PR1 — emit a `Discovery` to the optional sink. The sink is a
      // no-op by default; errors thrown by the sink are absorbed so a
      // misbehaving consumer cannot break the cache write path.
      if (typeof options.discoverySink === "function") {
        const discovery = discoverLiveModels({
          ...(providerListResult !== undefined ? { providerList: providerListResult } : {}),
          ...(openCodeModels && typeof openCodeModels === "object"
            ? { openCodeCache: openCodeModels }
            : {}),
        });
        try {
          options.discoverySink(discovery);
        } catch (sinkErr) {
          const sinkMsg = sinkErr instanceof Error ? sinkErr.message : String(sinkErr);
          logger?.warn("refreshCache", `discoverySink threw (absorbed): ${sinkMsg}`);
        }
      }

      // Live client data takes precedence over the gentle-ai file cache
      // (design: "input.client.provider.list() (primary) + gentle-ai
      // variants file"). When the live source is empty we fall back to
      // the gentle-ai cache file (or the OpenCode models cache below).
      const merged: Record<string, Record<string, string[]>> =
        Object.keys(liveVariants).length > 0 ? liveVariants : gentleAiVariants;

      // Sort variant keys for deterministic cache output (matches PR3's
      // extractVariantsFromProviderList behaviour; the gentle-ai cache file
      // is not guaranteed to already be sorted).
      for (const models of Object.values(merged)) {
        for (const modelId of Object.keys(models)) {
          models[modelId] = [...models[modelId]].sort();
        }
      }

      const providers = buildProvidersCache(merged) as Record<
      string,
      Record<string, { variants: string[] }>
    >;

      // If we still have no providers, attempt a last-ditch extraction from
      // openCodeModels by scanning provider objects with a `models` map.
      if (Object.keys(providers).length === 0 && openCodeModels && typeof openCodeModels === "object") {
        for (const [providerId, prov] of Object.entries(openCodeModels)) {
          if (!prov || typeof prov !== "object") continue;
          const models = (prov as { models?: unknown }).models;
          if (!models || typeof models !== "object") continue;
          const providerEntry: Record<string, { variants: string[] }> = {};
          for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
            if (!model || typeof model !== "object") continue;
            const variants = (model as { variants?: unknown }).variants;
            if (variants && typeof variants === "object" && Object.keys(variants as object).length > 0) {
              providerEntry[modelId] = {
                variants: Object.keys(variants as object).sort(),
              };
            }
          }
          if (Object.keys(providerEntry).length > 0) {
            (providers as Record<string, Record<string, { variants: string[] }>>)[providerId] = providerEntry;
          }
        }
      }

      const cache: ModelDataCache = {
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: providers as unknown as ModelDataCache["providers"],
        rubric: { ...PHASE_DIFFICULTY },
      };

      await writeCache(effectiveCachePath, cache, logger);
    } catch (err) {
      // Best-effort. Plugin init must never throw; log to stderr instead
      // and resolve.
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error("refreshCache", `failed: ${msg}`);
      process.stderr.write(
        `model-forecast: cache refresh failed: ${msg}\n`,
      );
    }
  })();

  // Cache the in-flight refresh under (path × client-presence) so any
  // concurrent caller awaiting the same target shares the same Promise.
  inflightRefresh = { key: inflightKey, promise: work };
  work.finally(() => {
    if (inflightRefresh !== null && inflightRefresh.promise === work) {
      inflightRefresh = null;
    }
  });

  return work;
}

/**
 * Wraps a `TaskHook` with a stderr trace line that fires BEFORE the
 * inner hook runs. Used to log every intercepted `task` call so the
 * user can confirm the rewrite path is active. The wrapper preserves
 * the `TaskHook` signature exactly — it does not transform input or
 * output, only emits a trace line and awaits the inner hook. Stderr
 * write failures are absorbed by `logTransition`.
 *
 * `tool.execute.before` fires for EVERY tool (read, grep, bash, …), not
 * just `task`. The trace is therefore gated to the `task` tool so it no
 * longer emits a misleading `subagent_type=<unknown>` line for every
 * non-task tool call. For task calls it reports both the raw
 * subagent_type and the normalized canonical phase so escalation
 * variants (`sdd-propose-alto`) are visibly resolved.
 *
 * We wrap (rather than modify `createTaskHook`) so the hook surface
 * stays stable and the existing tests in tests/plugin.test.ts which
 * directly call `hooks["tool.execute.before"]` continue to pass.
 */
function wrapTaskHookForTrace(inner: TaskHook, logger?: Logger): TaskHook {
  const wrapped: TaskHook = async (input, output) => {
    if (toolID(input?.tool) === "task") {
      const raw =
        typeof output?.args?.subagent_type === "string"
          ? output.args.subagent_type
          : "";
      const { phase, matched } = normalizePhase(raw);
      const subagentType = raw.length > 0 ? raw : "<unknown>";
      const callID = input?.callID ?? "<none>";
      if (logger) {
        logger.info(
          "task.before",
          `subagent_type=${subagentType} phase=${phase || "<unmatched>"} matched=${matched} callID=${callID}`,
        );
      } else {
        logTransition(
          `task.before subagent_type=${subagentType} phase=${phase || "<unmatched>"} matched=${matched} callID=${callID}`,
        );
      }
    }
    await inner(input, output);
  };
  // Task 1.5 — propagate the live availability GETTER through the
  // trace wrapper so downstream consumers/tests that read
  // `hooks["tool.execute.before"].getLiveAvailability()` still
  // observe the live state threaded from the plugin entry. The
  // wrapper must NOT cache the value — keeping the same closure
  // reference guarantees every read returns the current state.
  wrapped.getLiveAvailability = inner.getLiveAvailability;
  return wrapped;
}

/**
 * Plugin entry. Returns an empty hooks record (NO `chat.params`, NO
 * `tool.execute.before`) per spec and kicks off a fire-and-forget cache
 * refresh via `void`.
 *
 * Safe to call with or without an input argument. When OpenCode passes an
 * `input.client` (the live SDK client), its `provider.list()` is forwarded
 * to `refreshCache` as the primary data source so the runtime cache picks
 * up the live provider/model catalog instead of relying solely on the
 * gentle-ai / OpenCode file caches.
 */
export default async function modelForecastPlugin(
  input?: PluginInput,
  options?: ModelForecastPluginOptions,
): Promise<Record<string, unknown>> {
  // Extract the optional client without leaking OpenCode types into the
  // runtime contract. We only ever reach into `input.client`; other keys
  // are ignored.
  let client: PluginClient | undefined;
  if (input !== null && typeof input === "object") {
    const maybe = (input as { client?: unknown }).client;
    if (
      maybe !== null &&
      typeof maybe === "object" &&
      (typeof (maybe as { provider?: unknown }).provider === "object" ||
        typeof (maybe as { tui?: unknown }).tui === "object")
    ) {
      client = maybe as PluginClient;
    }
  }

  const { name: projectName, dir: projectDir } = extractProjectInfo(input as Record<string, unknown> | undefined);
  const logger = new Logger(projectName, projectDir, { verbose: options?.verbose === true });
  const interruptionAudit = createInterruptionAuditSink(
    projectDir,
    options?.interruptionAudit?.dependencies,
  );

  const hookConfig = pluginHooksConfig(options);
  // Visibility — one stderr line per plugin load so the user can
  // confirm the plugin was registered and with which mode/client.
  logger.info(
    "modelForecastPlugin",
    `init mode=${hookConfig.mode} client=${client !== undefined ? "present" : "absent"} dir=${projectDir}`,
  );
  if (hookConfig.mode !== "auto") return {};

  // Visibility: announce that the plugin is live in auto mode. Fired once
  // at registration so the user can see the plugin actually took effect.
  logger.info("modelForecastPlugin", "registering hooks (auto mode)");
  showToastSafely(client, "model-forecast: active in auto mode", "info");

  const profileCatalog: GeneratedProfileCatalog = { byBase: {} };

  // 429-fallback — quarantine layer. The store is created per plugin
  // instance so multiple instances stay isolated. `enabled: true` is
  // the default per design #1317 §2.
  const quarantineEnabled = options?.quarantine?.enabled !== false;
  const quarantine = new QuarantineStore({ ttlMs: options?.quarantine?.ttlMs, logger });
  const tracking = new Map<string, TrackedCall>();

  // Cross-bundle publishing: tsup builds the plugin (`dist/index.js`)
  // and the TUI (`dist/tui.js`) as SEPARATE bundles, so the TUI cannot
  // reach this QuarantineStore via a normal ESM import. Publish the
  // live instance on `globalThis` so the TUI can mutate it for
  // immediate in-session effect (and persist via saveToFile).
  setSharedQuarantineStore(quarantine);

  // Permanent quarantine persistence — survives CLI/plugin restart.
  // Stored alongside the model-data cache but in a separate file so
  // provider discovery cache and quarantine state do not conflict.
  // The path can be overridden via options.quarantine.filePath for
  // tests and isolated runs; default is the global cache location.
  const quarantineFilePath = options?.quarantine?.filePath ?? path.join(
    homedir(), ".cache", "opencode-model-forecast", "quarantine.json",
  );

  // Load permanent quarantines from previous sessions.
  // AWAITED so hooks never race with file load: the config hook and
  // tool hooks run AFTER OpenCode receives the hooks object.  Since
  // `modelForecastPlugin` is an async function, OpenCode awaits its
  // result before invoking any registered hooks — guaranteeing the
  // quarantine store is populated before isBlocked() is consulted.
  if (quarantineEnabled) {
    try {
      await quarantine.loadFromFile(quarantineFilePath);
      const permCount = quarantine.snapshot().length;
      if (permCount > 0) {
        logger.info("quarantine", `loaded ${permCount} permanent quarantines from previous session`);
        showToastSafely(client, `model-forecast: ${permCount} model(s) still quarantined from previous session`, "warning");
      }
    } catch {
      // Never block plugin startup on quarantine I/O failures.
    }
  }

  if (quarantineEnabled) {
    watchQuarantineFile(quarantineFilePath, quarantine, logger);
  }

  // Task 1 — session-scoped live availability state.
  //
  // Spec (Task 1.5 fix): the state is captured ONLY from the config
  // hook's existing bound, timeout-protected `client.provider.list()`
  // call. We do NOT eagerly capture it here at plugin init (a) because
  // OpenCode typically hasn't loaded providers yet, producing a
  // permanently unavailable state, and (b) because doing so would
  // duplicate the SDK call the config hook also makes.
  //
  // The state starts unavailable with a short reason and the config
  // hook updates it from the outcome of its own live call. The
  // `getLiveAvailability` closure reads the CURRENT value on every
  // call so the task hook always observes the latest state (not a
  // stale reference taken at construction time).
  let liveAvailability = unavailableLiveAvailabilityState("config hook not yet called");
  let latestConfigInvocation = 0;
  const getLiveAvailability = (): Readonly<LiveAvailabilityState> => liveAvailability;
  const setLiveAvailability = (
    invocation: number,
    next: LiveAvailabilityState,
  ): void => {
    // Last-invocation-wins: a slower earlier config call must never
    // overwrite availability established by a newer invocation.
    if (invocation !== latestConfigInvocation) {
      logger.trace(
        "liveAvailability",
        `ignored stale config invocation=${invocation}; latest=${latestConfigInvocation}`,
      );
      return;
    }
    liveAvailability = next;
    logger.info(
      "liveAvailability",
      next.ready
        ? `ready models=${next.models.size} source=${next.source}`
        : `unavailable: ${next.reason}`,
    );
  };

  const generatedProfileResolver = createGeneratedProfileResolver(
    profileCatalog,
    { ...(quarantineEnabled ? { quarantine } : {}), logger },
  );

  // model-fallback-error-classification (SDD change) — Slice 3, task 22.
  // Design #1623 "Fallback mechanism" + "Re-entrancy guard". The after
  // hook is constructed BEFORE the before hook (below) so its
  // `fallbackSessionIDs` set can be shared into `createTaskHook`'s deps —
  // both hooks MUST guard against the SAME set of engine-created child
  // sessions. Gated by `enabled !== false` AND the client actually
  // exposing usable `session.create`/`session.prompt` methods; the
  // default is ON only when both hold (rollback plan: `fallback:
  // {enabled: false}` — or an absent/partial client — restores
  // pre-Slice-3 audit-only behavior).
  const fallbackClientUsable =
    client !== undefined &&
    typeof client.session?.create === "function" &&
    typeof client.session?.prompt === "function";
  const fallbackEnabled = fallbackClientUsable && options?.fallback?.enabled !== false;
  let innerAfterHook: ReturnType<typeof createAfterHook> | undefined;
  if (quarantineEnabled) {
    innerAfterHook = createAfterHook({
      quarantine,
      tracking,
      catalog: profileCatalog,
      ladder: DEFAULT_LADDER,
      logger,
      ...(client !== undefined
        ? { fallback: { client, enabled: fallbackEnabled, interruptionAudit } }
        : {}),
      // Visibility: mirror the loud-advisory stderr line AND surface it
      // on-screen. The after hook emits this ONCE per quarantine event
      // (delete-on-consume per callID), so it is not per-call spam.
      warnSink: (message: string) => {
        try {
          process.stderr.write(`${message}\n`);
        } catch {
          // Never let the loud-advisory warning block the hook.
        }
        showToastSafely(client, message, "warning");
      },
    });
  }
  const fallbackSessionIDs = innerAfterHook?.fallbackSessionIDs;

  const hooks: Record<string, unknown> = {
    config: async (config: { agent?: Record<string, Record<string, unknown> | undefined> }) => {
      const invocation = ++latestConfigInvocation;
      // Fail closed immediately. This invalidates any prior ready snapshot
      // before generated-profile gating or pre-provider setup can fail.
      setLiveAvailability(
        invocation,
        unavailableLiveAvailabilityState("provider.list not yet settled for this config invocation"),
      );
      let providerListAttempted = false;
      // OpenCode AWAITS the config hook; any rejection here surfaces as a
      // structured `Cause { failures: [...] }` and aborts startup. Wrap the
      // ENTIRE body so profile generation is strictly best-effort and can
      // never break config resolution.
      try {
        // Only clear TTL-based quarantines (rate limits); permanent quarantines
        // (provider/billing errors) persist across plugin restarts.
        quarantine.clearNonPermanent();
        if (options?.generatedProfiles?.enabled === false) {
          setLiveAvailability(
            invocation,
            unavailableLiveAvailabilityState("generated profiles are disabled"),
          );
          return;
        }
        const hasInputDirectory =
          input !== null &&
          typeof input === "object" &&
          typeof (input as { directory?: unknown }).directory === "string";
        const hasBenchmarkOptions =
          options?.benchmarks?.rootDir !== undefined ||
          options?.benchmarks?.globalPath !== undefined;
        const shouldLoadBenchmarks =
          process.env.VITEST === undefined ||
          hasInputDirectory ||
          hasBenchmarkOptions;
        if (shouldLoadBenchmarks) {
          await loadEffectiveBenchmarks({
            rootDir: options?.benchmarks?.rootDir ?? projectDir,
            globalPath: options?.benchmarks?.globalPath,
          });
        }
        let connectedModels = [] as ReturnType<typeof connectedModelsFromProviderList>;
        // Diagnostic: capture WHY zero profiles were produced so the user
        // can `grep model-forecast` and see the exact reason on screen.
        let reason = "";
        // NOTE (this-binding): the OpenCode SDK exposes `client.provider`
        // as a class instance (`class Provider extends _HeyApiClient`)
        // whose `list()` reads `this._client`. Extracting the method into
        // a bare reference and calling it (`listFn()`) loses the `this`
        // binding and throws `Cannot read properties of undefined` INSIDE
        // the SDK. We therefore invoke it bound to the provider instance.
        //
        // Task 1.5: the SAME call result is reused to update the
        // session-scoped live availability state. No duplicate SDK call.
        const provider = client?.provider;
        const listFn = provider?.list;
        if (typeof listFn !== "function") {
          reason = client === undefined ? "no client at config time" : "provider.list unavailable";
          setLiveAvailability(
            invocation,
            deriveLiveAvailabilityState({ client, listCallNotMade: true }),
          );
        } else {
          let listResult: unknown;
          let listError: unknown;
          try {
            providerListAttempted = true;
            listResult = await withTimeout(
              Promise.resolve(listFn.call(provider)),
              LIVE_AVAILABILITY_TIMEOUT_MS,
              "provider.list",
            );
            connectedModels = connectedModelsFromProviderList(extractProviderList(listResult));
            if (connectedModels.length === 0) reason = "provider.list returned no models";
          } catch (err) {
            listError = err;
            reason = `provider.list threw: ${err instanceof Error ? err.message : String(err)}`;
            connectedModels = [];
          }
          // Update the session-scoped live availability state from this
          // call's outcome. The pure derivation helper turns success /
          // failure / timeout / malformed / empty into the right state.
          setLiveAvailability(
            invocation,
            deriveLiveAvailabilityState({
              client,
              ...(listError !== undefined ? { listError } : { listResult }),
            }),
          );
        }
        // Fallback: when the live provider list is empty/unavailable at config
        // time (OpenCode starts providers after the config hook fires), read
        // the on-disk cache that refreshCache already wrote at plugin init.
        // This guarantees the config hook always has a model catalog to work
        // with, regardless of provider-list timing.
        if (connectedModels.length === 0) {
          try {
            const effectiveFallbackCachePath = options?.cachePath ?? defaultCachePath();
            const cached = await withTimeout(readCache(effectiveFallbackCachePath, logger), 3000, "readCache");
            if (cached !== null && cached.providers) {
              const fromCache = connectedModelsFromCache(cached.providers);
              if (fromCache.length > 0) {
                connectedModels = fromCache;
                reason = `fallback: ${fromCache.length} model(s) from disk cache`;
              } else {
                reason = "disk cache had no models";
              }
            } else {
              reason = "no disk cache yet";
            }
          } catch {
            reason = "disk cache read failed";
          }
        }
        const generated = generateProfilesForConfig(config, connectedModels, {
          phasePrefixes: options?.generatedProfiles?.phasePrefixes,
          maxProfilesPerBase: 3,
        });
        profileCatalog.byBase = generated.byBase;

        // Visibility: report how many generated profiles were created and
        // across how many base agents. This is the key on-screen feedback —
        // it confirms the config hook ran and produced routing profiles.
        const baseAgentCount = Object.keys(generated.byBase).length;
        const profileCount = Object.values(generated.byBase).reduce(
          (sum, profiles) => sum + profiles.length,
          0,
        );
        if (profileCount === 0 && reason === "" && baseAgentCount === 0) {
          reason = "no base phase agents in config";
        }
        // Visibility — stderr trace of the config-hook transition. Pairs
        // with the on-screen toast so a user can `grep model-forecast` in
        // the session log and see the same numbers (and the reason when 0).
        logger.info(
          "config",
          `hook fired, generated profiles=${profileCount} across ${baseAgentCount} base agents${reason ? ` (${reason})` : ""}`,
        );
        if (profileCount > 0) {
          showToastSafely(
            client,
            `model-forecast: generated ${profileCount} profile(s) across ${baseAgentCount} base agent(s)`,
            "success",
          );
        } else {
          showToastSafely(
            client,
            `model-forecast: generated 0 profiles — ${reason || "no candidates"}`,
            "warning",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!providerListAttempted) {
          setLiveAvailability(
            invocation,
            unavailableLiveAvailabilityState(
              `config hook failed before provider.list: ${message}`,
            ),
          );
        }
        // Absorb any unexpected failure (e.g. a non-mutable config object)
        // so the config hook resolves and OpenCode does not report a
        // startup `Cause` failure. Best-effort, logged to stderr only.
        logger.error(
          "config",
          `hook failed: ${message}`,
        );
      }
    },
    "tool.execute.before": wrapTaskHookForTrace(
      createTaskHook(hookConfig, {
        resolveCandidates: options?.resolveCandidates ?? generatedProfileResolver,
        logger,
        ...(quarantineEnabled ? { tracking, quarantine } : {}),
        ...(fallbackSessionIDs !== undefined ? { fallbackSessionIDs } : {}),
        getLiveAvailability,
      }),
      logger,
    ),
  };
  if (quarantineEnabled && innerAfterHook !== undefined) {
    const afterHook = innerAfterHook;
    // Wrap the after hook to persist permanent quarantines after every
    // quarantine event. saveToFile is idempotent and cheap — it only
    // writes entries with expiresAt === Infinity.
    hooks["tool.execute.after"] = async (
      input: Parameters<typeof afterHook>[0],
      output: Parameters<typeof afterHook>[1],
    ): Promise<void> => {
      const countBefore = quarantine.snapshot().length;
      await afterHook(input, output);
      const countAfter = quarantine.snapshot().length;
      // Only save if the quarantine count changed (a new entry was added).
      if (countAfter > countBefore) {
        await quarantine.saveToFile(quarantineFilePath);
      }
    };
  }
  return hooks;
}

// Named export mirrors the default so tests and the tsup build agree on
// the entry point shape.
export { modelForecastPlugin };
