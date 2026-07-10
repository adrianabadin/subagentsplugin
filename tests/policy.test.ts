/**
 * PR1 — selection-policy unit tests (forecast-orchestration-layer).
 *
 * RED phase (task 1.4 + 1.6): these tests reference `loadPolicy` and
 * the default-policy constants from `../src/policy.js`, which do NOT
 * exist yet. Running `npm test` before the implementation lands MUST
 * fail with a "Cannot find module" error.
 *
 * Spec contract (spec #1274 "Layered policy resolution" + "Resilient
 * policy loading"):
 *   - Merge order: project file → plugin options → user file →
 *     built-in defaults. Per-key, top wins.
 *   - Built-in defaults: `mode: "advisory"`,
 *     `confidenceThreshold: 0.6`, ladder
 *     `[minimax, google-antigravity, openai, glm-5.2, anthropic]`.
 *   - Invalid / missing / empty policy MUST fall back to defaults
 *     with a warning. Never throws.
 *
 * Policy file format (JSON):
 *   {
 *     "mode": "off" | "advisory" | "auto",
 *     "confidenceThreshold": number in [0, 1],
 *     "ladder": ["minimax" | "google-antigravity" | "openai" | "glm-5.2" | "anthropic", ...]
 *   }
 * All fields are optional; only the keys present in a layer override
 * lower-priority layers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  DEFAULT_LADDER,
  DEFAULT_POLICY,
  loadPolicy,
} from "../src/policy.js";
import type {
  LadderRung,
  SelectionMode,
} from "../src/types.js";

/** Helper: writes a JSON policy file at the given absolute path. */
async function writePolicyFile(filePath: string, content: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(content, null, 2), "utf8");
}

describe("policy — built-in defaults (spec 'Layered policy resolution')", () => {
  it("exports the canonical built-in defaults", () => {
    expect(DEFAULT_POLICY.mode).toBe("advisory");
    expect(DEFAULT_POLICY.confidenceThreshold).toBe(0.6);
  });

  it("exports the canonical 5-rung default ladder (cheapest first)", () => {
    expect(Array.from(DEFAULT_LADDER)).toEqual([
      "minimax",
      "google-antigravity",
      "openai",
      "glm-5.2",
      "anthropic",
    ] satisfies LadderRung[]);
  });

  it("returns the built-in defaults when no layers are supplied", async () => {
    const warnings: string[] = [];
    const resolved = await loadPolicy({ warningSink: (msg) => warnings.push(msg) });
    expect(resolved.mode).toBe("advisory");
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
    // All keys sourced from built-in defaults.
    expect(resolved.sources.mode).toBe("built-in");
    expect(resolved.sources.confidenceThreshold).toBe("built-in");
    expect(resolved.sources.ladder).toBe("built-in");
  });
});

