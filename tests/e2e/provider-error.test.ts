import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/error-classification.js";

describe("E2E provider-error recovery", () => {
  it("retains provider-error classification", () => {
    expect(classifyError("429 too many requests, and also invalid_api_key supplied")?.type).toBe("provider_error");
  });
});
