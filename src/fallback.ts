/**
 * model-fallback-error-classification (SDD change) — Slice 3, task 20.
 *
 * Spec #1620 "Recursive Retry With Bounded Attempts" (recursive-fallback
 * ADDED requirements). Design #1623 "Fallback mechanism" +
 * "Re-entrancy guard" + "Client wiring".
 *
 * PR-03 (supervised-model-fallback-recovery) "Deterministic hardening
 * of createFallbackEngine" replaces the boolean result shape with a
 * structured `FallbackResult` union (success / exhausted / cancelled),
 * extends `FallbackAttempt` with sequence/provider/timestamps, applies
 * the design §12 provider-diversity preference (amendment P-03),
 * enforces deadlines on `session.create` (INV-004), and tombstones
 * created sessions for five minutes after they leave the active set
 * (INV-010 + amendment R-01 follow-ups).
 *
 * `createFallbackEngine` runs the bounded retry loop: on a classified
 * failure of a tracked `task` call, find the next viable non-quarantined
 * model, re-prompt it via the OpenCode SDK client (`session.create` +
 * `session.prompt`), classify the new result via `classifySdkResult`
 * (design §8 with amendments C-06 and P-01), and either return success
 * (caller overwrites `output.output`/`output.metadata`) or continue to
 * the next attempt. Stops after EXACTLY `maxAttempts` total attempts
 * (including the attempt that triggered the call into this engine) and
 * surfaces a structured terminal error on exhaustion — NEVER a silent
 * empty output.
 *
 * Re-entrancy ownership belongs exclusively to `AttemptCoordinator`.
 * Every child session is registered before prompting and tombstoned when
 * the prompt settles, so nested and late hook events can be rejected.
 *
 * The cancelled variant of `FallbackResult` is declared for forward
 * compatibility with PR-07's cancellation handling; the engine does not
 * emit it in PR-03 because the event hook arrives in PR-05.
 *
 * Client shape is intentionally loose/structural (design #1623 "Client
 * wiring" — no SDK type import). `client.session.create` /
 * `client.session.prompt` are optional; `client.session.abort({path:{id}})`
 * mirrors sdk.gen.d.ts:150 and is used only for failed/stalled prompts.
 * When create or prompt is missing, the engine degrades gracefully
 * (treats the loop as immediately exhausted
 * after the one attempt the caller already reports) instead of throwing.
 */

import type { QuarantineErrorType, QuarantineStore } from "./quarantine.js";
import type { LadderRung } from "./types.js";
import type { Logger } from "./logger.js";
import type { OpenCodeClient } from "./opencode-client.js";
export type { OpenCodeClient } from "./opencode-client.js";
/** @deprecated Use OpenCodeClient from opencode-client instead. */
export type FallbackClient = OpenCodeClient;
import type { AttemptCoordinator } from "./attempt-coordinator.js";
import { safeAbortSession } from "./session-abort.js";
import {
  classifySdkResult,
  type AttemptOutcome,
} from "./attempt-outcome.js";
import { withDeadline, DeadlineError } from "./async-deadline.js";
import {
  DEFAULT_RATE_LIMIT_TTL_MS,
  MAX_TOTAL_ATTEMPTS,
  ATTEMPT_HARD_TIMEOUT_MS,
  SESSION_CREATE_TIMEOUT_MS,
} from "./recovery-policy.js";
import { resolveRateLimitTtlMs } from "./rate-limit-reset.js";
import { providerOf } from "./model-groups.js";
import type {
  InterruptionAuditEvent,
  InterruptionAuditSink,
} from "./interruption-audit.js";

const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_FALLBACK_SESSION_TOMBSTONE_LIMIT = 256;

/** A single fallback attempt record (used both mid-loop and in the terminal result). */
export interface FallbackAttempt {
  /** 1-indexed ordinal position. INV-002 caps the total at three. */
  sequence: 1 | 2 | 3;
  model: string;
  /**
   * Provider segment extracted via `providerOf` (design §12.2 +
   * amendment C-04). Lower-cased. Empty string when the model id has
   * no extractable provider — such models are discarded, never
   * attempted.
   */
  provider: string;
  /**
   * Reason for the attempt's terminal state. Mirrors
   * `AttemptFailureKind` for failures and a `"success"` / `"empty_output"` /
   * `"malformed_response"` literal for non-failure outcomes.
   */
  reason: string;
  /** Wall-clock millisecond timestamp when the engine began this attempt. */
  startedAt: number;
  /** Wall-clock millisecond timestamp when this attempt settled (success or failure). */
  finishedAt: number;
}

