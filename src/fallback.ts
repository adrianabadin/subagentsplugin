/**
 * model-fallback-error-classification (SDD change) — Slice 3, task 20.
 *
 * Spec #1620 "Recursive Retry With Bounded Attempts" (recursive-fallback
 * ADDED requirements). Design #1623 "Fallback mechanism" +
 * "Re-entrancy guard" + "Client wiring".
 *
 * `createFallbackEngine` runs the bounded retry loop: on a classified
 * failure of a tracked `task` call, find the next viable non-quarantined
 * model, re-prompt it via the OpenCode SDK client (`session.create` +
 * `session.prompt`), classify the new result, and either return success
 * (caller overwrites `output.output`/`output.metadata`) or continue to the
 * next attempt. Stops after EXACTLY `maxAttempts` total attempts
 * (including the attempt that triggered the call into this engine) and
 * surfaces a structured terminal error on exhaustion — NEVER a silent
 * empty output.
 *
 * Re-entrancy: every child session the engine creates is registered in
 * `fallbackSessionIDs` BEFORE `session.prompt` is called, so nested
 * `tool.execute.before` / `tool.execute.after` hooks firing for that
 * session (because the fallback session itself dispatches a `task` tool
 * call) can early-return. Combined with the hard `maxAttempts` cap, this
 * makes runaway recursive fallback loops structurally impossible.
 *
 * Client shape is intentionally loose/structural (design #1623 "Client
 * wiring" — no SDK type import). `client.session.create` /
 * `client.session.prompt` are optional; `client.session.abort({path:{id}})`
 * mirrors sdk.gen.d.ts:150 and is used only for failed/stalled prompts.
 * When create or prompt is missing, the engine degrades gracefully
 * (treats the loop as immediately exhausted
 * after the one attempt the caller already reports) instead of throwing.
 */

import { resolveQuarantineTtlMs, type QuarantineErrorType, type QuarantineStore } from "./quarantine.js";
import type { ClassifiedError } from "./error-classification.js";
import type { LadderRung } from "./types.js";
import type { Logger } from "./logger.js";
import type {
  InterruptionAuditEvent,
  InterruptionAuditSink,
} from "./interruption-audit.js";

const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_FALLBACK_SESSION_TOMBSTONE_LIMIT = 256;

/** A single fallback attempt record (used both mid-loop and in the terminal error). */
export interface FallbackAttempt {
  model: string;
  reason: string;
}

export interface FallbackSuccessResult {
  success: true;
  output: string;
  model: string;
  /** Total attempts consumed, INCLUDING the one that triggered the call (1-indexed). */
  attempts: number;
}

export interface FallbackExhaustedResult {
  success: false;
  cancelled: false;
  /** The formatted "[model-forecast] FALLBACK EXHAUSTED: ..." terminal error string. */
  output: string;
  attempts: FallbackAttempt[];
}

export interface FallbackCancelledResult {
  success: false;
  cancelled: true;
  output: string;
  attempts: FallbackAttempt[];
}

export type FallbackResult =
  | FallbackSuccessResult
  | FallbackExhaustedResult
  | FallbackCancelledResult;

/**
 * Loose structural shape of the OpenCode SDK's `client.session` surface
 * that the engine needs. Mirrors `client.session.create({body:{parentID?,
 * title?}})` (sdk.gen.d.ts:114) and `client.session.prompt({path:{id},
 * body:{model:{providerID,modelID}, agent, parts}})` (sdk.gen.d.ts:174).
 * All members are optional so a caller can pass a partial/absent client
 * without the engine crashing; abort is never required for dispatch.
 */
export interface FallbackSessionClient {
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
}

export interface FallbackClient {
  session?: FallbackSessionClient;
}

/**
 * Minimal shape of a `GeneratedProfileCatalog` slice needed to compute
 * `findNextViableModel` — deliberately duplicated (not imported) from
 * `hooks.ts`'s `AfterHookCatalogSlice` so `fallback.ts` and `hooks.ts` do
 * not form an import cycle (`hooks.ts` consumes this module).
 */
