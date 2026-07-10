/**
 * PR1 smoke test. Proves the vitest test runner, globals, and TypeScript
 * ESM pipeline all work end-to-end. Feature tests arrive in PR2+.
 */

import { describe, expect, it } from "vitest";

describe("PR1 bootstrap smoke", () => {
  it("loads vitest globals via tsconfig types", () => {
    expect(typeof describe).toBe("function");
    expect(typeof it).toBe("function");
    expect(typeof expect).toBe("function");
  });

  it("resolves ESM imports of source stubs", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
    expect(await mod.default()).toEqual({});
  });

  it("root module is a clean OpenCode plugin entry (default function, no extra runtime exports)", async () => {
    // Live E2E regression: OpenCode's plugin loader iterates every runtime
    // export of the package-root module and requires each to be a Plugin
    // function. When src/index.ts also re-exported the public API barrel
    // (constants like CONTEXT_SIZE_THRESHOLDS, SCORING_WEIGHTS, and helper
    // functions), the loader rejected the package with
    // `Plugin export is not a function`.
    //
    // The package root MUST therefore expose ONLY a default plugin
    // function — no named runtime exports. Public/programmatic API lives
    // in src/api.ts (package export `./api`).
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
    const runtimeKeys = Object.keys(mod);
    expect(runtimeKeys).toEqual(["default"]);
  });
});