export interface FallbackSuccessResult {
  status: "success";
  output: string;
  model: string;
  /** Every attempt actually run, INCLUDING the original failed one (sequence 1) and the winning fallback. */
  attempts: FallbackAttempt[];
}

export interface FallbackExhaustedResult {
  status: "exhausted";
  /** The "[model-forecast] FALLBACK EXHAUSTED: …" terminal output. ALWAYS non-empty (§18 invariant). */
  output: string;
  /** Every attempt actually run (may be shorter than `maxAttempts` if no viable candidate remains). */
  attempts: FallbackAttempt[];
}

export interface FallbackCancelledResult {
  status: "cancelled";
  reason: "user_cancelled" | "parent_cancelled";
  /** Attempts that ran before cancellation was observed. */
  attempts: FallbackAttempt[];
}

export type FallbackResult = FallbackSuccessResult | FallbackExhaustedResult | FallbackCancelledResult;

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
  client: OpenCodeClient | undefined;
  quarantine: QuarantineStore;
  catalog: FallbackCatalogSlice;
  ladder: readonly LadderRung[];
  /**
   * Error classifier for the original task output.
   */
  classify: (text: string) => null | { type: string; code: string; rawExcerpt?: string };
  /** Hard cap on TOTAL attempts (including the one that triggered the call). Default: `MAX_TOTAL_ATTEMPTS`. */
  maxAttempts?: number;
  /** Override the deadline applied to `session.create` (default: `SESSION_CREATE_TIMEOUT_MS`). */
  sessionCreateTimeoutMs?: number;
  /** Bound a fallback prompt so it can never be the sole progress signal. */
  sessionPromptTimeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
  /**
   * supervised-model-fallback-recovery (SDD change) — PR-04b.
   * Central coordinator that owns every recovery session lifecycle.
   */
  coordinator?: AttemptCoordinator;
  /**
   * Interruption audit sink for abort lifecycle events on failed/stalled
   * fallback child prompts. Fire-and-forget; never delays cleanup.
   */
  interruptionAudit?: InterruptionAuditSink;
  /** Override the deadline for session.abort (default: DEFAULT_ABORT_TIMEOUT_MS). */
  abortTimeoutMs?: number;
  /** Retired child IDs retained as bounded late-event tombstones. Active IDs are never evicted. */
  fallbackSessionTombstoneLimit?: number;
}

