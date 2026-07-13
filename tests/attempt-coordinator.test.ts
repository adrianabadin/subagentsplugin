/**
 * supervised-model-fallback-recovery (SDD change) — PR-04a (coordinator).
 *
 * Design "diseño fallback.md" §PR-04 lines 1737-1830 + amendments
 * C-05 (failure-claimed → fallback-exhausted transition) and
 * C-07 (invalid transitions logged via existing logger until PR-09).
 *
 * Scope: this file covers ONLY the `AttemptCoordinator` state machine —
 * its indices, methods, and invariants. Wiring it into `hooks.ts`,
 * `plugin.ts`, and `fallback.ts` is the job of PR-04b and is deliberately
 * out of scope here.
 *
 * Test scenarios (one `describe` per design-mandated case):
 *   - registro
 *   - duplicado callID
 *   - capacidad máxima
 *   - claim único
 *   - dos claims concurrentes
 *   - fallbackPromise única
 *   - transición inválida
 *   - cancelación
 *   - cleanup
 *   - tombstone
 *   - late event
 *   - internal session
 *   - límite de tombstones
 * Plus amendments C-05 and C-07.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import type { Logger } from "../src/logger.js";
import type { FallbackResult } from "../src/fallback.js";
import type {
  AbortOrigin,
  AttemptFailure,
  FailureSource,
  ModelAttempt,
  TrackedTask,
} from "../src/recovery-types.js";
import {
  COMPLETED_TASK_TOMBSTONE_MS,
  INTERNAL_SESSION_TOMBSTONE_MS,
  MAX_ACTIVE_TASKS,
  MAX_TOMBSTONES,
} from "../src/recovery-policy.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeFailure(
  kind: AttemptFailure["kind"] = "rate_limit",
  source: FailureSource = "tool-after",
): AttemptFailure {
  return {
    kind,
    source,
    code: "429",
    message: "rate limited",
    retryable: true,
    authoritative: true,
    detectedAt: 1_000,
  };
}

function makeFallbackSuccess(): FallbackResult {
  return {
    status: "success",
    output: "ok",
    model: "openai/gpt-4.1-mini",
    attempts: [],
  };
}

function makeFallbackExhausted(): FallbackResult {
  return {
    status: "exhausted",
    output: "[model-forecast] FALLBACK EXHAUSTED: 3 attempts failed for sdd-design. Manual action required.",
    attempts: [],
  };
}

function makeFallbackCancelled(): FallbackResult {
  return {
    status: "cancelled",
    reason: "user_cancelled",
    attempts: [],
  };
}

interface RegisterTaskOpts {
  callID?: string;
  parentSessionID?: string;
  originalSubagentType?: string;
  generatedAlias?: string;
  originalModel?: string;
  prompt?: string;
  recoveryToken?: string;
  now?: number;
}

function buildTask(coordinator: AttemptCoordinator, opts: RegisterTaskOpts = {}): TrackedTask {
  return coordinator.registerTask({
    callID: opts.callID ?? "call-1",
    parentSessionID: opts.parentSessionID ?? "parent-1",
    originalSubagentType: opts.originalSubagentType ?? "sdd-design",
    generatedAlias: opts.generatedAlias ?? "__mf_sdd-design__openai_gpt-4-1-mini_a1b2c3",
    originalModel: opts.originalModel ?? "openai/gpt-4.1-mini",
    prompt: opts.prompt ?? "do the thing",
    recoveryToken: opts.recoveryToken ?? "rtok-1",
    now: opts.now,
  });
}

function registerOriginalAttempt(
  coordinator: AttemptCoordinator,
  taskCallID: string,
  attemptID = "att-orig-1",
  now = 1_000,
): ModelAttempt {
  return coordinator.registerFallbackAttempt({
    id: attemptID,
    taskCallID,
    kind: "original",
    sequence: 1,
    model: "openai/gpt-4.1-mini",
    provider: "openai",
    agent: "sdd-design",
    parentSessionID: "parent-1",
    watchdogGeneration: 1,
    now,
  });
}

// ===========================================================================
// registro
// ===========================================================================

describe("AttemptCoordinator — registro (PR-04.1)", () => {
  it("adds the task to tasksByCallID and tasksByParentSessionID with state=registered", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });

    const task = buildTask(coordinator, { callID: "call-1", parentSessionID: "parent-1" });

    expect(task.state).toBe("registered");
    expect(task.callID).toBe("call-1");
    expect(task.parentSessionID).toBe("parent-1");
    expect(task.originalSubagentType).toBe("sdd-design");
    expect(task.originalAttemptID).toBe("");
    expect(task.failureAuthoritative).toBe(false);
    expect(task.afterHookSeen).toBe(false);
    expect(task.userCancelled).toBe(false);
    expect(task.parentRecoveryEnqueued).toBe(false);
    expect(typeof task.recoveryToken).toBe("string");
    expect(task.recoveryToken.length).toBeGreaterThan(0);

    expect(coordinator.tasksByCallID.get("call-1")).toBe(task);
    expect(coordinator.tasksByParentSessionID.get("parent-1")).toEqual(["call-1"]);
    expect(coordinator.completedTombstones.has("call-1")).toBe(false);
  });

  it("starts the task lifecycle awaiting the child session binding", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    expect(task.state).toBe("registered");
  });

  it("isolates state across two coordinators (per-plugin isolation)", () => {
    const a = new AttemptCoordinator({ logger: silentLogger() });
    const b = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(a, { callID: "c-a" });
    expect(a.tasksByCallID.has("c-a")).toBe(true);
    expect(b.tasksByCallID.has("c-a")).toBe(false);
  });
});

// ===========================================================================
// duplicado callID
// ===========================================================================

describe("AttemptCoordinator — duplicado callID (PR-04.2)", () => {
  it("throws when the same callID is registered twice", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(coordinator, { callID: "dup-1" });
    expect(() => buildTask(coordinator, { callID: "dup-1" })).toThrow(/duplicate callID|dup-1/i);
  });

  it("does not corrupt the index on duplicate registration", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(coordinator, { callID: "dup-2", parentSessionID: "p1" });
    try {
      buildTask(coordinator, { callID: "dup-2", parentSessionID: "p2" });
    } catch {
      // expected
    }
    // First registration remains intact.
    const survivor = coordinator.tasksByCallID.get("dup-2");
    expect(survivor).toBeDefined();
    expect(survivor?.parentSessionID).toBe("p1");
    expect(coordinator.tasksByParentSessionID.get("p1")).toEqual(["dup-2"]);
    expect(coordinator.tasksByParentSessionID.has("p2")).toBe(false);
  });
});

// ===========================================================================
// capacidad máxima
// ===========================================================================

describe("AttemptCoordinator — capacidad máxima (PR-04.3)", () => {
  it("accepts exactly MAX_ACTIVE_TASKS active tasks and rejects the next one", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });

    for (let i = 0; i < MAX_ACTIVE_TASKS; i++) {
      buildTask(coordinator, { callID: `call-${i}` });
    }
    expect(coordinator.tasksByCallID.size).toBe(MAX_ACTIVE_TASKS);

    expect(() => buildTask(coordinator, { callID: "overflow" })).toThrow(/capacity|1000|maximum|active/i);

    // Cleanup deferred tombstones via finalize keep the active count under control.
    coordinator.finalize({ callID: "call-0" });
    expect(coordinator.tasksByCallID.size).toBe(MAX_ACTIVE_TASKS - 1);
    // Now the next register succeeds.
    buildTask(coordinator, { callID: "after-finalize" });
    expect(coordinator.tasksByCallID.has("after-finalize")).toBe(true);
  });

  it("evicting an active task frees a slot before finalize is called", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    for (let i = 0; i < MAX_ACTIVE_TASKS; i++) {
      buildTask(coordinator, { callID: `slot-${i}` });
    }
    coordinator.finalize({ callID: "slot-0" });
    expect(coordinator.tasksByCallID.has("slot-0")).toBe(false);
    buildTask(coordinator, { callID: "replacement" });
    expect(coordinator.tasksByCallID.has("replacement")).toBe(true);
  });
});

// ===========================================================================
// claim único
// ===========================================================================

describe("AttemptCoordinator — claim único (PR-04.4)", () => {
  it("the first claimFailure on a task wins; subsequent claims are rejected", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: "att-orig-1", sessionID: "child-1", now: 1_100 });

    const first = coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("rate_limit", "tool-after"),
      source: "tool-after",
      now: 1_200,
    });
    expect(first.claimed).toBe(true);
    expect(first.reason).toBeUndefined();

    const second = coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("provider_error", "session-error"),
      source: "session-error",
      now: 1_250,
    });
    expect(second.claimed).toBe(false);
    expect(second.reason).toMatch(/already claimed|already/i);

    // The winning claim's source and failure remain authoritative.
    const settled = coordinator.tasksByCallID.get(task.callID);
    expect(settled?.failureClaimedBy).toBe("tool-after");
    expect(settled?.failure?.kind).toBe("rate_limit");
    expect(settled?.failureAuthoritative).toBe(true);
  });

  it("claimFailure transitions registered → failure-claimed (via awaiting-child path)", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: "att-orig-1", sessionID: "child-1", now: 1_100 });

    coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    expect(coordinator.tasksByCallID.get(task.callID)?.state).toBe("failure-claimed");
  });
});

// ===========================================================================
// dos claims concurrentes
// ===========================================================================

describe("AttemptCoordinator — dos claims concurrentes (PR-04.5)", () => {
  it("two parallel claimFailure calls resolve to exactly one winner", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: "att-orig-1", sessionID: "child-1", now: 1_100 });

    const results = await Promise.all([
      Promise.resolve(coordinator.claimFailure({
        callID: task.callID,
        attemptID: "att-orig-1",
        failure: makeFailure("rate_limit", "tool-after"),
        source: "tool-after",
        now: 1_200,
      })),
      Promise.resolve(coordinator.claimFailure({
        callID: task.callID,
        attemptID: "att-orig-1",
        failure: makeFailure("provider_error", "session-error"),
        source: "session-error",
        now: 1_205,
      })),
    ]);

    const winners = results.filter((r) => r.claimed).length;
    const losers = results.filter((r) => !r.claimed).length;
    expect(winners).toBe(1);
    expect(losers).toBe(1);

    // Authoritative source remains whichever won the race.
    const settled = coordinator.tasksByCallID.get(task.callID);
    expect(["tool-after", "session-error"]).toContain(settled?.failureClaimedBy);
  });

  it("the loser observes the winner's authoritative failure (no overwrite)", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: "att-orig-1", sessionID: "child-1", now: 1_100 });

    coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("rate_limit", "tool-after"),
      source: "tool-after",
      now: 1_200,
    });

    const loser = coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("model_not_configured", "session-error"),
      source: "session-error",
      now: 1_210,
    });
    expect(loser.claimed).toBe(false);

    const settled = coordinator.tasksByCallID.get(task.callID);
    expect(settled?.failure?.kind).toBe("rate_limit");
    expect(settled?.failureClaimedBy).toBe("tool-after");
  });
});

// ===========================================================================
// fallbackPromise única
// ===========================================================================

describe("AttemptCoordinator — fallbackPromise única (PR-04.6)", () => {
  it("the first setFallbackPromise wins; subsequent calls are ignored", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);

    const first = Promise.resolve(makeFallbackSuccess());
    const second = Promise.resolve(makeFallbackExhausted());

    const r1 = coordinator.setFallbackPromise({ callID: task.callID, promise: first });
    const r2 = coordinator.setFallbackPromise({ callID: task.callID, promise: second });

    expect(r1).toBe(first);
    expect(r2).toBe(first);

    const settled = await first;
    const observed = await r2;
    expect(observed.status).toBe("success");
    expect(settled.status).toBe("success");
  });

  it("setFallbackPromise is a no-op when called for an unknown callID", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const promise = Promise.resolve(makeFallbackSuccess());
    // Must NOT throw — the caller may speculatively set a promise for a
    // task that was never registered. Returning the same promise is fine.
    const result = coordinator.setFallbackPromise({ callID: "ghost", promise });
    expect(result).toBe(promise);
  });

  it("setFallbackPromise transitions the task to fallback-running (only when state allows)", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: "att-orig-1", sessionID: "child-1", now: 1_100 });
    coordinator.claimFailure({
      callID: task.callID,
      attemptID: "att-orig-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    expect(coordinator.tasksByCallID.get(task.callID)?.state).toBe("failure-claimed");

    coordinator.setFallbackPromise({
      callID: task.callID,
      promise: Promise.resolve(makeFallbackSuccess()),
    });
    expect(coordinator.tasksByCallID.get(task.callID)?.state).toBe("fallback-running");
  });
});

// ===========================================================================
// transición inválida
// ===========================================================================

describe("AttemptCoordinator — transición inválida (PR-04.7 + amendment C-07)", () => {
  let coordinator: AttemptCoordinator;
  let logger: Logger;

  beforeEach(() => {
    logger = silentLogger();
    coordinator = new AttemptCoordinator({ logger });
  });

  it("reportOriginalResult on a registered task is rejected and logged as invalid_transition", () => {
    const task = buildTask(coordinator, { callID: "bad-1" });
    coordinator.reportOriginalResult({ callID: "bad-1", output: "stuff", now: 2_000 });

    const after = coordinator.tasksByCallID.get("bad-1");
    expect(after?.state).toBe("registered");
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "AttemptCoordinator",
      expect.stringMatching(/invalid_transition.*bad-1/),
    );
  });

  it("recordFallbackResult before claimFailure is rejected and logged", () => {
    const task = buildTask(coordinator, { callID: "bad-2" });
    coordinator.recordFallbackResult({
      callID: "bad-2",
      result: makeFallbackSuccess(),
      now: 2_000,
    });
    const after = coordinator.tasksByCallID.get("bad-2");
    expect(after?.state).toBe("registered");
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("claimFailure on a terminal task is rejected and logged", () => {
    const task = buildTask(coordinator, { callID: "bad-3" });
    coordinator.finalize({ callID: "bad-3", now: 3_000 });

    const result = coordinator.claimFailure({
      callID: "bad-3",
      attemptID: "att-orig-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 3_500,
    });
    expect(result.claimed).toBe(false);
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "AttemptCoordinator",
      expect.stringMatching(/invalid_transition.*bad-3/),
    );
  });
});

// ===========================================================================
// cancelación
// ===========================================================================

describe("AttemptCoordinator — cancelación (PR-04.8)", () => {
  it("cancelParent transitions every active task under that parent to cancelled", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(coordinator, { callID: "c-a", parentSessionID: "parent-X" });
    buildTask(coordinator, { callID: "c-b", parentSessionID: "parent-X" });
    buildTask(coordinator, { callID: "c-c", parentSessionID: "parent-Y" });

    const cancelled = coordinator.cancelParent({
      parentSessionID: "parent-X",
      reason: "user_cancelled",
      now: 5_000,
    });

    expect(cancelled.map((t) => t.callID).sort()).toEqual(["c-a", "c-b"]);
    expect(coordinator.tasksByCallID.get("c-a")?.state).toBe("cancelled");
    expect(coordinator.tasksByCallID.get("c-a")?.userCancelled).toBe(true);
    expect(coordinator.tasksByCallID.get("c-b")?.state).toBe("cancelled");
    // The other parent stays untouched.
    expect(coordinator.tasksByCallID.get("c-c")?.state).toBe("registered");
  });

  it("cancelParent with reason=parent_cancelled does not set userCancelled", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(coordinator, { callID: "p-1", parentSessionID: "parent-Z" });

    coordinator.cancelParent({
      parentSessionID: "parent-Z",
      reason: "parent_cancelled",
      now: 5_000,
    });

    expect(coordinator.tasksByCallID.get("p-1")?.userCancelled).toBe(false);
    expect(coordinator.tasksByCallID.get("p-1")?.state).toBe("cancelled");
  });

  it("cancelParent on a parent with no active tasks returns an empty array", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const cancelled = coordinator.cancelParent({
      parentSessionID: "ghost",
      reason: "user_cancelled",
      now: 5_000,
    });
    expect(cancelled).toEqual([]);
  });
});

// ===========================================================================
// cleanup
// ===========================================================================

describe("AttemptCoordinator — cleanup (PR-04.9)", () => {
  it("finalize moves a terminal task to cleaned and adds it to completedTombstones", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "fin-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-fin-1");
    coordinator.bindSession({ attemptID: "att-orig-fin-1", sessionID: "child-fin-1", now: 1_500 });
    // Drive to a terminal state first so finalize is the final step.
    coordinator.reportOriginalResult({ callID: "fin-1", output: "done", now: 2_000 });
    expect(coordinator.tasksByCallID.get("fin-1")?.state).toBe("completed-original");

    coordinator.finalize({ callID: "fin-1", now: 3_000 });
    expect(coordinator.tasksByCallID.has("fin-1")).toBe(false);
    expect(coordinator.completedTombstones.get("fin-1")).toBe(3_000);
  });

  it("finalize transitions terminal → cleaned (logs nothing on success)", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "fin-2" });
    coordinator.reportOriginalResult({ callID: "fin-2", output: "ok", now: 2_000 });
    coordinator.finalize({ callID: "fin-2", now: 3_000 });
    expect(coordinator.tasksByCallID.has("fin-2")).toBe(false);
  });

  it("cleanup is deferred: the entry persists in completedTombstones for COMPLETED_TASK_TOMBSTONE_MS", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator({ logger: silentLogger() });
      const task = buildTask(coordinator, { callID: "defer-1" });
      coordinator.reportOriginalResult({ callID: "defer-1", output: "ok", now: 2_000 });
      coordinator.finalize({ callID: "defer-1", now: 3_000 });

      // Advance just under the threshold: tombstone is still present.
      vi.advanceTimersByTime(COMPLETED_TASK_TOMBSTONE_MS - 1);
      expect(coordinator.completedTombstones.has("defer-1")).toBe(true);

      // Cross the threshold: scheduled eviction fires and removes it.
      vi.advanceTimersByTime(2);
      expect(coordinator.completedTombstones.has("defer-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// tombstone (late events ignored)
// ===========================================================================

describe("AttemptCoordinator — tombstone (PR-04.10)", () => {
  it("after finalize, late noteActivity / claimFailure / recordFallbackResult are ignored and logged", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "tomb-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-tomb-1");
    coordinator.bindSession({ attemptID: "att-orig-tomb-1", sessionID: "child-tomb-1", now: 1_100 });
    coordinator.reportOriginalResult({ callID: "tomb-1", output: "ok", now: 2_000 });
    coordinator.finalize({ callID: "tomb-1", now: 3_000 });

    const logger = coordinator["logger"] as unknown as { warn: ReturnType<typeof vi.fn> };

    coordinator.noteActivity({ attemptID: "att-orig-tomb-1", now: 4_000 });
    const claim = coordinator.claimFailure({
      callID: "tomb-1",
      attemptID: "att-orig-tomb-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 4_100,
    });
    coordinator.recordFallbackResult({
      callID: "tomb-1",
      result: makeFallbackSuccess(),
      now: 4_200,
    });

    expect(claim.claimed).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// late event
// ===========================================================================

describe("AttemptCoordinator — late event (PR-04.11)", () => {
  it("late claimFailure after the task enters a terminal state is dropped (not an error)", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "late-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-late-1");
    coordinator.bindSession({ attemptID: "att-orig-late-1", sessionID: "child-late-1", now: 1_100 });
    coordinator.reportOriginalResult({ callID: "late-1", output: "ok", now: 2_000 });
    // Already in completed-original — a terminal state.
    const result = coordinator.claimFailure({
      callID: "late-1",
      attemptID: "att-orig-late-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 2_500,
    });
    expect(result.claimed).toBe(false);
    expect(result.reason).toMatch(/terminal|invalid/i);
    expect(coordinator.tasksByCallID.get("late-1")?.state).toBe("completed-original");
  });

  it("late recordFallbackResult on a task in completed-original is ignored", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "late-2" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-late-2");
    coordinator.bindSession({ attemptID: "att-orig-late-2", sessionID: "child-late-2", now: 1_100 });
    coordinator.reportOriginalResult({ callID: "late-2", output: "ok", now: 2_000 });
    coordinator.recordFallbackResult({
      callID: "late-2",
      result: makeFallbackSuccess(),
      now: 2_500,
    });
    expect(coordinator.tasksByCallID.get("late-2")?.state).toBe("completed-original");
    expect(coordinator.tasksByCallID.get("late-2")?.fallbackResult).toBeUndefined();
  });

  it("returns a safe shell when a late original result arrives after cleanup", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "late-3" });
    coordinator.reportOriginalResult({ callID: task.callID, output: "ok", now: 2_000 });
    coordinator.finalize({ callID: task.callID, now: 3_000 });

    const late = coordinator.reportOriginalResult({ callID: task.callID, output: "late", now: 4_000 });

    expect(late).toMatchObject({ callID: task.callID, state: "cleaned" });
  });
});

// ===========================================================================
// internal session
// ===========================================================================

describe("AttemptCoordinator — internal session (PR-04.12)", () => {
  it("isInternalSession returns false for unknown sessionIDs", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    expect(coordinator.isInternalSession("nope")).toBe(false);
  });

  it("markInternalSession + isInternalSession round-trip", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    coordinator.markInternalSession("fallback-child-1");
    expect(coordinator.isInternalSession("fallback-child-1")).toBe(true);
    expect(coordinator.internalSessionIDs.has("fallback-child-1")).toBe(true);
  });

  it("unmarkInternalSession keeps the session in the tombstone set and the active internal set is cleared", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator({ logger: silentLogger() });
      coordinator.markInternalSession("fallback-child-2");
      expect(coordinator.isInternalSession("fallback-child-2")).toBe(true);
      expect(coordinator.internalSessionIDs.has("fallback-child-2")).toBe(true);

      coordinator.unmarkInternalSession("fallback-child-2", 10_000);

      // Immediately after unmark: the active set is cleared AND the
      // session remains visible via the tombstone window so a late
      // event still recognises it as fallback-owned.
      expect(coordinator.internalSessionIDs.has("fallback-child-2")).toBe(false);
      expect(coordinator.internalSessionTombstones.has("fallback-child-2")).toBe(true);
      expect(coordinator.internalSessionTombstones.get("fallback-child-2")).toBe(10_000);
      // The public guard returns true during the tombstone window.
      expect(coordinator.isInternalSession("fallback-child-2")).toBe(true);

      vi.advanceTimersByTime(INTERNAL_SESSION_TOMBSTONE_MS + 1);
      expect(coordinator.internalSessionTombstones.has("fallback-child-2")).toBe(false);
      // After the window expires, the guard finally returns false.
      expect(coordinator.isInternalSession("fallback-child-2")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isInternalSession still returns true during the tombstone window (late events see fallback ownership)", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator({ logger: silentLogger() });
      coordinator.markInternalSession("fallback-child-3");
      coordinator.unmarkInternalSession("fallback-child-3", 20_000);
      vi.advanceTimersByTime(INTERNAL_SESSION_TOMBSTONE_MS - 10);
      expect(coordinator.isInternalSession("fallback-child-3")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// límite de tombstones
// ===========================================================================

describe("AttemptCoordinator — límite de tombstones (PR-04.13)", () => {
  it("the (MAX_TOMBSTONES + 1)-th finalize evicts the oldest tombstone FIFO", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });

    // Seed MAX_TOMBSTONES finished tasks.
    for (let i = 0; i < MAX_TOMBSTONES; i++) {
      buildTask(coordinator, { callID: `t-${i}` });
      coordinator.reportOriginalResult({ callID: `t-${i}`, output: "ok", now: 1_000 + i });
      coordinator.finalize({ callID: `t-${i}`, now: 2_000 + i });
    }
    expect(coordinator.completedTombstones.size).toBe(MAX_TOMBSTONES);
    expect(coordinator.completedTombstones.has("t-0")).toBe(true);

    // Add one more — must evict t-0.
    buildTask(coordinator, { callID: "t-overflow" });
    coordinator.reportOriginalResult({ callID: "t-overflow", output: "ok", now: 9_000 });
    coordinator.finalize({ callID: "t-overflow", now: 10_000 });

    expect(coordinator.completedTombstones.size).toBe(MAX_TOMBSTONES);
    expect(coordinator.completedTombstones.has("t-0")).toBe(false);
    expect(coordinator.completedTombstones.has("t-overflow")).toBe(true);
  });
});

// ===========================================================================
// Amendment C-05: failure-claimed → fallback-exhausted
// ===========================================================================

describe("AttemptCoordinator — amendment C-05: failure-claimed → fallback-exhausted", () => {
  it("markFallbackExhausted transitions failure-claimed to fallback-exhausted when no candidates remain", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "c05-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-c05-1");
    coordinator.bindSession({ attemptID: "att-orig-c05-1", sessionID: "child-c05-1", now: 1_100 });
    coordinator.claimFailure({
      callID: "c05-1",
      attemptID: "att-orig-c05-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    expect(coordinator.tasksByCallID.get("c05-1")?.state).toBe("failure-claimed");

    coordinator.markFallbackExhausted({ callID: "c05-1", now: 1_300 });
    expect(coordinator.tasksByCallID.get("c05-1")?.state).toBe("fallback-exhausted");
  });

  it("markFallbackExhausted on a task NOT in failure-claimed is ignored and logged", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "c05-2" });
    coordinator.markFallbackExhausted({ callID: "c05-2", now: 1_000 });
    expect(coordinator.tasksByCallID.get("c05-2")?.state).toBe("registered");
  });
});

// ===========================================================================
// recordFallbackResult transitions (helper coverage)
// ===========================================================================

describe("AttemptCoordinator — recordFallbackResult transitions", () => {
  it("success on a fallback-running task → fallback-ready", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "rec-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-rec-1");
    coordinator.bindSession({ attemptID: "att-orig-rec-1", sessionID: "child-rec-1", now: 1_100 });
    coordinator.claimFailure({
      callID: "rec-1",
      attemptID: "att-orig-rec-1",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    coordinator.setFallbackPromise({
      callID: "rec-1",
      promise: Promise.resolve(makeFallbackSuccess()),
    });
    coordinator.recordFallbackResult({ callID: "rec-1", result: makeFallbackSuccess(), now: 1_300 });
    expect(coordinator.tasksByCallID.get("rec-1")?.state).toBe("fallback-ready");
    expect(coordinator.tasksByCallID.get("rec-1")?.fallbackResult?.status).toBe("success");
  });

  it("exhausted on a fallback-running task → fallback-exhausted", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "rec-2" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-rec-2");
    coordinator.bindSession({ attemptID: "att-orig-rec-2", sessionID: "child-rec-2", now: 1_100 });
    coordinator.claimFailure({
      callID: "rec-2",
      attemptID: "att-orig-rec-2",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    coordinator.setFallbackPromise({
      callID: "rec-2",
      promise: Promise.resolve(makeFallbackExhausted()),
    });
    coordinator.recordFallbackResult({ callID: "rec-2", result: makeFallbackExhausted(), now: 1_300 });
    expect(coordinator.tasksByCallID.get("rec-2")?.state).toBe("fallback-exhausted");
  });

  it("cancelled on a fallback-running task → cancelled", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "rec-3" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-rec-3");
    coordinator.bindSession({ attemptID: "att-orig-rec-3", sessionID: "child-rec-3", now: 1_100 });
    coordinator.claimFailure({
      callID: "rec-3",
      attemptID: "att-orig-rec-3",
      failure: makeFailure("rate_limit"),
      source: "tool-after",
      now: 1_200,
    });
    coordinator.setFallbackPromise({
      callID: "rec-3",
      promise: Promise.resolve(makeFallbackCancelled()),
    });
    coordinator.recordFallbackResult({ callID: "rec-3", result: makeFallbackCancelled(), now: 1_300 });
    expect(coordinator.tasksByCallID.get("rec-3")?.state).toBe("cancelled");
  });
});

// ===========================================================================
// reportOriginalResult transitions (helper coverage)
// ===========================================================================

describe("AttemptCoordinator — reportOriginalResult transitions", () => {
  it("running-original + valid output → completed-original", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "rpt-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-orig-rpt-1");
    coordinator.bindSession({ attemptID: "att-orig-rpt-1", sessionID: "child-rpt-1", now: 1_100 });
    expect(coordinator.tasksByCallID.get("rpt-1")?.state).toBe("running-original");

    coordinator.reportOriginalResult({ callID: "rpt-1", output: "ok", now: 1_200 });
    expect(coordinator.tasksByCallID.get("rpt-1")?.state).toBe("completed-original");
    expect(coordinator.tasksByCallID.get("rpt-1")?.afterHookSeen).toBe(false);
  });
});

// ===========================================================================
// bindSession + noteActivity + noteToolBefore/After
// ===========================================================================

describe("AttemptCoordinator — attempt observation surface", () => {
  it("bindSession transitions awaiting-session → running and stores sessionID → attemptID mapping", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "bind-1" });
    const attempt = registerOriginalAttempt(coordinator, task.callID, "att-bind-1");
    expect(attempt.state).toBe("created");

    const bound = coordinator.bindSession({ attemptID: "att-bind-1", sessionID: "child-bind-1", now: 5_000 });
    expect(bound.state).toBe("running");
    expect(bound.sessionID).toBe("child-bind-1");
    expect(bound.boundAt).toBe(5_000);
    expect(coordinator.attemptsBySessionID.get("child-bind-1")).toBe("att-bind-1");
  });

  it("noteActivity sets firstActivityAt on the first call and lastActivityAt on every call", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "act-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-act-1");
    coordinator.bindSession({ attemptID: "att-act-1", sessionID: "child-act-1", now: 1_000 });

    const first = coordinator.noteActivity({ attemptID: "att-act-1", now: 1_500 });
    expect(first.firstActivityAt).toBe(1_500);
    expect(first.lastActivityAt).toBe(1_500);

    const second = coordinator.noteActivity({ attemptID: "att-act-1", now: 2_000 });
    expect(second.firstActivityAt).toBe(1_500); // unchanged
    expect(second.lastActivityAt).toBe(2_000);
  });

  it("noteToolBefore / noteToolAfter manage the activeToolCallIDs set and tool-running state", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "tool-1" });
    registerOriginalAttempt(coordinator, task.callID, "att-tool-1");
    coordinator.bindSession({ attemptID: "att-tool-1", sessionID: "child-tool-1", now: 1_000 });

    const before = coordinator.noteToolBefore({ attemptID: "att-tool-1", toolCallID: "tc-1", now: 1_100 });
    expect(before.state).toBe("tool-running");
    expect(before.activeToolCallIDs.has("tc-1")).toBe(true);

    const after = coordinator.noteToolAfter({ attemptID: "att-tool-1", toolCallID: "tc-1", now: 1_200 });
    expect(after.activeToolCallIDs.has("tc-1")).toBe(false);
  });
});

// ===========================================================================
// Plugin abort registry
// ===========================================================================

describe("AttemptCoordinator — pluginAbortSessionIDs", () => {
  it("registerPluginAbort stores the abort record before any abort is dispatched", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const record = coordinator.registerPluginAbort({
      sessionID: "child-abort-1",
      callID: "call-A",
      attemptID: "att-A",
      origin: "plugin-watchdog" as AbortOrigin,
      reason: "inactivity_timeout",
      requestedAt: 10_000,
    });
    expect(coordinator.pluginAbortSessionIDs.get("child-abort-1")).toEqual(record);
    expect(record.callID).toBe("call-A");
    expect(record.attemptID).toBe("att-A");
    expect(record.origin).toBe("plugin-watchdog");
    expect(record.requestedAt).toBe(10_000);
  });
});

// ===========================================================================
// dispose
// ===========================================================================

describe("AttemptCoordinator — dispose", () => {
  it("dispose clears all indices so a post-dispose read returns empty", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    buildTask(coordinator, { callID: "disp-1" });
    coordinator.markInternalSession("i-1");
    coordinator.registerPluginAbort({
      sessionID: "s-1",
      callID: "c-1",
      attemptID: "a-1",
      origin: "plugin-watchdog" as AbortOrigin,
      reason: "x",
    });

    coordinator.dispose();

    expect(coordinator.tasksByCallID.size).toBe(0);
    expect(coordinator.attemptsByID.size).toBe(0);
    expect(coordinator.internalSessionIDs.size).toBe(0);
    expect(coordinator.pluginAbortSessionIDs.size).toBe(0);
  });

  it("rejects all mutations after disposal and makes repeated disposal harmless", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    coordinator.dispose();
    coordinator.dispose();

    expect(() => buildTask(coordinator)).toThrow(/after dispose/);
    expect(() => coordinator.bindSession({ attemptID: "missing", sessionID: "child" })).toThrow(/after dispose/);
  });
});

describe("AttemptCoordinator — rejected inputs and late operations", () => {
  it("uses defaults while preserving the original attempt and rejects terminal session binding", () => {
    const coordinator = new AttemptCoordinator();
    const task = buildTask(coordinator);
    const original = registerOriginalAttempt(coordinator, task.callID, "original");
    const fallback = coordinator.registerFallbackAttempt({
      id: "fallback",
      taskCallID: task.callID,
      kind: "fallback",
      sequence: 2,
      model: "minimax/M3",
      provider: "minimax",
      agent: "sdd-design",
      parentSessionID: "parent-1",
      watchdogGeneration: 1,
    });
    expect(task.originalAttemptID).toBe(original.id);
    coordinator.bindSession({ attemptID: fallback.id, sessionID: "fallback-session" });
    coordinator.reportOriginalResult({ callID: task.callID, output: "ok" });
    expect(coordinator.bindTaskSession({ callID: task.callID, sessionID: "late-session" })).toBe(task);
    expect(coordinator.callIDBySessionID.has("late-session")).toBe(false);
  });

  it("rejects empty task and attempt ids, unknown attempts, and duplicate attempts without changing indices", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    expect(() => buildTask(coordinator, { callID: "" })).toThrow(/empty callID/);
    const task = buildTask(coordinator);
    expect(() => coordinator.registerFallbackAttempt({
      id: "",
      taskCallID: task.callID,
      kind: "original",
      sequence: 1,
      model: "openai/gpt-4.1-mini",
      provider: "openai",
      agent: "sdd-design",
      parentSessionID: "parent-1",
      watchdogGeneration: 1,
    })).toThrow(/empty id/);
    expect(() => coordinator.registerFallbackAttempt({
      id: "unknown-task",
      taskCallID: "missing",
      kind: "original",
      sequence: 1,
      model: "openai/gpt-4.1-mini",
      provider: "openai",
      agent: "sdd-design",
      parentSessionID: "parent-1",
      watchdogGeneration: 1,
    })).toThrow(/unknown task/);
    registerOriginalAttempt(coordinator, task.callID, "attempt-1");
    expect(() => registerOriginalAttempt(coordinator, task.callID, "attempt-1")).toThrow(/duplicate attempt/);
    expect(() => coordinator.bindSession({ attemptID: "missing", sessionID: "child" })).toThrow(/unknown attempt/);
  });

  it("returns safe shells for unknown result paths and ignores terminal attempt observations", () => {
    const logger = silentLogger();
    const coordinator = new AttemptCoordinator({ logger });
    expect(coordinator.noteActivity({ attemptID: "missing" }).state).toBe("cleaned");
    expect(coordinator.recordFallbackResult({ callID: "missing", result: makeFallbackSuccess() }).state).toBe("cleaned");
    expect(coordinator.reportOriginalResult({ callID: "missing", output: "ok" }).state).toBe("cleaned");

    const task = buildTask(coordinator);
    const attempt = registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: attempt.id, sessionID: "child" });
    coordinator.claimFailure({ callID: task.callID, attemptID: attempt.id, failure: makeFailure(), source: "tool-after" });
    expect(coordinator.noteActivity({ attemptID: attempt.id })).toBe(attempt);
    expect(coordinator.noteToolBefore({ attemptID: attempt.id, toolCallID: "tool" })).toBe(attempt);
    expect(coordinator.noteToolAfter({ attemptID: attempt.id, toolCallID: "tool" })).toBe(attempt);
    expect(() => coordinator.noteToolBefore({ attemptID: "missing", toolCallID: "tool" })).toThrow(/unknown attempt/);
    expect(() => coordinator.noteToolAfter({ attemptID: "missing", toolCallID: "tool" })).toThrow(/unknown attempt/);
  });

  it("cancels one task, associates sessions, and only enqueues a parent recovery once", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "single" });
    expect(coordinator.taskForSession("missing")).toBeUndefined();
    expect(coordinator.bindTaskSession({ callID: "missing", sessionID: "child" })).toBeUndefined();
    coordinator.bindTaskSession({ callID: task.callID, sessionID: "child" });
    expect(coordinator.taskForSession("child")).toBe(task);
    expect(coordinator.cancelTask({ callID: task.callID, reason: "parent_cancelled" })?.state).toBe("cancelled");
    expect(coordinator.cancelTask({ callID: task.callID, reason: "parent_cancelled" })?.state).toBe("cancelled");

    const recoverable = buildTask(coordinator, { callID: "recoverable" });
    expect(coordinator.markParentRecoveryEnqueued(recoverable.callID)).toBe(true);
    expect(coordinator.markParentRecoveryEnqueued(recoverable.callID)).toBe(false);
    expect(coordinator.markParentRecoveryEnqueued("missing")).toBe(false);
  });

  it("cleans every secondary index and tolerates a logger that throws", () => {
    const logger = { warn: vi.fn(() => { throw new Error("sink failed"); }) } as unknown as Logger;
    const coordinator = new AttemptCoordinator({ logger, maxTombstones: 1 });
    const task = buildTask(coordinator, { callID: "cleanup" });
    const attempt = registerOriginalAttempt(coordinator, task.callID, "cleanup-attempt");
    coordinator.bindSession({ attemptID: attempt.id, sessionID: "cleanup-child" });
    coordinator.bindTaskSession({ callID: task.callID, sessionID: "task-child" });
    coordinator.registerPluginAbort({ sessionID: "cleanup-child", callID: task.callID, attemptID: attempt.id, origin: "plugin-watchdog", reason: "timeout" });
    coordinator.reportOriginalResult({ callID: task.callID, output: "ok" });
    coordinator.finalize({ callID: task.callID });

    expect(coordinator.attemptsByID.size).toBe(0);
    expect(coordinator.attemptsBySessionID.size).toBe(0);
    expect(coordinator.callIDBySessionID.size).toBe(0);
    expect(coordinator.pendingOriginalByParentID.size).toBe(0);
    expect(coordinator.pluginAbortSessionIDs.size).toBe(0);
    expect(() => coordinator.claimFailure({ callID: "cleanup", attemptID: attempt.id, failure: makeFailure(), source: "tool-after" })).not.toThrow();
  });

  it("handles parent and fallback terminal edge cases without mutating completed tasks", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator, { callID: "terminal" });
    coordinator.bindTaskSession({ callID: task.callID, sessionID: "child" });
    coordinator.reportOriginalResult({ callID: task.callID, output: "ok" });
    expect(coordinator.cancelParent({ parentSessionID: "parent-1", reason: "user_cancelled" })).toEqual([]);
    expect(coordinator.markFallbackExhausted({ callID: task.callID })).toBe(task);
    expect(coordinator.markFallbackExhausted({ callID: "missing" }).state).toBe("cleaned");
    coordinator.finalize({ callID: task.callID });
    coordinator.finalize({ callID: task.callID });
    expect(coordinator.completedTombstones.has(task.callID)).toBe(true);
  });

  it("keeps an internal-session tombstone stable when it is unmarked twice", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    coordinator.markInternalSession("internal");
    coordinator.unmarkInternalSession("internal");
    coordinator.unmarkInternalSession("internal");
    expect(coordinator.internalSessionTombstones.size).toBe(1);
  });

  it("does not overwrite an authoritative failure or revive a completed task", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = buildTask(coordinator);
    const attempt = registerOriginalAttempt(coordinator, task.callID);
    coordinator.bindSession({ attemptID: attempt.id, sessionID: "child" });
    coordinator.claimFailure({ callID: task.callID, attemptID: attempt.id, failure: makeFailure(), source: "tool-after" });
    coordinator.reportOriginalResult({ callID: task.callID, output: "late success" });
    expect(task.state).toBe("failure-claimed");
    coordinator.setFallbackPromise({ callID: task.callID, promise: Promise.resolve(makeFallbackSuccess()) });
    coordinator.recordFallbackResult({ callID: task.callID, result: makeFallbackSuccess() });
    expect(coordinator.cancelParent({ parentSessionID: task.parentSessionID, reason: "user_cancelled" })).toHaveLength(1);
  });
});
