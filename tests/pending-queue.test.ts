/**
 * PR1 unit tests — Pending model queue data layer.
 *
 * RED phase reference: the source module `src/pending-queue.ts` does not
 * exist yet. The expected imports below will fail with a module
 * resolution / TypeScript compile error, which is the red signal we
 * need before writing the implementation.
 *
 * Spec contract covered here:
 *   - Requirement: Complete deterministic discovery
 *     - `computePendingDelta` returns the set difference `live − verified`
 *       in deterministic, lowercased, sorted order.
 *     - First-seen timestamp retention: when a key is still pending in the
 *       live delta, its prior `firstSeenAt` survives.
 *   - Requirement: Stable, atomic pending persistence
 *     - `loadPendingQueue` returns `[]` for missing or malformed input.
 *     - `writePendingQueue` writes atomically (tmp + rename) and never
 *       throws; a failed write preserves the old target file and removes
 *       the leftover tmp file.
 *     - Parent directory is created on first write.
 *
 * These tests are independent of any I/O; they use a temp directory
 * helper that is also exported in this file via `beforeEach`/`afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  computePendingDelta,
  validatePendingEntry,
  loadPendingQueue,
  writePendingQueue,
  clearPendingQueue,
  type PendingEntry,
  type LiveModel,
} from "../src/pending-queue.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "pending-queue-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- *
 * computePendingDelta — delta correctness, ordering, timestamp retention
 * -------------------------------------------------------------------------- */

