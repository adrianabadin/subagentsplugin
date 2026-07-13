import { describe, expect, it } from "vitest";
import { decideOriginalResult, type OriginalResultDecision } from "../src/recovery-arbitration.js";
import type { TrackedTask } from "../src/recovery-types.js";

function task(overrides: Partial<TrackedTask> = {}): TrackedTask {
  return {
    callID: "call-1",
    parentSessionID: "parent-1",
    originalSubagentType: "sdd-design",
    generatedAlias: "__mf_sdd-design__openai_gpt-4-1_a1b2c3",
    originalModel: "openai/gpt-4.1",
    prompt: "work",
    state: "running-original",
    createdAt: 1,
    updatedAt: 1,
    originalAttemptID: "attempt-1",
    failureAuthoritative: false,
    afterHookSeen: false,
    userCancelled: false,
    parentRecoveryEnqueued: false,
    recoveryToken: "token",
    ...overrides,
  };
}

describe("recovery arbitration", () => {
  it("gives a human cancellation priority over every other outcome", () => {
    const decision = decideOriginalResult(task({ userCancelled: true, state: "cancelled" }), "late original output");
    expect(decision).toEqual<OriginalResultDecision>({ action: "preserve", reason: "human_cancelled" });
  });

  it("keeps an authoritative error ahead of a late original output", () => {
    const decision = decideOriginalResult(task({
      state: "fallback-running",
      failureAuthoritative: true,
    }), "late original output");
    expect(decision).toEqual<OriginalResultDecision>({ action: "await-fallback", reason: "authoritative_failure" });
  });

  it("uses a successful fallback ahead of a late original output", () => {
    const decision = decideOriginalResult(task({
      state: "fallback-ready",
      fallbackResult: { status: "success", output: "fallback", model: "minimax/M3", attempts: [] },
    }), "late original output");
    expect(decision).toEqual<OriginalResultDecision>({ action: "fallback", reason: "fallback_success" });
  });

  it("allows valid original output to reverse a provisional timeout before fallback succeeds", () => {
    const decision = decideOriginalResult(task({
      state: "fallback-running",
      failureAuthoritative: false,
      failure: {
        kind: "inactivity_timeout", source: "watchdog", code: "inactivity_timeout", message: "timeout",
        retryable: true, authoritative: false, detectedAt: 1,
      },
    }), "original completed");
    expect(decision).toEqual<OriginalResultDecision>({ action: "original", reason: "valid_original" });
  });

  it("does not accept an empty original output", () => {
    expect(decideOriginalResult(task(), "   ")).toEqual<OriginalResultDecision>({ action: "ignore", reason: "invalid_original" });
  });
});
