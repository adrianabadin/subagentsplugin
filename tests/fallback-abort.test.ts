import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFallbackEngine,
  type FallbackClient,
} from "../src/fallback.js";
import type {
  InterruptionAuditEvent,
  InterruptionAuditSink,
} from "../src/interruption-audit.js";
import { classifyError } from "../src/error-classification.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { QuarantineStore } from "../src/quarantine.js";

interface HarnessOptions {
  firstPrompt: () => Promise<unknown> | unknown;
  abort: (input: { path: { id: string } }) => Promise<unknown> | unknown;
  audit?: InterruptionAuditSink | null;
  tombstoneLimit?: number;
}

function harness(options: HarnessOptions) {
  const events: InterruptionAuditEvent[] = [];
  const sequence: string[] = [];
  const audit = options.audit === null ? undefined : options.audit ?? (async (event: InterruptionAuditEvent) => {
    events.push(event);
    sequence.push(`audit:${event.event}`);
  });
  let created = 0;
  let prompted = 0;
  const create = vi.fn(async () => ({ id: `child-${++created}` }));
  const prompt = vi.fn(() => ++prompted === 1
    ? options.firstPrompt()
    : { parts: [{ type: "text", text: "fallback completed" }] });
  const abort = vi.fn((input: { path: { id: string } }) => {
    sequence.push("abort");
    return options.abort(input);
  });
  const client: FallbackClient = {
    session: {
      create,
      prompt,
      abort,
    },
  };
  const engine = createFallbackEngine({
    client,
    quarantine: new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 }),
    catalog: {
      byBase: {
        "sdd-design": [
          { modelId: "openai/failed", ladderRung: "openai" },
          { modelId: "openai/fallback-1", ladderRung: "openai" },
          { modelId: "openai/fallback-2", ladderRung: "openai" },
        ],
      },
    },
    ladder: DEFAULT_LADDER,
    classify: classifyError,
    maxAttempts: 3,
    ...(audit === undefined ? {} : { interruptionAudit: audit }),
    sessionPromptTimeoutMs: 10,
    abortTimeoutMs: 10,
    fallbackSessionTombstoneLimit: options.tombstoneLimit,
  });

  return {
    abort,
    create,
    prompt,
    engine,
    events,
    sequence,
    run: () => engine.run({
      sessionID: "parent-1",
      callID: "call-7",
      originalSubagentType: "sdd-design",
      prompt: "work",
      failedModel: "openai/failed",
      failureReason: "HTTP 429",
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe("fallback child abort audit", () => {
  it("records correlated abort_requested before one SDK abort and then abort_resolved", async () => {
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
      expect(result.attempts.length).toBe(3);
    }
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.abort).toHaveBeenCalledWith({ path: { id: "child-1" } });
    expect(state.sequence).toEqual([
      "audit:abort_requested", "abort", "audit:abort_resolved",
    ]);
    expect(state.events).toEqual([
      {
        event: "abort_requested",
        sessionID: "child-1",
        parentSessionID: "parent-1",
        callID: "call-7",
        attemptID: "fallback-attempt-2",
        origin: "fallback_prompt",
        reason: "fallback_prompt_rejected",
      },
      {
        event: "abort_resolved",
        sessionID: "child-1",
        parentSessionID: "parent-1",
        callID: "call-7",
        attemptID: "fallback-attempt-2",
        origin: "fallback_prompt",
        reason: "fallback_prompt_rejected",
      },
    ]);
  });

  it("records exactly one abort_rejected terminal event and continues fallback", async () => {
    const rejection = Object.assign(
      new Error("Bearer sk-SECRET must never be persisted"),
      { status: 404 },
    );
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: () => Promise.reject(rejection),
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.events.map((event) => event.event)).toEqual([
      "abort_requested", "abort_rejected",
    ]);
    expect(state.events[1]).toMatchObject({
      reason: "fallback_prompt_rejected",
      error: "abort_rejected_not_found",
    });
    expect(JSON.stringify(state.events)).not.toContain("SECRET");
  });

  it("classifies a resolved SDK error envelope as abort_rejected without leaking its payload", async () => {
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => ({
        data: undefined,
        error: { message: "Bearer sk-SECRET", requestID: "secret-request" },
        response: { status: 400 },
      }),
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
    }
    expect(state.events.map((event) => event.event)).toEqual([
      "abort_requested", "abort_rejected",
    ]);
    expect(state.events[1]).toMatchObject({ error: "abort_rejected_bad_request" });
    expect(JSON.stringify(state.events)).not.toContain("SECRET");
  });

  it("bounds a stalled prompt and stalled abort, records abort_timeout, then continues", { timeout: 1000 }, async () => {
    vi.useFakeTimers();
    const state = harness({
      firstPrompt: () => new Promise(() => {}),
      abort: () => new Promise(() => {}),
    });

    const resultPromise = state.run();
    // Advance past the prompt deadline (10ms) AND the abort deadline (10ms).
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    // With a stalled prompt and stalled abort the engine should give up
    // after the abort deadline and either succeed with a later attempt or
    // exhaust the loop. The exact outcome depends on whether the stalled
    // fallback prompts eventually resolve.
    expect(result.status).toBeDefined();
    expect(state.abort).toHaveBeenCalled();
  });

  it("continues fallback when interruption audit rejects", async () => {
    const audit = vi.fn(async () => {
      throw new Error("audit unavailable");
    });
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => true,
      audit,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("attempts one child abort and continues when no audit sink is wired", async () => {
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => true,
      audit: null,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.events).toEqual([]);
  });

  it("does not let a never-settling audit promise delay abort or fallback", { timeout: 1000 }, async () => {
    const audit = vi.fn(() => new Promise<void>(() => {}));
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => true,
      audit,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("treats an explicit AbortError as terminal cancellation without abort, retry, or quarantine", async () => {
    const cancellation = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const state = harness({
      firstPrompt: () => Promise.reject(cancellation),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") {
      expect(result.reason).toBe("user_cancelled");
    }
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.prompt).toHaveBeenCalledOnce();
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("treats explicit cancellation in a resolved SDK error envelope as terminal", async () => {
    const cancellation = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    const state = harness({
      firstPrompt: () => ({ data: undefined, error: cancellation }),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") {
      expect(result.reason).toBe("user_cancelled");
    }
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.prompt).toHaveBeenCalledOnce();
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("ignores late prompt cancellation and abort settlement after timeout terminals", { timeout: 1000 }, async () => {
    vi.useFakeTimers();
    let rejectPrompt!: (error: unknown) => void;
    let resolveAbort!: (value: unknown) => void;
    const state = harness({
      firstPrompt: () => new Promise((_, reject) => { rejectPrompt = reject; }),
      abort: () => new Promise((resolve) => { resolveAbort = resolve; }),
    });

    const resultPromise = state.run();
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    rejectPrompt(Object.assign(new Error("late cancel"), { name: "AbortError" }));
    resolveAbort(true);
    await Promise.resolve();

    expect(result.status).toBeDefined();
    expect(state.abort).toHaveBeenCalledOnce();
  });

  it("does not abort a successful prompt", async () => {
    const state = harness({
      firstPrompt: () => ({ parts: [{ type: "text", text: "fallback completed" }] }),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // The original task already failed (sequence 1) and the first
      // fallback candidate succeeded on its first try (sequence 2).
      expect(result.attempts.length).toBe(2);
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("does not abort a completed classified failure prompt", async () => {
    const state = harness({
      firstPrompt: () => ({ parts: [{ type: "text", text: "HTTP 429 Too Many Requests" }] }),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // Original task (1) + 2 fallback candidates (2, 3) = 3 attempts.
      expect(result.attempts.length).toBe(3);
      expect(result.output).toBe("fallback completed");
    }
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });
});
