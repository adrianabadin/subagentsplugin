/**
 * Tests for the interactive `forecast config` CLI subcommand.
 *
 * Coverage targets the contract surface — pure parsers, validation, and
 * state mutations — without spinning up an actual `node:readline`
 * instance. The interactive loop is tested via the script runner with a
 * mocked readline interface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { readdirSync, readFileSync } from "node:fs";

import {
  parseConfigArgs,
  loadConfigState,
  saveConfigState,
  validateAvailability,
  validateConfidence,
  validateCost,
  validatePositiveInt,
  validateBenchmarkScore,
  validateDate,
} from "../src/cli-config.js";
import type { BenchmarkEntry } from "../src/benchmark-registry.js";

function seedEntry(key: string, overrides: Partial<BenchmarkEntry> = {}): BenchmarkEntry {
  return {
    key,
    benchmarks: { mmlu: 0.85 },
    availability: "available",
    source: "test",
    date: "2026-07-08",
    confidence: 0.9,
    ...overrides,
  };
}

describe("parseConfigArgs", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseConfigArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root).toBeUndefined();
    expect(r.nonInteractive).toBe(false);
  });

  it("parses --root", () => {
    const r = parseConfigArgs(["--root", "/tmp/proj"]);
    expect(r).toEqual({ ok: true, root: "/tmp/proj", nonInteractive: false });
  });

  it("parses --non-interactive", () => {
    const r = parseConfigArgs(["--non-interactive"]);
    expect(r).toEqual({ ok: true, nonInteractive: true });
  });

  it("rejects unknown flags", () => {
    const r = parseConfigArgs(["--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --root without a value", () => {
    const r = parseConfigArgs(["--root"]);
    expect(r.ok).toBe(false);
  });
});

describe("validators", () => {
  it("validateAvailability accepts the three literals", () => {
    expect(validateAvailability("available").ok).toBe(true);
    expect(validateAvailability("unknown").ok).toBe(true);
    expect(validateAvailability("unavailable").ok).toBe(true);
  });

  it("validateAvailability rejects anything else", () => {
    expect(validateAvailability("maybe").ok).toBe(false);
    expect(validateAvailability("").ok).toBe(false);
    expect(validateAvailability(42).ok).toBe(false);
  });

  it("validateConfidence accepts finite 0..1", () => {
    expect(validateConfidence("0").ok).toBe(true);
    expect(validateConfidence("1").ok).toBe(true);
    expect(validateConfidence("0.5").ok).toBe(true);
  });

  it("validateConfidence rejects out-of-range and non-finite", () => {
    expect(validateConfidence("-0.1").ok).toBe(false);
    expect(validateConfidence("1.1").ok).toBe(false);
    expect(validateConfidence("abc").ok).toBe(false);
    expect(validateConfidence("").ok).toBe(false);
  });

  it("validateCost accepts non-negative finite numbers", () => {
    expect(validateCost("0").ok).toBe(true);
    expect(validateCost("0.5").ok).toBe(true);
    expect(validateCost("100").ok).toBe(true);
  });

  it("validateCost rejects negative or non-finite", () => {
    expect(validateCost("-1").ok).toBe(false);
    expect(validateCost("abc").ok).toBe(false);
  });

  it("validatePositiveInt accepts positive integers", () => {
    expect(validatePositiveInt("1").ok).toBe(true);
    expect(validatePositiveInt("1000000").ok).toBe(true);
  });

  it("validatePositiveInt rejects zero, negative, non-integer", () => {
    expect(validatePositiveInt("0").ok).toBe(false);
    expect(validatePositiveInt("-5").ok).toBe(false);
    expect(validatePositiveInt("1.5").ok).toBe(false);
    expect(validatePositiveInt("abc").ok).toBe(false);
  });

  it("validateBenchmarkScore accepts 0..1 finite", () => {
    expect(validateBenchmarkScore("0").ok).toBe(true);
    expect(validateBenchmarkScore("1").ok).toBe(true);
    expect(validateBenchmarkScore("0.42").ok).toBe(true);
  });

  it("validateBenchmarkScore rejects out-of-range", () => {
    expect(validateBenchmarkScore("-0.1").ok).toBe(false);
    expect(validateBenchmarkScore("1.5").ok).toBe(false);
  });

  it("validateDate accepts YYYY-MM-DD parseable strings", () => {
    expect(validateDate("2026-07-08").ok).toBe(true);
    expect(validateDate("2026-01-01").ok).toBe(true);
  });

  it("validateDate rejects unparseable strings", () => {
    expect(validateDate("yesterday").ok).toBe(false);
    expect(validateDate("").ok).toBe(false);
  });
});

describe("loadConfigState", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cfg-load-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns compiled registry when forecast-data/benchmarks.json is absent", async () => {
    const map = await loadConfigState(tmpRoot);
    expect(map.size).toBeGreaterThan(0);
    expect(map.has("anthropic/claude-opus-4-7")).toBe(true);
  });

  it("loads editable overrides from the injected global benchmarks path", async () => {
    const globalPath = path.join(tmpRoot, "global", "benchmarks.json");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify([
        seedEntry("opencode-go/deepseek-v4-pro", {
          availability: "unavailable",
          source: "from-global",
          confidence: 0.88,
        }),
      ]),
      "utf8",
    );

    const map = await loadConfigState(tmpRoot, { globalPath });

    expect(map.get("opencode-go/deepseek-v4-pro")?.source).toBe("from-global");
    expect(map.get("opencode-go/deepseek-v4-pro")?.availability).toBe("unavailable");
  });

  it("does not load repo-local forecast-data into the editable global state", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "benchmarks.json"),
      JSON.stringify([
        seedEntry("openai/gpt-5.5", { source: "from-repo-local", confidence: 0.99 }),
      ]),
      "utf8",
    );
    const map = await loadConfigState(tmpRoot);
    expect(map.get("openai/gpt-5.5")?.source).not.toBe("from-repo-local");
  });

  it("appends new keys from global benchmarks", async () => {
    const globalPath = path.join(tmpRoot, "global", "benchmarks.json");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify([seedEntry("custom/new-model")]),
      "utf8",
    );
    const map = await loadConfigState(tmpRoot, { globalPath });
    expect(map.has("custom/new-model")).toBe(true);
  });
});

describe("saveConfigState", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cfg-save-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes the default global benchmarks file atomically", async () => {
    const map = new Map<string, BenchmarkEntry>();
    map.set("custom/test-model", seedEntry("custom/test-model"));
    const out = await saveConfigState(tmpRoot, map, {
      globalPath: path.join(tmpRoot, "global", "benchmarks.json"),
    });
    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe("custom/test-model");
  });

  it("overwrites existing file", async () => {
    const globalPath = path.join(tmpRoot, "global", "benchmarks.json");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(globalPath, "[]", "utf8");
    const map = new Map<string, BenchmarkEntry>();
    map.set("custom/replaced", seedEntry("custom/replaced"));
    const out = await saveConfigState(tmpRoot, map, { globalPath });
    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written[0].key).toBe("custom/replaced");
  });

  it("writes to the injected global benchmarks path", async () => {
    const globalPath = path.join(tmpRoot, "global", "benchmarks.json");
    const map = new Map<string, BenchmarkEntry>();
    map.set("custom/global-model", seedEntry("custom/global-model"));

    const out = await saveConfigState(tmpRoot, map, { globalPath });

    expect(out).toBe(globalPath);
    const written = JSON.parse(await readFile(globalPath, "utf8"));
    expect(written[0].key).toBe("custom/global-model");
  });
});

describe("config interactive loop — script runner with mocked readline", () => {
  let tmpRoot: string;
  let globalPath: string;
  let stdoutWrites: string[];
  let responses: string[];
  let stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  type RlMock = EventEmitter & {
    question: (prompt: string, cb: (answer: string) => void) => void;
    close: () => void;
    resume: () => void;
  };
  let rl: RlMock;

  function setupMock(): void {
    responses = [];
    stdoutWrites = [];
    const stdinMock = Object.assign(new EventEmitter(), { isTTY: true, resume() { return stdinMock; } });
    stdin = stdinMock as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
    rl = Object.assign(new EventEmitter(), {
      question: (prompt: string, cb: (answer: string) => void) => {
        stdoutWrites.push(prompt);
        const next = responses.shift();
        if (next === undefined) {
          // EOF: simulate end-of-input. Deliver an empty string so the
          // awaiting `ask()` resolves, then close so the loop exits.
          cb("");
          rl.emit("close");
          return;
        }
        cb(next);
      },
      close: () => rl.emit("close"),
      resume: () => stdin,
    });
  }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cfg-loop-"));
    globalPath = path.join(tmpRoot, "global", "benchmarks.json");
    setupMock();
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      stdoutWrites.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      stdoutWrites.push(String(s));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function io(): { stdin: NodeJS.ReadableStream & { isTTY?: boolean }; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; globalPath: string; createReadline: (s: NodeJS.ReadableStream, o: NodeJS.WritableStream) => typeof rl } {
    return {
      stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      globalPath,
      createReadline: () => rl,
    };
  }

  it("edits a confidence value, persists on quit (y)", async () => {
    const { runConfig } = await import("../src/cli-config.js");
    responses = ["e openai/gpt-5.5", "c 0.42", "x", "q", "y"];

    const result = await runConfig({ ok: true, root: tmpRoot, nonInteractive: false }, io());
    expect(result.persisted).toBe(true);
    const map = await loadConfigState(tmpRoot, { globalPath });
    expect(map.get("openai/gpt-5.5")?.confidence).toBeCloseTo(0.42);
  });

  it("rejects invalid confidence without aborting the loop", async () => {
    const { runConfig } = await import("../src/cli-config.js");
    responses = ["e openai/gpt-5.5", "c 1.5", "c 0.7", "x", "q", "n"];

    await runConfig({ ok: true, root: tmpRoot, nonInteractive: false }, io());
    const out = stdoutWrites.join("");
    expect(out).toContain("invalid confidence");
  });

  it("does NOT persist when user answers n on quit", async () => {
    const { runConfig } = await import("../src/cli-config.js");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(globalPath, "[]", "utf8");

    responses = ["e custom/nope", "c 0.5", "x", "q", "n"];
    const result = await runConfig({ ok: true, root: tmpRoot, nonInteractive: false }, io());
    expect(result.persisted).toBe(false);
    const written = JSON.parse(await readFile(globalPath, "utf8"));
    expect(written).toEqual([]);
  });

  it("refuses to run when stdin is not a TTY and --non-interactive is not set", async () => {
    const { runConfig } = await import("../src/cli-config.js");
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    responses = [];
    const result = await runConfig({ ok: true, root: tmpRoot, nonInteractive: false }, io());
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("TTY");
  });

  it("adds a new model when key does not exist", async () => {
    const { runConfig } = await import("../src/cli-config.js");
    responses = ["a custom/new-model", "x", "q", "y"];

    const result = await runConfig({ ok: true, root: tmpRoot, nonInteractive: false }, io());
    expect(result.persisted).toBe(true);

    const map = await loadConfigState(tmpRoot, { globalPath });
    expect(map.has("custom/new-model")).toBe(true);
    const entry = map.get("custom/new-model")!;
    expect(entry.availability).toBe("available");
  });
});

describe("built config bundle", () => {
  it("does not emit dynamic require for node:readline in the ESM output", () => {
    const distDir = path.join(process.cwd(), "dist");
    const built = readdirSync(distDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(path.join(distDir, name), "utf8"))
      .join("\n");

    expect(built).not.toContain("__require(\"readline\")");
    expect(built).not.toContain("__require(\"node:readline\")");
  });
});
