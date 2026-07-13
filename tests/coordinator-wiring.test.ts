/**
 * supervised-model-fallback-recovery (SDD change) — PR-04b wiring tests.
 *
 * Design "diseño fallback.md" §PR-04 lines 1737-1830 + amendment R-03
 * (split PR-04 into PR-04a coordinator + PR-04b wiring). This file
 * covers the WIRING slice: AttemptCoordinator (built in PR-04a) is
 * threaded through `plugin.ts`, `hooks.ts`, and `fallback.ts`,
 * replacing `Map<callID, TrackedCall>` and the `fallbackSessionIDs`
 * re-entrancy guard with `coordinator.tasksByCallID` and
 * `coordinator.isInternalSession` respectively.
 *
 * Scope guard (per orchestrator):
 *   - NO PR-05 event hook (session.error / message.updated wiring).
 *   - NO session association logic (coordinator.bindSession from PR-05).
 *   - NO watchdogs (PR-06 — firstActivity/inactivity/hard timers).
 *
 * Test scenarios (one describe per wiring site):
 *   - 1. createTaskHook: registers task in coordinator on accepted switch
 *   - 2. createTaskHook: re-entrancy guard via coordinator.isInternalSession
 *   - 3. createAfterHook: reads task from coordinator.tasksByCallID
 *   - 4. createAfterHook: delete-on-consume delegates to coordinator
 *   - 5. createAfterHook: re-entrancy guard via coordinator.isInternalSession
 *   - 6. createFallbackEngine: marks session internal before prompt
 *   - 7. createFallbackEngine: unmarks session after prompt settles
 *   - 8. createFallbackEngine: works without coordinator (back-compat)
 *   - 9. plugin.ts: instantiates coordinator and passes to hooks
 *
 * TDD contract: every test below ASSERTS the NEW behavior. They MUST
 * fail against the current code (which still uses Map + fallbackSessionIDs)
 * and pass only after PR-04b's wiring changes land.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { createFallbackEngine } from "../src/fallback.js";
import { createAfterHook, createTaskHook } from "../src/hooks.js";
import { QuarantineStore } from "../src/quarantine.js";
import { generatedProfileAlias } from "../src/profiles.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import modelForecastPlugin from "../src/plugin.js";
import type { Logger } from "../src/logger.js";
import type { HooksConfig, LadderRung, SelectDecision } from "../src/types.js";

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

function decision(overrides: Partial<SelectDecision> = {}): SelectDecision {
  return {
    action: "switch",
    subagent_type: "sdd-design-alto",
    model: "openai/gpt-5.5",
    effort: "high",
    reason: "test decision",
    confidence: 0.8,
    evidence: "test evidence",
    ...overrides,
  };
}

const cfg: HooksConfig = {
  mode: "auto",
  confidenceThreshold: 0.6,
  ladder: DEFAULT_LADDER,
  allowlist: [],
  denylist: [],
};

function makeCatalog(
  byBase: Record<string, Array<{ modelId: string }>>,
): { byBase: Record<string, Array<{ modelId: string; ladderRung: LadderRung }>> } {
  return {
    byBase: Object.fromEntries(
      Object.entries(byBase).map(([k, v]) => [
        k,
        v.map((entry) => ({ ...entry, ladderRung: "openai" as LadderRung })),
      ]),
    ),
  };
}

function seedTrackedTask(
  coordinator: AttemptCoordinator,
  callID: string,
  targetAlias: string,
  model: string,
  original: string,
  prompt = "do the thing",
): void {
  coordinator.registerTask({
    callID,
    parentSessionID: "parent-session",
    originalSubagentType: original,
    generatedAlias: targetAlias,
    originalModel: model,
    prompt,
  });
}

// ---------------------------------------------------------------------------
// 1. createTaskHook — registers task in coordinator on accepted switch
// ---------------------------------------------------------------------------

describe("createTaskHook — coordinator.registerTask on accepted switch", () => {
  it("notifies supervision after registering an accepted task", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const onTaskRegistered = vi.fn();
    const hook = createTaskHook(cfg, { coordinator, onTaskRegistered, select: () => decision() });
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "watch-call" }, { args: { subagent_type: "sdd-design", prompt: "work" } });
    expect(onTaskRegistered).toHaveBeenCalledWith("watch-call");
  });

  it("writes a TrackedTask entry to coordinator.tasksByCallID on a switch decision", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-5.5");

    const hook = createTaskHook(cfg, {
      select: () => decision({ subagent_type: targetAlias, model: "openai/gpt-5.5" }),
      coordinator,
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "design the API" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    const task = coordinator.tasksByCallID.get("c1");
    expect(task).toBeDefined();
    expect(task?.callID).toBe("c1");
    expect(task?.parentSessionID).toBe("s1");
    expect(task?.originalSubagentType).toBe("sdd-design");
    expect(task?.generatedAlias).toBe(targetAlias);
    expect(task?.originalModel).toBe("openai/gpt-5.5");
    expect(task?.prompt).toBe("design the API");
  });

  it("does NOT register a task when the decision is keep-default", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const hook = createTaskHook(cfg, {
      select: () => decision({ action: "keep-default", subagent_type: "", model: "" }),
      coordinator,
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(coordinator.tasksByCallID.has("c1")).toBe(false);
  });

  it("does NOT register a task when a switch is downgraded to keep-default (denylist)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const strictCfg: HooksConfig = {
      ...cfg,
      denylist: ["openai/gpt-5.5"],
    };
    const hook = createTaskHook(strictCfg, {
      select: () => decision(),
      coordinator,
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(coordinator.tasksByCallID.has("c1")).toBe(false);
  });

  it("registers TWO distinct tasks when the same session launches two distinct callIDs", async () => {
    // Triangulation: the callID-keyed index must NOT collapse into a per-session set.
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-5.5");
    const hook = createTaskHook(cfg, {
      select: () => decision({ subagent_type: targetAlias, model: "openai/gpt-5.5" }),
      coordinator,
    });

    const first = { args: { subagent_type: "sdd-design", prompt: "first" } };
    const second = { args: { subagent_type: "sdd-design", prompt: "second" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, first);
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c2" }, second);

    expect(coordinator.tasksByCallID.size).toBe(2);
    expect(coordinator.tasksByCallID.get("c1")?.prompt).toBe("first");
    expect(coordinator.tasksByCallID.get("c2")?.prompt).toBe("second");
  });

  it("falls back to writing the legacy tracking map when no coordinator is supplied (back-compat)", async () => {
    // Back-compat surface: callers that still pass `tracking` (legacy
    // Map<string, TrackedCall>) without a coordinator keep working.
    const tracking = new Map<string, { originalSubagentType: string; targetAlias: string; model: string }>();
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-5.5");
    const hook = createTaskHook(cfg, {
      select: () => decision({ subagent_type: targetAlias, model: "openai/gpt-5.5" }),
      tracking,
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(tracking.has("c1")).toBe(true);
    expect(tracking.get("c1")?.targetAlias).toBe(targetAlias);
  });
});

// ---------------------------------------------------------------------------
// 2. createTaskHook — re-entrancy guard via coordinator.isInternalSession
// ---------------------------------------------------------------------------

describe("createTaskHook — re-entrancy guard via coordinator.isInternalSession", () => {
  it("early-returns (no rewrite) when input.sessionID is internal to the coordinator", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    coordinator.markInternalSession("fallback-child-session");

    const audit = vi.fn();
    const hook = createTaskHook(cfg, {
      audit,
      coordinator,
      select: () => decision(),
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "fallback-child-session", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design"); // unchanged
    expect(audit).not.toHaveBeenCalled();
    expect(coordinator.tasksByCallID.has("c1")).toBe(false);
  });

  it("proceeds normally when input.sessionID is NOT internal to the coordinator", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-5.5");
    const hook = createTaskHook(cfg, {
      coordinator,
      select: () => decision({ subagent_type: targetAlias, model: "openai/gpt-5.5" }),
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe(targetAlias);
    expect(coordinator.tasksByCallID.has("c1")).toBe(true);
  });

  it("still treats tombstoned internal sessions as internal (late-event recognition)", async () => {
    // isInternalSession must return true during the tombstone window so
    // a late after-hook event for a fallback-owned session is still
    // recognised as fallback-owned.
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    coordinator.markInternalSession("fallback-late");
    coordinator.unmarkInternalSession("fallback-late");

    const hook = createTaskHook(cfg, {
      coordinator,
      select: () => decision(),
    });

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "fallback-late", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// 3. createAfterHook — reads task from coordinator.tasksByCallID
// ---------------------------------------------------------------------------

describe("createAfterHook — reads task from coordinator.tasksByCallID", () => {
  it("on a classified failure, dispatches the fallback engine using coordinator-side fields", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    seedTrackedTask(
      coordinator,
      "c1",
      generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini"),
      "openai/gpt-4.1-mini",
      "sdd-design",
      "do the thing",
    );
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const client = {
      session: {
        create: vi.fn(async () => ({ id: "child-1" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "fallback success" }] })),
      },
    };

    const hook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      coordinator,
      fallback: { client, enabled: true },
    });

    const output: { output?: unknown; metadata?: unknown } = {
      output: "upstream returned HTTP 429 Too Many Requests",
    };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(output.output).toBe("fallback success");
    expect(
      (output.metadata as { mfFallback?: { attempts: number; model: string } } | undefined)
        ?.mfFallback,
    ).toEqual({ attempts: 2, model: "minimax/M3" });
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
  });

  it("silently skips when coordinator has no entry for the callID", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });

    const hook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      coordinator,
    });

    const output: { output?: unknown } = { output: "anything" };
    await expect(
      hook({ tool: { id: "task" }, sessionID: "parent", callID: "unknown" }, output),
    ).resolves.not.toThrow();
    // Output is NOT rewritten when the callID has no entry.
    expect(output.output).toBe("anything");
    expect(quarantine.snapshot()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. createAfterHook — delete-on-consume delegates to coordinator
// ---------------------------------------------------------------------------

describe("createAfterHook — coordinator task retention for arbitration", () => {
  it("keeps the task available after quarantine dispatch so PR-07 can arbitrate late outcomes", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    seedTrackedTask(
      coordinator,
      "c1",
      generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini"),
      "openai/gpt-4.1-mini",
      "sdd-design",
    );
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }],
    });

    const hook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      coordinator,
    });

    const output: { output?: unknown } = { output: "upstream returned HTTP 429" };
    await hook({ tool: { id: "task" }, sessionID: "parent", callID: "c1" }, output);

    expect(coordinator.tasksByCallID.has("c1")).toBe(true);
  });

  it("a second after-hook invocation with the same callID is a no-op (already consumed)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    seedTrackedTask(
      coordinator,
      "c1",
      generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini"),
      "openai/gpt-4.1-mini",
      "sdd-design",
    );
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }],
    });

    const hook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      coordinator,
    });

    const output1: { output?: unknown } = { output: "upstream returned HTTP 429" };
    const output2: { output?: unknown } = { output: "second-call output" };

    await hook({ tool: { id: "task" }, sessionID: "parent", callID: "c1" }, output1);
    await hook({ tool: { id: "task" }, sessionID: "parent", callID: "c1" }, output2);

    // Only one quarantine entry produced (the second call is silent).
    expect(quarantine.snapshot().filter((e) => e.model === "openai/gpt-4.1-mini").length).toBe(1);
    // Second call did NOT mutate its output.
    expect(output2.output).toBe("second-call output");
  });
});

// ---------------------------------------------------------------------------
// 5. createAfterHook — re-entrancy guard via coordinator.isInternalSession
// ---------------------------------------------------------------------------

describe("createAfterHook — re-entrancy guard via coordinator.isInternalSession", () => {
  it("early-returns when input.sessionID is internal to the coordinator", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    seedTrackedTask(
      coordinator,
      "c1",
      generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini"),
      "openai/gpt-4.1-mini",
      "sdd-design",
    );
    coordinator.markInternalSession("fallback-child");

    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }],
    });

    const client = {
      session: {
        create: vi.fn(async () => ({ id: "child-x" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "x" }] })),
      },
    };

    const hook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      coordinator,
      fallback: { client, enabled: true },
    });

    const output: { output?: unknown; metadata?: unknown } = { output: "HTTP 429" };
    await hook({ tool: { id: "task" }, sessionID: "fallback-child", callID: "c1" }, output);

    // No quarantine, no fallback rewrite, no entry consumed.
    expect(quarantine.snapshot()).toEqual([]);
    expect(output.output).toBe("HTTP 429");
    expect(output.metadata).toBeUndefined();
    expect(coordinator.tasksByCallID.has("c1")).toBe(true);
    // Engine was never dispatched.
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. createFallbackEngine — marks session internal before prompt
// ---------------------------------------------------------------------------

describe("createFallbackEngine — coordinator.markInternalSession before prompt", () => {
  it("calls coordinator.markInternalSession(sessionId) BEFORE session.prompt fires", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const order: string[] = [];

    const client = {
      session: {
        create: vi.fn(async () => {
          order.push("create");
          return { id: "child-session" };
        }),
        prompt: vi.fn(async (opts: unknown) => {
          order.push("prompt");
          // While the prompt is in flight, the coordinator MUST already
          // consider the session internal — otherwise the re-entrancy
          // guard would race.
          order.push(`isInternal=${coordinator.isInternalSession("child-session")}`);
          return { parts: [{ type: "text", text: "fallback success output" }] };
        }),
      },
    };
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      classify: (text: string) => (text.includes("429") ? { type: "rate_limit", code: "429" } : null),
      maxAttempts: 3,
      now: () => new Date(1_700_000_000),
      logger: silentLogger(),
      coordinator,
    });

    const result = await engine.run({
      sessionID: "parent",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "429",
    });

    expect(result.status).toBe("success");
    expect(order).toContain("create");
    expect(order).toContain("prompt");
    expect(order).toContain("isInternal=true");
  });
});

// ---------------------------------------------------------------------------
// 7. createFallbackEngine — unmarks session after prompt settles
// ---------------------------------------------------------------------------

describe("createFallbackEngine — coordinator.unmarkInternalSession after prompt settles", () => {
  it("calls coordinator.unmarkInternalSession after a successful prompt", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const client = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-1" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "fallback success" }] })),
      },
    };
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      classify: (text: string) => (text.includes("429") ? { type: "rate_limit", code: "429" } : null),
      maxAttempts: 3,
      now: () => new Date(1_700_000_000),
      logger: silentLogger(),
      coordinator,
    });

    await engine.run({
      sessionID: "parent",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "429",
    });

    // Session is tombstoned: not in active set but isInternalSession
    // still returns true within the tombstone window.
    expect(coordinator.internalSessionIDs.has("child-session-1")).toBe(false);
    expect(coordinator.isInternalSession("child-session-1")).toBe(true);
    expect(coordinator.internalSessionTombstones.has("child-session-1")).toBe(true);
  });

  it("calls coordinator.unmarkInternalSession after a failed prompt (fallback continues)", async () => {
    const coordinator = new AttemptCoordinator({ logger: silentLogger() });
    const client = {
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "child-fail" })
          .mockResolvedValueOnce({ id: "child-success" }),
        prompt: vi
          .fn()
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "HTTP 429 from model A" }] })
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "fallback success output" }] }),
      },
    };
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google/gemini-2.5-flash" },
      ],
    });

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      classify: (text: string) => (text.includes("429") ? { type: "rate_limit", code: "429" } : null),
      maxAttempts: 3,
      now: () => new Date(1_700_000_000),
      logger: silentLogger(),
      coordinator,
    });

    const result = await engine.run({
      sessionID: "parent",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "429",
    });

    expect(result.status).toBe("success");
    // First attempt's session is tombstoned (not active, but recognisable).
    expect(coordinator.internalSessionIDs.has("child-fail")).toBe(false);
    expect(coordinator.isInternalSession("child-fail")).toBe(true);
    expect(coordinator.internalSessionTombstones.has("child-fail")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. createFallbackEngine — back-compat without coordinator
// ---------------------------------------------------------------------------

describe("createFallbackEngine — works without coordinator (back-compat surface)", () => {
  it("still maintains fallbackSessionIDs internally and exposes the field on the engine", async () => {
    // The back-compat field stays available so legacy callers and tests
    // that read `engine.fallbackSessionIDs` keep working.
    const client = {
      session: {
        create: vi.fn(async () => ({ id: "legacy-child" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "ok" }] })),
      },
    };
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      classify: (text: string) => (text.includes("429") ? { type: "rate_limit", code: "429" } : null),
      maxAttempts: 3,
      now: () => new Date(1_700_000_000),
      logger: silentLogger(),
    });

    expect(engine.fallbackSessionIDs).toBeInstanceOf(Set);

    const result = await engine.run({
      sessionID: "parent",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "429",
    });
    expect(result.status).toBe("success");
    // Legacy session is tombstoned (active set drained after prompt).
    expect(engine.fallbackSessionIDs.has("legacy-child")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. plugin.ts — instantiates coordinator and passes it to hooks
// ---------------------------------------------------------------------------

describe("modelForecastPlugin — wires AttemptCoordinator end-to-end", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-coord-wiring-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("end-to-end: fallback engine dispatches on a 429 with coordinator-backed tracking (no legacy Map)", async () => {
    const quarantinePath = path.join(tempDir, "quarantine.json");
    const cachePath = path.join(tempDir, "model-data.json");
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "google",
                models: {
                  "gemini-2.5-pro": {
                    variants: { high: {} },
                    cost: { input: 2, output: 8 },
                    limit: { context: 2_097_152 },
                    status: "active",
                  },
                  "gemini-2.5-flash": {
                    variants: { high: {} },
                    cost: { input: 1, output: 4 },
                    limit: { context: 1_000_000 },
                    status: "active",
                  },
                },
              },
            ],
          },
        }),
      },
      session: {
        create: vi.fn(async () => ({ id: "fallback-child-session" })),
        prompt: vi.fn(async () => ({
          parts: [{ type: "text", text: "fallback model finished the task" }],
        })),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin(
      { client },
      {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        cachePath,
      },
    );

    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
        },
      },
    });

    const beforeHook = hooks["tool.execute.before"] as (
      input: unknown,
      output: { args: Record<string, unknown> },
    ) => Promise<void>;
    const afterHook = hooks["tool.execute.after"] as (
      input: unknown,
      output: { output?: unknown; metadata?: unknown },
    ) => Promise<void>;

    const beforeOutput = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-coord-wiring" },
      beforeOutput,
    );
    const rewritten = beforeOutput.args.subagent_type as string;
    expect(rewritten).toMatch(/^__mf_sdd-design__/);

    const afterOutput: { output?: unknown; metadata?: unknown } = {
      output: "upstream returned HTTP 429 Too Many Requests",
    };
    await afterHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-coord-wiring" },
      afterOutput,
    );

    // The fallback engine dispatched and succeeded — output overwritten.
    expect(afterOutput.output).toBe("fallback model finished the task");
    const metadata = afterOutput.metadata as
      | { mfFallback?: { attempts: number; model: string } }
      | undefined;
    expect(metadata?.mfFallback?.attempts).toBeGreaterThanOrEqual(2);
    expect(metadata?.mfFallback?.model).toContain("google/");
  });
});