export interface FallbackCatalogSlice {
  byBase: Record<string, Array<{ modelId: string; ladderRung?: LadderRung }>>;
}

export interface FallbackEngineDeps {
  client: FallbackClient | undefined;
  quarantine: QuarantineStore;
  catalog: FallbackCatalogSlice;
  ladder: readonly LadderRung[];
  classify: (text: string) => ClassifiedError | null;
  /** Hard cap on TOTAL attempts (including the one that triggered the call). Design mandates exactly 3 in production. */
  maxAttempts: number;
  now?: () => Date;
  logger?: Logger;
  interruptionAudit?: InterruptionAuditSink;
  promptTimeoutMs?: number;
  abortTimeoutMs?: number;
  /** Retired child IDs retained as bounded late-event tombstones. Active IDs are never evicted. */
  fallbackSessionTombstoneLimit?: number;
}

export interface FallbackRunParams {
  /** The parent (original) session id — used as `parentID` for created child sessions. */
  sessionID: string;
  /** The base subagent_type / phase, used for `agent` on the prompt and in the terminal error message. */
  originalSubagentType: string;
  /** The original task prompt text, re-sent verbatim to each fallback candidate. */
  prompt: string;
  /** The model that failed and triggered this call (attempt 1). */
  failedModel: string;
  /** The classification reason/code for attempt 1's failure (used in the terminal error / attempts log). */
  failureReason: string;
  /** Correlates fallback-owned child aborts with the original task call. */
  callID?: string;
}

export interface FallbackEngine {
  /** Active child IDs plus bounded retired tombstones shared by before/after hooks. */
  fallbackSessionIDs: Set<string>;
  run: (params: FallbackRunParams) => Promise<FallbackResult>;
}

function extractSessionId(created: unknown): string | undefined {
  if (created === null || typeof created !== "object") return undefined;
  const direct = (created as { id?: unknown }).id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const info = (created as { info?: { id?: unknown } }).info;
  if (info !== undefined && typeof info === "object" && info !== null) {
    const infoId = (info as { id?: unknown }).id;
    if (typeof infoId === "string" && infoId.length > 0) return infoId;
  }
  const data = (created as { data?: { id?: unknown } }).data;
  if (data !== undefined && typeof data === "object" && data !== null) {
    const dataId = (data as { id?: unknown }).id;
    if (typeof dataId === "string" && dataId.length > 0) return dataId;
  }
  return undefined;
}

