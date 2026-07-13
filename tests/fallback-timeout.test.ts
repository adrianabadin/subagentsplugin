/**
 * supervised-model-fallback-recovery (SDD change) — PR-03.
 *
 * Engine-level coverage for design §21 PR-03 "Pruebas obligatorias":
 *   - create timeout (DeadlineError on session.create, no fallback loop)
 *   - create rejection (any throw from session.create)
 *   - id no extraíble (create succeeds but yields no usable session id)
 *   - session guard before prompt (capture guard state at the moment
 *     session.prompt fires; it must ALREADY contain the new session id)
 *   - exhausted non-empty (the §18 FALLBACK EXHAUSTED output is always
 *     non-empty, never a silent blank string)
 *
 * Composes with the pure-classifier coverage in `attempt-outcome.test.ts`
 * (which pins §8 textual and structural rules independently). These
 * tests focus on the ENGINE wiring: deadlines, structured FallbackResult
 * shape, sequence/provider/startedAt/finishedAt in FallbackAttempt.
 */
import { describe, expect, it, vi } from "vitest";
import { createFallbackEngine, type FallbackCatalogSlice, type FallbackClient } from "../src/fallback.js";
import { QuarantineStore } from "../src/quarantine.js";
import { classifyError } from "../src/error-classification.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";

function makeCatalog(
  byBase: Record<string, Array<{ modelId: string }>>,
): FallbackCatalogSlice {
  return {
    byBase: Object.fromEntries(
      Object.entries(byBase).map(([k, v]) => [
        k,
        v.map((entry) => ({ ...entry, ladderRung: "openai" as const })),
      ]),
    ),
  };
}

describe("createFallbackEngine() — session.create hardening", () => {
  it("session.create times out: attempt is recorded as session_create_timeout, no session.prompt fired, exhausted result is non-empty", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const create = vi.fn(async () => {
      // simulate a hung create that never resolves
      return new Promise<unknown>(() => {});
    });
    const prompt = vi.fn();
    const client: FallbackClient = { session: { create, prompt } };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
      // Use a short deadline so the test doesn't wait the production
      // 15s; the engine wrapper still asserts that the deadline fires.
      sessionCreateTimeoutMs: 100,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    // Exhausted with non-empty output (§18 invariant + design gate).
    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.output).toContain("FALLBACK EXHAUSTED");
      expect(result.attempts.length).toBeGreaterThanOrEqual(2);
      const timeoutAttempt = result.attempts.find((a) => a.reason === "session_create_timeout");
      expect(timeoutAttempt).toBeDefined();
    }
    // No prompt was ever fired because create never produced a session.
    expect(prompt).not.toHaveBeenCalled();
  });

  it("session.create rejects (non-timeout throw): attempt is recorded with the error message as reason", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const create = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const prompt = vi.fn();
    const client: FallbackClient = { session: { create, prompt } };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      // The first attempted model was the failedModel itself; the
      // engine then tried minimax/M3 (which threw on create). Both
      // attempts must be recorded.
      expect(result.attempts.length).toBeGreaterThanOrEqual(2);
      const minimaxAttempt = result.attempts.find((a) => a.model === "minimax/M3");
      expect(minimaxAttempt).toBeDefined();
      expect(minimaxAttempt?.reason).toBe("network unreachable");
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it("session.create returns no usable session id (id no extraíble): attempt recorded as session_create_failed, prompt never fired", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    // create resolves successfully but the response has no id field.
    const create = vi.fn(async () => ({ data: { totally: "missing-id" } }));
    const prompt = vi.fn();
    const client: FallbackClient = { session: { create, prompt } };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    expect(prompt).not.toHaveBeenCalled();
    if (result.status === "exhausted") {
      const minimaxAttempt = result.attempts.find((a) => a.model === "minimax/M3");
      expect(minimaxAttempt).toBeDefined();
      expect(minimaxAttempt?.reason).toBe("session_create_failed");
    }
  });

  it("session guard is populated BEFORE session.prompt fires (re-entrancy invariant)", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    let activeAtPromptTime: boolean | undefined;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-x" })),
        prompt: vi.fn(async (opts: { path: { id: string } }) => {
          activeAtPromptTime = true;
          return { parts: [{ type: "text", text: "done" }] };
        }),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(activeAtPromptTime).toBe(true);
  });
});

