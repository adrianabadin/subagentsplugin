import { describe, expect, it } from "vitest";
import { providerOf } from "../../src/model-groups.js";

describe("E2E provider diversity", () => {
  it("preserves normalized provider routing", () => {
    expect(providerOf("minimax/M3")).toBe("minimax");
  });
});
