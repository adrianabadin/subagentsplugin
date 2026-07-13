/**
 * Tests for the `doctor` subcommand in `src/cli.ts`.
 *
 * `runDoctor` is a pure async function that reads three on-disk caches
 * (model data, gentle-ai variants, OpenCode models) plus the static
 * ladder + phase rubric, and returns a JSON snapshot describing the
 * plugin state the user would see.
 *
 * Coverage:
 *   - Returns the documented JSON shape on success.
 *   - Falls back gracefully when caches are missing (exists:false,
 *     no provider/model counts, no throw).
 *   - Reports `wouldRegisterHooks: []` for `advisory` mode and the
 *     three-hook list for `auto` mode.
 *   - Surface the latest cache timestamp + freshness classification.
 *
 * The internal-error path (exit code 1) is covered in
 * `tests/doctor-error.test.ts` because it requires a module-level
 * `vi.mock` that is incompatible with the happy-path assertions
 * in this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { runDoctor } from "../src/cli.js";
import { writeCache } from "../src/cache.js";
import type { ModelDataCache } from "../src/types.js";

describe("runDoctor() — JSON snapshot", () => {
  let tempDir: string;
  let cachePath: string;
  let gentleAiPath: string;
  let openCodePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdout: { write: (data: string) => void };
  let stderr: { write: (data: string) => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "doctor-test-"));
    cachePath = path.join(tempDir, "model-data.json");
    gentleAiPath = path.join(tempDir, "variants.json");
    openCodePath = path.join(tempDir, "opencode-models.json");
    stdoutWrites = [];
    stderrWrites = [];
    stdout = {
      write: (data: string): void => {
        stdoutWrites.push(data);
      },
    };
    stderr = {
      write: (data: string): void => {
        stderrWrites.push(data);
      },
    };
    // Isolate `runDoctor`'s auto-detect from the user's real
    // opencode.json. Without these stubs, tests that omit an explicit
    // `options.mode` would resolve `mode: "auto"` from the developer's
    // actual config and break the "defaults to advisory" assertions.
    // We point every candidate env var at a fresh temp dir that has no
    // `opencode/opencode.json` subpath so the helper falls through to
    // the default.
    vi.stubEnv("OPENCODE_CONFIG", path.join(tempDir, "no-config.json"));
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns exit code 0 and writes valid JSON to stdout when caches are missing", async () => {
    const result = await runDoctor(
      [],
      {
        cachePath,
        gentleAiPath,
        openCodePath,
        mode: "advisory",
      },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("advisory");
    expect(parsed.wouldRegisterHooks).toEqual([]);
    expect(Array.isArray(parsed.ladder)).toBe(true);
    expect(parsed.ladder.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.phases)).toBe(true);
    expect(parsed.phases).toContain("sdd-design");
    expect(parsed.caches.modelData.exists).toBe(false);
    expect(parsed.caches.gentleAiVariants.exists).toBe(false);
    expect(parsed.caches.openCodeModels.exists).toBe(false);
    expect(Array.isArray(parsed.recommendations)).toBe(true);
    // When ALL caches are missing, we should see the populate recommendation.
    expect(
      parsed.recommendations.some((r: string) => /cache file missing/i.test(r)),
    ).toBe(true);
  });

  it("returns exit code 0 and reports wouldRegisterHooks:[] for advisory mode", async () => {
    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.wouldRegisterHooks).toEqual([]);
  });

  it("returns exit code 0 and reports the three-hook list for auto mode", async () => {
    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "auto" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.wouldRegisterHooks).toEqual([
      "config",
      "tool.execute.before",
      "tool.execute.after",
    ]);
    // Auto-mode recommendation surfaces in the list.
    expect(
      parsed.recommendations.some((r: string) => /auto mode active/i.test(r)),
    ).toBe(true);
  });

  it("reports enabled recovery capabilities for a complete client", async () => {
    const result = await runDoctor(
      [],
      {
        cachePath,
        gentleAiPath,
        openCodePath,
        mode: "auto",
        recoveryEnabled: true,
        recoveryClient: { create: true, prompt: true, abort: true, promptAsync: true, children: true },
      },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.recovery).toEqual({
      enabled: true,
      capabilities: {
        eventHook: true,
        create: true,
        prompt: true,
        abort: true,
        promptAsync: true,
        children: true,
        watchdog: true,
        parentRecovery: true,
      },
    });
  });

  it("reports disabled recovery and unavailable methods for a partial client", async () => {
    await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, recoveryEnabled: false, recoveryClient: { create: true } },
      { stdout, stderr },
    );

    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.recovery.enabled).toBe(false);
    expect(parsed.recovery.capabilities).toMatchObject({
      eventHook: false,
      create: true,
      prompt: false,
      watchdog: false,
      parentRecovery: false,
    });
  });

  it("reads a populated model-data cache and reports provider/model counts", async () => {
    const data: ModelDataCache = {
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
          "claude-sonnet-4-5": {
            variants: ["", "low", "medium", "high", "max"],
          },
        },
        openai: {
          "gpt-5.5": { variants: ["medium", "high"] },
        },
      },
      rubric: {
        "sdd-design": "high",
        "sdd-archive": "low",
      },
    };
    await writeCache(cachePath, data);

    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    const m = parsed.caches.modelData;
    expect(m.exists).toBe(true);
    expect(m.version).toBe(1);
    expect(m.generatedAt).toBe(data.generatedAt);
    expect(m.providerCount).toBe(2);
    expect(m.modelCount).toBe(3);
    // Fresh cache → recommendation should mention it.
    expect(
      parsed.recommendations.some((r: string) => /fresh/i.test(r)),
    ).toBe(true);
  });

  it("classifies an old cache as stale (no fresh recommendation)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const data: ModelDataCache = {
      version: 1,
      generatedAt: twoHoursAgo,
      providers: {},
      rubric: {},
    };
    await writeCache(cachePath, data);

    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.caches.modelData.exists).toBe(true);
    expect(
      parsed.recommendations.some((r: string) => /stale/i.test(r)),
    ).toBe(true);
  });

  it("reads a populated gentle-ai variants cache and reports provider/model counts", async () => {
    await writeFile(
      gentleAiPath,
      JSON.stringify({
        anthropic: {
          "claude-opus-4-7": ["high", "max", "xhigh"],
          "claude-sonnet-4-5": ["medium", "high"],
        },
        openai: {
          "gpt-5.5": ["medium", "high"],
        },
      }),
    );

    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    const g = parsed.caches.gentleAiVariants;
    expect(g.exists).toBe(true);
    expect(g.providerCount).toBe(2);
    expect(g.modelCount).toBe(3);
  });

  it("reads a populated OpenCode models cache and reports provider count", async () => {
    await writeFile(
      openCodePath,
      JSON.stringify({
        anthropic: { id: "anthropic", models: {} },
        openai: { id: "openai", models: {} },
        minimax: { id: "minimax", models: {} },
      }),
    );

    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    const o = parsed.caches.openCodeModels;
    expect(o.exists).toBe(true);
    expect(o.providerCount).toBe(3);
  });

  it("handles malformed cache files gracefully (no throw, exists:false)", async () => {
    // Write invalid JSON to the model-data cache path.
    await writeFile(cachePath, "{not json");

    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.caches.modelData.exists).toBe(false);
  });

  it("defaults to advisory mode when no mode override is provided", async () => {
    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.wouldRegisterHooks).toEqual([]);
  });

  it("defaults to the built-in DEFAULT_LADDER when no override is provided", async () => {
    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "auto" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.ladder).toEqual([
      "minimax",
      "google-antigravity",
      "openai",
      "glm-5.2",
      "anthropic",
    ]);
  });

  it("emits no stderr text on the happy path (only stdout JSON)", async () => {
    const result = await runDoctor(
      [],
      { cachePath, gentleAiPath, openCodePath, mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
  });
});
