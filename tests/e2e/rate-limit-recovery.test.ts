import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AttemptCoordinator } from "../../src/attempt-coordinator.js";
import { createAfterHook } from "../../src/hooks.js";
import { DEFAULT_LADDER } from "../../src/policy.js";
import { QuarantineStore } from "../../src/quarantine.js";

describe("E2E rate-limit recovery", () => {
  it("uses coordinator-only recovery surfaces and publishes only the root plugin and API exports", async () => {
    const coordinator = new AttemptCoordinator();
    const hook = createAfterHook({
      coordinator,
      quarantine: new QuarantineStore({ now: () => 1_700_000_000 }),
      catalog: { byBase: {} },
      ladder: DEFAULT_LADDER,
      fallback: {
        client: {
          session: {
            create: vi.fn(),
            prompt: vi.fn(),
          },
        },
      },
    });

    expect("fallbackSessionIDs" in hook).toBe(false);

    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./api"]);
  });
});