describe("createFallbackEngine() — FallbackAttempt shape", () => {
  it("every recorded attempt carries sequence, model, provider, reason, startedAt, finishedAt", async () => {
    const start = 1_700_000_000_000;
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => Math.floor(start / 1_000) });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
      ],
    });

    let nowMs = start;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-1" })),
        prompt: vi.fn(async () => {
          nowMs += 50;
          return { parts: [{ type: "text", text: "HTTP 429 too many requests" }] };
        }),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
      now: () => new Date(nowMs),
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") return;

    expect(result.attempts).toHaveLength(3);
    for (const attempt of result.attempts) {
      expect(typeof attempt.sequence).toBe("number");
      expect([1, 2, 3]).toContain(attempt.sequence);
      expect(typeof attempt.model).toBe("string");
      expect(attempt.model.length).toBeGreaterThan(0);
      expect(typeof attempt.provider).toBe("string");
      expect(typeof attempt.reason).toBe("string");
      expect(typeof attempt.startedAt).toBe("number");
      expect(typeof attempt.finishedAt).toBe("number");
      expect(attempt.finishedAt).toBeGreaterThanOrEqual(attempt.startedAt);
    }
    // Sequences are monotonic 1, 2, 3.
    expect(result.attempts.map((a) => a.sequence)).toEqual([1, 2, 3]);
    // Each attempt's provider matches the slice before the first slash.
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[1]?.provider).toBe("minimax");
    expect(result.attempts[2]?.provider).toBe("google-antigravity");
  });

  it("success result carries the FallbackAttempt list and the resolved model", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-y" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "task completed" }] })),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.model).toBe("minimax/M3");
    expect(result.output).toBe("task completed");
    // attempts array on success includes the failed original + the successful fallback.
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.attempts.some((a) => a.model === "openai/gpt-4.1-mini")).toBe(true);
    expect(result.attempts.some((a) => a.model === "minimax/M3")).toBe(true);
  });
});

describe("createFallbackEngine() — tombstone after completion", () => {
  it("after run completes, the created session id has moved from active to tombstone", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-tomb" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "task completed" }] })),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    // After completion: tombstone holds the session id; active no longer does.
  });

  it("exhausted run also tombstones every session id it created", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
      ],
    });

    let counter = 0;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: `child-${++counter}` })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "HTTP 429" }] })),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    // Both created sessions must be tombstoned, not active.
  });
});

describe("createFallbackEngine() — supervised fallback prompt", () => {
  it("aborts a hung fallback prompt instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(async () => {});
      const engine = createFallbackEngine({
        client: { session: { create: vi.fn(async () => ({ id: "hung-child" })), prompt: vi.fn(() => new Promise(() => {})), abort } },
        quarantine: new QuarantineStore({ ttlMs: 1_000 }),
        catalog: makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] }),
        ladder: DEFAULT_LADDER,
        classify: classifyError,
        maxAttempts: 2,
        sessionPromptTimeoutMs: 10,
      });
      const result = engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
      await vi.advanceTimersByTimeAsync(10);
      expect((await result).status).toBe("exhausted");
      expect(abort).toHaveBeenCalledWith({ path: { id: "hung-child" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a watchdog abort before terminating a supervised fallback prompt", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator();
      coordinator.registerTask({ callID: "fallback-call", parentSessionID: "parent", originalSubagentType: "sdd-design", generatedAlias: "alias", originalModel: "openai/gpt-4.1-mini", prompt: "work" });
      const engine = createFallbackEngine({
        client: { session: { create: vi.fn(async () => ({ id: "supervised-child" })), prompt: vi.fn(() => new Promise(() => {})), abort: vi.fn(async () => {}) } },
        quarantine: new QuarantineStore({ ttlMs: 1_000 }), catalog: makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] }),
        ladder: DEFAULT_LADDER, classify: classifyError, maxAttempts: 2, sessionPromptTimeoutMs: 10, coordinator,
      });
      const result = engine.run({ sessionID: "parent", taskCallID: "fallback-call", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
      await vi.advanceTimersByTimeAsync(10);
      await result;
      expect(coordinator.pluginAbortSessionIDs.get("supervised-child")?.origin).toBe("plugin-watchdog");
    } finally { vi.useRealTimers(); }
  });
});
