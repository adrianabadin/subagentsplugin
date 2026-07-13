import { describe, expect, it, vi } from "vitest";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";

function completeTask(coordinator: AttemptCoordinator, id: number): void {
  const callID = `call-${id}`;
  coordinator.registerTask({
    callID,
    parentSessionID: `parent-${id}`,
    originalSubagentType: "sdd-design",
    generatedAlias: "__mf_sdd-design__minimax-m3_123456",
    originalModel: "minimax/M3",
    prompt: "work",
  });
  coordinator.bindTaskSession({ callID, sessionID: `child-${id}` });
  coordinator.reportOriginalResult({ callID, output: "complete" });
  coordinator.finalize({ callID });
}

describe("AttemptCoordinator stress cleanup", () => {
  it("bounds maps and timers while finalizing 500 tasks", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator({
        maxTombstones: 50,
        tombstoneTtlMs: 1_000,
      });

      for (let id = 0; id < 500; id += 1) completeTask(coordinator, id);

      expect(coordinator.tasksByCallID.size).toBe(0);
      expect(coordinator.tasksByParentSessionID.size).toBe(0);
      expect(coordinator.callIDBySessionID.size).toBe(0);
      expect(coordinator.completedTombstones.size).toBeLessThanOrEqual(50);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(50);

      vi.advanceTimersByTime(1_000);
      expect(coordinator.completedTombstones.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up 50 concurrent task completions without leaving timers or indices", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AttemptCoordinator({ tombstoneTtlMs: 1_000 });

      await Promise.all(
        Array.from({ length: 50 }, (_, id) => Promise.resolve().then(() => completeTask(coordinator, id))),
      );

      expect(coordinator.tasksByCallID.size).toBe(0);
      expect(coordinator.tasksByParentSessionID.size).toBe(0);
      expect(coordinator.callIDBySessionID.size).toBe(0);
      expect(coordinator.completedTombstones.size).toBe(50);
      expect(vi.getTimerCount()).toBe(50);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(coordinator.completedTombstones.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