export interface FallbackRunParams {
  /** The parent (original) session id — used as `parentID` for created child sessions. */
  sessionID: string;
  /** Owning supervised task when this engine is invoked by recovery wiring. */
  taskCallID?: string;
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

/**
 * §12.2 provider extraction — amendment C-04 mandates this single
 * definition. A model without a slash returns "" and is discarded
 * (never entered into the candidates list).
 */
function splitModelId(modelId: string): { providerID: string; modelID: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { providerID: "", modelID: modelId };
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

function providerFor(modelId: string): string {
  return providerOf(modelId);
}

function nowMs(now: () => Date): number {
  return now().getTime();
}

function isProviderErrorKind(reason: string): boolean {
  return reason === "provider_error";
}

/**
 * Find the next viable candidate with provider-diversity preference.
 *
 * §12.1 + amendment P-03: between candidates, PREFER providers not yet
 * attempted in this run. Reuse a previously-attempted provider only
 * when (a) no other-provider candidate exists AND (b) the prior
 * attempt of that provider did not return `provider_error`.
 *
 * @param excludeModels  Models already attempted (quarantine-excluded by the caller).
 * @param attemptedProviders Providers that have already been attempted this run.
 * @param providerHadError Providers whose previous attempt returned provider_error.
 */
function findNextViableModel(
  catalog: FallbackCatalogSlice,
  originalSubagentType: string,
  quarantine: QuarantineStore,
  ladder: readonly LadderRung[],
  excludeModels: ReadonlySet<string>,
  attemptedProviders: ReadonlySet<string>,
  providerHadError: ReadonlySet<string>,
): string | null {
  const candidates = catalog.byBase[originalSubagentType] ?? [];
  // Bucket candidates by rung AND by (provider, error-free) status so
  // we can satisfy P-03 in a single ladder walk.
  const freshByRung = new Map<LadderRung, string[]>();
  const reuseByRung = new Map<LadderRung, string[]>();
  for (const candidate of candidates) {
    const rung = candidate.ladderRung;
    if (rung === undefined) continue;
    const modelId = candidate.modelId;
    if (excludeModels.has(modelId)) continue;
    if (quarantine.isBlocked(modelId)) continue;
    const provider = providerFor(modelId);
    // Discard models without extractable provider (C-04).
    if (provider.length === 0) continue;
    const fresh = !attemptedProviders.has(provider);
    const reusable =
      !fresh &&
      attemptedProviders.has(provider) &&
      !providerHadError.has(provider);
    if (!fresh && !reusable) continue;
    const target = fresh ? freshByRung : reuseByRung;
    const list = target.get(rung) ?? [];
    list.push(modelId);
    target.set(rung, list);
  }
  // Walk the ladder first against fresh-provider candidates; fall back
  // to same-provider candidates only when no fresh candidate remains.
  for (const rung of ladder) {
    const fresh = freshByRung.get(rung);
    if (fresh !== undefined && fresh.length > 0) return fresh[0];
  }
  for (const rung of ladder) {
    const reuse = reuseByRung.get(rung);
    if (reuse !== undefined && reuse.length > 0) return reuse[0];
  }
  return null;
}

/**
 * Formats the terminal "FALLBACK EXHAUSTED" error. §18 mandates the
 * non-empty invariant: this function is the only producer of the
 * `output` field on `FallbackExhaustedResult` and is REQUIRED to
 * always yield a string of length > 0 (the design gate forbids the
 * empty-string → success branch from ever being reachable).
 */
function formatExhausted(base: string, attempts: readonly FallbackAttempt[]): string {
  const list = attempts.map((attempt) => `${attempt.model}(${attempt.reason})`).join(", ");
  return `[model-forecast] FALLBACK EXHAUSTED: ${attempts.length} attempts failed for ${base}. Attempts: ${list}. Manual action required.`;
}

/**
 * Tombstone duration for a created session id once its prompt has
 * settled. Five minutes per design §21 PR-03 item 12 (and matches the
 * `COMPLETED_TASK_TOMBSTONE_MS` constant already exposed in
 * `recovery-policy.ts`).
 */
function reasonForOutcome(outcome: AttemptOutcome): string {
  if (outcome.kind === "success") return "success";
  return outcome.reason;
}

/** Loose structural type for the session API used by abortFailedPrompt. */
interface SessionApiWithAbort {
  abort?: (opts: { path: { id: string } }) => Promise<unknown> | unknown;
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
  const { quarantine, catalog, ladder, logger, coordinator } = deps;
  const maxAttempts = deps.maxAttempts ?? MAX_TOTAL_ATTEMPTS;
  const sessionCreateTimeoutMs = deps.sessionCreateTimeoutMs ?? SESSION_CREATE_TIMEOUT_MS;
  const sessionPromptTimeoutMs = deps.sessionPromptTimeoutMs ?? ATTEMPT_HARD_TIMEOUT_MS;
  const abortTimeoutMs = deps.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const nowFn = deps.now ?? ((): Date => new Date());
  const attemptedProviders = new Set<string>();
  const providerHadError = new Set<string>();

  // Tombstone management for re-entrancy guard (feature branch addition).
  const configuredTombstoneLimit = deps.fallbackSessionTombstoneLimit;
  const fallbackSessionTombstoneLimit =
    typeof configuredTombstoneLimit === "number" && Number.isFinite(configuredTombstoneLimit)
      ? Math.max(0, Math.floor(configuredTombstoneLimit))
      : DEFAULT_FALLBACK_SESSION_TOMBSTONE_LIMIT;
  const activeFallbackSessionIDs = new Set<string>();
  const retiredFallbackSessionIDs = new Set<string>();

  function registerFallbackSession(sessionID: string): void {
    retiredFallbackSessionIDs.delete(sessionID);
    activeFallbackSessionIDs.add(sessionID);
  }

  function retireFallbackSession(sessionID: string): void {
    activeFallbackSessionIDs.delete(sessionID);
    if (fallbackSessionTombstoneLimit === 0) {
      retiredFallbackSessionIDs.delete(sessionID);
      return;
    }
    retiredFallbackSessionIDs.delete(sessionID);
    retiredFallbackSessionIDs.add(sessionID);
    while (retiredFallbackSessionIDs.size > fallbackSessionTombstoneLimit) {
      const oldest = retiredFallbackSessionIDs.values().next().value as string | undefined;
      if (oldest === undefined) break;
      retiredFallbackSessionIDs.delete(oldest);
    }
  }

  function markInternal(sessionId: string, taskCallID: string | undefined): void {
    if (coordinator === undefined) return;
    // When coordinator is available, use it as the canonical registry.
    try {
      coordinator.markInternalSession(sessionId, taskCallID);
    } catch (err) {
      logger?.warn(
        "fallback",
        `coordinator.markInternalSession failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Also track locally for tombstone-based re-entrancy.
    registerFallbackSession(sessionId);
  }

  function unmarkInternal(sessionId: string): void {
    if (coordinator === undefined) {
      retireFallbackSession(sessionId);
      return;
    }
    try {
      coordinator.unmarkInternalSession(sessionId);
    } catch (err) {
      logger?.warn(
        "fallback",
        `coordinator.unmarkInternalSession failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    retireFallbackSession(sessionId);
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
    sessionApi: SessionApiWithAbort,
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

  function quarantineFailure(outcome: AttemptOutcome, model: string, fallbackReason: string, rawText: string): void {
    if (outcome.kind !== "failure") return;
    const reason = outcome.code;
    const reasonKind = outcome.reason;
    if (reasonKind === "rate_limit") {
      const ttlMs = resolveRateLimitTtlMs(
        [{ source: "text", value: rawText }],
        Date.now(),
      );
      // resolveRateLimitTtlMs returns DEFAULT_RATE_LIMIT_TTL_MS when no hint is found.
      quarantine.addAutomaticRateLimit(model, reason, ttlMs);
    } else if (reasonKind === "model_not_configured") {
      quarantine.addAutomaticExactModel(model, reason, "model_not_configured");
    } else if (reasonKind === "provider_error") {
      const provider = providerFor(model);
      quarantine.addAutomaticProvider(provider, reason, "provider_error");
    } else {
      // empty_output / malformed_response / unknown_retryable / etc.:
      // no global quarantine (design §10.4 / §10.5). The candidate is
      // excluded from THIS recovery only (already handled by the
      // excludeModels set).
      logger?.info(
        "fallback",
        `non-quarantining failure for ${model}: ${reasonKind} (${fallbackReason})`,
      );
    }
  }

  async function run(params: FallbackRunParams): Promise<FallbackResult> {
    const startedAt0 = nowMs(nowFn);
    const originalProvider = providerFor(params.failedModel);
    if (originalProvider.length > 0) attemptedProviders.add(originalProvider);
    const attempts: FallbackAttempt[] = [{
      sequence: 1,
      model: params.failedModel,
      provider: originalProvider,
      reason: params.failureReason,
      startedAt: startedAt0,
      finishedAt: startedAt0,
    }];
    const attemptedModels = new Set<string>([params.failedModel]);

    const sessionApi = deps.client?.session;
    const canDispatch = typeof sessionApi?.create === "function" && typeof sessionApi?.prompt === "function";

    while (attempts.length < maxAttempts) {
      if (params.taskCallID !== undefined && coordinator?.tasksByCallID.get(params.taskCallID)?.userCancelled) {
        return { status: "cancelled", reason: "user_cancelled", attempts };
      }
      if (!canDispatch) break;

      const nextModel = findNextViableModel(
        catalog,
        params.originalSubagentType,
        quarantine,
        ladder,
        attemptedModels,
        attemptedProviders,
        providerHadError,
      );
      if (nextModel === null) {
        logger?.info(
          "fallback",
          `no viable candidate remains for ${params.originalSubagentType} after ${attempts.length} attempt(s); terminating`,
        );
        break;
      }
      attemptedModels.add(nextModel);

      const nextProvider = providerFor(nextModel);
      if (nextProvider.length > 0) attemptedProviders.add(nextProvider);

      const attemptStartedAt = nowMs(nowFn);
      let sessionId: string | undefined;

      try {
        const created = await withDeadline(
          "session.create",
          sessionCreateTimeoutMs,
          () =>
            Promise.resolve(
              sessionApi!.create!({
                body: {
                  parentID: params.sessionID,
                  title: `model-forecast fallback attempt ${attempts.length + 1} (${nextModel})`,
                },
              }),
            ),
        );
        sessionId = extractSessionId(created);
      } catch (err) {
        const finishedAt = nowMs(nowFn);
        const reason =
          err instanceof DeadlineError
            ? "session_create_timeout"
            : err instanceof Error
              ? err.message
              : "session_create_failed";
        logger?.warn("fallback", `session.create threw for ${nextModel}: ${reason}`);
        attempts.push({
          sequence: (attempts.length + 1) as 1 | 2 | 3,
          model: nextModel,
          provider: nextProvider,
          reason,
          startedAt: attemptStartedAt,
          finishedAt,
        });
        continue;
      }

      if (sessionId === undefined) {
        const finishedAt = nowMs(nowFn);
        logger?.warn("fallback", `session.create for ${nextModel} did not return a usable session id`);
        attempts.push({
          sequence: (attempts.length + 1) as 1 | 2 | 3,
          model: nextModel,
          provider: nextProvider,
          reason: "session_create_failed",
          startedAt: attemptStartedAt,
          finishedAt,
        });
        continue;
      }

      // Register BEFORE prompting — this is the re-entrancy guard. Any
      // nested tool.execute.before/after hook firing for this sessionID
      // (because the fallback session itself dispatches a task tool call)
      // must see this session id as already-fallback-owned.
      //
      // The coordinator records ownership before the prompt so
      // `isInternalSession` remains true throughout the prompt.
      markInternal(sessionId, params.taskCallID);

      const { providerID, modelID } = splitModelId(nextModel);

      const attemptNumber = attempts.length + 1;
      let promptResult: unknown;
      try {
        promptResult = await withDeadline(
          "session.prompt",
          sessionPromptTimeoutMs,
          () => Promise.resolve(sessionApi!.prompt!({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              agent: params.originalSubagentType,
              parts: [{ type: "text", text: params.prompt }],
            },
          })),
        );
      } catch (err) {
        const finishedAt = nowMs(nowFn);
        const timedOut = err instanceof DeadlineError;
        const explicitCancel = isExplicitCancellation(err);
        // Explicit user cancellation (AbortError / CancelledError /
        // ABORT_ERR / ERR_CANCELLED) is TERMINAL — never retry, never
        // quarantine, never mark exhausted. Just return immediately so
        // the after-hook surfaces the cancellation to the caller.
        if (explicitCancel) {
          logger?.info(
            "fallback",
            `session.prompt cancelled for ${nextModel} (${err instanceof Error ? err.name : "unknown"}); returning cancelled`,
          );
          unmarkInternal(sessionId);
          return { status: "cancelled", reason: "user_cancelled", attempts };
        }
        const reason = timedOut ? "hard_timeout" : err instanceof Error ? err.message : "session_prompt_failed";
        // Audit+abort the failed fallback child prompt. When the prompt
        // failed (timeout OR transport rejection) we want one observable
        // abort lifecycle emitted — even when the next iteration of the
        // fallback loop will simply retry on a different model. The audit
        // sink is best-effort and never blocks the retry.
        if (timedOut && coordinator !== undefined && params.taskCallID !== undefined) {
          const task = coordinator.tasksByCallID.get(params.taskCallID);
          void safeAbortSession({
            client: sessionApi,
            coordinator,
            sessionID: sessionId,
            callID: params.taskCallID,
            attemptID: task?.originalAttemptID || sessionId,
            origin: "plugin-watchdog",
            reason: "hard_timeout",
            logger,
          });
        } else if (typeof sessionApi!.abort === "function") {
          // Always emit an audit-tracked abort for failed fallback
          // prompts (timeout OR transport rejection). The audit reason
          // disambiguates the two cases.
          void abortFailedPrompt(sessionApi! as SessionApiWithAbort, {
            sessionID: sessionId,
            parentSessionID: params.sessionID,
            ...(params.callID !== undefined ? { callID: params.callID } : {}),
            attemptID: `fallback-attempt-${attemptNumber}`,
            origin: "fallback_prompt",
            reason: timedOut ? "fallback_prompt_timeout" : "fallback_prompt_rejected",
          });
        }
        logger?.warn("fallback", `session.prompt threw for ${nextModel}: ${reason}`);
        attempts.push({
          sequence: (attempts.length + 1) as 1 | 2 | 3,
          model: nextModel,
          provider: nextProvider,
          reason,
          startedAt: attemptStartedAt,
          finishedAt,
        });
        // Tombstone this session: prompt failed but session id still
        // exists. Move it from active to tombstone.
        unmarkInternal(sessionId);
        if (params.taskCallID !== undefined && coordinator?.tasksByCallID.get(params.taskCallID)?.userCancelled) {
          return { status: "cancelled", reason: "user_cancelled", attempts };
        }
        continue;
      }

      const outcome = classifySdkResult(promptResult);
      const finishedAt = nowMs(nowFn);

      // Resolved SDK error envelopes can carry an AbortError / cancellation
      // marker (e.g. `{ data: undefined, error: <AbortError> }`). When the
      // SDK surfaces this as a resolved value rather than a thrown
      // rejection, we still want the same terminal cancellation as the
      // thrown case — no retry, no quarantine, no abort, no exhausted.
      if (outcome.kind === "failure") {
        const envelopeError = sdkEnvelopeError(promptResult);
        if (isExplicitCancellation(envelopeError)) {
          logger?.info(
            "fallback",
            `session.prompt resolved with cancellation envelope for ${nextModel}; returning cancelled`,
          );
          unmarkInternal(sessionId);
          return { status: "cancelled", reason: "user_cancelled", attempts };
        }
      }

      if (outcome.kind === "success") {
        logger?.info(
          "fallback",
          `attempt ${attempts.length + 1} succeeded on ${nextModel}`,
        );
        attempts.push({
          sequence: (attempts.length + 1) as 1 | 2 | 3,
          model: nextModel,
          provider: nextProvider,
          reason: reasonForOutcome(outcome),
          startedAt: attemptStartedAt,
          finishedAt,
        });
        unmarkInternal(sessionId);
        return {
          status: "success",
          output: outcome.text,
          model: nextModel,
          attempts,
        };
      }

      // outcome.kind === "failure"
      const rawText = typeof outcome.rawExcerpt === "string" ? outcome.rawExcerpt : "";
      const reasonLabel = reasonForOutcome(outcome);

      // Provider-error bookkeeping for diversity preference (P-03).
      if (isProviderErrorKind(reasonLabel) && nextProvider.length > 0) {
        providerHadError.add(nextProvider);
      }

      quarantineFailure(outcome, nextModel, reasonLabel, rawText);

      logger?.info(
        "fallback",
        `attempt ${attempts.length + 1} failed on ${nextModel} (${reasonLabel}); ${
          reasonLabel === "rate_limit" || reasonLabel === "model_not_configured" || reasonLabel === "provider_error"
            ? "quarantined"
            : "excluded from this recovery only"
        }`,
      );
      attempts.push({
        sequence: (attempts.length + 1) as 1 | 2 | 3,
        model: nextModel,
        provider: nextProvider,
        reason: reasonLabel,
        startedAt: attemptStartedAt,
        finishedAt,
      });
      unmarkInternal(sessionId);
    }

    const output = formatExhausted(params.originalSubagentType, attempts);
    logger?.warn("fallback", output);
    return { status: "exhausted", output, attempts };
  }

  return { run };
}

/**
 * Re-exported so callers (and tests) don't have to import the quarantine
 * module directly just to spell the discriminated union's string variants.
 */
export type { QuarantineErrorType };
