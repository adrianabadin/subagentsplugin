/**
 * supervised-model-fallback-recovery (SDD change) — PR-05.
 *
 * The OpenCode `event` hook: normalizes session/message/permission
 * events, associates child sessions to tracked tasks (§14), and detects
 * authoritative failures BEFORE `tool.execute.after` — creating the
 * `fallbackPromise` early (design §PR-05 merge gate, lines 1907-1909).
 *
 * Design "diseño fallback.md" §PR-05 (lines 1834-1909) + §14
 * (lines 1004-1068), amended by:
 *   - C-02: `permission.updated` is the real event; `permission.asked`
 *     does not exist and is ignored by `normalizeEvent`.
 *   - C-03: reset timing comes only from `session.status.retry.next`
 *     and error text (no HTTP headers).
 *   - P-02: a 429 whose reset is ≤ 60s is tolerated once (one internal
 *     OpenCode retry) before the failure is claimed. "Only where
 *     feasible": PR-05 tracks the tolerance with a per-session flag and
 *     no timer — the watchdog that observes the retry outcome lands in
 *     PR-06.
 *   - R-02: activity classification lives in `opencode-events.ts`; PR-05
 *     wires NO activity watchdog (design items 10 + 11).
 *
 * Prohibitions honoured (design §PR-05 items 10 + 11): this hook NEVER
 * aborts a session and NEVER starts an activity/inactivity timer. It is
 * strictly best-effort — every handler catches its own exceptions
 * (design item 9) and the whole hook can never throw.
 */

import type { AttemptCoordinator } from "./attempt-coordinator.js";
import type { AttemptWatchdog } from "./attempt-watchdog.js";
import type { FallbackResult } from "./fallback.js";
import type { Logger } from "./logger.js";
import type { OpenCodeSessionClient } from "./opencode-client.js";
import type { ParentRecovery } from "./parent-recovery.js";
import { safeAbortSession } from "./session-abort.js";
import type { AttemptFailure, FailureSource, TrackedTask } from "./recovery-types.js";
import {
  classifyErrorText,
  classifyStructuredError,
  eventSessionID,
  isActivityEvent,
  normalizeEvent,
  resolveAssociation,
  resolveKnownResetMs,
  type AssociationCandidate,
  type AssociationEventInfo,
  type AuthoritativeFailure,
  type NormalizedEvent,
} from "./opencode-events.js";

/** P-02 tolerance boundary: a reset within this window is tolerated once. */
const RESET_TOLERANCE_MS = 60_000;

export interface EventHookClient {
  session?: OpenCodeSessionClient;
}

export interface EventHookDeps {
  coordinator: AttemptCoordinator;
  /** Optional SDK client — only `session.children` is consulted (tie-break, §14.5). */
  client?: EventHookClient;
  logger?: Logger;
  /** Injected clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** PR-06 activity watchdog; keyed by child session id in the event path. */
  watchdog?: Pick<AttemptWatchdog, "watch" | "bind" | "stop" | "activity" | "permissionPending">;
  /**
   * Dispatches the bounded fallback engine for a task whose failure was
   * claimed from an event, BEFORE `tool.execute.after` fires (merge
   * gate). Injected by `plugin.ts`. When omitted, an authoritative
   * failure is still claimed but no `fallbackPromise` is created — the
   * pure/test path.
   */
  startFallback?: (task: TrackedTask, failure: AuthoritativeFailure) => Promise<FallbackResult>;
  /** PR-08 continuation guard started after an authoritative failure claim. */
  parentRecovery?: ParentRecovery;
}

export type EventHook = (input: { event?: unknown }) => Promise<void>;

