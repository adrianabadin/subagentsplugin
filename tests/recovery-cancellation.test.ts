import { describe, expect, it, vi } from "vitest";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { createEventHook } from "../src/opencode-event-hook.js";

function setup() {
  const coordinator = new AttemptCoordinator();
  coordinator.registerTask({
    callID: "call-1", parentSessionID: "parent-1", originalSubagentType: "sdd-design",
    generatedAlias: "__mf_sdd-design__openai_gpt-4-1_a1b2c3", originalModel: "openai/gpt-4.1", prompt: "work",
  });
  coordinator.bindTaskSession({ callID: "call-1", sessionID: "original-child" });
  const abort = vi.fn(async () => undefined);
  const startFallback = vi.fn(async () => ({ status: "exhausted" as const, output: "exhausted", attempts: [] }));
  const hook = createEventHook({ coordinator, client: { session: { abort } }, startFallback });
  return { coordinator, abort, startFallback, hook };
}

function aborted(sessionID: string) {
  return { event: { type: "session.error", properties: { sessionID, error: { name: "MessageAbortedError", data: { message: "cancelled" } } } } };
}

describe("recovery cancellation", () => {
  it("treats an unregistered child abort as human cancellation and never starts fallback", async () => {
    const { coordinator, hook, startFallback } = setup();
    await hook(aborted("original-child"));
    expect(coordinator.tasksByCallID.get("call-1")?.state).toBe("cancelled");
    expect(coordinator.tasksByCallID.get("call-1")?.userCancelled).toBe(true);
    expect(startFallback).not.toHaveBeenCalled();
  });

  it("ignores an abort previously registered by the plugin", async () => {
    const { coordinator, hook, startFallback } = setup();
    coordinator.registerPluginAbort({ sessionID: "original-child", callID: "call-1", attemptID: "attempt-1", origin: "plugin-watchdog", reason: "hard_timeout" });
    await hook(aborted("original-child"));
    expect(coordinator.tasksByCallID.get("call-1")?.state).toBe("running-original");
    expect(startFallback).not.toHaveBeenCalled();
  });

  it("cancels every task under a human-cancelled parent and aborts its active fallback sessions", async () => {
    const { coordinator, abort, hook } = setup();
    coordinator.markInternalSession("fallback-child", "call-1");
    await hook(aborted("parent-1"));
    expect(coordinator.tasksByCallID.get("call-1")?.state).toBe("cancelled");
    expect(abort).toHaveBeenCalledWith({ path: { id: "fallback-child" } });
  });

  it("does not start two fallback runs when event and after-style failure claims race", async () => {
    const { hook, startFallback } = setup();
    await Promise.all([
      hook({ event: { type: "session.status", properties: { sessionID: "original-child", status: { type: "retry", message: "HTTP 429" } } } }),
      hook({ event: { type: "session.error", properties: { sessionID: "original-child", error: { name: "APIError", data: { message: "HTTP 429", statusCode: 429 } } } } }),
    ]);
    expect(startFallback).toHaveBeenCalledTimes(1);
  });
});
