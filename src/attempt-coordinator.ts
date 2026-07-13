/**
 * supervised-model-fallback-recovery (SDD change) — PR-04a (coordinator).
 *
 * Design "diseño fallback.md" §PR-04 lines 1737-1830 + amendments
 * C-05 (failure-claimed → fallback-exhausted transition) and
 * C-07 (invalid transitions logged via the existing logger until the
 * dedicated `RecoveryAuditEntry` type lands in PR-09).
 *
 * PR-04a scope: create the `AttemptCoordinator` class with all indices
 * (`tasksByCallID`, `attemptsByID`, `attemptsBySessionID`,
 * `pendingOriginalByParentID`, `tasksByParentSessionID`,
 * `pluginAbortSessionIDs`, `internalSessionIDs`, `completedTombstones`)
 * and the required methods (`registerTask`, `registerFallbackAttempt`,
 * `bindSession`, `noteActivity`, `noteToolBefore`, `noteToolAfter`,
 * `claimFailure`, `setFallbackPromise`, `recordFallbackResult`,
 * `reportOriginalResult`, `cancelParent`, `finalize`, `dispose`). The
 * coordinator is SELF-CONTAINED in this PR — wiring it into
 * `hooks.ts`, `plugin.ts`, and `fallback.ts` is the job of PR-04b.
 *
 * Invariants enforced:
 *   - INV-001..INV-014 are NOT yet enforced here; PR-04b will wire the
 *     coordinator into the hook surface that triggers them. The state
 *     machine in this file is the substrate; the policy lives in the
 *     callers (PR-04b+).
 *   - INV-010 (no late event causes a second action) is enforced at the
 *     tombstone level: any mutation on a callID whose entry was
 *     finalized or whose tombstone has been queried is dropped.
 *   - §PR-04 item 4 (`MAX_ACTIVE_TASKS = 1000`): registerTask refuses
 *     when the active set is full.
 *   - §PR-04 item 10 (fallbackPromise unique): setFallbackPromise is
 *     idempotent — the first promise wins, subsequent calls return
 *     the same promise without mutating task state.
 *   - §PR-04 item 11 (cleanup deferred 5 minutes): finalize schedules
 *     a tombstone eviction after `COMPLETED_TASK_TOMBSTONE_MS`.
 *   - §PR-04 item 12 (tombstones capped at 2000): oldest entry is
 *     evicted FIFO when the next finalize would overflow the cap.
 *   - Amendment C-05: `failure-claimed` → `fallback-exhausted` is an
 *     explicit transition triggered by `markFallbackExhausted`.
 *   - Amendment C-07: every illegal transition logs a `warn` line via
 *     the injected logger (or a noop logger when omitted) instead of
 *     writing to a future `RecoveryAuditEntry`.
 */

import { randomUUID } from "node:crypto";
import type { FallbackResult } from "./fallback.js";
import type { Logger } from "./logger.js";
import type {
  AbortOrigin,
  AttemptFailure,
  FailureSource,
  ModelAttempt,
  ModelAttemptState,
  TaskRecoveryState,
  TrackedTask,
} from "./recovery-types.js";
import {
  COMPLETED_TASK_TOMBSTONE_MS,
  INTERNAL_SESSION_TOMBSTONE_MS,
  MAX_ACTIVE_TASKS,
  MAX_TOMBSTONES,
} from "./recovery-policy.js";

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

export interface RegisterTaskInput {
  callID: string;
  parentSessionID: string;
  originalSubagentType: string;
  generatedAlias: string;
  originalModel: string;
  prompt: string;
  recoveryToken?: string;
  /**
   * Optional explicit timestamp (epoch ms). When omitted, the
   * coordinator's injected `now` clock is consulted.
   */
  now?: number;
}

export interface RegisterFallbackAttemptInput {
  id: string;
  taskCallID: string;
  kind: "original" | "fallback";
  sequence: 1 | 2 | 3;
  model: string;
  provider: string;
  agent: string;
  parentSessionID: string;
  /** Initial watchdog generation counter (incremented by watchdog renewals). */
  watchdogGeneration: number;
  /** Optional explicit timestamp (epoch ms). */
  now?: number;
}

