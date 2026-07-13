import { describe, expect, it } from "vitest";
import { classifySdkResult } from "../../src/attempt-outcome.js";

describe("E2E empty-output recovery", () => {
  it("treats an empty SDK response as a recoverable failure", () => {
    expect(classifySdkResult({ parts: [] }).kind).toBe("failure");
  });
});
