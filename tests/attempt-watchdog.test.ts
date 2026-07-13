import { describe, expect, it, vi } from "vitest";
import { AttemptWatchdog } from "../src/attempt-watchdog.js";

describe("AttemptWatchdog", () => {
  it("fires bind, first-activity, inactivity, tool and hard timeouts using policy overrides", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: string[] = [];
      const watchdog = new AttemptWatchdog({
        timeouts: { childBindMs: 10, firstActivityMs: 20, inactivityMs: 30, toolMs: 40, hardMs: 50 },
        onTimeout: ({ kind }) => { timeouts.push(kind); },
      });
      watchdog.watch("a", { waitingForBind: true });
      await vi.advanceTimersByTimeAsync(10);
      watchdog.bind("a");
      await vi.advanceTimersByTimeAsync(20);
      watchdog.activity("a");
      await vi.advanceTimersByTimeAsync(30);
      watchdog.toolStart("a");
      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(50);
      expect(timeouts).toEqual(expect.arrayContaining(["child_bind", "first_activity", "inactivity", "tool", "hard"]));
    } finally { vi.useRealTimers(); }
  });

  it("resets inactivity on heartbeat, pauses it for permission/tool, and resumes it", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: string[] = [];
      const watchdog = new AttemptWatchdog({ timeouts: { firstActivityMs: 100, inactivityMs: 20, hardMs: 1000 }, onTimeout: ({ kind }) => { timeouts.push(kind); } });
      watchdog.watch("a");
      watchdog.bind("a");
      watchdog.activity("a");
      await vi.advanceTimersByTimeAsync(10);
      watchdog.activity("a");
      await vi.advanceTimersByTimeAsync(11);
      watchdog.permissionPending("a", true);
      await vi.advanceTimersByTimeAsync(100);
      watchdog.permissionPending("a", false);
      watchdog.activity("a");
      watchdog.toolStart("a");
      await vi.advanceTimersByTimeAsync(100);
      watchdog.toolEnd("a");
      await vi.advanceTimersByTimeAsync(20);
      expect(timeouts).toEqual(["inactivity"]);
    } finally { vi.useRealTimers(); }
  });

  it("ignores timers from an old generation", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new AttemptWatchdog({ timeouts: { hardMs: 10 }, onTimeout });
      watchdog.watch("a");
      watchdog.watch("a");
      await vi.advanceTimersByTimeAsync(10);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
