import { describe, expect, it } from "vitest";
import { AttemptCoordinator } from "../../src/attempt-coordinator.js";

describe("E2E recovery memory cleanup", () => {
  it("clears all active coordinator state on disposal", () => {
    const coordinator = new AttemptCoordinator();
    coordinator.dispose();
    expect(coordinator.tasksByCallID.size).toBe(0);
    expect(coordinator.attemptsByID.size).toBe(0);
  });
});
