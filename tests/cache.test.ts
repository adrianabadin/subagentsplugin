/**
 * PR3 unit tests — atomic cache read/write + TTL.
 *
 * RED phase: these tests reference src/cache.ts which does NOT exist yet.
 * Running `npm test` before the implementation lands should fail with a
 * module resolution / compile error.
 *
 * Acceptance criteria from the design and spec:
 * - Atomic write via tmp+rename (model-variants.ts pattern): readers
 *   never see partial JSON; concurrent plugin loads do not race.
 * - TTL check: `isCacheFresh(cache, now, ttlMs)` is true iff
 *   `generatedAt + ttlMs > now`.
 * - Graceful fallback: missing file or invalid JSON returns `null`,
 *   never throws.
 * - Default path: `~/.cache/opencode-model-forecast/model-data.json`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  CACHE_FILENAME,
  defaultCachePath,
  isCacheFresh,
  readCache,
  writeCache,
} from "../src/cache.js";
import type { ModelDataCache } from "../src/types.js";

describe("cache — defaultCachePath", () => {
  it("returns a path under ~/.cache/opencode-model-forecast/", () => {
    const p = defaultCachePath();
    expect(p).toContain(".cache");
    expect(p).toContain("opencode-model-forecast");
  });

  it("ends with the CACHE_FILENAME (model-data.json)", () => {
    const p = defaultCachePath();
    expect(p.endsWith(CACHE_FILENAME)).toBe(true);
    expect(CACHE_FILENAME).toBe("model-data.json");
  });
});

describe("cache — atomic write/read roundtrip", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cache-roundtrip-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes then reads back an equivalent ModelDataCache", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T12:00:00.000Z",
      providers: {
        anthropic: {
          "claude-opus-4-7": { variants: ["", "low", "medium", "high", "xhigh", "max"] },
          "claude-sonnet-4-5": { variants: ["", "low", "medium", "high", "max"] },
        },
        openai: {
          "gpt-5": { variants: ["", "low", "medium", "high"] },
        },
      },
      rubric: {
        "sdd-design": "high",
        "sdd-spec": "medium",
        "sdd-archive": "low",
      },
    };

    await writeCache(cachePath, data);
    const read = await readCache(cachePath);

    expect(read).not.toBeNull();
    expect(read).toEqual(data);
    expect(read?.version).toBe(1);
    expect(read?.providers.anthropic["claude-opus-4-7"].variants).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(read?.rubric["sdd-design"]).toBe("high");
  });

  it("does not leave behind a .tmp file after a successful write", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      providers: {},
      rubric: {},
    };

    await writeCache(cachePath, data);

    const entries = await readdir(tempDir);
    expect(entries).toContain("model-data.json");
    expect(entries.find((e) => e.includes(".tmp"))).toBeUndefined();
  });

  it("creates the parent directory when it does not yet exist", async () => {
    const nestedDir = path.join(tempDir, "nested", "deeper");
    const cachePath = path.join(nestedDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      providers: {},
      rubric: {},
    };

    await writeCache(cachePath, data);
    const read = await readCache(cachePath);

    expect(read).toEqual(data);
  });

  it("overwrites an existing file on subsequent writes (no leftover tmp)", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const dataA: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      providers: { anthropic: { "claude-opus-4-7": { variants: ["low"] } } },
      rubric: { "sdd-design": "high" },
    };
    const dataB: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T01:00:00.000Z",
      providers: { anthropic: { "claude-sonnet-4-5": { variants: ["max"] } } },
      rubric: { "sdd-archive": "low" },
    };

    await writeCache(cachePath, dataA);
    await writeCache(cachePath, dataB);
    const read = await readCache(cachePath);

    expect(read).toEqual(dataB);

    const entries = await readdir(tempDir);
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });
});

describe("cache — readCache graceful fallback", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cache-fallback-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when the cache file does not exist", async () => {
    const cachePath = path.join(tempDir, "does-not-exist.json");
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it("returns null when the cache file contains invalid JSON", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    await writeFile(cachePath, "{not valid json");
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it("returns null when the cache file is empty", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    await writeFile(cachePath, "");
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it("returns null when the parsed JSON has the wrong version", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 99,
        generatedAt: "2026-07-02T00:00:00.000Z",
        providers: {},
        rubric: {},
      }),
    );
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it("returns null when the parsed value is not an object (e.g. array)", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    await writeFile(cachePath, JSON.stringify(["not", "a", "cache"]));
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });
});

describe("cache — isCacheFresh TTL check", () => {
  it("returns true when generatedAt + ttlMs is strictly in the future", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const cache: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T11:30:00.000Z", // 30 minutes ago
      providers: {},
      rubric: {},
    };
    expect(isCacheFresh(cache, now, 60 * 60 * 1000)).toBe(true); // TTL = 1h, plenty of time
  });

  it("returns false when generatedAt + ttlMs is in the past", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const cache: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T10:00:00.000Z", // 2 hours ago
      providers: {},
      rubric: {},
    };
    expect(isCacheFresh(cache, now, 60 * 60 * 1000)).toBe(false); // TTL = 1h, expired
  });

  it("returns false when generatedAt is invalid (not a parseable ISO date)", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const cache: ModelDataCache = {
      version: 1,
      generatedAt: "not-a-date",
      providers: {},
      rubric: {},
    };
    expect(isCacheFresh(cache, now, 60 * 60 * 1000)).toBe(false);
  });

  it("honors a zero TTL — every cache is stale", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const cache: ModelDataCache = {
      version: 1,
      generatedAt: now.toISOString(),
      providers: {},
      rubric: {},
    };
    expect(isCacheFresh(cache, now, 0)).toBe(false);
  });

  it("honors a very large TTL — cache from years ago is still fresh", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const cache: ModelDataCache = {
      version: 1,
      generatedAt: "2020-01-01T00:00:00.000Z",
      providers: {},
      rubric: {},
    };
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(isCacheFresh(cache, now, tenYearsMs)).toBe(true);
  });
});

describe("cache — atomic rename actually moves the file (race-free)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cache-race-"));
    // Pre-create a target file with old content to prove rename replaces it.
    const target = path.join(tempDir, "model-data.json");
    await mkdir(tempDir, { recursive: true });
    await writeFile(target, '"old content"');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("replaces prior file content via atomic rename (not append)", async () => {
    const target = path.join(tempDir, "model-data.json");
    const data: ModelDataCache = {
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      providers: { anthropic: { "claude-opus-4-7": { variants: ["max"] } } },
      rubric: {},
    };

    await writeCache(target, data);
    const read = await readCache(target);

    expect(read).toEqual(data);
    // The old literal string must NOT appear inside the file.
    const raw = (await import("fs/promises")).readFile(target, "utf8");
    expect(await raw).not.toContain("old content");
  });
});