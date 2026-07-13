import { describe, expect, it } from "vitest";
import { createFallbackEngine } from "../../src/fallback.js";
import { QuarantineStore } from "../../src/quarantine.js";
import { DEFAULT_LADDER } from "../../src/policy.js";

describe("E2E exhausted recovery", () => {
  it("produces non-empty terminal output", async () => {
    const engine = createFallbackEngine({ client: {}, quarantine: new QuarantineStore(), catalog: { byBase: {} }, ladder: DEFAULT_LADDER, classify: () => null });
    const result = await engine.run({ sessionID: "parent", originalSubagentType: "sdd-design", prompt: "", failedModel: "openai/a", failureReason: "429" });
    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") expect(result.output.length).toBeGreaterThan(0);
  });
});
