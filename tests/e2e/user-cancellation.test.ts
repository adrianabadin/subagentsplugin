import { describe, expect, it } from "vitest";
import { decideOriginalResult } from "../../src/recovery-arbitration.js";

describe("E2E user cancellation", () => {
  it("keeps cancellation ahead of fallback output", () => {
    expect(decideOriginalResult({ userCancelled: true, state: "cancelled" } as never, "output").action).toBe("preserve");
  });
});
