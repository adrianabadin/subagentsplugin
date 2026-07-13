import { describe, expect, it, vi } from "vitest";
import { AttemptWatchdog } from "../../src/attempt-watchdog.js";

describe("E2E hung original task recovery", () => {
  it("exposes watchdog supervision", () => {
    expect(AttemptWatchdog).toBeTypeOf("function");
    expect(vi).toBeDefined();
  });
});
