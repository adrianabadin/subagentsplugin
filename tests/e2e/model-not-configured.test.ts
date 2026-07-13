import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/error-classification.js";

describe("E2E model-not-configured recovery", () => {
  it("retains the exact-model classification used by recovery", () => {
    expect(classifyError("model not found for provider")?.type).toBe("model_not_configured");
  });
});