function joinTextParts(result: unknown): string {
  if (result === null || typeof result !== "object") return "";
  const parts = (result as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function splitModelId(modelId: string): { providerID: string; modelID: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { providerID: "", modelID: modelId };
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

/**
 * Finds the next viable (non-quarantined, not-already-attempted-this-run)
 * candidate for `originalSubagentType`, walking the ladder cheapest-first
 * — same algorithm as `hooks.ts`'s `findNextViableModel`, extended with an
 * `excludeModels` set so the engine never re-dispatches a model it already
 * attempted in this run (defense-in-depth on top of quarantine).
 */
function findNextViableModel(
  catalog: FallbackCatalogSlice,
  originalSubagentType: string,
  quarantine: QuarantineStore,
  ladder: readonly LadderRung[],
  excludeModels: ReadonlySet<string>,
): string | null {
  const candidates = catalog.byBase[originalSubagentType] ?? [];
  const byRung = new Map<LadderRung, string[]>();
  for (const candidate of candidates) {
    const rung = candidate.ladderRung;
    if (rung === undefined) continue;
    const list = byRung.get(rung) ?? [];
    list.push(candidate.modelId);
    byRung.set(rung, list);
  }
  for (const rung of ladder) {
    const models = byRung.get(rung);
    if (models === undefined) continue;
    for (const modelId of models) {
      if (excludeModels.has(modelId)) continue;
      if (quarantine.isBlocked(modelId)) continue;
      return modelId;
    }
  }
  return null;
}

/**
 * Formats the terminal "FALLBACK EXHAUSTED" error. Matches design #1623's
 * exact message shape for the canonical 3-attempt case:
 *
 *   [model-forecast] FALLBACK EXHAUSTED: 3 attempts failed for <base>.
 *   Attempts: m1(reason), m2(reason), m3(reason). Manual action required.
 *
 * Generalizes the attempt count so the "all candidates quarantined at
 * dispatch" scenario (which may terminate with fewer than `maxAttempts`
 * recorded attempts) still produces a well-formed, non-empty message.
 */
function formatExhausted(base: string, attempts: readonly FallbackAttempt[]): string {
  const list = attempts.map((attempt) => `${attempt.model}(${attempt.reason})`).join(", ");
  return `[model-forecast] FALLBACK EXHAUSTED: ${attempts.length} attempts failed for ${base}. Attempts: ${list}. Manual action required.`;
}

function formatCancelled(base: string): string {
  return `[model-forecast] FALLBACK CANCELLED: child prompt cancelled for ${base}.`;
}

type BoundedOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timeout" };

async function settleWithin<T>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
): Promise<BoundedOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve().then(operation).then(
    (value): BoundedOutcome<T> => ({ status: "resolved", value }),
    (error): BoundedOutcome<T> => ({ status: "rejected", error }),
  );
  const deadline = new Promise<BoundedOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isExplicitCancellation(error: unknown): boolean {
  try {
    if (error === null || typeof error !== "object") return false;
    const record = error as { name?: unknown; code?: unknown };
    return record.name === "AbortError" ||
      record.name === "CanceledError" ||
      record.name === "CancelledError" ||
      record.code === "ABORT_ERR" ||
      record.code === "ERR_CANCELED" ||
      record.code === "ERR_CANCELLED";
  } catch {
    return false;
  }
}

function sdkEnvelopeError(value: unknown): unknown | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const error = (value as { error?: unknown }).error;
    return error === undefined ? undefined : error;
  } catch {
    return undefined;
  }
}

type AbortRejectionCode =
  | "abort_rejected_bad_request"
  | "abort_rejected_not_found"
  | "abort_rejected_cancelled"
  | "abort_rejected_timeout"
  | "abort_rejected_transport"
  | "abort_rejected_unknown";

function classifyAbortRejection(error: unknown): AbortRejectionCode {
  try {
    if (isExplicitCancellation(error)) return "abort_rejected_cancelled";
    if (error === null || typeof error !== "object") return "abort_rejected_unknown";
    const record = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      error?: unknown;
      response?: { status?: unknown };
    };
    const detail = record.error;
    if (detail !== undefined && isExplicitCancellation(detail)) {
      return "abort_rejected_cancelled";
    }
    const detailRecord = detail !== null && typeof detail === "object"
      ? detail as { status?: unknown; statusCode?: unknown; code?: unknown }
      : undefined;
    const status = record.status ?? record.statusCode ?? detailRecord?.status ??
      detailRecord?.statusCode ?? record.response?.status;
    if (status === 400) return "abort_rejected_bad_request";
    if (status === 404) return "abort_rejected_not_found";
    const code = record.code ?? detailRecord?.code;
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return "abort_rejected_timeout";
    }
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EPIPE" ||
      error instanceof TypeError
    ) {
      return "abort_rejected_transport";
    }
  } catch {
    // Hostile error objects fall through to the closed unknown code.
  }
  return "abort_rejected_unknown";
}