export interface BindSessionInput {
  attemptID: string;
  sessionID: string;
  now?: number;
}

export interface NoteActivityInput {
  attemptID: string;
  now?: number;
}

export interface NoteToolInput {
  attemptID: string;
  toolCallID: string;
  now?: number;
}

export interface ClaimFailureInput {
  callID: string;
  attemptID: string;
  failure: AttemptFailure;
  source: FailureSource;
  now?: number;
}

export interface ClaimResult {
  /** True iff this caller won the race to claim the failure. */
  claimed: boolean;
  /**
   * When `claimed === false`, a short reason: "duplicate", "terminal",
   * "invalid_transition". Undefined on success.
   */
  reason?: string;
}

export interface SetFallbackPromiseInput {
  callID: string;
  promise: Promise<FallbackResult>;
}

export interface RecordFallbackResultInput {
  callID: string;
  result: FallbackResult;
  now?: number;
}

export interface ReportOriginalResultInput {
  callID: string;
  output: string;
  now?: number;
}

export interface CancelParentInput {
  parentSessionID: string;
  reason: "user_cancelled" | "parent_cancelled";
  now?: number;
}

export interface FinalizeInput {
  callID: string;
  now?: number;
}

export interface MarkFallbackExhaustedInput {
  callID: string;
  now?: number;
}

export interface RegisterPluginAbortInput {
  sessionID: string;
  callID: string;
  attemptID: string;
  origin: AbortOrigin;
  reason: string;
  requestedAt?: number;
}

export interface PluginAbortRecord {
  sessionID: string;
  callID: string;
  attemptID: string;
  origin: AbortOrigin;
  reason: string;
  requestedAt: number;
}

export interface AttemptCoordinatorOptions {
  logger?: Logger;
  /** Inject a deterministic clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Override `COMPLETED_TASK_TOMBSTONE_MS` for tests. */
  tombstoneTtlMs?: number;
  /** Override `INTERNAL_SESSION_TOMBSTONE_MS` for tests. */
  internalSessionTombstoneMs?: number;
  /** Override `MAX_ACTIVE_TASKS` for tests. */
  maxActiveTasks?: number;
  /** Override `MAX_TOMBSTONES` for tests. */
  maxTombstones?: number;
}

// ---------------------------------------------------------------------------
// Terminal task states (single source of truth for "no further mutation")
// ---------------------------------------------------------------------------

const TERMINAL_TASK_STATES: ReadonlySet<TaskRecoveryState> = new Set<TaskRecoveryState>([
  "completed-original",
  "completed-fallback",
  "fallback-exhausted",
  "parent-recovery-enqueued",
  "cancelled",
  "cleaned",
]);

// Active task states (the ones that participate in cancellation / cleanup).
const ACTIVE_TASK_STATES: ReadonlySet<TaskRecoveryState> = new Set<TaskRecoveryState>([
  "registered",
  "awaiting-child",
  "running-original",
  "failure-claimed",
  "fallback-running",
  "fallback-ready",
  "awaiting-original-settlement",
]);

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Central state machine for supervised subagent recovery.
 *
 * PR-04a: self-contained. PR-04b will replace the `Map<callID, TrackedCall>`
 * in `plugin.ts` with this coordinator, and replace the `fallbackSessionIDs`
 * field returned from `createAfterHook` with `coordinator.isInternalSession(...)`.
 */
export class AttemptCoordinator {
  // ---- Indices (design §PR-04 items 2.1..2.8) ----
  readonly tasksByCallID = new Map<string, TrackedTask>();
  readonly attemptsByID = new Map<string, ModelAttempt>();
  readonly attemptsBySessionID = new Map<string, string>();
  /**
   * supervised-model-fallback-recovery (SDD change) — PR-05 §14.
   * Task-level child-session association: child `sessionID` → owning
   * task `callID`. Populated by `bindTaskSession` when the event hook
   * resolves a `session.created` event to a tracked task (§14.4). The
   * original attempt is not registered by the before hook (PR-04b), so
   * binding is recorded at the TASK level here rather than via
   * `bindSession` (which requires a `ModelAttempt`).
   */
  readonly callIDBySessionID = new Map<string, string>();
  readonly pendingOriginalByParentID = new Map<string, string[]>();
  readonly tasksByParentSessionID = new Map<string, string[]>();
  readonly pluginAbortSessionIDs = new Map<string, PluginAbortRecord>();
  readonly internalSessionIDs = new Set<string>();
  /** Active fallback session → owning callID, needed to cancel only its recovery. */
  readonly internalSessionCallIDs = new Map<string, string>();
  /** callID → completedAt wall-clock (used for deferred cleanup eviction). */
  readonly completedTombstones = new Map<string, number>();
  /** sessionID → tombstoned-at wall-clock (used by `isInternalSession` for late events). */
  readonly internalSessionTombstones = new Map<string, number>();

