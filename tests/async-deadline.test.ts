import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withDeadline, DeadlineError } from "../src/async-deadline.js";

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves before timeout", async () => {
    const run = vi.fn(async () => "success");
    const promise = withDeadline("op1", 1000, run);
    
    vi.advanceTimersByTime(500);
    const result = await promise;
    
    expect(result).toBe("success");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects/propagates rejection before timeout", async () => {
    const run = vi.fn(async () => {
      throw new Error("fail");
    });
    const promise = withDeadline("op2", 1000, run);
    
    vi.advanceTimersByTime(500);
    await expect(promise).rejects.toThrow("fail");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects with DeadlineError on timeout", async () => {
    const run = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 2000)));
    const promise = withDeadline("op3", 1000, run);
    
    vi.advanceTimersByTime(1005);
    await expect(promise).rejects.toThrow(DeadlineError);
    
    try {
      await promise;
    } catch (err: any) {
      expect(err.operation).toBe("op3");
      expect(err.timeoutMs).toBe(1000);
    }
  });

  it("timer is cleared on resolve and reject", async () => {
    const spyClear = vi.spyOn(global, "clearTimeout");
    
    // Resolve case
    const run1 = vi.fn(async () => "ok");
    await withDeadline("op4", 1000, run1);
    expect(spyClear).toHaveBeenCalled();
    
    spyClear.mockClear();
    
    // Reject case
    const run2 = vi.fn(async () => {
      throw new Error("err");
    });
    try {
      await withDeadline("op5", 1000, run2);
    } catch {}
    expect(spyClear).toHaveBeenCalled();
    
    spyClear.mockRestore();
  });

  it("timer.unref() is invoked if present", async () => {
    // Restore real timers temporarily for this test to avoid conflicting with vitest fake timers
    vi.useRealTimers();
    
    const originalSetTimeout = global.setTimeout;
    const fakeTimer = {
      unref: vi.fn(),
    };
    global.setTimeout = vi.fn().mockReturnValue(fakeTimer) as any;
    try {
      const run = vi.fn(async () => "ok");
      await withDeadline("op6", 1000, run);
      expect(fakeTimer.unref).toHaveBeenCalled();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it("synchronous throw inside run() propagates", async () => {
    const run = () => {
      throw new Error("sync fail");
    };
    await expect(withDeadline("op7", 1000, run)).rejects.toThrow("sync fail");
  });
});
