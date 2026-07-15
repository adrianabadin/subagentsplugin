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
    promptTimeoutMs: 10,
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

    expect(result).toMatchObject({ success: true, output: "fallback completed", attempts: 3 });
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

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
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

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
    expect(state.events.map((event) => event.event)).toEqual([
      "abort_requested", "abort_rejected",
    ]);
    expect(state.events[1]).toMatchObject({ error: "abort_rejected_bad_request" });
    expect(JSON.stringify(state.events)).not.toContain("SECRET");
  });

  it("bounds a stalled prompt and stalled abort, records abort_timeout, then continues", { timeout: 250 }, async () => {
    vi.useFakeTimers();
    const state = harness({
      firstPrompt: () => new Promise(() => {}),
      abort: () => new Promise(() => {}),
    });

    const resultPromise = state.run();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.events.map((event) => event.event)).toEqual([
      "abort_requested", "abort_timeout",
    ]);
    expect(state.events[0]?.reason).toBe("fallback_prompt_timeout");
    expect(state.events[1]).toMatchObject({
      reason: "fallback_prompt_timeout",
      error: "deadline_exceeded",
    });
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

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
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

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
    expect(state.abort).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.events).toEqual([]);
  });

  it("does not let a never-settling audit promise delay abort or fallback", { timeout: 250 }, async () => {
    const audit = vi.fn(() => new Promise<void>(() => {}));
    const state = harness({
      firstPrompt: () => Promise.reject(new Error("prompt transport failed")),
      abort: async () => true,
      audit,
    });

    const result = await state.run();

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
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

    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      output: "[model-forecast] FALLBACK CANCELLED: child prompt cancelled for sdd-design.",
    });
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

    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.prompt).toHaveBeenCalledOnce();
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("ignores late prompt cancellation and abort settlement after timeout terminals", { timeout: 250 }, async () => {
    vi.useFakeTimers();
    let rejectPrompt!: (error: unknown) => void;
    let resolveAbort!: (value: unknown) => void;
    const state = harness({
      firstPrompt: () => new Promise((_, reject) => { rejectPrompt = reject; }),
      abort: () => new Promise((resolve) => { resolveAbort = resolve; }),
    });

    const resultPromise = state.run();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;
    rejectPrompt(Object.assign(new Error("late cancel"), { name: "AbortError" }));
    resolveAbort(true);
    await Promise.resolve();

    expect(result).toMatchObject({ success: true, output: "fallback completed" });
    expect(state.events.map((event) => event.event)).toEqual([
      "abort_requested", "abort_timeout",
    ]);
    expect(state.abort).toHaveBeenCalledOnce();
  });

  it("keeps active IDs guarded and bounds retired fallback session tombstones", async () => {
    let activeWasGuarded = false;
    let state!: ReturnType<typeof harness>;
    state = harness({
      firstPrompt: () => {
        activeWasGuarded = state.engine.fallbackSessionIDs.has("child-1");
        return { parts: [{ type: "text", text: "fallback completed" }] };
      },
      abort: async () => true,
      tombstoneLimit: 2,
    });

    await state.run();
    await state.run();
    await state.run();

    expect(activeWasGuarded).toBe(true);
    expect([...state.engine.fallbackSessionIDs]).toEqual(["child-2", "child-3"]);
  });

  it.each([
    ["successful", "fallback completed", 2],
    ["completed classified failure", "HTTP 429 Too Many Requests", 3],
  ])("does not abort a %s prompt", async (_label, firstOutput, attempts) => {
    const state = harness({
      firstPrompt: () => ({ parts: [{ type: "text", text: firstOutput }] }),
      abort: async () => true,
    });

    const result = await state.run();

    expect(result).toMatchObject({ success: true, attempts });
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });
});