  /** Active timers — cleared by `dispose()` so a plugin shutdown does not leak. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Logger either injected or no-op (best-effort, never throws). */
  private readonly logger: Logger;
  private readonly nowFn: () => number;
  private readonly tombstoneTtlMs: number;
  private readonly internalSessionTombstoneMs: number;
  private readonly maxActiveTasks: number;
  private readonly maxTombstones: number;
  /** Whether `dispose()` has run — prevents double-dispose and post-shutdown mutations. */
  private disposed = false;

  constructor(options: AttemptCoordinatorOptions = {}) {
    this.logger = options.logger ?? noopLogger();
    this.nowFn = options.now ?? ((): number => Date.now());
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? COMPLETED_TASK_TOMBSTONE_MS;
    this.internalSessionTombstoneMs = options.internalSessionTombstoneMs ?? INTERNAL_SESSION_TOMBSTONE_MS;
    this.maxActiveTasks = options.maxActiveTasks ?? MAX_ACTIVE_TASKS;
    this.maxTombstones = options.maxTombstones ?? MAX_TOMBSTONES;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a new supervised task. Throws on duplicate callID or when
   * the active-task cap is reached (design §PR-04 item 4).
   *
   * The task starts in state `registered`; the before hook will transition
   * it to `awaiting-child` on completion. PR-04b wires that transition.
   */
  registerTask(input: RegisterTaskInput): TrackedTask {
    this.assertAlive();
    if (input.callID.length === 0) {
      throw new Error("[model-forecast] AttemptCoordinator.registerTask: empty callID");
    }
    if (this.tasksByCallID.has(input.callID)) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.registerTask: duplicate callID '${input.callID}'`,
      );
    }
    if (this.tasksByCallID.size >= this.maxActiveTasks) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.registerTask: capacity reached (max=${this.maxActiveTasks})`,
      );
    }
    const now = input.now ?? this.nowFn();
    const task: TrackedTask = {
      callID: input.callID,
      parentSessionID: input.parentSessionID,
      originalSubagentType: input.originalSubagentType,
      generatedAlias: input.generatedAlias,
      originalModel: input.originalModel,
      prompt: input.prompt,
      state: "registered",
      createdAt: now,
      updatedAt: now,
      originalAttemptID: "",
      failureAuthoritative: false,
      afterHookSeen: false,
      userCancelled: false,
      parentRecoveryEnqueued: false,
      recoveryToken: input.recoveryToken ?? randomUUID(),
    };
    this.tasksByCallID.set(input.callID, task);

    // Mirror into the parent index, preserving FIFO insertion order.
    const siblings = this.tasksByParentSessionID.get(input.parentSessionID) ?? [];
    siblings.push(input.callID);
    this.tasksByParentSessionID.set(input.parentSessionID, siblings);

