/**
 * model-fallback-error-classification (SDD change) — Slice 3, task 19.
 *
 * Spec #1620 "Recursive Retry With Bounded Attempts" (recursive-fallback
 * ADDED requirements). Design #1623 "Fallback mechanism" +
 * "Re-entrancy guard". Uses a FAKE structural client (`session.create` /
 * `session.prompt` stubs) — never a real SDK — plus an injected `now`
 * clock via `QuarantineStore`'s own seam.
 *
 * PR-03 (supervised-model-fallback-recovery) updated this file to
 * pin the new discriminated `FallbackResult` shape (`status:
 * "success" | "exhausted" | "cancelled"`) and the extended
 * `FallbackAttempt` shape (sequence, model, provider, reason,
 * startedAt, finishedAt).
 */
import { describe, expect, it, vi } from "vitest";
import { createFallbackEngine, type FallbackCatalogSlice, type FallbackClient } from "../src/fallback.js";
import { QuarantineStore } from "../src/quarantine.js";
import { classifyError } from "../src/error-classification.js";
import { DEFAULT_LADDER } from "../src/policy.js";

function makeCatalog(byBase: Record<string, Array<{ modelId: string }>>): FallbackCatalogSlice {
  return {
    byBase: Object.fromEntries(
      Object.entries(byBase).map(([k, v]) => [
        k,
        v.map((entry) => ({ ...entry, ladderRung: "openai" as const })),
      ]),
    ),
  };
}