describe("policy — merge order (project > plugin > user > built-in)", () => {
  let tempDir: string;
  let projectPath: string;
  let userPath: string;
  let warnings: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "policy-test-"));
    projectPath = path.join(tempDir, "project-policy.json");
    userPath = path.join(tempDir, "user-policy.json");
    warnings = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("user file overrides built-in defaults when nothing else is supplied", async () => {
    await writePolicyFile(userPath, { mode: "auto", confidenceThreshold: 0.9 });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("auto");
    expect(resolved.confidenceThreshold).toBe(0.9);
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
    expect(resolved.sources.mode).toBe("user");
    expect(resolved.sources.confidenceThreshold).toBe("user");
    expect(resolved.sources.ladder).toBe("built-in");
  });

  it("project file overrides user file for the same key", async () => {
    await writePolicyFile(userPath, { mode: "auto", confidenceThreshold: 0.9 });
    await writePolicyFile(projectPath, { mode: "off" });
    const resolved = await loadPolicy({
      projectPolicyPath: projectPath,
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    // project file's `mode` wins; user file's `confidenceThreshold`
    // (not present in project) still wins over built-in default.
    expect(resolved.mode).toBe("off");
    expect(resolved.confidenceThreshold).toBe(0.9);
    expect(resolved.sources.mode).toBe("project");
    expect(resolved.sources.confidenceThreshold).toBe("user");
  });

  it("plugin options override user file for the same key", async () => {
    await writePolicyFile(userPath, { mode: "auto" });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      pluginOptions: { mode: "off" },
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("off");
    expect(resolved.sources.mode).toBe("plugin");
  });

  it("project file overrides plugin options for the same key", async () => {
    await writePolicyFile(projectPath, { mode: "auto" });
    const resolved = await loadPolicy({
      projectPolicyPath: projectPath,
      pluginOptions: { mode: "off" },
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("auto");
    expect(resolved.sources.mode).toBe("project");
  });

  it("merges per-key: project sets mode, plugin sets confidenceThreshold, both apply", async () => {
    await writePolicyFile(projectPath, { mode: "auto" });
    const resolved = await loadPolicy({
      projectPolicyPath: projectPath,
      pluginOptions: { confidenceThreshold: 0.85 },
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("auto");            // from project
    expect(resolved.confidenceThreshold).toBe(0.85); // from plugin
    expect(resolved.sources.mode).toBe("project");
    expect(resolved.sources.confidenceThreshold).toBe("plugin");
  });

  it("merges per-key for ladder: project ladder wins over user ladder", async () => {
    await writePolicyFile(userPath, { ladder: ["openai", "anthropic"] });
    await writePolicyFile(projectPath, { ladder: ["anthropic", "openai"] });
    const resolved = await loadPolicy({
      projectPolicyPath: projectPath,
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.ladder).toEqual(["anthropic", "openai"] satisfies LadderRung[]);
    expect(resolved.sources.ladder).toBe("project");
  });

  it("respects full priority order: project > plugin > user > built-in", async () => {
    // Each layer sets only one key. Result must reflect the highest
    // priority value for each.
    await writePolicyFile(userPath, { mode: "auto" });
    const resolved = await loadPolicy({
      projectPolicyPath: projectPath, // empty file, contributes nothing
      pluginOptions: { mode: "off", confidenceThreshold: 0.7 },
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    // mode: project absent → plugin 'off' wins over user 'auto'.
    expect(resolved.mode).toBe("off");
    // confidenceThreshold: project absent → plugin '0.7' wins.
    expect(resolved.confidenceThreshold).toBe(0.7);
    expect(resolved.sources.mode).toBe("plugin");
    expect(resolved.sources.confidenceThreshold).toBe("plugin");
  });
});

describe("policy — resilient fallback (spec 'Resilient policy loading')", () => {
  let tempDir: string;
  let projectPath: string;
  let userPath: string;
  let warnings: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "policy-fallback-"));
    projectPath = path.join(tempDir, "project-policy.json");
    userPath = path.join(tempDir, "user-policy.json");
    warnings = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("falls back to defaults with a warning when the user file is missing", async () => {
    const resolved = await loadPolicy({
      userPolicyPath: path.join(tempDir, "nonexistent.json"),
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("advisory");
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(warnings.some((w) => /user policy/i.test(w))).toBe(true);
  });

  it("falls back to defaults with a warning when the project file is missing", async () => {
    const resolved = await loadPolicy({
      projectPolicyPath: path.join(tempDir, "nonexistent.json"),
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.mode).toBe("advisory");
    expect(warnings.some((w) => /project policy/i.test(w))).toBe(true);
  });

  it("falls back per-key when the user file is malformed JSON", async () => {
    await writeFile(userPath, "this is { not json", "utf8");
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    // User layer contributed nothing → built-in defaults apply.
    expect(resolved.mode).toBe("advisory");
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(warnings.some((w) => /user policy|malformed|json/i.test(w))).toBe(true);
  });

  it("falls back per-key when the user file has an invalid mode", async () => {
    await writePolicyFile(userPath, { mode: "maybe" });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    // Invalid mode → fall back to default; confidenceThreshold still
    // missing in user → falls back to default too.
    expect(resolved.mode).toBe("advisory");
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(warnings.some((w) => /mode/i.test(w))).toBe(true);
  });

  it("falls back per-key when the user file has an invalid confidenceThreshold", async () => {
    await writePolicyFile(userPath, { confidenceThreshold: 1.5 });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(warnings.some((w) => /threshold/i.test(w))).toBe(true);
  });

  it("falls back per-key when the user file has an empty ladder", async () => {
    await writePolicyFile(userPath, { ladder: [] });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
    expect(warnings.some((w) => /ladder/i.test(w))).toBe(true);
  });

  it("falls back per-key when the user file has an unknown ladder rung", async () => {
    await writePolicyFile(userPath, { ladder: ["minimax", "unknown-vendor", "anthropic"] });
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
    expect(warnings.some((w) => /ladder/i.test(w))).toBe(true);
  });

  it("never throws on a totally missing environment (no paths, no options)", async () => {
    // Specifically: no paths, no plugin options, no warning sink.
    // Resolves with built-in defaults; emits nothing.
    const resolved = await loadPolicy();
    expect(resolved.mode).toBe("advisory");
    expect(resolved.confidenceThreshold).toBe(0.6);
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
  });

  it("accepts a non-array `ladder` and falls back to defaults with warning", async () => {
    await writePolicyFile(userPath, { ladder: "minimax,openai" }); // wrong shape
    const resolved = await loadPolicy({
      userPolicyPath: userPath,
      warningSink: (msg) => warnings.push(msg),
    });
    expect(resolved.ladder).toEqual(DEFAULT_LADDER);
    expect(warnings.some((w) => /ladder/i.test(w))).toBe(true);
  });
});

describe("policy — defense: warning sink is optional and never required", () => {
  it("does not throw when no warning sink is supplied", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "policy-nowarn-"));
    try {
      const userPath = path.join(tempDir, "user-policy.json");
      await writePolicyFile(userPath, { mode: "lol" });
      // No warning sink — silent fallback.
      const resolved = await loadPolicy({ userPolicyPath: userPath });
      expect(resolved.mode).toBe("advisory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws nothing when warning sink is a vi.fn()", async () => {
    const sink = vi.fn();
    const tempDir = await mkdtemp(path.join(tmpdir(), "policy-vifn-"));
    try {
      const userPath = path.join(tempDir, "user-policy.json");
      await writePolicyFile(userPath, { mode: "auto" });
      const resolved = await loadPolicy({
        userPolicyPath: userPath,
        warningSink: sink,
      });
      expect(resolved.mode).toBe("auto");
      expect(sink).not.toHaveBeenCalled(); // valid input → no warning
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("policy — ResolvedPolicy shape", () => {
  it("exposes `mode`, `confidenceThreshold`, `ladder`, and `sources`", async () => {
    const resolved = await loadPolicy();
    expect(typeof resolved.mode).toBe("string");
    expect(["off", "advisory", "auto"]).toContain(resolved.mode as SelectionMode);
    expect(typeof resolved.confidenceThreshold).toBe("number");
    expect(Array.isArray(resolved.ladder)).toBe(true);
    expect(resolved.sources).toEqual({
      mode: expect.stringMatching(/^(built-in|user|plugin|project)$/),
      confidenceThreshold: expect.stringMatching(/^(built-in|user|plugin|project)$/),
      ladder: expect.stringMatching(/^(built-in|user|plugin|project)$/),
    });
  });

  it("treats confidenceThreshold in [0, 1] as valid", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "policy-ct-"));
    try {
      const userPath = path.join(tempDir, "user-policy.json");
      await writePolicyFile(userPath, { confidenceThreshold: 0 });
      const resolved = await loadPolicy({ userPolicyPath: userPath });
      expect(resolved.confidenceThreshold).toBe(0);

      await writePolicyFile(userPath, { confidenceThreshold: 1 });
      const r2 = await loadPolicy({ userPolicyPath: userPath });
      expect(r2.confidenceThreshold).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
