import { describe, expect, it, vi } from "vitest";
import { safeAbortSession } from "../src/session-abort.js";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";

describe("safeAbortSession", () => {
  it("registers the plugin abort before invoking the SDK and reports success", async () => {
    const coordinator = new AttemptCoordinator();
    const order: string[] = [];
    const result = await safeAbortSession({
      client: { abort: vi.fn(async () => { order.push("sdk"); }) },
      coordinator,
      sessionID: "child-1",
      callID: "call-1",
      attemptID: "attempt-1",
      origin: "plugin-watchdog",
      reason: "inactivity_timeout",
    });

    expect(coordinator.pluginAbortSessionIDs.get("child-1")?.reason).toBe("inactivity_timeout");
    expect(order).toEqual(["sdk"]);
    expect(result.status).toBe("fulfilled");
  });

  it("treats a rejected or timed-out SDK abort as requested", async () => {
    vi.useFakeTimers();
    try {
      const rejected = await safeAbortSession({
        client: { abort: vi.fn(async () => { throw new Error("nope"); }) },
        coordinator: new AttemptCoordinator(), sessionID: "s1", callID: "c1", attemptID: "a1",
        origin: "plugin-watchdog", reason: "hard_timeout",
      });
      expect(rejected.status).toBe("rejected");

      const pending = safeAbortSession({
        client: { abort: vi.fn(() => new Promise(() => {})) },
        coordinator: new AttemptCoordinator(), sessionID: "s2", callID: "c2", attemptID: "a2",
        origin: "plugin-watchdog", reason: "hard_timeout", timeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect((await pending).status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows exactly two abort requests for a session", async () => {
    let now = 0;
    const coordinator = new AttemptCoordinator({ now: () => now });
    const abort = vi.fn(async () => {});
    const input = { client: { abort }, coordinator, sessionID: "s", callID: "c", attemptID: "a", origin: "plugin-watchdog" as const, reason: "hard_timeout", now: () => now };

    expect((await safeAbortSession(input)).status).toBe("fulfilled");
    now = 15_000;
    expect((await safeAbortSession(input)).status).toBe("fulfilled");
    now = 30_000;
    expect((await safeAbortSession(input)).status).toBe("skipped");
    expect(abort).toHaveBeenCalledTimes(2);
  });
});
