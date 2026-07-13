import { describe, expect, it } from "vitest";
import { DeadlineError } from "../../src/async-deadline.js";

describe("E2E hung fallback recovery", () => {
  it("has a dedicated deadline failure", () => {
    expect(new DeadlineError("session.prompt", 1)).toMatchObject({ operation: "session.prompt", timeoutMs: 1 });
  });
});
