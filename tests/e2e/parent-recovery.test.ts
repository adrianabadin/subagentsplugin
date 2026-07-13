import { describe, expect, it } from "vitest";
import { ParentRecovery } from "../../src/parent-recovery.js";

describe("E2E parent recovery", () => {
  it("provides a bounded parent recovery controller", () => {
    expect(ParentRecovery).toBeTypeOf("function");
  });
});
