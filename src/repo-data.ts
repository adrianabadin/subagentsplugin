/**
 * Forecast benchmark data loaders.
 *
 * Precedence:
 *   compiled registry < global overrides < repo-local overrides
 *
 * Global overrides live at:
 *   ~/.config/opencode-model-forecast/benchmarks.json
 *
 * Repo-local overrides remain supported at:
 *   <root>/forecast-data/benchmarks.json
 *
 * Merge is replace-by-key, not deep merge.
 */

import { randomBytes } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

import { isBenchmarkEntry, setRepoLocal, type BenchmarkEntry } from "./benchmark-registry.js";

export { isBenchmarkEntry };

export const FORECAST_DATA_DIR = "forecast-data";
export const BENCHMARKS_FILE = "benchmarks.json";
export const OVERRIDES_FILE = "overrides.json";

export interface EffectiveBenchmarksOptions {
  rootDir: string;
  globalPath?: string;
}

export function globalBenchmarksPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(homedir(), ".config");
  return path.join(configHome, "opencode-model-forecast", BENCHMARKS_FILE);
}

async function loadBenchmarkArray(file: string, fallbackLabel: string): Promise<BenchmarkEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[model-forecast] ${file} is malformed: ${err instanceof Error ? err.message : String(err)} - falling back to ${fallbackLabel}`,
    );
    return null;
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[model-forecast] ${file} must be a JSON array - falling back to ${fallbackLabel}`);
    return null;
  }

  const entries: BenchmarkEntry[] = [];
  for (const item of parsed) {
    if (!isBenchmarkEntry(item)) continue;
    entries.push(item);
  }
  return entries;
}

export async function loadRepoBenchmarks(rootDir: string): Promise<BenchmarkEntry[] | null> {
  return loadBenchmarkArray(path.join(rootDir, FORECAST_DATA_DIR, BENCHMARKS_FILE), "compiled registry");
}

export async function loadGlobalBenchmarks(file: string = globalBenchmarksPath()): Promise<BenchmarkEntry[] | null> {
  return loadBenchmarkArray(file, "compiled registry");
}

export async function saveGlobalBenchmarks(
  entries: readonly BenchmarkEntry[],
  file: string = globalBenchmarksPath(),
): Promise<string> {
  const outDir = path.dirname(file);
  await mkdir(outDir, { recursive: true });
  const tmpPath = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify([...entries], null, 2), "utf8");
  await rename(tmpPath, file);
  return file;
}

export async function loadEffectiveBenchmarks(
  options: EffectiveBenchmarksOptions,
): Promise<BenchmarkEntry[]> {
  const byKey = new Map<string, BenchmarkEntry>();

  const globalEntries = await loadGlobalBenchmarks(options.globalPath);
  for (const entry of globalEntries ?? []) {
    byKey.set(entry.key, entry);
  }

  const repoEntries = await loadRepoBenchmarks(options.rootDir);
  for (const entry of repoEntries ?? []) {
    byKey.set(entry.key, entry);
  }

  const effective = [...byKey.values()];
  setRepoLocal(effective.length > 0 ? effective : null);
  return effective;
}

/**
 * Optional `forecast-data/overrides.json` for preset / ladder / quarantine
 * overrides. Returns `null` when absent or malformed.
 *
 * Reserved for the task-5 docs lockdown. The shape is intentionally loose
 * so future fields can be added without a breaking change.
 */
export interface RepoOverrides {
  preset?: string;
  ladder?: ReadonlyArray<{ rung: string; modelId: string }>;
  quarantine?: { permanent?: string[] };
}

export async function loadRepoOverrides(rootDir: string): Promise<RepoOverrides | null> {
  const file = path.join(rootDir, FORECAST_DATA_DIR, OVERRIDES_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[model-forecast] ${file} is malformed: ${err instanceof Error ? err.message : String(err)} - falling back to compiled defaults`,
    );
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(
      `[model-forecast] ${file} must be a JSON object - falling back to compiled defaults`,
    );
    return null;
  }
  return parsed as RepoOverrides;
}
