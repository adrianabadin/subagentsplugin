/**
 * `forecast update-data` — write repo-local benchmark overrides.
 *
 * Usage:
 *   model-forecast update-data --from-file <path>
 *   model-forecast update-data --from-file <path> --root <dir>
 *
 * Reads a JSON array of `BenchmarkEntry` from `<path>`, validates each
 * entry, then writes the result to `<root>/forecast-data/benchmarks.json`
 * atomically. Existing forecast-data on disk is preserved on validation
 * failure (no partial write).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";

import {
  FORECAST_DATA_DIR,
  BENCHMARKS_FILE,
} from "./repo-data.js";
import { isBenchmarkEntry, type BenchmarkEntry } from "./benchmark-registry.js";

export interface UpdateDataArgs {
  ok: true;
  fromFile: string;
  root?: string;
}

export interface UpdateDataSuccess {
  ok: true;
  entriesWritten: number;
  outputPath: string;
}

export interface UpdateDataFailure {
  ok: false;
  error: string;
  /** When validation failed: lines (1-based) for entries that failed. */
  invalidLines?: number[];
}

export type UpdateDataResult = UpdateDataSuccess | UpdateDataFailure;

/**
 * Pure argument parser for the `update-data` subcommand. Accepts the
 * argv slice AFTER `update-data` itself.
 */
export function parseUpdateDataArgs(args: string[]): UpdateDataArgs | UpdateDataFailure {
  let fromFile: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--from-file") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--from-file requires a path argument" };
      fromFile = value;
      i += 1;
    } else if (arg === "--root") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--root requires a path argument" };
      root = value;
      i += 1;
    } else {
      return { ok: false, error: `unknown argument for update-data: ${arg}` };
    }
  }
  if (fromFile === undefined) {
    return { ok: false, error: "update-data requires --from-file <path>" };
  }
  return { ok: true, fromFile, root };
}

/**
 * Runs the `update-data` subcommand end-to-end. Reads, validates, and
 * writes the file atomically. Returns a discriminated result so the CLI
 * entry point can map it to exit code + stderr.
 */
export async function runUpdateData(
  args: UpdateDataArgs,
  cwd: string = process.cwd(),
): Promise<UpdateDataResult> {
  const root = args.root ?? cwd;
  let raw: string;
  try {
    raw = await readFile(args.fromFile, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `cannot read ${args.fromFile}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `${args.fromFile} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${args.fromFile} must be a JSON array of BenchmarkEntry objects`,
    };
  }
  const valid: BenchmarkEntry[] = [];
  const invalidLines: number[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    if (isBenchmarkEntry(parsed[i])) {
      valid.push(parsed[i]);
    } else {
      invalidLines.push(i + 1);
    }
  }
  if (invalidLines.length > 0) {
    return {
      ok: false,
      error: `${args.fromFile} contains ${invalidLines.length} invalid entr${invalidLines.length === 1 ? "y" : "ies"} (1-based lines: ${invalidLines.slice(0, 10).join(", ")}${invalidLines.length > 10 ? "…" : ""})`,
      invalidLines,
    };
  }
  const outDir = path.join(root, FORECAST_DATA_DIR);
  const outPath = path.join(outDir, BENCHMARKS_FILE);
  const tmpPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(valid, null, 2), "utf8");
    await rename(tmpPath, outPath);
  } catch (err) {
    // Best-effort cleanup of the orphan tmp file. Swallow unlink errors
    // so we don't mask the original failure.
    await unlink(tmpPath).catch(() => undefined);
    return {
      ok: false,
      error: `failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    entriesWritten: valid.length,
    outputPath: outPath,
  };
}