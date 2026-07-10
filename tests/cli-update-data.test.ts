/**
 * Tests for the `update-data` CLI subcommand.
 *
 * Spec scenario (`sdd/forecast-ux-maintenance/spec.md`):
 *   - Valid JSON → `benchmarks.json` written with entries.
 *   - Missing file → error reported; no data written.
 *   - Malformed JSON → error reported; no data written.
 *   - Partial invalid entries → error reported with line context;
 *     existing data is preserved (no partial write).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  parseUpdateDataArgs,
  runUpdateData,
} from "../src/cli-update-data.js";

describe("parseUpdateDataArgs", () => {
  it("requires --from-file", () => {
    const r = parseUpdateDataArgs([]);
    expect(r.ok).toBe(false);
  });

  it("parses --from-file", () => {
    const r = parseUpdateDataArgs(["--from-file", "data.json"]);
    expect(r).toEqual({ ok: true, fromFile: "data.json" });
  });

  it("parses --root", () => {
    const r = parseUpdateDataArgs(["--from-file", "data.json", "--root", "/tmp/proj"]);
    expect(r).toEqual({ ok: true, fromFile: "data.json", root: "/tmp/proj" });
  });

  it("rejects unknown flags", () => {
    const r = parseUpdateDataArgs(["--from-file", "x.json", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --from-file without value", () => {
    const r = parseUpdateDataArgs(["--from-file"]);
    expect(r.ok).toBe(false);
  });
});

describe("runUpdateData", () => {
  let tmpRoot: string;
  let fromFile: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "update-data-"));
    fromFile = path.join(tmpRoot, "incoming.json");
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function validEntry(key: string): unknown {
    return {
      key,
      benchmarks: { mmlu: 0.9 },
      availability: "available",
      source: "test",
      date: "2026-07-08",
      confidence: 0.85,
    };
  }

  it("writes forecast-data/benchmarks.json for valid input", async () => {
    await writeFile(fromFile, JSON.stringify([validEntry("openai/gpt-5.5")]), "utf8");

    const result = await runUpdateData({ ok: true, fromFile }, tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entriesWritten).toBe(1);
    expect(result.outputPath).toBe(path.join(tmpRoot, "forecast-data", "benchmarks.json"));

    const written = JSON.parse(await readFile(result.outputPath, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe("openai/gpt-5.5");
  });

  it("returns ok=false with invalidLines when entries are malformed", async () => {
    await writeFile(
      fromFile,
      JSON.stringify([
        validEntry("openai/gpt-5.5"),
        { key: "broken/entry" }, // missing required fields
        validEntry("anthropic/claude-opus-4-8"),
      ]),
      "utf8",
    );

    const result = await runUpdateData({ ok: true, fromFile }, tmpRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidLines).toEqual([2]);
    expect(result.error).toContain("1 invalid entry");
    expect(result.error).toContain("lines: 2");

    // forecast-data/benchmarks.json MUST NOT have been written.
    const exists = await readFile(path.join(tmpRoot, "forecast-data", "benchmarks.json"), "utf8")
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("preserves existing forecast-data/ on validation failure", async () => {
    const existingDir = path.join(tmpRoot, "forecast-data");
    await mkdir(existingDir, { recursive: true });
    const existingFile = path.join(existingDir, "benchmarks.json");
    const existing = JSON.stringify([validEntry("openai/gpt-5.4")]);
    await writeFile(existingFile, existing, "utf8");

    await writeFile(
      fromFile,
      JSON.stringify([validEntry("openai/gpt-5.5"), { key: "broken" }]),
      "utf8",
    );

    const result = await runUpdateData({ ok: true, fromFile }, tmpRoot);
    expect(result.ok).toBe(false);

    const preserved = await readFile(existingFile, "utf8");
    expect(preserved).toBe(existing);
  });

  it("returns ok=false when --from-file is missing", async () => {
    const result = await runUpdateData({ ok: true, fromFile: path.join(tmpRoot, "nope.json") }, tmpRoot);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when --from-file is malformed JSON", async () => {
    await writeFile(fromFile, "{ not valid", "utf8");
    const result = await runUpdateData({ ok: true, fromFile }, tmpRoot);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when --from-file is not an array", async () => {
    await writeFile(fromFile, JSON.stringify({ key: "openai/gpt-5.5" }), "utf8");
    const result = await runUpdateData({ ok: true, fromFile }, tmpRoot);
    expect(result.ok).toBe(false);
  });
});