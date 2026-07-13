/**
 * supervised-model-fallback-recovery (SDD change) — PR-05.
 *
 * Event-hook behavior tests for `src/opencode-event-hook.ts`:
 * authoritative-failure detection from events BEFORE `tool.execute.after`
 * (merge gate), the P-02 ≤ 60s tolerance window, duplicate/late-event
 * suppression, internal-session re-entrancy, and best-effort exception
 * handling (design item 9).
 *
 * Design "diseño fallback.md" §PR-05 (lines 1834-1909), amended by
 * C-02 (permission.updated), C-03/P-02 (reset tolerance), R-02
 * (activity). No session aborts, no watchdogs.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { createEventHook } from "../src/opencode-event-hook.js";
import modelForecastPlugin from "../src/plugin.js";
import type { FallbackResult } from "../src/fallback.js";
import type { Logger } from "../src/logger.js";

const NOW = 1_700_000_000_000;

function silentLogger(): Logger {
  return { trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function setup(startFallback?: () => Promise<FallbackResult>) {
  const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
  coordinator.registerTask({
    callID: "c-1",
    parentSessionID: "parent-1",
    originalSubagentType: "sdd-design",
    generatedAlias: "__mf_sdd-design__abc_c-1",
    originalModel: "openai/gpt-5.5",
    prompt: "do the thing",
    now: NOW,
  });
  coordinator.bindTaskSession({ callID: "c-1", sessionID: "child-1", now: NOW });
  const startSpy = vi.fn(startFallback ?? (() => new Promise<FallbackResult>(() => {})));
  const hook = createEventHook({ coordinator, logger: silentLogger(), now: () => NOW, startFallback: startSpy });
  return { coordinator, hook, startSpy };
}

function retryEvent(sessionID: string, message: string, next?: number) {
  return {
    event: {
      type: "session.status",
      properties: { sessionID, status: { type: "retry", attempt: 1, message, ...(next !== undefined ? { next } : {}) } },
    },
  };
}

function sessionErrorEvent(sessionID: string, error: unknown) {
  return { event: { type: "session.error", properties: { sessionID, error } } };
}

// ---------------------------------------------------------------------------
// Merge gate: a 429 event creates fallbackPromise before tool.execute.after
// ---------------------------------------------------------------------------

describe("createEventHook — 429 status creates fallbackPromise early (merge gate)", () => {
  it("claims the failure and registers a fallbackPromise on a 429 retry status", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(retryEvent("child-1", "Request failed: HTTP 429 Too Many Requests"));

    const task = coordinator.tasksByCallID.get("c-1");
    expect(task?.fallbackPromise).toBeDefined();
    expect(task?.state).toBe("fallback-running");
    expect(task?.failure?.kind).toBe("rate_limit");
    expect(task?.failureAuthoritative).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("records the fallback result when the dispatched promise resolves", async () => {
    const result: FallbackResult = {
      status: "success",
      output: "recovered output",
      model: "google/gemini-2.5-pro",
      attempts: [],
    };
    const { coordinator, hook } = setup(() => Promise.resolve(result));
    await hook(retryEvent("child-1", "HTTP 429"));
    // Let the .then() microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    const task = coordinator.tasksByCallID.get("c-1");
    expect(task?.fallbackResult).toEqual(result);
    expect(task?.state).toBe("fallback-ready");
  });
});

// ---------------------------------------------------------------------------
// session.error — structured, authoritative, prevails over text (item 7)
// ---------------------------------------------------------------------------

describe("createEventHook — session.error authoritative claims", () => {
  it("claims provider_error from a ProviderAuthError (provider auth)", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(sessionErrorEvent("child-1", { name: "ProviderAuthError", data: { providerID: "anthropic", message: "invalid_api_key" } }));

    const task = coordinator.tasksByCallID.get("c-1");
    expect(task?.failure?.kind).toBe("provider_error");
    expect(task?.fallbackPromise).toBeDefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("claims model_not_configured from an UnknownError whose message names a missing model", async () => {
    const { coordinator, hook } = setup();
    await hook(sessionErrorEvent("child-1", { name: "UnknownError", data: { message: "model_not_found: gpt-9" } }));

    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("model_not_configured");
  });

  it("ignores a MessageAbortedError (abort is not a model failure — no watchdog/abort in PR-05)", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(sessionErrorEvent("child-1", { name: "MessageAbortedError", data: { message: "aborted" } }));

    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("running-original");
    expect(coordinator.tasksByCallID.get("c-1")?.failure).toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// message.updated — inspect structured error (item 8)
// ---------------------------------------------------------------------------

describe("createEventHook — message.updated structured error", () => {
  it("claims a rate_limit failure from an assistant message error (error message)", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook({
      event: {
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "child-1", error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429, isRetryable: true } } } },
      },
    });
    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("rate_limit");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a message.updated with no error (activity only, no watchdog)", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "child-1" } } } });
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("running-original");
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P-02 tolerance window (reset <= 60s allows one internal retry)
// ---------------------------------------------------------------------------

describe("createEventHook — P-02 tolerance window", () => {
  it("tolerates the first 429 whose reset is <= 60s, then claims on the second", async () => {
    const { coordinator, hook, startSpy } = setup();

    // First retry: reset in 30s → tolerate, do NOT claim.
    await hook(retryEvent("child-1", "rate limit, retrying", NOW + 30_000));
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("running-original");
    expect(coordinator.tasksByCallID.get("c-1")?.failure).toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();

    // Second retry for the same session → claim now.
    await hook(retryEvent("child-1", "rate limit, retrying", NOW + 30_000));
    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("rate_limit");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT tolerate a 429 whose reset is > 60s — claims immediately", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(retryEvent("child-1", "rate limit", NOW + 120_000));
    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("rate_limit");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT tolerate a 429 with no reset hint — claims immediately", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(retryEvent("child-1", "HTTP 429 rate limit reached"));
    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("rate_limit");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate + late event suppression (INV-010)
// ---------------------------------------------------------------------------

describe("createEventHook — duplicate + late events", () => {
  it("claims only once for a duplicated authoritative event", async () => {
    const { hook, startSpy } = setup();
    await hook(retryEvent("child-1", "HTTP 429"));
    await hook(retryEvent("child-1", "HTTP 429"));
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a late event after the task has been finalized (tombstoned)", async () => {
    const { coordinator, hook, startSpy } = setup();
    // Drive the task terminal and finalize it (tombstone).
    coordinator.cancelParent({ parentSessionID: "parent-1", reason: "user_cancelled", now: NOW });
    coordinator.finalize({ callID: "c-1", now: NOW });

    await hook(retryEvent("child-1", "HTTP 429"));
    expect(startSpy).not.toHaveBeenCalled();
    expect(coordinator.tasksByCallID.has("c-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ignore / re-entrancy / robustness
// ---------------------------------------------------------------------------

describe("createEventHook — ignore, re-entrancy, robustness", () => {
  it("ignores unknown events without side effects", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook({ event: { type: "file.edited", properties: { file: "x" } } });
    await hook({ event: { type: "permission.asked", properties: { sessionID: "child-1" } } });
    expect(startSpy).not.toHaveBeenCalled();
    expect(coordinator.tasksByCallID.get("c-1")?.state).toBe("running-original");
  });

  it("ignores an authoritative event on an internal (fallback-owned) session", async () => {
    const { coordinator, hook, startSpy } = setup();
    coordinator.markInternalSession("child-1");
    await hook(retryEvent("child-1", "HTTP 429"));
    expect(startSpy).not.toHaveBeenCalled();
    expect(coordinator.tasksByCallID.get("c-1")?.failure).toBeUndefined();
  });

  it("ignores an authoritative event for an unassociated session", async () => {
    const { coordinator, hook, startSpy } = setup();
    await hook(retryEvent("child-unknown", "HTTP 429"));
    expect(startSpy).not.toHaveBeenCalled();
    expect(coordinator.tasksByCallID.get("c-1")?.failure).toBeUndefined();
  });

  it("never throws on a malformed event payload", async () => {
    const { hook } = setup();
    await expect(hook({ event: undefined })).resolves.toBeUndefined();
    await expect(hook({})).resolves.toBeUndefined();
    await expect(hook(undefined as never)).resolves.toBeUndefined();
  });

  it("absorbs a throwing startFallback (best-effort, design item 9)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger(), now: () => NOW });
    coordinator.registerTask({
      callID: "c-1",
      parentSessionID: "parent-1",
      originalSubagentType: "sdd-design",
      generatedAlias: "__mf_sdd-design__abc_c-1",
      originalModel: "openai/gpt-5.5",
      prompt: "p",
      now: NOW,
    });
    coordinator.bindTaskSession({ callID: "c-1", sessionID: "child-1", now: NOW });
    const hook = createEventHook({
      coordinator,
      now: () => NOW,
      startFallback: () => {
        throw new Error("dispatch blew up");
      },
    });
    await expect(hook(retryEvent("child-1", "HTTP 429"))).resolves.toBeUndefined();
    // The failure was still claimed even though dispatch failed.
    expect(coordinator.tasksByCallID.get("c-1")?.failure?.kind).toBe("rate_limit");
  });
});

// ---------------------------------------------------------------------------
// plugin.ts wiring — the event hook is registered and dispatches early
// ---------------------------------------------------------------------------

describe("modelForecastPlugin — registers and drives the event hook", () => {
  let tempDir: string;
  let opts: { quarantine: { filePath: string }; cachePath: string };

  async function makeOpts(): Promise<typeof opts> {
    tempDir = await mkdtemp(path.join(tmpdir(), "mf-event-hook-"));
    return {
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
      cachePath: path.join(tempDir, "model-data.json"),
    };
  }

  function pluginClient() {
    return {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "google",
                models: {
                  "gemini-2.5-pro": { variants: { high: {} }, cost: { input: 2, output: 8 }, limit: { context: 2_000_000 }, status: "active" },
                  "gemini-2.5-flash": { variants: { high: {} }, cost: { input: 1, output: 4 }, limit: { context: 1_000_000 }, status: "active" },
                },
              },
            ],
          },
        }),
      },
      session: {
        create: vi.fn(async () => ({ id: "fallback-child" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "recovered by fallback" }] })),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
  }

  it("registers an `event` hook in auto mode with recovery enabled", async () => {
    const hooks = await modelForecastPlugin({ client: pluginClient() }, { mode: "auto", ...(await makeOpts()) });
    expect(typeof hooks["event"]).toBe("function");
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does NOT register the event hook when recovery.enabled is false (P-06)", async () => {
    const hooks = await modelForecastPlugin({ client: pluginClient() }, { mode: "auto", recovery: { enabled: false }, ...(await makeOpts()) });
    expect(hooks["event"]).toBeUndefined();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("dispatches the fallback engine from a 429 event BEFORE any tool.execute.after (merge gate)", async () => {
    const client = pluginClient();
    const hooks = await modelForecastPlugin({ client }, { mode: "auto", ...(await makeOpts()) });

    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: { "sdd-design": { mode: "subagent", model: "google/gemini-2.5-pro", prompt: "Design" } } });

    const beforeHook = hooks["tool.execute.before"] as (input: unknown, output: { args: Record<string, unknown> }) => Promise<void>;
    const eventHook = hooks["event"] as (input: { event?: unknown }) => Promise<void>;

    // Register the supervised task (rewrites subagent_type, sessionID = s1).
    const beforeOutput = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook({ tool: { id: "task" }, sessionID: "s1", callID: "call-42" }, beforeOutput);
    expect(beforeOutput.args.subagent_type as string).toMatch(/^__mf_sdd-design__/);

    // The child subagent session is created, then it hits a 429 — all
    // BEFORE tool.execute.after would fire for the parent task call.
    await eventHook({ event: { type: "session.created", properties: { info: { id: "child-abc", parentID: "s1", title: "work call-42" } } } });
    await eventHook({ event: { type: "session.status", properties: { sessionID: "child-abc", status: { type: "retry", attempt: 1, message: "HTTP 429 Too Many Requests" } } } });

    // Let the dispatched fallback engine run its async attempt.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The fallback engine was dispatched from the event — proving the
    // 429 created work before tool.execute.after occurred.
    expect(client.session.create).toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalled();
    await rm(tempDir, { recursive: true, force: true });
  });
});