export function createFallbackEngine(deps: FallbackEngineDeps): FallbackEngine {
  const { quarantine, catalog, ladder, classify, logger } = deps;
  const maxAttempts = deps.maxAttempts;
  const fallbackSessionIDs = new Set<string>();
  const activeFallbackSessionIDs = new Set<string>();
  const retiredFallbackSessionIDs = new Set<string>();
  const promptTimeoutMs = deps.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const abortTimeoutMs = deps.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const configuredTombstoneLimit = deps.fallbackSessionTombstoneLimit;
  const fallbackSessionTombstoneLimit =
    typeof configuredTombstoneLimit === "number" && Number.isFinite(configuredTombstoneLimit)
      ? Math.max(0, Math.floor(configuredTombstoneLimit))
      : DEFAULT_FALLBACK_SESSION_TOMBSTONE_LIMIT;

  function registerFallbackSession(sessionID: string): void {
    retiredFallbackSessionIDs.delete(sessionID);
    activeFallbackSessionIDs.add(sessionID);
    fallbackSessionIDs.add(sessionID);
  }

  function retireFallbackSession(sessionID: string): void {
    activeFallbackSessionIDs.delete(sessionID);
    if (fallbackSessionTombstoneLimit === 0) {
      retiredFallbackSessionIDs.delete(sessionID);
      fallbackSessionIDs.delete(sessionID);
      return;
    }
    retiredFallbackSessionIDs.delete(sessionID);
    retiredFallbackSessionIDs.add(sessionID);
    while (retiredFallbackSessionIDs.size > fallbackSessionTombstoneLimit) {
      const oldest = retiredFallbackSessionIDs.values().next().value as string | undefined;
      if (oldest === undefined) break;
      retiredFallbackSessionIDs.delete(oldest);
      if (!activeFallbackSessionIDs.has(oldest)) fallbackSessionIDs.delete(oldest);
    }
  }

  function attemptInterruptionAudit(event: InterruptionAuditEvent): void {
    const sink = deps.interruptionAudit;
    if (sink === undefined) return;
    try {
      void Promise.resolve(sink(event)).catch(() => undefined);
    } catch {
      // Abort audit is fire-and-forget and must never delay child cleanup.
    }
  }

  async function abortFailedPrompt(
    sessionApi: FallbackSessionClient,
    correlation: Omit<InterruptionAuditEvent, "event" | "error">,
  ): Promise<void> {
    const abort = sessionApi.abort;
    if (typeof abort !== "function") return;

    attemptInterruptionAudit({ event: "abort_requested", ...correlation });
    const outcome = await settleWithin(
      () => abort.call(sessionApi, { path: { id: correlation.sessionID } }),
      abortTimeoutMs,
    );

    const resolvedError = outcome.status === "resolved"
      ? sdkEnvelopeError(outcome.value)
      : undefined;
    const rejection = outcome.status === "rejected"
      ? outcome.error
      : outcome.status === "resolved"
        ? outcome.value
        : undefined;
    if (outcome.status === "resolved" && resolvedError === undefined) {
      attemptInterruptionAudit({ event: "abort_resolved", ...correlation });
    } else if (outcome.status === "rejected" || resolvedError !== undefined) {
      attemptInterruptionAudit({
        event: "abort_rejected",
        ...correlation,
        error: classifyAbortRejection(rejection),
      });
    } else {
      attemptInterruptionAudit({
        event: "abort_timeout",
        ...correlation,
        error: "deadline_exceeded",
      });
    }
  }

  async function run(params: FallbackRunParams): Promise<FallbackResult> {
    const attempts: FallbackAttempt[] = [{ model: params.failedModel, reason: params.failureReason }];
    const attemptedModels = new Set<string>([params.failedModel]);

    const sessionApi = deps.client?.session;
    const canDispatch = typeof sessionApi?.create === "function" && typeof sessionApi?.prompt === "function";

    while (attempts.length < maxAttempts) {
      if (!canDispatch) break;

      const nextModel = findNextViableModel(catalog, params.originalSubagentType, quarantine, ladder, attemptedModels);
      if (nextModel === null) {
        logger?.info("fallback", `no viable candidate remains for ${params.originalSubagentType} after ${attempts.length} attempt(s); terminating`);
        break;
      }
      attemptedModels.add(nextModel);

      let sessionId: string | undefined;
      try {
        const created = await Promise.resolve(
          sessionApi!.create!({
            body: {
              parentID: params.sessionID,
              title: `model-forecast fallback attempt ${attempts.length + 1} (${nextModel})`,
            },
          }),
        );
        sessionId = extractSessionId(created);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "session_create_failed";
        logger?.warn("fallback", `session.create threw for ${nextModel}: ${reason}`);
        attempts.push({ model: nextModel, reason: "session_create_failed" });
        quarantine.add(nextModel, "session_create_failed");
        continue;
      }

      if (sessionId === undefined) {
        logger?.warn("fallback", `session.create for ${nextModel} did not return a usable session id`);
        attempts.push({ model: nextModel, reason: "session_create_failed" });
        quarantine.add(nextModel, "session_create_failed");
        continue;
      }

      // Register BEFORE prompting — this is the re-entrancy guard. Any
      // nested tool.execute.before/after hook firing for this sessionID
      // (because the fallback session itself dispatches a task tool call)
      // must see this session id as already-fallback-owned.
      registerFallbackSession(sessionId);

      const { providerID, modelID } = splitModelId(nextModel);

      const attemptNumber = attempts.length + 1;
      try {
        const promptOutcome = await settleWithin(
          () => sessionApi!.prompt!({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              agent: params.originalSubagentType,
              parts: [{ type: "text", text: params.prompt }],
            },
          }),
          promptTimeoutMs,
        );
        const promptError = promptOutcome.status === "rejected"
          ? promptOutcome.error
          : promptOutcome.status === "resolved"
            ? sdkEnvelopeError(promptOutcome.value)
            : undefined;
        if (promptOutcome.status !== "resolved" || promptError !== undefined) {
          if (
            promptError !== undefined &&
            isExplicitCancellation(promptError)
          ) {
            attempts.push({ model: nextModel, reason: "user_cancelled" });
            const output = formatCancelled(params.originalSubagentType);
            logger?.info("fallback", output);
            return { success: false, cancelled: true, output, attempts };
          }

          const timedOut = promptOutcome.status === "timeout";
          const reason = timedOut
            ? "fallback_prompt_timeout"
            : "fallback_prompt_rejected";
          const auditReason = timedOut
            ? "fallback_prompt_timeout"
            : "fallback_prompt_rejected";
          logger?.warn(
            "fallback",
            `session.prompt ${timedOut ? "timed out" : "rejected"} for ${nextModel}`,
          );
          await abortFailedPrompt(sessionApi!, {
            sessionID: sessionId,
            parentSessionID: params.sessionID,
            ...(params.callID !== undefined ? { callID: params.callID } : {}),
            attemptID: `fallback-attempt-${attemptNumber}`,
            origin: "fallback_prompt",
            reason: auditReason,
          });
          attempts.push({ model: nextModel, reason });
          quarantine.add(nextModel, reason);
          continue;
        }
        const promptResult = promptOutcome.value;

        const text = joinTextParts(promptResult);
        const classified = classify(text);

        if (classified === null || classified.type === "other") {
          // No known error pattern matched — success.
          logger?.info("fallback", `attempt ${attempts.length + 1} succeeded on ${nextModel}`);
          return { success: true, output: text, model: nextModel, attempts: attempts.length + 1 };
        }

        const errorType = classified.type as QuarantineErrorType;
        const ttlMs = resolveQuarantineTtlMs({ errorType, model: nextModel });
        quarantine.add(nextModel, classified.code, ttlMs, errorType);
        logger?.info("fallback", `attempt ${attempts.length + 1} failed on ${nextModel} (${classified.code}); quarantined`);
        attempts.push({ model: nextModel, reason: classified.code });
      } finally {
        // Active IDs are never evicted. Completed IDs become bounded
        // tombstones so late nested hook events still short-circuit without
        // leaking every child session for the lifetime of the plugin.
        retireFallbackSession(sessionId);
      }
    }

    const output = formatExhausted(params.originalSubagentType, attempts);
    logger?.warn("fallback", output);
    return { success: false, cancelled: false, output, attempts };
  }

  return { fallbackSessionIDs, run };
}
