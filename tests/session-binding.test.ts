/**
 * supervised-model-fallback-recovery (SDD change) — PR-05.
 *
 * Session-binding tests: the coordinator's task-level session binding
 * (`bindTaskSession` / `taskForSession` / `callIDBySessionID`) and the
 * event hook's §14 child-session association (exact match, wrong
 * parent/alias/model, tie, children tie-break — design §14.1-14.5).
 *
 * Coordinator-only describes live here without importing the event hook
 * so the binding substrate can be exercised in isolation. Hook-driven
 * association describes are added once `createEventHook` exists.
 */

import { describe, expect, it, vi } from "vitest";

import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { createEventHook } from "../src/opencode-event-hook.js";
import type { Logger } from "../src/logger.js";

const NOW = 1_700_000_000_000;

function silentLogger(): Logger {
  return { trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

interface TaskSeed {
  callID: string;
  alias?: string;
  model?: string;
  createdAt?: number;
  parentSessionID?: string;
}

function seed(coordinator: AttemptCoordinator, task: TaskSeed): void {
  coordinator.registerTask({
    callID: task.callID,
    parentSessionID: task.parentSessionID ?? "parent-1",
    originalSubagentType: "sdd-design",
    generatedAlias: task.alias ?? `__mf_sdd-design__abc_${task.callID}`,
    originalModel: task.model ?? "openai/gpt-5.5",
    prompt: "do the thing",
    now: task.createdAt ?? NOW,
  });
}

interface CreatedInfoExtra {
  agent?: string;
  model?: { providerID: string; modelID: string };
  title?: string;
  createdAt?: number;
}

function createdEvent(childID: string, parentID: string, extra: CreatedInfoExtra = {}) {
  const info: Record<string, unknown> = { id: childID, parentID };
  if (extra.agent !== undefined) info.agent = extra.agent;
  if (extra.model !== undefined) info.model = extra.model;
  if (extra.title !== undefined) info.title = extra.title;
  if (extra.createdAt !== undefined) info.time = { created: extra.createdAt };
  return { event: { type: "session.created", properties: { info } } };
}

function register(coordinator: AttemptCoordinator, callID: string, parentSessionID = "parent-1"): void {
  coordinator.registerTask({
    callID,
    parentSessionID,
    originalSubagentType: "sdd-design",
    generatedAlias: `__mf_sdd-design__abc_${callID}`,
    originalModel: "openai/gpt-5.5",
    prompt: "do the thing",
  });
}

// ---------------------------------------------------------------------------
// coordinator.bindTaskSession / taskForSession
// ---------------------------------------------------------------------------

describe("AttemptCoordinator.bindTaskSession — task-level session binding", () => {
  it("records the sessionID→task mapping and promotes registered → running-original", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    register(coordinator, "c-1");
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("registered");

    const task = coordinator.bindTaskSession({ callID: "c-1", sessionID: "child-1" });

    expect(task?.callID).toBe("c-1");
    expect(task?.state).toBe("running-original");
    expect(coordinator.callIDBySessionID.get("child-1")).toBe("c-1");
    expect(coordinator.taskForSession("child-1")?.callID).toBe("c-1");
  });

  it("returns undefined and does not map when the callID is unknown", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const task = coordinator.bindTaskSession({ callID: "ghost", sessionID: "child-x" });
    expect(task).toBeUndefined();
    expect(coordinator.callIDBySessionID.has("child-x")).toBe(false);
    expect(coordinator.taskForSession("child-x")).toBeUndefined();
  });

  it("does not re-transition a task that is already terminal", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    register(coordinator, "c-2");
    coordinator.bindTaskSession({ callID: "c-2", sessionID: "child-2" });
    coordinator.cancelParent({ parentSessionID: "parent-1", reason: "user_cancelled" });
    expect(coordinator.tasksByCallID.get("c-2")?.state).toBe("cancelled");

    const task = coordinator.bindTaskSession({ callID: "c-2", sessionID: "child-2b" });
    // Still cancelled — binding a terminal task must not resurrect it.
    expect(task?.state).toBe("cancelled");
  });

  it("taskForSession returns undefined for an unmapped session", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    expect(coordinator.taskForSession("nope")).toBeUndefined();
  });

  it("clears the session mapping on dispose", () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    register(coordinator, "c-3");
    coordinator.bindTaskSession({ callID: "c-3", sessionID: "child-3" });
    coordinator.dispose();
    expect(coordinator.callIDBySessionID.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event-hook §14 association (session.created → bind)
// ---------------------------------------------------------------------------

describe("createEventHook — §14 session.created association", () => {
  function hookFor(coordinator: AttemptCoordinator, children?: (opts: unknown) => unknown) {
    const client = children !== undefined ? { session: { children } } : undefined;
    return createEventHook({ coordinator, logger: silentLogger(), now: () => NOW, ...(client !== undefined ? { client } : {}) });
  }

  it("associates the exact single candidate under the parent", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1" });
    const hook = hookFor(coordinator);

    await hook(createdEvent("child-1", "parent-1", { createdAt: NOW }));

    expect(coordinator.taskForSession("child-1")?.callID).toBe("c-1");
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("running-original");
  });

  it("does NOT associate when the parent does not match any tracked task (parent incorrecto)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", parentSessionID: "parent-1" });
    const hook = hookFor(coordinator);

    await hook(createdEvent("child-1", "parent-OTHER", { createdAt: NOW }));

    expect(coordinator.taskForSession("child-1")).toBeUndefined();
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("registered");
  });

  it("routes by model when the event agent matches no candidate alias (alias incorrecto)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", alias: "__mf_a__1", model: "openai/gpt-5.5" });
    seed(coordinator, { callID: "c-2", alias: "__mf_b__2", model: "google/gemini-2.5-pro" });
    const hook = hookFor(coordinator);

    // agent matches neither; model matches only c-1.
    await hook(createdEvent("child-1", "parent-1", { agent: "__mf_unknown__x", model: { providerID: "openai", modelID: "gpt-5.5" }, createdAt: NOW }));

    expect(coordinator.taskForSession("child-1")?.callID).toBe("c-1");
  });

  it("routes by alias when the event model matches no candidate (modelo incorrecto)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", alias: "__mf_a__1", model: "openai/gpt-5.5" });
    seed(coordinator, { callID: "c-2", alias: "__mf_b__2", model: "google/gemini-2.5-pro" });
    const hook = hookFor(coordinator);

    // model matches neither; agent matches only c-1's alias.
    await hook(createdEvent("child-1", "parent-1", { agent: "__mf_a__1", model: { providerID: "xai", modelID: "grok-9" }, createdAt: NOW }));

    expect(coordinator.taskForSession("child-1")?.callID).toBe("c-1");
  });

  it("does NOT associate on a tie between two equally-scoring candidates (empate)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", model: "openai/gpt-5.5" });
    seed(coordinator, { callID: "c-2", model: "openai/gpt-5.5" });
    const hook = hookFor(coordinator);

    // Only parent + time signals → both score 110.
    await hook(createdEvent("child-1", "parent-1", { createdAt: NOW }));

    expect(coordinator.taskForSession("child-1")).toBeUndefined();
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("registered");
    expect(coordinator.tasksByCallID.get("c-2")?.state).toBe("registered");
  });

  it("breaks a tie using session.children when a child title carries the callID (children resuelve empate)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", model: "openai/gpt-5.5" });
    seed(coordinator, { callID: "c-2", model: "openai/gpt-5.5" });
    const children = vi.fn(async () => [{ id: "child-1", title: "work for c-1 in progress" }]);
    const hook = hookFor(coordinator, children);

    await hook(createdEvent("child-1", "parent-1", { createdAt: NOW }));

    expect(children).toHaveBeenCalledTimes(1);
    expect(coordinator.taskForSession("child-1")?.callID).toBe("c-1");
  });

  it("leaves the tie unresolved when session.children cannot disambiguate (children no resuelve empate)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    seed(coordinator, { callID: "c-1", model: "openai/gpt-5.5" });
    seed(coordinator, { callID: "c-2", model: "openai/gpt-5.5" });
    const children = vi.fn(async () => [{ id: "child-1", title: "generic subagent work" }]);
    const hook = hookFor(coordinator, children);

    await hook(createdEvent("child-1", "parent-1", { createdAt: NOW }));

    expect(children).toHaveBeenCalledTimes(1);
    expect(coordinator.taskForSession("child-1")).toBeUndefined();
  });
});