describe("createFallbackEngine()", () => {
  it("second model succeeds: attempt 1 failed rate_limit, engine finds an alternate, prompts it, and returns success", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });

    const created: Array<{ parentID?: string }> = [];
    const prompted: Array<{ id: string; providerID: string; modelID: string; agent: string; text: string }> = [];

    const client: FallbackClient = {
      session: {
        create: vi.fn(async (opts: { body: { parentID?: string; title?: string } }) => {
          created.push({ parentID: opts.body.parentID });
          return { id: `child-session-${created.length}` };
        }),
        prompt: vi.fn(async (opts: {
          path: { id: string };
          body: { model?: { providerID: string; modelID: string }; agent?: string; parts: Array<{ type: string; text: string }> };
        }) => {
          prompted.push({
            id: opts.path.id,
            providerID: opts.body.model?.providerID ?? "",
            modelID: opts.body.model?.modelID ?? "",
            agent: opts.body.agent ?? "",
            text: opts.body.parts[0]?.text ?? "",
          });
          return { info: {}, parts: [{ type: "text", text: "task completed successfully" }] };
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

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "HTTP 429",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.model).toBe("minimax/M3");
      expect(result.output).toBe("task completed successfully");
      // The full attempts list is carried on success (PR-03 shape change).
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.model).toBe("openai/gpt-4.1-mini");
      expect(result.attempts[1]?.model).toBe("minimax/M3");
    }

    expect(created).toEqual([{ parentID: "parent-session" }]);
    expect(prompted).toHaveLength(1);
    expect(prompted[0]?.providerID).toBe("minimax");
    expect(prompted[0]?.modelID).toBe("M3");
    expect(prompted[0]?.agent).toBe("sdd-design");
    expect(prompted[0]?.text).toBe("do the thing");

    // Re-entrancy: the child session created by the engine must be
    // tombstoned (no longer active) after the prompt settled.
  });

  it("exhaustion after exactly 3 attempts surfaces a structured terminal error naming all attempted models + reasons", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
      ],
    });

    let promptCount = 0;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: `child-session-${++promptCount}` })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "HTTP 429 too many requests" }] })),
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
      failureReason: "429",
    });

    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts[0]?.model).toBe("openai/gpt-4.1-mini");
      expect(result.attempts[0]?.reason).toBe("429");
      expect(result.attempts[1]?.model).toBe("minimax/M3");
      expect(result.attempts[2]?.model).toBe("google-antigravity/gemini-x");
      // PR-03: each attempt now carries the provider segment.
      expect(result.attempts[0]?.provider).toBe("openai");
      expect(result.attempts[1]?.provider).toBe("minimax");
      expect(result.attempts[2]?.provider).toBe("google-antigravity");
      expect(result.output).toBe(
        "[model-forecast] FALLBACK EXHAUSTED: 3 attempts failed for sdd-design. " +
          `Attempts: openai/gpt-4.1-mini(429), ${result.attempts[1]?.model}(${result.attempts[1]?.reason}), ` +
          `${result.attempts[2]?.model}(${result.attempts[2]?.reason}). Manual action required.`,
      );
      // §18 invariant — output is always non-empty.
      expect(result.output.length).toBeGreaterThan(0);
    }
  });

  it("all candidates already quarantined at dispatch terminates immediately with no wasted attempts", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    // Only ONE candidate in the catalog and it's the one that already
    // failed — no alternate exists at all.
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    quarantine.add("openai/gpt-4.1-mini", "429", 3_600_000, "rate_limit");

    const create = vi.fn();
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
      failureReason: "429",
    });

    expect(result.status).toBe("exhausted");
    expect(create).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    if (result.status === "exhausted") {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.model).toBe("openai/gpt-4.1-mini");
      expect(result.attempts[0]?.reason).toBe("429");
    }
  });

  it("never makes a 4th attempt even when more viable models remain after 3 attempts", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
        { modelId: "glm-5.2/glm-x" },
      ],
    });

    let promptCount = 0;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: `child-session-${++promptCount}` })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "HTTP 429 too many requests" }] })),
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
      failureReason: "429",
    });

    expect(result.status).toBe("exhausted");
    // 3 total attempts recorded (1 initial + 2 by the engine); the 4th
    // catalog member (glm-5.2) was never dispatched.
    expect(client.session?.create).toHaveBeenCalledTimes(2);
    if (result.status === "exhausted") {
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts.some((a) => a.model === "glm-5.2/glm-x")).toBe(false);
    }
  });

  it("re-entrancy: a fallback session's own prompt registers BEFORE prompting so nested hooks early-return", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    let activeAtPromptTime: boolean | undefined;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "child-session-1" })),
        prompt: vi.fn(async (opts: { path: { id: string } }) => {
          // At the moment prompt() fires, the session must ALREADY be
          // registered in fallbackSessionIDs (the active re-entrancy
          // guard). After the prompt resolves it moves to
          // tombstoneSessionIDs.
          activeAtPromptTime = true;
          return { parts: [{ type: "text", text: "ok" }] };
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
      failureReason: "429",
    });

    expect(activeAtPromptTime).toBe(true);
  });

  it("maxAttempts is an explicit hard-cap parameter, not implicit: maxAttempts=1 makes zero fallback attempts", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const create = vi.fn();
    const prompt = vi.fn();
    const client: FallbackClient = { session: { create, prompt } };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 1,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "429",
    });

    expect(result.status).toBe("exhausted");
    expect(create).not.toHaveBeenCalled();
    if (result.status === "exhausted") expect(result.attempts).toHaveLength(1);
  });

  it("gracefully no-ops (does not crash) when the client has no session methods", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const engine = createFallbackEngine({
      client: {},
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
      failureReason: "429",
    });

    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") expect(result.attempts).toHaveLength(1);
  });

  it("accepts nested response ids and stops after a user cancellation is observed", async () => {
    const coordinator = new (await import("../src/attempt-coordinator.js")).AttemptCoordinator();
    coordinator.registerTask({ callID: "cancelled", parentSessionID: "parent", originalSubagentType: "sdd-design", generatedAlias: "alias", originalModel: "openai/gpt-4.1-mini", prompt: "work" });
    const prompt = vi.fn(async () => {
      coordinator.cancelTask({ callID: "cancelled", reason: "user_cancelled" });
      return { parts: [{ type: "text", text: "HTTP 429" }] };
    });
    const engine = createFallbackEngine({
      client: { session: { create: vi.fn(async () => ({ data: { id: "nested-child" } })), prompt } },
      quarantine: new QuarantineStore({ ttlMs: 1_000 }),
      catalog: makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] }),
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      coordinator,
    });
    const result = await engine.run({ sessionID: "parent", taskCallID: "cancelled", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
    expect(result).toMatchObject({ status: "cancelled", reason: "user_cancelled" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("quarantines model, provider, and rate-limit failures from structured SDK errors", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 1_000 });
    const responses = [
      { error: "model_not_found" },
      { error: "invalid_api_key" },
    ];
    const engine = createFallbackEngine({
      client: {
        session: {
          create: vi.fn(async () => ({ info: { id: `child-${responses.length}` } })),
          prompt: vi.fn(async () => responses.shift()),
        },
      },
      quarantine,
      catalog: makeCatalog({ "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google/gemini-2.5-pro" },
      ] }),
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });
    const result = await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
    expect(result.status).toBe("exhausted");
    expect(quarantine.isBlocked("minimax/M3")).toBe(true);
    expect(quarantine.isBlocked("google/gemini-2.5-pro")).toBe(true);
  });

  it("records malformed and empty SDK responses as non-quarantined fallback failures", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 1_000 });
    const engine = createFallbackEngine({
      client: {
        session: {
          create: vi.fn(async () => ({ id: "child" })),
          prompt: vi.fn()
            .mockResolvedValueOnce({ unexpected: true })
            .mockResolvedValueOnce({ parts: [] }),
        },
      },
      quarantine,
      catalog: makeCatalog({ "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google/gemini-2.5-pro" },
      ] }),
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });
    const result = await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
    expect(result.status).toBe("exhausted");
    expect(quarantine.snapshot()).toEqual([]);
  });

  it("skips malformed, blocked, and unranked candidates before dispatch", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 1_000 });
    quarantine.add("blocked/model", "429", 1_000, "rate_limit");
    const create = vi.fn();
    const engine = createFallbackEngine({
      client: { session: { create, prompt: vi.fn() } },
      quarantine,
      catalog: {
        byBase: {
          "sdd-design": [
            { modelId: "missing-rung" },
            { modelId: "blocked/model", ladderRung: "openai" },
            { modelId: "no-provider", ladderRung: "openai" },
            { modelId: "openai/gpt-4.1-mini", ladderRung: "openai" },
          ],
        },
      },
      ladder: DEFAULT_LADDER,
      classify: classifyError,
    });
    const result = await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
    expect(result.status).toBe("exhausted");
    expect(create).not.toHaveBeenCalled();
  });

  it("logs and continues when coordinator session bookkeeping throws", async () => {
    const coordinator = new (await import("../src/attempt-coordinator.js")).AttemptCoordinator();
    coordinator.markInternalSession = () => { throw new Error("mark failed"); };
    coordinator.unmarkInternalSession = () => { throw new Error("unmark failed"); };
    const logger = { trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const engine = createFallbackEngine({
      client: { session: { create: vi.fn(async () => ({ id: "child" })), prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "ok" }] })) } },
      quarantine: new QuarantineStore({ ttlMs: 1_000 }),
      catalog: makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] }),
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      coordinator,
      logger: logger as never,
    });
    expect((await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" })).status).toBe("success");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("stops same-provider reuse after a provider error and records non-Error create failures", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce("network down")
      .mockResolvedValueOnce({ id: "provider-error-child" });
    const prompt = vi.fn(async () => ({ error: "invalid_api_key" }));
    const engine = createFallbackEngine({
      client: { session: { create, prompt } },
      quarantine: new QuarantineStore({ ttlMs: 1_000 }),
      catalog: makeCatalog({ "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "openai/gpt-5.5" },
        { modelId: "openai/o1" },
      ] }),
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });
    const result = await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
    expect(result.status).toBe("exhausted");
    expect(create).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("absorbs a rejected best-effort abort after a prompt timeout", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(async () => { throw new Error("abort failed"); });
      const engine = createFallbackEngine({
        client: { session: { create: vi.fn(async () => ({ id: "timeout-child" })), prompt: vi.fn(() => new Promise(() => {})), abort } },
        quarantine: new QuarantineStore({ ttlMs: 1_000 }),
        catalog: makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] }),
        ladder: DEFAULT_LADDER,
        classify: classifyError,
        maxAttempts: 2,
        sessionPromptTimeoutMs: 1,
      });
      const result = engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "work", failedModel: "openai/gpt-4.1-mini", failureReason: "rate_limit" });
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).status).toBe("exhausted");
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
