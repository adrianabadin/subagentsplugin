/**
 * PR4 unit tests — CLI argument parsing + runCli handler.
 *
 * RED phase: these tests reference src/cli.ts which is still a stub in
 * PR1 form. The new tests call `parseCliArgs` and `runCli` (the latter
 * writing JSON to stdout), which do not exist yet.
 *
 * Acceptance criteria (per task 4.2):
 *   - forecast --phase <p> [--preset <name>] [--cache <path>] → JSON on stdout
 *   - Exit 0 on success, exit 1 on invalid args.
 *
 * The CLI also invokes `forecast()` under the hood. We mock the I/O
 * surface so tests stay deterministic and fast (no real FS reads unless
 * we explicitly point them at a temp cache).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { parseCliArgs, runCli } from "../src/cli.js";
import type { ModelDataCache } from "../src/types.js";
import { writeCache } from "../src/cache.js";

describe("cli — parseCliArgs", () => {
  it("parses --phase and produces a ForecastInput-shaped result", () => {
    const result = parseCliArgs(["--phase", "sdd-design"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.phase).toBe("sdd-design");
      expect(result.input.preset).toBeUndefined();
      expect(result.input.cachePath).toBeUndefined();
    }
  });

  it("parses --preset", () => {
    const result = parseCliArgs(["--phase", "sdd-design", "--preset", "performance"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.preset).toBe("performance");
    }
  });

  it("parses --cache", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--cache",
      "/tmp/foo.json",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.cachePath).toBe("/tmp/foo.json");
    }
  });

  it("parses all three flags together", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-tasks",
      "--preset",
      "economy",
      "--cache",
      "/var/cache/model.json",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({
        phase: "sdd-tasks",
        preset: "economy",
        cachePath: "/var/cache/model.json",
      });
    }
  });

  it("rejects arguments when --phase is missing", () => {
    const result = parseCliArgs(["--preset", "performance"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("phase");
    }
  });

  it("rejects arguments when --phase has no value", () => {
    const result = parseCliArgs(["--phase"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/phase/);
    }
  });

  it("rejects unknown flags", () => {
    const result = parseCliArgs(["--phase", "sdd-design", "--unknown", "bar"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("unknown");
    }
  });

  it("rejects --preset with no value", () => {
    const result = parseCliArgs(["--phase", "sdd-design", "--preset"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("preset");
    }
  });

  it("rejects --cache with no value", () => {
    const result = parseCliArgs(["--phase", "sdd-design", "--cache"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("cache");
    }
  });

  it("accepts an empty args list only if it provides no input — i.e. always fails (--phase required)", () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(false);
  });
});

describe("cli — runCli end-to-end (mocked stdio)", () => {
  let tempDir: string;
  let cachePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cli-test-"));
    cachePath = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    };
    await writeCache(cachePath, data);

    stdoutWrites = [];
    stderrWrites = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes a valid Forecast JSON to stdout and returns exit code 0", async () => {
    const result = await runCli(["--phase", "sdd-design", "--cache", cachePath]);

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    expect(stdoutWrites.length).toBeGreaterThan(0);
    const stdout = stdoutWrites.join("");
    // The stdout must be valid JSON.
    const parsed = JSON.parse(stdout);
    expect(parsed.model).toBe("anthropic/claude-opus-4-7");
    expect(parsed.effort).toBe("high");
    expect(parsed.fallback).toBe(false);
    expect(typeof parsed.reasoning).toBe("string");
  });

  it("returns exit code 1 and writes an error to stderr when --phase is missing", async () => {
    const result = await runCli(["--preset", "performance"]);

    expect(result.exitCode).toBe(1);
    expect(stdoutWrites.join("")).toBe("");
    expect(stderrWrites.join("").toLowerCase()).toContain("phase");
  });

  it("returns exit code 1 on unknown flag", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--bogus",
      "value",
    ]);

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("").toLowerCase()).toContain("unknown");
  });

  it("passes --preset through to the forecast engine", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--preset",
      "balanced",
      "--cache",
      cachePath,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // sdd-design + balanced preset → opus
    expect(parsed.model).toBe("anthropic/claude-opus-4-7");
  });
});

describe("cli — PR2 evidence-based-forecasting flags", () => {
  // PR2 adds --verbose + 6 context flags. The CLI must:
  //   - Parse them into `input.verbose` and `input.context`
  //   - When verbose, output the full VerboseForecast JSON
  //   - When not verbose, output the canonical 4-field Forecast JSON
  //     (backward compatibility)
  //   - Reject malformed values (non-number diff-lines, unknown breadth)

  let tempDir: string;
  let cachePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cli-pr2-"));
    cachePath = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    };
    await writeCache(cachePath, data);

    stdoutWrites = [];
    stderrWrites = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("--verbose sets input.verbose=true", () => {
    const result = parseCliArgs(["--phase", "sdd-design", "--verbose"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.verbose).toBe(true);
  });

  it("--diff-lines <n> parses a number into context.diffLines", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "150",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.diffLines).toBe(150);
  });

  it("--file <path> is repeatable and collected into context.files", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--file",
      "src/a.ts",
      "--file",
      "src/b.ts",
      "--file",
      "tests/a.test.ts",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.context?.files).toEqual([
        "src/a.ts",
        "src/b.ts",
        "tests/a.test.ts",
      ]);
    }
  });

  it("--symbol <name> is repeatable and collected into context.symbols", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--symbol",
      "forecast",
      "--symbol",
      "clampEffort",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.context?.symbols).toEqual(["forecast", "clampEffort"]);
    }
  });

  it("--risk-domain <domain> sets context.riskDomain", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--risk-domain",
      "architecture",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.riskDomain).toBe("architecture");
  });

  it("--context-breadth <narrow|moderate|wide> sets context.contextBreadth", () => {
    for (const breadth of ["narrow", "moderate", "wide"] as const) {
      const result = parseCliArgs([
        "--phase",
        "sdd-design",
        "--context-breadth",
        breadth,
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.context?.contextBreadth).toBe(breadth);
    }
  });

  it("--modality <type> is repeatable and collected into context.modality", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--modality",
      "code",
      "--modality",
      "docs",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.context?.modality).toEqual(["code", "docs"]);
    }
  });

  it("rejects --context-breadth with an invalid value", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--context-breadth",
      "huge",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/breadth/);
    }
  });

  it("rejects --diff-lines with a non-numeric value", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "not-a-number",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/diff-lines|number/);
    }
  });

  it("combines all context flags into a single ForecastInput.context object", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "200",
      "--file",
      "src/forecast.ts",
      "--symbol",
      "forecast",
      "--risk-domain",
      "feature",
      "--context-breadth",
      "moderate",
      "--modality",
      "code",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.context).toEqual({
        diffLines: 200,
        files: ["src/forecast.ts"],
        symbols: ["forecast"],
        riskDomain: "feature",
        contextBreadth: "moderate",
        modality: ["code"],
      });
    }
  });

  it("runCli: --verbose outputs the full VerboseForecast JSON (7 fields)", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--verbose",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // 4-field base
    expect(parsed.model).toBe("anthropic/claude-opus-4-7");
    expect(parsed.effort).toBe("high");
    expect(parsed.fallback).toBe(false);
    expect(typeof parsed.reasoning).toBe("string");
    // 3 verbose extensions
    expect(Array.isArray(parsed.evidence)).toBe(true);
    expect(parsed.evidence.length).toBeGreaterThan(0);
    expect(typeof parsed.confidence).toBe("number");
    expect(Array.isArray(parsed.alternatives)).toBe(true);
  });

  it("runCli: default (no --verbose) outputs the canonical 4-field Forecast JSON", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      // No --verbose
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // Exactly 4 keys, no verbose extensions.
    expect(Object.keys(parsed).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
  });

  it("runCli: context flags alone (no --verbose) preserve 4-field shape but augment reasoning", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--diff-lines",
      "150",
      "--risk-domain",
      "feature",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // Exactly 4 keys
    expect(Object.keys(parsed).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    // Reasoning mentions the scoring pipeline ran
    expect(parsed.reasoning.toLowerCase()).toMatch(/evidence/);
  });
});

// ---------------------------------------------------------------------------
// PR3 acceptance — CLI verbose contract + new context flags (PR2 + design #1227)
//
// These tests pin the orchestrator-facing CLI contract documented in the
// updated SKILL.md (task 3.5):
//   - --verbose produces the full VerboseForecast JSON (7 fields: 4 base + 3 verbose).
//   - The 6 new context flags parse cleanly into ForecastInput.context.
//   - Default (no --verbose) emits the canonical 4-field Forecast JSON
//     (proposal #1224 success criterion #1: existing CLI/output remains usable).
//   - W1 contract: --verbose + context surfaces non-Anthropic alternatives
//     without overriding the chosen model field (PR3 W1 acceptance).
// ---------------------------------------------------------------------------

describe("cli — PR3 acceptance: verbose contract + new flags + W1 default-model preserved", () => {
  let tempDir: string;
  let cachePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cli-pr3-"));
    cachePath = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    };
    await writeCache(cachePath, data);

    stdoutWrites = [];
    stderrWrites = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- --verbose contract ----

  it("PR3 acceptance: --verbose emits 7-field VerboseForecast JSON (4 base + 3 verbose)", async () => {
    // PR3 acceptance for proposal #1224 success criterion #2:
    // "Verbose mode returns evidence citations, confidence, and alternatives."
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--verbose",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // 4 base
    expect(typeof parsed.model).toBe("string");
    expect(typeof parsed.effort).toBe("string");
    expect(typeof parsed.reasoning).toBe("string");
    expect(typeof parsed.fallback).toBe("boolean");
    // 3 verbose
    expect(Array.isArray(parsed.evidence)).toBe(true);
    expect(parsed.evidence.length).toBeGreaterThan(0);
    expect(typeof parsed.confidence).toBe("number");
    expect(parsed.confidence).toBeGreaterThanOrEqual(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(parsed.alternatives)).toBe(true);
    expect(parsed.alternatives.length).toBeGreaterThan(0);
  });

  // ---- default 4-field backward compatibility ----

  it("PR3 acceptance: default (no --verbose) emits exactly the 4-field Forecast JSON", async () => {
    // Proposal #1224 success criterion #1: "Existing CLI/output remains
    // usable and default 4-field Forecast JSON still passes."
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(Object.keys(parsed).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    expect("evidence" in parsed).toBe(false);
    expect("confidence" in parsed).toBe(false);
    expect("alternatives" in parsed).toBe(false);
  });

  // ---- new context flags parsing ----

  it("PR3 acceptance: --diff-lines parses integer into context.diffLines", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "42",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.diffLines).toBe(42);
  });

  it("PR3 acceptance: --file is repeatable and accumulates into context.files", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--file",
      "src/a.ts",
      "--file",
      "src/b.ts",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("PR3 acceptance: --symbol is repeatable and accumulates into context.symbols", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--symbol",
      "forecast",
      "--symbol",
      "scoreCandidates",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.symbols).toEqual(["forecast", "scoreCandidates"]);
  });

  it("PR3 acceptance: --risk-domain parses string into context.riskDomain", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--risk-domain",
      "architecture",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.riskDomain).toBe("architecture");
  });

  it("PR3 acceptance: --context-breadth parses narrow|moderate|wide", () => {
    for (const breadth of ["narrow", "moderate", "wide"] as const) {
      const result = parseCliArgs([
        "--phase",
        "sdd-design",
        "--context-breadth",
        breadth,
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.context?.contextBreadth).toBe(breadth);
    }
  });

  it("PR3 acceptance: --modality is repeatable and accumulates into context.modality", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--modality",
      "code",
      "--modality",
      "docs",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.context?.modality).toEqual(["code", "docs"]);
  });

  it("PR3 acceptance: --context-breadth rejects invalid values", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--context-breadth",
      "huge",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toMatch(/breadth/);
  });

  it("PR3 acceptance: --diff-lines rejects non-numeric values", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "not-a-number",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toMatch(/diff-lines|number/);
  });

  it("PR3 acceptance: all 6 context flags combine into a single ForecastInput.context", () => {
    const result = parseCliArgs([
      "--phase",
      "sdd-design",
      "--diff-lines",
      "200",
      "--file",
      "src/forecast.ts",
      "--symbol",
      "forecast",
      "--risk-domain",
      "feature",
      "--context-breadth",
      "moderate",
      "--modality",
      "code",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.context).toEqual({
        diffLines: 200,
        files: ["src/forecast.ts"],
        symbols: ["forecast"],
        riskDomain: "feature",
        contextBreadth: "moderate",
        modality: ["code"],
      });
    }
  });

  // ---- W1 contract: --verbose with context does NOT override chosen model ----

  it("PR3 acceptance (W1): --verbose with context surfaces non-Anthropic alternatives without overriding model", async () => {
    // W1 resolution (PR2 gate #1235 / decision #1236): the chosen model
    // field is NEVER overridden by evidence-based preference. The
    // non-Anthropic preference is surfaced via `alternatives[]`.
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--verbose",
      "--diff-lines",
      "800",
      "--context-breadth",
      "wide",
      "--risk-domain",
      "architecture",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // Chosen model stays on the cache/preset path.
    expect(parsed.model).toBe("anthropic/claude-opus-4-7");
    // Verbose output is present (additive only).
    expect(Array.isArray(parsed.alternatives)).toBe(true);
    // Non-Anthropic alternatives are surfaced for orchestrator visibility.
    const nonAnthropic = parsed.alternatives.filter(
      (a: { model: string }) => !a.model.startsWith("anthropic/"),
    );
    expect(nonAnthropic.length).toBeGreaterThan(0);
    // Chosen model is NEVER the top-scored alternative (W1 hard contract).
    const topAlt = parsed.alternatives[0];
    expect(parsed.model).not.toBe(topAlt.model);
  });

  // ---- runCli end-to-end: verbose + context together still parses & emits ----

  it("PR3 acceptance: --verbose + all context flags combine cleanly (parse + emit)", async () => {
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--verbose",
      "--diff-lines",
      "100",
      "--file",
      "src/forecast.ts",
      "--symbol",
      "forecast",
      "--risk-domain",
      "feature",
      "--context-breadth",
      "moderate",
      "--modality",
      "code",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // 4 base
    expect(parsed.model).toBe("anthropic/claude-opus-4-7");
    expect(parsed.fallback).toBe(false);
    // 3 verbose
    expect(Array.isArray(parsed.evidence)).toBe(true);
    expect(parsed.evidence.length).toBeGreaterThan(0);
    expect(typeof parsed.confidence).toBe("number");
    expect(Array.isArray(parsed.alternatives)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR1 (forecast-orchestration-layer) — `--select` CLI flag.
//
// Spec contract (spec #1274 "Stable advisory selection decision" + "Legacy
// forecast unchanged"):
//   - `--select` is a new CLI flag that emits a SelectDecision JSON
//     (7 fields: action, subagent_type, model, effort, reason, confidence,
//     evidence) instead of the canonical 4-field Forecast JSON.
//   - Without `--select`, the legacy 4-field Forecast JSON contract is
//     preserved (regression-pinned per proposal #1259 success criteria).
//   - The two output shapes are mutually exclusive: a single CLI invocation
//     emits ONE of them, never both.
// ---------------------------------------------------------------------------

describe("cli — PR1 (forecast-orchestration-layer) — --select flag", () => {
  let tempDir: string;
  let cachePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cli-select-"));
    cachePath = path.join(tempDir, "model-data.json");
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
      },
      rubric: {},
    };
    await writeCache(cachePath, data);

    stdoutWrites = [];
    stderrWrites = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- parseCliArgs contract ----

  it("--select parses to a 'select: true' flag on the parse result", () => {
    const result = parseCliArgs(["--select", "--phase", "sdd-design"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.select).toBe(true);
      // ForecastInput itself is unchanged — `select` is a CLI-layer
      // routing concern, not an engine input.
      expect(result.input.phase).toBe("sdd-design");
    }
  });

  it("default (no --select) leaves select=false", () => {
    const result = parseCliArgs(["--phase", "sdd-design"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.select).toBe(false);
    }
  });

  // ---- runCli end-to-end: --select emits SelectDecision JSON ----

  it("--select emits a SelectDecision JSON with exactly 7 fields", async () => {
    const result = await runCli([
      "--select",
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = stdoutWrites.join("");
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);

    // Exactly the 7 SelectDecision keys; no Forecast fields leak in.
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "action",
        "confidence",
        "effort",
        "evidence",
        "model",
        "reason",
        "subagent_type",
      ].sort(),
    );
  });

  it("--select emits action from the closed enum {switch, keep-default}", async () => {
    const result = await runCli([
      "--select",
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(["switch", "keep-default"]).toContain(parsed.action);
    // Subagent type is a non-empty string when the runner produced one.
    expect(typeof parsed.subagent_type).toBe("string");
    expect(typeof parsed.model).toBe("string");
    expect(typeof parsed.effort).toBe("string");
    expect(typeof parsed.reason).toBe("string");
    expect(typeof parsed.evidence).toBe("string");
    expect(typeof parsed.confidence).toBe("number");
    expect(parsed.confidence).toBeGreaterThanOrEqual(0);
    expect(parsed.confidence).toBeLessThanOrEqual(1);
  });

  // ---- regression: default forecast path UNCHANGED when --select is absent ----

  it("default (no --select) preserves the canonical 4-field Forecast JSON (regression-pinned)", async () => {
    // This test pins the spec #1274 "Legacy forecast unchanged" rule:
    // a CLI invocation that does NOT pass --select MUST keep the
    // 228-test legacy 4-field contract intact.
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      // No --select
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(Object.keys(parsed).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    // The 7 SelectDecision fields MUST NOT appear in the forecast path.
    expect("action" in parsed).toBe(false);
    expect("subagent_type" in parsed).toBe(false);
    expect("confidence" in parsed).toBe(false);
    expect("evidence" in parsed).toBe(false);
    expect("reason" in parsed).toBe(false);
  });

  // ---- mutual exclusion: forecast and select are separate paths ----

  it("--select and --verbose together: --select wins (decision emitted, not forecast)", async () => {
    // When both flags are present, the CLI MUST route to the select path
    // (decision JSON) rather than the verbose forecast path. The two
    // outputs are mutually exclusive.
    const result = await runCli([
      "--phase",
      "sdd-design",
      "--cache",
      cachePath,
      "--select",
      "--verbose",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    // Decision shape: 7 SelectDecision keys, no Forecast fields.
    expect("action" in parsed).toBe(true);
    expect("reasoning" in parsed).toBe(false);
    expect("fallback" in parsed).toBe(false);
    expect("alternatives" in parsed).toBe(false);
  });

  it("--select errors on missing --phase (same contract as forecast path)", async () => {
    const result = await runCli(["--select"]);
    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("").toLowerCase()).toContain("phase");
  });
});
