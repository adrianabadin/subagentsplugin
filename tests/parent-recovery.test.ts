import { describe, expect, it, vi } from "vitest";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { ParentRecovery } from "../src/parent-recovery.js";

function setup(options: { children?: unknown; promptAsync?: () => Promise<unknown>; prompt?: () => Promise<unknown>; abort?: () => Promise<unknown> } = {}) {
  const coordinator = new AttemptCoordinator();
  coordinator.registerTask({
    callID: "call-1", parentSessionID: "parent-1", originalSubagentType: "sdd-design",
    generatedAlias: "__mf_sdd-design__openai_gpt-4-1_a1b2c3", originalModel: "openai/gpt-4.1", prompt: "work",
    recoveryToken: "recovery-1",
  });
  coordinator.bindTaskSession({ callID: "call-1", sessionID: "original-child" });
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const promptAsync = vi.fn<(opts: unknown) => Promise<unknown>>(options.promptAsync === undefined ? async () => undefined : options.promptAsync);
  const prompt = vi.fn<(opts: unknown) => Promise<unknown>>(options.prompt === undefined ? async () => undefined : options.prompt);
  const children = vi.fn(async () => options.children ?? []);
  const recovery = new ParentRecovery({
    coordinator,
    client: { abort, children, ...(options.promptAsync === undefined ? { promptAsync } : { promptAsync }), ...(options.prompt === undefined ? { prompt } : { prompt }) },
    settlementMs: 15,
    enqueueTimeoutMs: 10,
  });
  return { coordinator, recovery, abort, children, promptAsync, prompt };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("ParentRecovery", () => {
  it("stops during the first settlement window when the after hook arrives", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, promptAsync, abort } = setup();
      recovery.schedule("call-1");
      recovery.noteAfter("call-1");
      await advance(45);
      expect(abort).not.toHaveBeenCalled();
      expect(promptAsync).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("stops during the second settlement window when the after hook arrives", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, promptAsync, abort } = setup();
      recovery.schedule("call-1");
      await advance(15);
      expect(abort).toHaveBeenCalledWith({ path: { id: "original-child" } });
      recovery.noteAfter("call-1");
      await advance(30);
      expect(promptAsync).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("performs a second child abort, settles the parent, then enqueues recovery", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, abort, promptAsync, coordinator } = setup();
      coordinator.tasksByCallID.get("call-1")!.fallbackResult = { status: "success", output: "recovered", model: "other/model", attempts: [] };
      recovery.schedule("call-1");
      await advance(45);
      expect(abort).toHaveBeenNthCalledWith(1, { path: { id: "original-child" } });
      expect(abort).toHaveBeenNthCalledWith(2, { path: { id: "parent-1" } });
      expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "parent-1" } }));
      expect(coordinator.tasksByCallID.get("call-1")?.state).toBe("parent-recovery-enqueued");
    } finally { vi.useRealTimers(); }
  });

  it("continues to enqueue when the parent abort fails", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, promptAsync } = setup({ abort: async () => { throw new Error("abort failed"); } });
      recovery.schedule("call-1");
      await advance(45);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("falls back to prompt with noReply when promptAsync rejects", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, prompt } = setup({ promptAsync: async () => { throw new Error("no async"); } });
      recovery.schedule("call-1");
      await advance(45);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ noReply: true }) }));
    } finally { vi.useRealTimers(); }
  });

  it("records an explicit terminal client-capability error when neither prompt API exists", async () => {
    vi.useFakeTimers();
    try {
      const { coordinator } = setup();
      const recovery = new ParentRecovery({ coordinator, client: { abort: async () => undefined }, settlementMs: 15 });
      recovery.schedule("call-1");
      await advance(45);
      expect(recovery.terminalErrors.get("call-1")).toMatch(/prompt API/i);
    } finally { vi.useRealTimers(); }
  });

  it("falls back after the promptAsync enqueue deadline", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, prompt } = setup({ promptAsync: () => new Promise(() => {}) });
      recovery.schedule("call-1");
      await advance(55);
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("uses the unique recovery token and truncates fallback output to 32k", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, promptAsync, coordinator } = setup();
      const output = "x".repeat(32_100);
      coordinator.tasksByCallID.get("call-1")!.fallbackResult = { status: "exhausted", output, attempts: [] };
      recovery.schedule("call-1");
      await advance(45);
      const text = (promptAsync.mock.calls[0]?.[0] as { body: { parts: Array<{ text: string }> } }).body.parts[0]!.text;
      expect(text).toContain("recovery_id: recovery-1");
      expect(text).toContain("fallback_status: exhausted");
      expect(text).toMatch(/\[truncated by model-forecast: \d+ chars omitted\]/);
      const embedded = text.match(/<MODEL_FORECAST_RESULT>\n([\s\S]*)\n<\/MODEL_FORECAST_RESULT>/)?.[1] ?? "";
      expect(embedded.length).toBeLessThanOrEqual(32_000);
      expect(text.length).toBeLessThan(33_000);
    } finally { vi.useRealTimers(); }
  });

  it("schedules and enqueues each recovery only once, including after a late after hook", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, promptAsync } = setup();
      recovery.schedule("call-1");
      recovery.schedule("call-1");
      await advance(45);
      recovery.noteAfter("call-1");
      await advance(45);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not enqueue when cancellation occurs before the enqueue", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, coordinator, promptAsync } = setup();
      recovery.schedule("call-1");
      await advance(30);
      coordinator.cancelTask({ callID: "call-1", reason: "user_cancelled" });
      await advance(15);
      expect(promptAsync).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not issue a fallback prompt after cancellation wins a pending enqueue", async () => {
    vi.useFakeTimers();
    try {
      let resolveAsync: (() => void) | undefined;
      const { recovery, coordinator, prompt } = setup({ promptAsync: () => new Promise<void>((resolve) => { resolveAsync = resolve; }) });
      recovery.schedule("call-1");
      await advance(45);
      coordinator.cancelTask({ callID: "call-1", reason: "user_cancelled" });
      resolveAsync?.();
      await advance(10);
      expect(prompt).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not abort the parent when another active, unrelated child exists", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, abort, promptAsync } = setup({ children: [{ id: "original-child", status: "running" }, { id: "unrelated-child", status: "busy" }] });
      recovery.schedule("call-1");
      await advance(45);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("protects the parent when an unrelated active child is nested under info", async () => {
    vi.useFakeTimers();
    try {
      const { recovery, abort } = setup({ children: [{ info: { id: "original-child", status: "running" } }, { info: { id: "unrelated-child", status: "busy" } }] });
      recovery.schedule("call-1");
      await advance(45);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
