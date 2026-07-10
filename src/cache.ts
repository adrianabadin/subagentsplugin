/**
 * PR3 — Cache schema, atomic read/write, TTL check.
 *
 * Acceptance criteria from the design and spec:
 * - Atomic write via tmp+rename (model-variants.ts pattern from
 *   gentle-ai/internal/assets/opencode/plugins/model-variants.ts): readers
 *   never see partial JSON; concurrent plugin loads do not race over the
 *   same tmp path.
 * - TTL check: `isCacheFresh(cache, now, ttlMs)` is true iff
 *   `generatedAt + ttlMs > now`. A zero or invalid TTL counts as stale.
 * - Graceful fallback: missing file, invalid JSON, wrong version, or
 *   non-object root → `readCache` returns `null` and never throws.
 * - Default path: `~/.cache/opencode-model-forecast/model-data.json`.
 *
 * The cache schema is `ModelDataCache` from src/types.ts (PR2):
 *   - version: 1
 *   - generatedAt: ISO-8601
 *   - providers: providerId → modelId → { variants: Effort[] }
 *   - rubric: phase → difficulty tier
 */

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { randomBytes } from "crypto";
import path from "path";
import type { ModelDataCache } from "./types.js";
import type { Logger } from "./logger.js";

/** Filename of the on-disk cache. */
export const CACHE_FILENAME = "model-data.json";

/** Directory under which the cache lives. */
export const CACHE_DIR_NAME = ".cache/opencode-model-forecast";

/** Schema version accepted by `readCache`. */
const SUPPORTED_VERSION = 1 as const;

/**
 * Returns the default cache path: `~/.cache/opencode-model-forecast/model-data.json`.
 * Pure — does not touch the filesystem.
 */
export function defaultCachePath(): string {
  return path.join(homedir(), CACHE_DIR_NAME, CACHE_FILENAME);
}

/**
 * Reads the cache file at `cachePath`. Returns `null` on:
 *   - missing file (ENOENT)
 *   - empty file
 *   - invalid JSON
 *   - non-object root (e.g. array)
 *   - `version !== 1`
 *
 * Never throws.
 */
export async function readCache(
  cachePath: string,
  logger?: Logger,
): Promise<ModelDataCache | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    logger?.trace("readCache", `cache miss (file error): ${cachePath}`);
    return null;
  }
  if (raw.trim().length === 0) {
    logger?.trace("readCache", `cache miss (empty file): ${cachePath}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.trace("readCache", `cache miss (invalid JSON): ${cachePath}`);
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    logger?.trace("readCache", `cache miss (non-object root): ${cachePath}`);
    return null;
  }
  const candidate = parsed as ModelDataCache;
  if (candidate.version !== SUPPORTED_VERSION) {
    logger?.trace("readCache", `cache miss (wrong version ${candidate.version}): ${cachePath}`);
    return null;
  }
  if (typeof candidate.generatedAt !== "string") {
    logger?.trace("readCache", `cache miss (missing generatedAt): ${cachePath}`);
    return null;
  }
  logger?.trace("readCache", `cache hit (${Object.keys(candidate.providers ?? {}).length} providers): ${cachePath}`);
  return candidate;
}

/**
 * Writes `data` atomically at `cachePath`. The parent directory is created
 * if missing; the data is first written to a per-invocation tmp file and
 * then renamed over the target. On success the tmp file is consumed by the
 * rename; on failure the tmp file is best-effort cleaned up.
 *
 * Throws on filesystem errors (caller — the plugin init path — is expected
 * to catch and log without aborting startup).
 */
export async function writeCache(
  cachePath: string,
  data: ModelDataCache,
  logger?: Logger,
): Promise<void> {
  const cacheDir = path.dirname(cachePath);
  await mkdir(cacheDir, { recursive: true });

  const tmpPath = path.join(
    cacheDir,
    `${CACHE_FILENAME}.${randomBytes(3).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpPath, cachePath);
    logger?.info("writeCache", `cache written (${Object.keys(data.providers ?? {}).length} providers): ${cachePath}`);
  } catch (err) {
    // Best-effort cleanup of the tmp file on failure so it does not
    // accumulate in the cache directory.
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failures — original error is more informative.
    }
    logger?.error("writeCache", `write failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Returns `true` iff `cache.generatedAt + ttlMs` is strictly after `now`.
 * An invalid `generatedAt` (not parseable by `Date`) is treated as stale.
 * A `ttlMs <= 0` makes every cache stale (no implicit forever-cache).
 */
export function isCacheFresh(
  cache: ModelDataCache,
  now: Date,
  ttlMs: number,
): boolean {
  if (ttlMs <= 0) {
    return false;
  }
  const generatedAtMs = new Date(cache.generatedAt).getTime();
  if (Number.isNaN(generatedAtMs)) {
    return false;
  }
  return generatedAtMs + ttlMs > now.getTime();
}