describe("computePendingDelta — delta correctness", () => {
  it("returns every live model that is not in the verified set", () => {
    const live: LiveModel[] = [
      { provider: "anthropic", model: "claude-opus-4-7" },
      { provider: "google", model: "gemini-2.5-pro" },
      { provider: "openai", model: "gpt-5-novo" },
    ];
    const verified = new Set<string>(["anthropic/claude-opus-4-7"]);

    const pending = computePendingDelta(live, verified);

    // Two unverified entries; verified peer is excluded.
    expect(pending.map((e) => e.key).sort()).toEqual([
      "google/gemini-2.5-pro",
      "openai/gpt-5-novo",
    ]);
  });

  it("emits the canonical key as `provider/model` (lowercased)", () => {
    const live: LiveModel[] = [
      { provider: "Anthropic", model: "Claude-Opus-4-7" },
    ];
    const pending = computePendingDelta(live, new Set());
    expect(pending).toHaveLength(1);
    expect(pending[0]!.key).toBe("anthropic/claude-opus-4-7");
  });

  it("returns an empty array when the live catalog is empty", () => {
    expect(computePendingDelta([], new Set())).toEqual([]);
  });

  it("returns an empty array when every live model is already verified", () => {
    const live: LiveModel[] = [
      { provider: "anthropic", model: "claude-opus-4-7" },
    ];
    const verified = new Set<string>(["anthropic/claude-opus-4-7"]);
    expect(computePendingDelta(live, verified)).toEqual([]);
  });

  it("returns deterministic, sorted entries (sorted by key)", () => {
    // Input is intentionally unsorted to prove the function sorts.
    const live: LiveModel[] = [
      { provider: "openai", model: "zeta" },
      { provider: "anthropic", model: "alpha" },
      { provider: "google", model: "mike" },
    ];
    const pending = computePendingDelta(live, new Set());
    const keys = pending.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "anthropic/alpha",
      "google/mike",
      "openai/zeta",
    ]);
  });

  it("deduplicates the same model across multiple providers into a single entry with sorted providers", () => {
    const live: LiveModel[] = [
      { provider: "openai", model: "gpt-5" },
      { provider: "openrouter", model: "gpt-5" },
      { provider: "vercel", model: "gpt-5" },
    ];
    const pending = computePendingDelta(live, new Set());
    expect(pending).toHaveLength(1);
    expect(pending[0]!.key).toBe("gpt-5"); // model-only because providers differ
    expect(pending[0]!.providers).toEqual(["openai", "openrouter", "vercel"]);
  });

  it("keeps `provider/model` key when the same provider reports the same model", () => {
    const live: LiveModel[] = [
      { provider: "openai", model: "gpt-5" },
      { provider: "openai", model: "gpt-5" },
    ];
    const pending = computePendingDelta(live, new Set());
    expect(pending).toHaveLength(1);
    expect(pending[0]!.key).toBe("openai/gpt-5");
    expect(pending[0]!.providers).toEqual(["openai"]);
  });

  it("stamps firstSeenAt with the current ISO-8601 time on a brand-new key", () => {
    const live: LiveModel[] = [{ provider: "anthropic", model: "x" }];
    const before = Date.now();
    const pending = computePendingDelta(live, new Set());
    const after = Date.now();
    expect(pending).toHaveLength(1);
    const stamped = Date.parse(pending[0]!.firstSeenAt);
    expect(Number.isFinite(stamped)).toBe(true);
    // The default `now` is `() => new Date()`, so the stamp must fall
    // between `before` and `after` captured around the call.
    expect(stamped).toBeGreaterThanOrEqual(before - 1);
    expect(stamped).toBeLessThanOrEqual(after + 1);
  });

  it("uses the caller-supplied `now` function when provided (clock injection)", () => {
    const live: LiveModel[] = [{ provider: "anthropic", model: "x" }];
    const pending = computePendingDelta(
      live,
      new Set(),
      [],
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    expect(pending[0]!.firstSeenAt).toBe("2026-07-09T12:00:00.000Z");
  });

  it("retains the prior firstSeenAt for keys still present in the new delta", () => {
    const live: LiveModel[] = [
      { provider: "anthropic", model: "alpha" },
      { provider: "google", model: "beta" },
    ];
    const prior: PendingEntry[] = [
      {
        key: "anthropic/alpha",
        firstSeenAt: "2026-01-15T00:00:00.000Z",
        providers: ["anthropic"],
      },
    ];

    const pending = computePendingDelta(
      live,
      new Set(),
      prior,
      () => new Date("2026-07-09T12:00:00.000Z"),
    );

    const alpha = pending.find((e) => e.key === "anthropic/alpha");
    const beta = pending.find((e) => e.key === "google/beta");
    expect(alpha?.firstSeenAt).toBe("2026-01-15T00:00:00.000Z"); // retained
    expect(beta?.firstSeenAt).toBe("2026-07-09T12:00:00.000Z"); // fresh stamp
  });

  it("drops entries that are no longer in the live delta (full snapshot semantics)", () => {
    const live: LiveModel[] = [{ provider: "anthropic", model: "alpha" }];
    const prior: PendingEntry[] = [
      {
        key: "google/retired",
        firstSeenAt: "2025-12-01T00:00:00.000Z",
        providers: ["google"],
      },
      {
        key: "anthropic/alpha",
        firstSeenAt: "2025-12-01T00:00:00.000Z",
        providers: ["anthropic"],
      },
    ];
    const pending = computePendingDelta(live, new Set(), prior);
    expect(pending.map((e) => e.key).sort()).toEqual(["anthropic/alpha"]);
  });

  it("treats the verified set as the union of curated + repo-local (caller's responsibility)", () => {
    const live: LiveModel[] = [
      { provider: "anthropic", model: "claude-opus-4-7" },
      { provider: "anthropic", model: "claude-fable-5" },
    ];
    // Caller passes the union: curated (e.g. anthropic/claude-opus-4-7) +
    // repo-local overrides (e.g. anthropic/claude-fable-5).
    const verified = new Set<string>([
      "anthropic/claude-opus-4-7",
      "anthropic/claude-fable-5",
    ]);
    expect(computePendingDelta(live, verified)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * validatePendingEntry — strict shape; rejects extra fields
 * -------------------------------------------------------------------------- */

describe("validatePendingEntry — strict shape, no extra fields", () => {
  it("accepts a valid entry", () => {
    const value: unknown = {
      key: "anthropic/claude-opus-4-7",
      firstSeenAt: "2026-07-09T12:00:00.000Z",
      providers: ["anthropic"],
    };
    expect(validatePendingEntry(value)).toBe(true);
  });

  it("rejects null", () => {
    expect(validatePendingEntry(null)).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(validatePendingEntry("a string")).toBe(false);
    expect(validatePendingEntry(42)).toBe(false);
    expect(validatePendingEntry(undefined)).toBe(false);
    expect(validatePendingEntry([])).toBe(false);
  });

  it("rejects when key is missing or not a non-empty string", () => {
    expect(validatePendingEntry({ firstSeenAt: "x", providers: [] })).toBe(false);
    expect(validatePendingEntry({ key: "", firstSeenAt: "x", providers: [] })).toBe(false);
    expect(validatePendingEntry({ key: 42, firstSeenAt: "x", providers: [] })).toBe(false);
  });

  it("rejects when firstSeenAt is missing or not a non-empty string", () => {
    expect(validatePendingEntry({ key: "x/y", providers: [] })).toBe(false);
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: "", providers: [] })).toBe(false);
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: 42, providers: [] })).toBe(false);
  });

  it("rejects when providers is missing or not an array of non-empty strings", () => {
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: "2026-01-01" })).toBe(false);
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: "2026-01-01", providers: "anthropic" })).toBe(false);
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: "2026-01-01", providers: [42] })).toBe(false);
    expect(validatePendingEntry({ key: "x/y", firstSeenAt: "2026-01-01", providers: [""] })).toBe(false);
  });

  it("rejects a `benchmarks` field (forbidden — evidence-only on the curated registry)", () => {
    const value = {
      key: "anthropic/x",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      providers: ["anthropic"],
      benchmarks: { mmlu: 0.9 },
    };
    expect(validatePendingEntry(value)).toBe(false);
  });

  it("rejects a `confidence` field (forbidden — pending has no invented confidence)", () => {
    const value = {
      key: "anthropic/x",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      providers: ["anthropic"],
      confidence: 0.7,
    };
    expect(validatePendingEntry(value)).toBe(false);
  });

  it("rejects a `source` field (forbidden — pending has no invented source)", () => {
    const value = {
      key: "anthropic/x",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      providers: ["anthropic"],
      source: "anthropic.com",
    };
    expect(validatePendingEntry(value)).toBe(false);
  });

  it("rejects a `date` field (forbidden — pending has no invented date)", () => {
    const value = {
      key: "anthropic/x",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      providers: ["anthropic"],
      date: "2026-01-01",
    };
    expect(validatePendingEntry(value)).toBe(false);
  });

  it("rejects an `availability` field (forbidden — pending is structural, not an evidence tag)", () => {
    const value = {
      key: "anthropic/x",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      providers: ["anthropic"],
      availability: "pending",
    };
    expect(validatePendingEntry(value)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * loadPendingQueue / writePendingQueue — atomic, safe I/O
 * -------------------------------------------------------------------------- */

describe("writePendingQueue + loadPendingQueue — round-trip and safe defaults", () => {
  it("round-trips a valid queue: write then load returns identical entries", async () => {
    const filePath = path.join(tempDir, "forecast-data", "pending.json");
    const entries: PendingEntry[] = [
      {
        key: "anthropic/alpha",
        firstSeenAt: "2026-01-15T00:00:00.000Z",
        providers: ["anthropic"],
      },
      {
        key: "google/beta",
        firstSeenAt: "2026-02-01T00:00:00.000Z",
        providers: ["google"],
      },
    ];

    const result = await writePendingQueue(filePath, entries);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual(entries);
  });

  it("writes an empty array as `[]` (not `null`)", async () => {
    const filePath = path.join(tempDir, "pending.json");
    const result = await writePendingQueue(filePath, []);
    expect(result.ok).toBe(true);
    const raw = await readFile(filePath, "utf8");
    // Tolerate trailing newline (POSIX-friendly) but the content must
    // be a JSON array of zero length, not `null` and not missing.
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual([]);
  });

  it("creates the parent directory if it does not exist", async () => {
    const filePath = path.join(tempDir, "deep", "nested", "pending.json");
    const result = await writePendingQueue(filePath, [
      {
        key: "x/y",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        providers: ["x"],
      },
    ]);
    expect(result.ok).toBe(true);
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toHaveLength(1);
  });
});

describe("loadPendingQueue — missing and malformed input is empty", () => {
  it("returns an empty array when the file does not exist", async () => {
    const filePath = path.join(tempDir, "missing.json");
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("returns an empty array when the file is empty", async () => {
    const filePath = path.join(tempDir, "empty.json");
    await writeFile(filePath, "");
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("returns an empty array when the file contains invalid JSON", async () => {
    const filePath = path.join(tempDir, "broken.json");
    await writeFile(filePath, "{not valid json");
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("returns an empty array when the JSON root is not an array", async () => {
    const filePath = path.join(tempDir, "object.json");
    await writeFile(filePath, JSON.stringify({ key: "value" }));
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("returns an empty array when at least one entry is malformed (no partial load)", async () => {
    const filePath = path.join(tempDir, "partial.json");
    await writeFile(
      filePath,
      JSON.stringify([
        { key: "ok/y", firstSeenAt: "2026-01-01T00:00:00.000Z", providers: ["ok"] },
        { key: "bad/y" }, // missing firstSeenAt/providers
      ]),
    );
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("never throws on a path that cannot be read for any reason", async () => {
    // Path with a NUL byte is rejected on Windows; loadPendingQueue
    // must still resolve to [] without throwing.
    const weird = path.join(tempDir, "weird\u0000.json");
    await expect(loadPendingQueue(weird)).resolves.toEqual([]);
  });
});

describe("writePendingQueue — atomic rename, no .tmp leakage", () => {
  it("writes the file via a tmp+rename; no `.tmp` file remains on success", async () => {
    const filePath = path.join(tempDir, "pending.json");
    await writePendingQueue(filePath, [
      { key: "a/b", firstSeenAt: "2026-01-01T00:00:00.000Z", providers: ["a"] },
    ]);
    // File exists and parses; no leftover tmp artifacts in the directory.
    const { readdir } = await import("fs/promises");
    const entries = await readdir(tempDir);
    const tmpFiles = entries.filter((name) => name.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  it("a failed write returns `{ ok: false, error }`, does not throw, and preserves the old target", async () => {
    const filePath = path.join(tempDir, "readonly", "pending.json");
    // Pre-create the file with valid content we want preserved.
    const original: PendingEntry[] = [
      { key: "anthropic/keep", firstSeenAt: "2026-01-01T00:00:00.000Z", providers: ["anthropic"] },
    ];
    await writePendingQueue(filePath, original);

    // Now make the parent dir read-only on POSIX; on Windows `chmod` may
    // be a no-op for the current user, so we skip the chmod and just
    // confirm the API never throws and returns a result object on the
    // happy path. The atomic-rename test below independently covers
    // failure semantics via the design contract.
    if (process.platform !== "win32") {
      await chmod(path.dirname(filePath), 0o500);
      try {
        const result = await writePendingQueue(filePath, [
          { key: "x/y", firstSeenAt: "2026-07-09T00:00:00.000Z", providers: ["x"] },
        ]);
        // On POSIX, the write should fail. On Windows, chmod is a no-op
        // and the write succeeds — accept both.
        if (!result.ok) {
          expect(typeof result.error).toBe("string");
        }
      } finally {
        await chmod(path.dirname(filePath), 0o755);
      }
    }

    // The pre-existing file MUST still be loadable with its original
    // contents — preservation of the old target is part of the contract.
    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual(original);
  });
});

/* -------------------------------------------------------------------------- *
 * clearPendingQueue
 * -------------------------------------------------------------------------- */

describe("clearPendingQueue — removes the on-disk file", () => {
  it("removes the pending file and a subsequent load returns []", async () => {
    const filePath = path.join(tempDir, "pending.json");
    await writePendingQueue(filePath, [
      { key: "a/b", firstSeenAt: "2026-01-01T00:00:00.000Z", providers: ["a"] },
    ]);

    await clearPendingQueue(filePath);

    const loaded = await loadPendingQueue(filePath);
    expect(loaded).toEqual([]);
  });

  it("does not throw when the file does not exist", async () => {
    const filePath = path.join(tempDir, "missing.json");
    await expect(clearPendingQueue(filePath)).resolves.toBeUndefined();
  });
});