// ---------------------------------------------------------------------------
// Defensive readers for the children tie-break payload
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function childrenArray(result: unknown): ReadonlyArray<Record<string, unknown>> {
  const direct = Array.isArray(result) ? result : undefined;
  const nested = direct === undefined ? asRecord(result)?.data : undefined;
  const list = direct ?? (Array.isArray(nested) ? nested : undefined);
  if (list === undefined) return [];
  return list.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function childInfoFor(result: unknown, sessionID: string): AssociationEventInfo | undefined {
  for (const child of childrenArray(result)) {
    const info = asRecord(child.info) ?? child;
    const id = typeof info.id === "string" ? info.id : undefined;
    if (id !== sessionID) continue;
    const out: AssociationEventInfo = {};
    if (typeof info.title === "string") out.title = info.title;
    if (typeof info.agent === "string") out.agent = info.agent;
    const model = asRecord(info.model);
    if (model !== undefined && typeof model.providerID === "string" && typeof model.modelID === "string") {
      out.model = `${model.providerID}/${model.modelID}`;
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

export function createEventHook(deps: EventHookDeps): EventHook {
  const { coordinator, client, logger, watchdog, parentRecovery } = deps;
  const nowFn = deps.now ?? ((): number => Date.now());
  const startFallback = deps.startFallback;
  // P-02: sessions whose first ≤60s-reset 429 has already been tolerated.
  const toleratedSessions = new Set<string>();

  function warn(message: string, err: unknown): void {
    try {
      logger?.warn("event", `${message}: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // Best-effort — logging must never break the hook.
    }
  }

  function enumerateCandidates(parentSessionID: string): AssociationCandidate[] {
    const out: AssociationCandidate[] = [];
    const callIDs = coordinator.tasksByParentSessionID.get(parentSessionID) ?? [];
    for (const callID of callIDs) {
      const task = coordinator.tasksByCallID.get(callID);
      if (task === undefined) continue;
      // Only tasks that have NOT yet bound a child session (§14.3).
      if (task.state !== "registered" && task.state !== "awaiting-child") continue;
      out.push({
        callID,
        parentSessionID: task.parentSessionID,
        generatedAlias: task.generatedAlias,
        originalModel: task.originalModel,
        createdAt: task.createdAt,
      });
    }
    return out;
  }

  async function handleCreated(event: Extract<NormalizedEvent, { kind: "session.created" }>): Promise<void> {
    if (event.parentID === undefined) return;
    const candidates = enumerateCandidates(event.parentID);
    if (candidates.length === 0) return;

    const info: AssociationEventInfo = { parentID: event.parentID };
    if (event.agent !== undefined) info.agent = event.agent;
    if (event.model !== undefined) info.model = event.model;
    if (event.title !== undefined) info.title = event.title;
    if (event.createdAt !== undefined) info.createdAt = event.createdAt;

    const resolution = resolveAssociation(info, candidates);
    if (resolution.kind === "associate") {
      coordinator.bindTaskSession({ callID: resolution.callID, sessionID: event.sessionID });
      watchdog?.stop(resolution.callID);
      watchdog?.watch(event.sessionID);
      watchdog?.bind(event.sessionID);
      return;
    }
    if (resolution.kind !== "tie") return;

    // §14.5 ambiguity: consult session.children and re-score the tied
    // candidates with the fuller child info. If it still ties, associate
    // nothing (never pick arbitrarily).
    const augmented = await augmentFromChildren(event.parentID, event.sessionID, info);
    if (augmented === undefined) return;
    const tied = candidates.filter((candidate) => resolution.callIDs.includes(candidate.callID));
    const second = resolveAssociation(augmented, tied);
    if (second.kind === "associate") {
      coordinator.bindTaskSession({ callID: second.callID, sessionID: event.sessionID });
      watchdog?.stop(second.callID);
      watchdog?.watch(event.sessionID);
      watchdog?.bind(event.sessionID);
    }
  }

  async function augmentFromChildren(
    parentSessionID: string,
    sessionID: string,
    base: AssociationEventInfo,
  ): Promise<AssociationEventInfo | undefined> {
    const childrenFn = client?.session?.children;
    if (typeof childrenFn !== "function") return undefined;
    try {
      const result = await Promise.resolve(childrenFn({ path: { id: parentSessionID } }));
      const childInfo = childInfoFor(result, sessionID);
      if (childInfo === undefined) return undefined;
      const merged: AssociationEventInfo = { ...base };
      if (childInfo.title !== undefined) merged.title = childInfo.title;
      if (childInfo.agent !== undefined) merged.agent = childInfo.agent;
      if (childInfo.model !== undefined) merged.model = childInfo.model;
      return merged;
    } catch (err) {
      warn("session.children tie-break failed", err);
      return undefined;
    }
  }

  function handleRetry(event: Extract<NormalizedEvent, { kind: "session.status" }>): void {
    const task = coordinator.taskForSession(event.sessionID);
    if (task === undefined) return;
    const message = event.retry?.message;
    const failure = classifyErrorText(message);
    if (failure === null) return;

    if (failure.kind === "rate_limit") {
      // P-02 tolerance: a known reset ≤ 60s gets one internal retry
      // before we claim the failure.
      const resetMs = resolveKnownResetMs(event.retry?.next, message, nowFn());
      if (resetMs !== undefined && resetMs <= RESET_TOLERANCE_MS && !toleratedSessions.has(event.sessionID)) {
        toleratedSessions.add(event.sessionID);
        try {
          logger?.info("event", `P-02 tolerance: 429 reset in ${resetMs}ms tolerated once for ${event.sessionID}`);
        } catch {
          // best-effort
        }
        return;
      }
    }
    claimAndDispatch(task, failure, "session-status");
  }

  function handleSessionError(event: Extract<NormalizedEvent, { kind: "session.error" }>): void {
    if (event.error === undefined || event.sessionID === undefined) return;
    if (event.error.name === "MessageAbortedError") {
      void handleExternalAbort(event.sessionID);
      return;
    }
    // Design item 7: the structured error prevails over any text.
    const failure = classifyStructuredError(event.error);
    if (failure === null) return;
    const task = coordinator.taskForSession(event.sessionID);
    if (task === undefined) return;
    claimAndDispatch(task, failure, "session-error");
  }

  async function handleExternalAbort(sessionID: string): Promise<void> {
    // Plugin-owned aborts were registered before the SDK call (INV-007).
    if (coordinator.pluginAbortSessionIDs.has(sessionID)) return;
    const direct = coordinator.taskForSession(sessionID);
    const callIDs = direct !== undefined
      ? [direct.callID]
      : coordinator.tasksByParentSessionID.get(sessionID) ??
        (coordinator.internalSessionCallIDs.has(sessionID) ? [coordinator.internalSessionCallIDs.get(sessionID)!] : []);
    if (callIDs.length === 0) return;
    if (direct === undefined && coordinator.tasksByParentSessionID.has(sessionID)) {
      coordinator.cancelParent({ parentSessionID: sessionID, reason: "user_cancelled" });
    } else {
      for (const callID of callIDs) coordinator.cancelTask({ callID, reason: "user_cancelled" });
    }
    for (const [fallbackSessionID, callID] of coordinator.internalSessionCallIDs) {
      if (!callIDs.includes(callID)) continue;
      const task = coordinator.tasksByCallID.get(callID);
      void safeAbortSession({
        client: client?.session,
        coordinator,
        sessionID: fallbackSessionID,
        callID,
        attemptID: task?.originalAttemptID || fallbackSessionID,
        origin: "plugin-cleanup",
        reason: "user_cancelled",
        logger,
      });
    }
  }

  function handleMessageUpdated(event: Extract<NormalizedEvent, { kind: "message.updated" }>): void {
    // Design item 8: inspect the structured error only. No error → the
    // message is activity (R-02); PR-05 wires no watchdog, so no action.
    if (event.error === undefined || event.sessionID === undefined) return;
    const failure = classifyStructuredError(event.error);
    if (failure === null) return;
    const task = coordinator.taskForSession(event.sessionID);
    if (task === undefined) return;
    claimAndDispatch(task, failure, "message-error");
  }

  function claimAndDispatch(task: TrackedTask, failure: AuthoritativeFailure, source: FailureSource): void {
    const attemptFailure: AttemptFailure = {
      kind: failure.kind,
      source,
      code: failure.code,
      message: failure.message,
      retryable: failure.kind === "rate_limit",
      authoritative: true,
      detectedAt: nowFn(),
    };
    if (failure.statusCode !== undefined) attemptFailure.statusCode = failure.statusCode;
    if (failure.rawExcerpt !== undefined) attemptFailure.rawExcerpt = failure.rawExcerpt;

    const claim = coordinator.claimFailure({
      callID: task.callID,
      attemptID: task.originalAttemptID,
      failure: attemptFailure,
      source,
    });
    // Duplicate / late / terminal → the first claimer already acted.
    if (!claim.claimed) return;
    parentRecovery?.schedule(task.callID);
    if (startFallback === undefined) return;

    let promise: Promise<FallbackResult>;
    try {
      promise = startFallback(task, failure);
    } catch (err) {
      // Design item 9: dispatch failure must not break the hook. The
      // failure stays claimed; the after-hook / later PRs remain the
      // safety net.
      warn(`startFallback threw for ${task.callID}`, err);
      return;
    }
    coordinator.setFallbackPromise({ callID: task.callID, promise });
    void promise.then(
      (result) => {
        try {
          coordinator.recordFallbackResult({ callID: task.callID, result });
        } catch (err) {
          warn(`recordFallbackResult failed for ${task.callID}`, err);
        }
      },
      (err) => {
        warn(`fallback promise rejected for ${task.callID}`, err);
      },
    );
  }

  return async (input): Promise<void> => {
    try {
      const raw = input === null || typeof input !== "object" ? undefined : (input as { event?: unknown }).event;
      const event = normalizeEvent(raw);
      if (event === null) return;

      const sessionID = eventSessionID(event);
      // An abort is the one internal-session event that must be arbitrated.
      if (sessionID !== undefined && event.kind === "session.error" && event.error?.name === "MessageAbortedError") {
        await handleExternalAbort(sessionID);
        return;
      }
      // Re-entrancy: never act on other events for fallback-owned sessions.
      if (sessionID !== undefined && coordinator.isInternalSession(sessionID)) return;
      if (sessionID !== undefined && coordinator.taskForSession(sessionID) !== undefined && isActivityEvent(event)) {
        if (event.kind === "permission.updated") watchdog?.permissionPending(sessionID, true);
        if (event.kind === "permission.replied") watchdog?.permissionPending(sessionID, false);
        watchdog?.activity(sessionID);
      }

      switch (event.kind) {
        case "session.created":
          await handleCreated(event);
          return;
        case "session.status":
          if (event.status === "retry") handleRetry(event);
          return;
        case "session.error":
          handleSessionError(event);
          return;
        case "message.updated":
          handleMessageUpdated(event);
          return;
        default:
          // session.idle / session.deleted / message.part.updated /
          // permission.* are normalized (R-02 activity) but drive no
          // action in PR-05: no aborts, no watchdogs.
          return;
      }
    } catch (err) {
      // Whole-hook guard (design item 9): the event hook can NEVER throw.
      warn("event hook top-level guard", err);
    }
  };
}