    return task;
  }

  /**
   * Register a model attempt (original or fallback) attached to a tracked task.
   * Throws on duplicate attemptID.
   */
  registerFallbackAttempt(input: RegisterFallbackAttemptInput): ModelAttempt {
    this.assertAlive();
    if (input.id.length === 0) {
      throw new Error("[model-forecast] AttemptCoordinator.registerFallbackAttempt: empty id");
    }
    if (this.attemptsByID.has(input.id)) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.registerFallbackAttempt: duplicate attempt id '${input.id}'`,
      );
    }
    const task = this.tasksByCallID.get(input.taskCallID);
    if (task === undefined) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.registerFallbackAttempt: unknown task callID '${input.taskCallID}'`,
      );
    }
    const now = input.now ?? this.nowFn();
    const attempt: ModelAttempt = {
      id: input.id,
      taskCallID: input.taskCallID,
      kind: input.kind,
      sequence: input.sequence,
      model: input.model,
      provider: input.provider,
      agent: input.agent,
      parentSessionID: input.parentSessionID,
      state: "created",
      createdAt: now,
      lastActivityAt: now,
      retryCount: 0,
      retryWaitAccumulatedMs: 0,
      waitingPermission: false,
      activeToolCallIDs: new Set<string>(),
      watchdogGeneration: input.watchdogGeneration,
    };
    this.attemptsByID.set(input.id, attempt);
    if (input.kind === "original") {
      // The first attempt registered on a task becomes its canonical
      // originalAttemptID (used by later transitions / logging).
      if (task.originalAttemptID.length === 0) {
        task.originalAttemptID = input.id;
        task.updatedAt = now;
      }
      // Pending original FIFO per parent — used by §14 session binding scoring.
      const queue = this.pendingOriginalByParentID.get(input.parentSessionID) ?? [];
      queue.push(input.id);
      this.pendingOriginalByParentID.set(input.parentSessionID, queue);
    }
    return attempt;
  }

  // -------------------------------------------------------------------------
  // Attempt observation
  // -------------------------------------------------------------------------

  /** Bind a sessionID to an attempt and transition the attempt to `running`. */
  bindSession(input: BindSessionInput): ModelAttempt {
    this.assertAlive();
    const attempt = this.attemptsByID.get(input.attemptID);
    if (attempt === undefined) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.bindSession: unknown attemptID '${input.attemptID}'`,
      );
    }
    const now = input.now ?? this.nowFn();
    attempt.sessionID = input.sessionID;
    attempt.boundAt = now;
    attempt.lastActivityAt = now;
    transitionAttempt(attempt, "running");
    this.attemptsBySessionID.set(input.sessionID, input.attemptID);

    // Promote the owning task to running-original via awaiting-child
    // (§6.3 transition: registered → awaiting-child → running-original).
    // PR-04b wires the before hook to call `markAwaitingChild` between
    // `registerTask` and `bindSession`; if the caller skips the explicit
    // transition (e.g. a unit test that exercises binding directly),
    // bindSession transits through awaiting-child automatically so the
    // state machine is observable end-to-end.
    const task = this.tasksByCallID.get(attempt.taskCallID);
    if (task !== undefined) {
      if (task.state === "registered") {
        transitionTask(task, "awaiting-child", now);
      }
      if (task.state === "awaiting-child") {
        transitionTask(task, "running-original", now);
      }
    }
    return attempt;
  }

  /**
   * Mark new activity on an attempt. Sets `firstActivityAt` on the first
   * call and updates `lastActivityAt` on every call.
   */
  noteActivity(input: NoteActivityInput): ModelAttempt {
    this.assertAlive();
    const attempt = this.attemptsByID.get(input.attemptID);
    if (attempt === undefined) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.noteActivity: unknown attemptID '${input.attemptID}'`,
      );
    }
    if (isAttemptTerminal(attempt.state)) {
      this.logInvalidTransition(attempt.taskCallID, `noteActivity on terminal attempt '${attempt.id}' (state=${attempt.state})`);
      return attempt;
    }
    const now = input.now ?? this.nowFn();
    if (attempt.firstActivityAt === undefined) {
      attempt.firstActivityAt = now;
    }
    attempt.lastActivityAt = now;
    return attempt;
  }

  /** Begin tracking an active tool call on the attempt (transitions to tool-running). */
  noteToolBefore(input: NoteToolInput): ModelAttempt {
    this.assertAlive();
    const attempt = this.attemptsByID.get(input.attemptID);
    if (attempt === undefined) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.noteToolBefore: unknown attemptID '${input.attemptID}'`,
      );
    }
    if (isAttemptTerminal(attempt.state)) {
      this.logInvalidTransition(attempt.taskCallID, `noteToolBefore on terminal attempt '${attempt.id}' (state=${attempt.state})`);
      return attempt;
    }
    const now = input.now ?? this.nowFn();
    attempt.activeToolCallIDs.add(input.toolCallID);
    attempt.lastActivityAt = now;
    if (attempt.state === "running" || attempt.state === "awaiting-session" || attempt.state === "created") {
      transitionAttempt(attempt, "tool-running");
    }
    return attempt;
  }

  /** End tracking of an active tool call. When the last tool exits, returns to running. */
  noteToolAfter(input: NoteToolInput): ModelAttempt {
    this.assertAlive();
    const attempt = this.attemptsByID.get(input.attemptID);
    if (attempt === undefined) {
      throw new Error(
        `[model-forecast] AttemptCoordinator.noteToolAfter: unknown attemptID '${input.attemptID}'`,
      );
    }
    if (isAttemptTerminal(attempt.state)) {
      this.logInvalidTransition(attempt.taskCallID, `noteToolAfter on terminal attempt '${attempt.id}' (state=${attempt.state})`);
      return attempt;
    }
    const now = input.now ?? this.nowFn();
    attempt.activeToolCallIDs.delete(input.toolCallID);
    attempt.lastActivityAt = now;
    if (attempt.state === "tool-running" && attempt.activeToolCallIDs.size === 0) {
      transitionAttempt(attempt, "running");
    }
    return attempt;
  }

  // -------------------------------------------------------------------------
  // Failure claim (concurrent-safe)
  // -------------------------------------------------------------------------

  /**
   * Claim a failure on a task. The first call wins; concurrent or
   * subsequent calls return `{ claimed: false }` with a short reason.
   */
  claimFailure(input: ClaimFailureInput): ClaimResult {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      // Late event after finalize → tombstone check.
      if (this.completedTombstones.has(input.callID)) {
        this.logInvalidTransition(input.callID, `claimFailure on tombstoned callID (after=${this.completedTombstones.get(input.callID)})`);
        return { claimed: false, reason: "tombstoned" };
      }
      this.logInvalidTransition(input.callID, `claimFailure on unknown callID`);
      return { claimed: false, reason: "unknown_callID" };
    }
    if (task.state === "failure-claimed" || task.failureClaimedBy !== undefined) {
      return { claimed: false, reason: "already claimed" };
    }
    if (!ACTIVE_TASK_STATES.has(task.state)) {
      this.logInvalidTransition(task.callID, `claimFailure on non-active task (state=${task.state})`);
      return { claimed: false, reason: "invalid_transition" };
    }
    const now = input.now ?? this.nowFn();
    task.failure = input.failure;
    task.failureClaimedBy = input.source;
    task.failureAuthoritative = input.failure.authoritative;
    task.updatedAt = now;
    // The original attempt (sequence 1) carries the failure metadata so the
    // post-mortem audit can correlate it. Subsequent attempts (fallback)
    // don't overwrite this — see INV-008.
    const attempt = this.attemptsByID.get(input.attemptID);
    if (attempt !== undefined) {
      attempt.failure = input.failure;
      attempt.completedAt = now;
      transitionAttempt(attempt, "failed");
    }
    transitionTask(task, "failure-claimed", now);
    return { claimed: true };
  }

  // -------------------------------------------------------------------------
  // Fallback promise + result (unique assignment per §PR-04 item 10)
  // -------------------------------------------------------------------------

  /**
   * Set the fallback promise for a task. Idempotent: the FIRST promise wins,
   * subsequent calls return the same promise without overwriting state.
   */
  setFallbackPromise(input: SetFallbackPromiseInput): Promise<FallbackResult> {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      // The caller may speculatively set a promise for a task that was
      // never registered (e.g. PR-05's pre-tool hook). Returning the
      // promise as-is is the safe no-op behaviour — never throw.
      return input.promise;
    }
    if (task.fallbackPromise !== undefined) {
      return task.fallbackPromise;
    }
    task.fallbackPromise = input.promise;
    const now = this.nowFn();
    task.updatedAt = now;
    if (task.state === "failure-claimed") {
      transitionTask(task, "fallback-running", now);
    }
    return input.promise;
  }

  /**
   * Record the terminal result of the fallback promise. Transitions the
   * task to `fallback-ready` (success), `fallback-exhausted` (exhausted),
   * or `cancelled` (cancelled).
   */
  recordFallbackResult(input: RecordFallbackResultInput): TrackedTask {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      if (this.completedTombstones.has(input.callID)) {
        this.logInvalidTransition(input.callID, `recordFallbackResult on tombstoned callID`);
      } else {
        this.logInvalidTransition(input.callID, `recordFallbackResult on unknown callID`);
      }
      // Caller is allowed to proceed; we just return a stand-in. PR-04b
      // will wire callers that cannot tolerate a missing task.
      return unknownTaskShell(input.callID);
    }
    if (task.state !== "fallback-running") {
      this.logInvalidTransition(task.callID, `recordFallbackResult in state=${task.state}`);
      return task;
    }
    const now = input.now ?? this.nowFn();
    task.fallbackResult = input.result;
    task.updatedAt = now;
    if (input.result.status === "success") {
      transitionTask(task, "fallback-ready", now);
    } else if (input.result.status === "exhausted") {
      transitionTask(task, "fallback-exhausted", now);
    } else {
      // cancelled
      transitionTask(task, "cancelled", now);
      task.userCancelled = input.result.reason === "user_cancelled";
    }
    return task;
  }

  // -------------------------------------------------------------------------
  // Original outcome
  // -------------------------------------------------------------------------

  /**
   * Report a successful original result for a task. Transitions the task
   * from `running-original` (or `failure-claimed` in a race reversal) to
   * `completed-original`.
   */
  reportOriginalResult(input: ReportOriginalResultInput): TrackedTask {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      if (this.completedTombstones.has(input.callID)) {
        this.logInvalidTransition(input.callID, `reportOriginalResult on tombstoned callID`);
      } else {
        this.logInvalidTransition(input.callID, `reportOriginalResult on unknown callID`);
      }
      return unknownTaskShell(input.callID);
    }
    // INV-008: an authoritative failure has already been claimed. A late
    // successful original cannot cancel the fallback.
    if (task.failureAuthoritative) {
      this.logInvalidTransition(task.callID, `reportOriginalResult ignored: authoritative failure already claimed`);
      return task;
    }
    // §6.3: reportOriginalResult is ONLY legal from running-original.
    // `registered` / `awaiting-child` / `failure-claimed` / terminal states
    // all reject and log as invalid_transition.
    if (task.state !== "running-original") {
      this.logInvalidTransition(task.callID, `reportOriginalResult on task in state=${task.state}`);
      return task;
    }
    const now = input.now ?? this.nowFn();
    transitionTask(task, "completed-original", now);
    return task;
  }

  // -------------------------------------------------------------------------
  // Cancellation (human + parent)
  // -------------------------------------------------------------------------

  /**
   * Cancel every active task belonging to a parent session.
   * Returns the list of tasks that were actually transitioned.
   */
  cancelParent(input: CancelParentInput): TrackedTask[] {
    this.assertAlive();
    const callIDs = this.tasksByParentSessionID.get(input.parentSessionID) ?? [];
    const cancelled: TrackedTask[] = [];
    const now = input.now ?? this.nowFn();
    for (const callID of callIDs) {
      const task = this.tasksByCallID.get(callID);
      if (task === undefined) continue;
      if (!ACTIVE_TASK_STATES.has(task.state)) continue;
      transitionTask(task, "cancelled", now);
      task.userCancelled = input.reason === "user_cancelled";
      cancelled.push(task);
    }
    return cancelled;
  }

  /** Cancel one task for a human/external abort without touching sibling work. */
  cancelTask(input: { callID: string; reason: "user_cancelled" | "parent_cancelled"; now?: number }): TrackedTask | undefined {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined || !ACTIVE_TASK_STATES.has(task.state)) return task;
    transitionTask(task, "cancelled", input.now ?? this.nowFn());
    task.userCancelled = input.reason === "user_cancelled";
    return task;
  }

  // -------------------------------------------------------------------------
  // Cleanup / tombstones
  // -------------------------------------------------------------------------

  /**
   * Move a task to `cleaned`, remove it from active indices, add it to
   * `completedTombstones`, and schedule its eviction after the tombstone TTL.
   *
   * Design §PR-04 items 11 + 12: cleanup is deferred (5 minutes) and the
   * tombstone cap is `MAX_TOMBSTONES` with FIFO eviction.
   */
  finalize(input: FinalizeInput): void {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task !== undefined) {
      // Only terminal states can be cleaned (defensive — finalize can be
      // called before a transition only by the trusted after-hook path).
      if (task.state !== "cleaned") {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          this.logInvalidTransition(task.callID, `finalize from non-terminal state=${task.state}`);
        }
        transitionTask(task, "cleaned", input.now ?? this.nowFn());
      }
      this.tasksByCallID.delete(input.callID);
    }
    // Even when the task was already evicted, a tombstone entry must
    // record the cleanup time so late events for that callID are dropped.
    if (!this.completedTombstones.has(input.callID)) {
      this.evictOldestTombstoneIfFull();
      this.completedTombstones.set(input.callID, input.now ?? this.nowFn());
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.completedTombstones.delete(input.callID);
      }, this.tombstoneTtlMs);
      timer.unref?.();
      this.timers.add(timer);
    }
  }

  // -------------------------------------------------------------------------
  // PR-05 §14: task-level child-session association
  // -------------------------------------------------------------------------

  /**
   * Associate a child `sessionID` with a tracked task (design §14.4).
   * Records the `sessionID → callID` mapping and promotes the task
   * through `registered → awaiting-child → running-original` (§6.3) so
   * the state machine reflects that the child session is live. Terminal
   * tasks are never resurrected. Returns the task (or `undefined` when
   * the callID is unknown).
   *
   * The original attempt is NOT registered by the before hook (PR-04b),
   * so binding lives at the task level here — `bindSession` (which needs
   * a `ModelAttempt`) is reserved for the watchdog wiring that lands in
   * PR-06.
   */
  bindTaskSession(input: { callID: string; sessionID: string; now?: number }): TrackedTask | undefined {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      this.logInvalidTransition(input.callID, `bindTaskSession on unknown callID`);
      return undefined;
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      this.logInvalidTransition(task.callID, `bindTaskSession on terminal task (state=${task.state})`);
      return task;
    }
    const now = input.now ?? this.nowFn();
    this.callIDBySessionID.set(input.sessionID, input.callID);
    if (task.state === "registered") {
      transitionTask(task, "awaiting-child", now);
    }
    if (task.state === "awaiting-child") {
      transitionTask(task, "running-original", now);
    }
    return task;
  }

  /** Resolve the tracked task bound to a child `sessionID` (or undefined). */
  taskForSession(sessionID: string): TrackedTask | undefined {
    const callID = this.callIDBySessionID.get(sessionID);
    if (callID === undefined) return undefined;
    return this.tasksByCallID.get(callID);
  }

  // -------------------------------------------------------------------------
  // Amendment C-05: failure-claimed → fallback-exhausted
  // -------------------------------------------------------------------------

  /**
   * Transition a `failure-claimed` task to `fallback-exhausted`. This is
   * the amendment C-05 escape hatch for the case where NO candidate is
   * available (all quarantined, no provider diversity, no client).
   * §18 still emits the terminal output (zero-or-more attempts listed +
   * exhaustion reason) — see §18 in the design.
   */
  markFallbackExhausted(input: MarkFallbackExhaustedInput): TrackedTask {
    this.assertAlive();
    const task = this.tasksByCallID.get(input.callID);
    if (task === undefined) {
      this.logInvalidTransition(input.callID, `markFallbackExhausted on unknown callID`);
      return unknownTaskShell(input.callID);
    }
    if (task.state !== "failure-claimed") {
      this.logInvalidTransition(task.callID, `markFallbackExhausted in state=${task.state}`);
      return task;
    }
    transitionTask(task, "fallback-exhausted", input.now ?? this.nowFn());
    return task;
  }

  // -------------------------------------------------------------------------
  // Internal session ownership (design §INV-012 + §16.1)
  // -------------------------------------------------------------------------

  /** True iff the sessionID is registered as internal AND not yet tombstoned-expired. */
  isInternalSession(sessionID: string): boolean {
    if (this.internalSessionIDs.has(sessionID)) return true;
    const tombstonedAt = this.internalSessionTombstones.get(sessionID);
    if (tombstonedAt === undefined) return false;
    // Tombstone window — still considered internal so a late event is
    // recognised as fallback-owned and short-circuited by the before hook.
    return true;
  }

  /** Register a session as created by the fallback engine (before `session.prompt`). */
  markInternalSession(sessionID: string, callID?: string): void {
    this.assertAlive();
    this.internalSessionIDs.add(sessionID);
    if (callID !== undefined) this.internalSessionCallIDs.set(sessionID, callID);
  }

  /**
   * Move a session out of the active internal set into the tombstone set
   * with a deferred eviction after `INTERNAL_SESSION_TOMBSTONE_MS`.
   */
  unmarkInternalSession(sessionID: string, now?: number): void {
    this.assertAlive();
    this.internalSessionIDs.delete(sessionID);
    this.internalSessionCallIDs.delete(sessionID);
    if (!this.internalSessionTombstones.has(sessionID)) {
      this.internalSessionTombstones.set(sessionID, now ?? this.nowFn());
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.internalSessionTombstones.delete(sessionID);
      }, this.internalSessionTombstoneMs);
      timer.unref?.();
      this.timers.add(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Plugin abort registry (design §16.1)
  // -------------------------------------------------------------------------

  /**
   * Register an abort that the plugin is about to issue against a session.
   * The record is stored BEFORE the abort call so a late event for the
   * same session can recognise it as plugin-issued and skip its handler.
   */
  registerPluginAbort(input: RegisterPluginAbortInput): PluginAbortRecord {
    this.assertAlive();
    const record: PluginAbortRecord = {
      sessionID: input.sessionID,
      callID: input.callID,
      attemptID: input.attemptID,
      origin: input.origin,
      reason: input.reason,
      requestedAt: input.requestedAt ?? this.nowFn(),
    };
    this.pluginAbortSessionIDs.set(input.sessionID, record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  /**
   * Release every timer and clear every index. Called at plugin shutdown
   * so the process can exit without timers holding the loop open.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.tasksByCallID.clear();
    this.attemptsByID.clear();
    this.attemptsBySessionID.clear();
    this.callIDBySessionID.clear();
    this.pendingOriginalByParentID.clear();
    this.tasksByParentSessionID.clear();
    this.pluginAbortSessionIDs.clear();
    this.internalSessionIDs.clear();
    this.internalSessionCallIDs.clear();
    this.completedTombstones.clear();
    this.internalSessionTombstones.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("[model-forecast] AttemptCoordinator: cannot use coordinator after dispose()");
    }
  }

  private evictOldestTombstoneIfFull(): void {
    if (this.completedTombstones.size < this.maxTombstones) return;
    // FIFO eviction — Map iteration order is insertion order.
    const oldest = this.completedTombstones.keys().next();
    if (oldest.done) return;
    this.completedTombstones.delete(oldest.value);
  }

  /**
   * Amendment C-07: invalid transitions are logged via the existing
   * logger instead of a future `RecoveryAuditEntry`. Best-effort: a
   * logger throw never breaks the state machine.
   */
  private logInvalidTransition(callID: string, message: string): void {
    try {
      this.logger.warn("AttemptCoordinator", `invalid_transition: ${message} (callID=${callID})`);
    } catch {
      // Best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function transitionTask(task: TrackedTask, next: TaskRecoveryState, now: number): void {
  task.state = next;
  task.updatedAt = now;
}

function transitionAttempt(attempt: ModelAttempt, next: ModelAttemptState): void {
  attempt.state = next;
}

function isAttemptTerminal(state: ModelAttemptState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "cleaned";
}

function unknownTaskShell(callID: string): TrackedTask {
  // Stand-in returned when a method is called for a tombstoned or
  // never-registered callID. The caller MAY inspect it; mutating it has
  // no effect on coordinator state.
  return {
    callID,
    parentSessionID: "",
    originalSubagentType: "",
    generatedAlias: "",
    originalModel: "",
    prompt: "",
    state: "cleaned",
    createdAt: 0,
    updatedAt: 0,
    originalAttemptID: "",
    failureAuthoritative: false,
    afterHookSeen: false,
    userCancelled: false,
    parentRecoveryEnqueued: false,
    recoveryToken: "",
  };
}

function noopLogger(): Logger {
  // Minimal stub matching the parts of Logger used here. Avoids pulling
  // the full Logger constructor (which needs project context) into a
  // self-contained PR-04a unit test path.
  return {
    trace: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}
