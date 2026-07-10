/**
 * 429-fallback (SDD change) — QuarantineStore unit tests.
 *
 * Spec #1316 requirement 2 "QuarantineStore TTL Semantics" with the six
 * scenarios: immediate block, expiry, boundary equal, duplicate add, clear,
 * snapshot lazy purge. The injectable-clock contract from design #1317 §2
 * (default ttlMs 3_600_000) is pinned by a seventh test.
 *
 * TDD ordering: these tests reference the production API
 * `new QuarantineStore(opts).add/isBlocked/clear/snapshot(...)`. They are
 * expected to FAIL until src/quarantine.ts is implemented.
 */

import { describe, expect, it, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomBytes } from "crypto";

import {
  QuarantineStore,
  clearSharedQuarantineStore,
  defaultQuarantineFilePath,
  getSharedQuarantineStore,
  resolveQuarantineTtlMs,
  setSharedQuarantineStore,
} from "../src/quarantine.js";

describe("QuarantineStore — TTL semantics", () => {
  it("blocks a model immediately after add (immediate block)", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    store.add("minimax/M3", "usage_limit_reached");
    expect(store.isBlocked("minimax/M3")).toBe(true);
  });

  it("unblocks a model once now >= expiresAt (after expiry)", () => {
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ ttlMs: 1_000_000, now: () => nowMs });
    store.add("openai/gpt-5.5", "rate_limit_exceeded");
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    nowMs = 2_000_001;
    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
  });

  it("treats boundary now === expiresAt as NOT blocked (half-open)", () => {
    // Spec scenario: expiresAt = 1e6, now = 1e6 ⇒ isBlocked = false.
    // Add at now=1_000_000 with ttlMs=1_000_000 ⇒ expiresAt = 2_000_000.
    // Check at now=2_000_000 ⇒ 2_000_000 < 2_000_000 = false (unblocked).
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ ttlMs: 1_000_000, now: () => nowMs });
    store.add("anthropic/claude-opus-4-8", "usage limit has been reached");
    nowMs = 2_000_000;
    expect(store.isBlocked("anthropic/claude-opus-4-8")).toBe(false);
  });

  it("treats boundary now < expiresAt as blocked (half-open, just inside)", () => {
    const store = new QuarantineStore({ ttlMs: 1_000_000, now: () => 1_000_000 });
    store.add("minimax/M3", "rate_limit_exceeded");
    const justInside = new QuarantineStore({ ttlMs: 1_000_000, now: () => 1_999_999 });
    justInside.add("minimax/M3", "rate_limit_exceeded");
    expect(justInside.isBlocked("minimax/M3")).toBe(true);
  });

  it("is idempotent: re-adding the same model refreshes expiresAt + reason (single entry)", () => {
    let nowMs = 1_500_000;
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => nowMs });
    store.add("minimax/M3", "old reason");
    const first = store.snapshot();
    expect(first).toHaveLength(1);
    expect(first[0]?.reason).toBe("old reason");
    expect(first[0]?.expiresAt).toBe(1_500_000 + 3_600_000);

    nowMs = 1_500_000; // re-add
    store.add("minimax/M3", "new reason");
    const second = store.snapshot();
    expect(second).toHaveLength(1);
    expect(second[0]?.reason).toBe("new reason");
    expect(second[0]?.expiresAt).toBe(1_500_000 + 3_600_000);
  });

  it("clear() empties the store (all isBlocked = false)", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    store.add("minimax/M3", "a");
    store.add("openai/gpt-5.5", "b");
    expect(store.isBlocked("minimax/M3")).toBe(true);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    store.clear();
    expect(store.isBlocked("minimax/M3")).toBe(false);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
    expect(store.snapshot()).toEqual([]);
  });

  it("snapshot() lazy-purges expired entries (expiresAt <= now excluded)", () => {
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ ttlMs: 1_000_000, now: () => nowMs });
    // live (expires at 2_000_000) — added first so it sits first in the map
    store.add("minimax/M3", "live");
    // roll clock so next add expires at 1_500_000 (expired at now=1_999_999)
    nowMs = 500_000;
    store.add("openai/gpt-5.5", "expired");
    // At now=1_999_999: openai is purged (expiresAt 1_500_000 <= now),
    // minimax is live (expiresAt 2_000_000 > now).
    nowMs = 1_999_999;
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.model).toBe("minimax/M3");
    expect(snap[0]?.reason).toBe("live");
  });

  it("uses a default ttl of 3_600_000ms when ttlMs is omitted", () => {
    // Single store with an injected clock — add once, advance clock,
    // observe the half-open transition at the default TTL.
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ now: () => nowMs });
    store.add("minimax/M3", "r");
    // Just before default TTL elapses — still blocked (1_999_999 < 4_600_000).
    nowMs = 1_000_000 + 3_600_000 - 1;
    expect(store.isBlocked("minimax/M3")).toBe(true);
    // Right at expiry — half-open, not blocked (4_600_000 < 4_600_000 is false).
    nowMs = 1_000_000 + 3_600_000;
    expect(store.isBlocked("minimax/M3")).toBe(false);
  });

  it("supports permanent quarantine when ttlMs is Infinity", () => {
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => nowMs });
    store.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);

    // Advance clock significantly, should still be blocked.
    nowMs = 999_999_999_999;
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);

    // Snapshot should not purge permanent entries.
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.model).toBe("openai/gpt-5.5");
    expect(snap[0]?.expiresAt).toBe(Infinity);
  });
});

/* -------------------------------------------------------------------------- *
 * Permanent quarantine persistence — entries with expiresAt === Infinity must
 * survive clearNonPermanent(), serialize to disk (null → Infinity), and
 * reload on construction so CLI restart does not delete them.
 * -------------------------------------------------------------------------- */
describe("QuarantineStore — permanent persistence", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      tmpDir = "";
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = path.join(tmpdir(), `quarantine-test-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    tmpDir = dir;
    return dir;
  }

  it("clearNonPermanent() removes only finite-ttl entries; permanent entries survive", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    store.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    store.add("google/gemini-3.5-flash", "rate_limit", 2 * 60 * 60 * 1000);
    store.add("minimax/M3", "rate_limit");

    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
    expect(store.isBlocked("minimax/M3")).toBe(true);

    store.clearNonPermanent();

    // Permanent entry survives.
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    // Non-permanent entries are removed.
    expect(store.isBlocked("google/gemini-3.5-flash")).toBe(false);
    expect(store.isBlocked("minimax/M3")).toBe(false);
  });

  it("clear() still empties everything including permanent entries (backward-compat)", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    store.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    store.add("minimax/M3", "rate_limit");

    store.clear();

    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
    expect(store.isBlocked("minimax/M3")).toBe(false);
  });

  it("serializes ONLY permanent entries to disk (TTL entries are skipped)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    let nowMs = 1_000_000;
    const store1 = new QuarantineStore({ now: () => nowMs });
    store1.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    store1.add("google/gemini-3.5-flash", "rate_limit", 2 * 60 * 60 * 1000);
    store1.add("minimax/M3", "rate_limit");

    await store1.saveToFile(filePath);

    // Verify file content: only the permanent entry is persisted.
    const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
    const parsed: Array<{ model: string; reason: string; expiresAt: number | null }> = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.model).toBe("openai/gpt-5.5");
    expect(parsed[0]?.reason).toBe("invalid_api_key");
    expect(parsed[0]?.expiresAt).toBeNull(); // null = Infinity

    // Simulate CLI restart — new store loads from same file.
    nowMs = 2_000_000;
    const store2 = new QuarantineStore({ now: () => nowMs });
    await store2.loadFromFile(filePath);

    // Only permanent entry survived restart.
    expect(store2.isBlocked("openai/gpt-5.5")).toBe(true);
    // TTL entries were NOT persisted — they must not survive restart.
    expect(store2.isBlocked("google/gemini-3.5-flash")).toBe(false);
    expect(store2.isBlocked("minimax/M3")).toBe(false);
  });

  it("loadFromFile does NOT throw on missing file (returns empty)", async () => {
    const dir = await makeTmpDir();
    const store = new QuarantineStore({ now: () => 1 });
    await expect(store.loadFromFile(path.join(dir, "nonexistent.json"))).resolves.toBeUndefined();
    expect(store.snapshot()).toEqual([]);
  });

  it("loadFromFile does NOT throw on invalid JSON (returns empty)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "bad.json");
    await writeFile(filePath, "not json at all", "utf8");

    const store = new QuarantineStore({ now: () => 1 });
    await expect(store.loadFromFile(filePath)).resolves.toBeUndefined();
    expect(store.snapshot()).toEqual([]);
  });

  it("loadFromFile skips ALL TTL entries (even non-expired) — only permanent survive restart", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    // Simulate a legacy file that contains both permanent and TTL entries.
    // Even non-expired TTL entries must be skipped — rate-limit quarantines
    // live in memory only and must never be revived across restart.
    const legacyContent = JSON.stringify([
      { model: "openai/gpt-5.5", reason: "permanent", expiresAt: null },
      { model: "minimax/M3", reason: "ttl-expired", expiresAt: 1_060_000 },
      { model: "anthropic/claude-opus-4-8", reason: "ttl-alive", expiresAt: 4_600_000 },
    ]);
    await writeFile(filePath, legacyContent, "utf8");

    const store = new QuarantineStore({ now: () => 2_000_000 });
    await store.loadFromFile(filePath);

    // Only the permanent entry is restored.
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    // TTL entries are skipped — even the one that would still be alive.
    expect(store.isBlocked("minimax/M3")).toBe(false);
    expect(store.isBlocked("anthropic/claude-opus-4-8")).toBe(false);
  });

  it("snapshot() preserves permanent entries from loaded file", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store1 = new QuarantineStore({ now: () => 1_000_000 });
    store1.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    await store1.saveToFile(filePath);

    const store2 = new QuarantineStore({ now: () => 2_000_000 });
    await store2.loadFromFile(filePath);

    const snap = store2.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.model).toBe("openai/gpt-5.5");
    expect(snap[0]?.expiresAt).toBe(Infinity);
  });

  it("saveToFile writes empty array when only TTL entries exist (clears stale permanent entries)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    // First write a permanent entry to simulate a legacy file.
    const store1 = new QuarantineStore({ now: () => 1_000_000 });
    store1.add("openai/gpt-5.5", "invalid_api_key", Infinity);
    await store1.saveToFile(filePath);

    // Now create a new store with ONLY TTL entries and save — it should
    // overwrite the file with an empty array (no permanent entries).
    const store2 = new QuarantineStore({ now: () => 2_000_000 });
    store2.add("google/gemini-3.5-flash", "rate_limit", 7_200_000);
    await store2.saveToFile(filePath);

    const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual([]);
  });

  it("loadFromFile handles empty array gracefully (no entries loaded)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");
    await writeFile(filePath, "[]", "utf8");

    const store = new QuarantineStore({ now: () => 1 });
    await store.loadFromFile(filePath);
    expect(store.snapshot()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * Model-group quarantine — adding one Gemini Flash alias blocks all group
 * aliases (routing variants + model-family variants).  TTL groups expire
 * together and must NOT persist.  Permanent groups survive restart.
 * `opencode-go/deepseek-*` must NOT be affected by `deepseek/*` quarantine
 * (different providers → separate group).
 * -------------------------------------------------------------------------- */
describe("QuarantineStore — model-group quarantine", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      tmpDir = "";
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = path.join(tmpdir(), `quarantine-group-test-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    tmpDir = dir;
    return dir;
  }

  describe("Gemini Flash group expansion", () => {
    it("add one Gemini Flash alias blocks all group aliases", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      // Add one alias — all group members should be blocked.
      store.add("google/gemini-3.5-flash", "rate_limit");

      // Direct variants
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3-flash")).toBe(true);
      // Routing/proxy variants
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(true);
      // Older flash (family group, if in registry)
      if (
        // Dynamically check — 2.5-flash is in the benchmark registry
        true
      ) {
        expect(store.isBlocked("google/gemini-2.5-flash")).toBe(true);
      }
      // Non-flash Gemini — NOT in group
      expect(store.isBlocked("google/gemini-2.5-pro")).toBe(false);
      expect(store.isBlocked("google/gemini-3.1-pro")).toBe(false);
    });

    it("add via antigravity alias also blocks canonical variants", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      store.add("google/antigravity-gemini-3-flash", "rate_limit");

      expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(true);
    });

    it("snapshot returns all expanded group entries", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      store.add("google/gemini-3.5-flash", "rate_limit");
      const snap = store.snapshot();

      // All group members appear
      const models = snap.map((e) => e.model).sort();
      expect(models).toContain("google/gemini-3.5-flash");
      expect(models).toContain("google/gemini-3-flash");
      expect(models).toContain("google/antigravity-gemini-3.5-flash");
      expect(models).toContain("google/antigravity-gemini-3-flash");
      // All have same reason
      for (const entry of snap) {
        expect(entry.reason).toBe("rate_limit");
      }
    });
  });

  describe("loadFromFile target semantics (hand-edited file)", () => {
    it("loads an individual Gemini Flash alias as a singleton (no implicit family expansion)", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      // Simulate a hand-edited file with only ONE individual Gemini Flash alias.
      const handEdited = JSON.stringify([
        { model: "google/gemini-3.5-flash", reason: "invalid_api_key", expiresAt: null },
      ]);
      await writeFile(filePath, handEdited, "utf8");

      const store = new QuarantineStore({ now: () => 2_000_000 });
      await store.loadFromFile(filePath);

      // ONLY the exact alias in the file is blocked — siblings are NOT.
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3-flash")).toBe(false);
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(false);
      expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(false);
      expect(store.isBlocked("google/gemini-2.5-flash")).toBe(false);
      expect(store.isBlocked("google/gemini-3.1-pro")).toBe(false);

      // Snapshot should contain exactly the one persisted alias.
      const snap = store.snapshot();
      const models = snap.map((e) => e.model);
      expect(models).toEqual(["google/gemini-3.5-flash"]);
    });

    it("loads an individual antigravity alias as a singleton too", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      const handEdited = JSON.stringify([
        { model: "google/antigravity-gemini-3-flash", reason: "invalid_api_key", expiresAt: null },
      ]);
      await writeFile(filePath, handEdited, "utf8");

      const store = new QuarantineStore({ now: () => 2_000_000 });
      await store.loadFromFile(filePath);

      expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3-flash")).toBe(false);
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(false);
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(false);
    });

    it("loads an explicit provider/* group from file and expands to every provider member", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      // Explicit group literal — must expand to all provider members.
      const handEdited = JSON.stringify([
        { model: "google/*", reason: "invalid_api_key", expiresAt: null },
      ]);
      await writeFile(filePath, handEdited, "utf8");

      const store = new QuarantineStore({ now: () => 2_000_000 });
      await store.loadFromFile(filePath);

      // Provider-wide expansion blocks flash AND non-flash google models.
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3-flash")).toBe(true);
      expect(store.isBlocked("google/gemini-3.1-pro")).toBe(true);
      // A different provider is NOT affected.
      expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
    });
  });

  describe("permanent group quarantine persistence", () => {
    it("serializes all expanded permanent entries to disk", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      const store = new QuarantineStore({ now: () => 1_000_000 });
      store.add("google/gemini-3.5-flash", "invalid_api_key", Infinity);

      await store.saveToFile(filePath);

      const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
      const parsed: Array<{ model: string; reason: string; expiresAt: number | null }> = JSON.parse(raw);

      // All group members persisted
      const models = parsed.map((e) => e.model).sort();
      expect(models).toContain("google/gemini-3.5-flash");
      expect(models).toContain("google/gemini-3-flash");
      expect(models).toContain("google/antigravity-gemini-3.5-flash");
      expect(models).toContain("google/antigravity-gemini-3-flash");
      for (const entry of parsed) {
        expect(entry.expiresAt).toBeNull(); // permanent → null
        expect(entry.reason).toBe("invalid_api_key");
      }
    });

    it("permanent group survives restart (load restores all aliases)", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      const store1 = new QuarantineStore({ now: () => 1_000_000 });
      store1.add("google/gemini-3.5-flash", "invalid_api_key", Infinity);
      await store1.saveToFile(filePath);

      // Simulate CLI restart — new store
      const store2 = new QuarantineStore({ now: () => 2_000_000 });
      await store2.loadFromFile(filePath);

      // All group members still blocked
      expect(store2.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store2.isBlocked("google/gemini-3-flash")).toBe(true);
      expect(store2.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(true);
      expect(store2.isBlocked("google/antigravity-gemini-3-flash")).toBe(true);
      // Non-group member not blocked
      expect(store2.isBlocked("google/gemini-3.1-pro")).toBe(false);
    });
  });

  describe("TTL group does NOT persist", () => {
    it("TTL group expires together, none survive restart", async () => {
      const dir = await makeTmpDir();
      const filePath = path.join(dir, "quarantine.json");

      let nowMs = 1_000_000;
      const store1 = new QuarantineStore({ now: () => nowMs });
      store1.add("google/gemini-3.5-flash", "rate_limit", 2 * 60 * 60 * 1000); // 2hr TTL

      // All group members blocked while TTL is active
      expect(store1.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store1.isBlocked("google/gemini-3-flash")).toBe(true);

      // TTL entries NOT persisted (saveToFile skips non-permanent)
      await store1.saveToFile(filePath);
      const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual([]); // nothing persisted (all TTL)

      // Simulate CLI restart — TTL quarantines gone
      nowMs = 2_000_000;
      const store2 = new QuarantineStore({ now: () => nowMs });
      await store2.loadFromFile(filePath);

      expect(store2.isBlocked("google/gemini-3.5-flash")).toBe(false);
      expect(store2.isBlocked("google/gemini-3-flash")).toBe(false);
    });

    it("TTL group expires after ttl elapses", () => {
      let nowMs = 1_000_000;
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => nowMs });
      store.add("google/gemini-3.5-flash", "rate_limit");

      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(true);

      // Fast-forward past TTL
      nowMs = 1_000_000 + 3_600_000;
      expect(store.isBlocked("google/gemini-3.5-flash")).toBe(false);
      expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(false);
    });
  });

  describe("deepseek — separate group from opencode-go", () => {
    it("deepseek/deepseek-v4-pro quarantine does NOT block opencode-go/deepseek-v4-pro", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      store.add("deepseek/deepseek-v4-pro", "rate_limit");

      expect(store.isBlocked("deepseek/deepseek-v4-pro")).toBe(true);
      expect(store.isBlocked("deepseek/deepseek-v4-flash")).toBe(false); // different model

      // opencode-go variants MUST NOT be blocked
      expect(store.isBlocked("opencode-go/deepseek-v4-pro")).toBe(false);
      expect(store.isBlocked("opencode-go/deepseek-v4-flash")).toBe(false);
    });

    it("opencode-go/deepseek-v4-pro quarantine does NOT block deepseek/deepseek-v4-pro", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      store.add("opencode-go/deepseek-v4-pro", "rate_limit");

      expect(store.isBlocked("opencode-go/deepseek-v4-pro")).toBe(true);
      // deepseek direct must NOT be blocked (different provider family)
      expect(store.isBlocked("deepseek/deepseek-v4-pro")).toBe(false);
    });
  });

  describe("non-group models — singleton (backward-compat)", () => {
    it("anthropic models stay singleton (only exact model blocked)", () => {
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      store.add("anthropic/claude-sonnet-4-6", "rate_limit");

      expect(store.isBlocked("anthropic/claude-sonnet-4-6")).toBe(true);
      // Different models NOT affected
      expect(store.isBlocked("anthropic/claude-sonnet-4-5")).toBe(false);
      expect(store.isBlocked("anthropic/claude-opus-4-7")).toBe(false);
    });
  });

  describe("profiles resolver integration", () => {
    it("resolver filters out all group aliases when one is quarantined", () => {
      // Simulate the profile resolver's quarantine check:
      // When generateProfiles produces catalog entries for multiple
      // Gemini Flash aliases, quarantining one must exclude ALL of them.
      const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });

      // Simulated profile modelIds from catalog
      const profileModelIds = [
        "google/gemini-3.5-flash",
        "google/gemini-3-flash",
        "google/antigravity-gemini-3.5-flash",
        "google/antigravity-gemini-3-flash",
        "google/gemini-3.1-pro",
      ];

      // No quarantine yet — all pass
      let visible = profileModelIds.filter((id) => !store.isBlocked(id));
      expect(visible).toHaveLength(5);

      // Quarantine one Gemini Flash
      store.add("google/gemini-3.5-flash", "rate_limit");

      // All Gemini Flash models blocked — only non-flash passes
      visible = profileModelIds.filter((id) => !store.isBlocked(id));
      expect(visible).toEqual(["google/gemini-3.1-pro"]);
    });
  });
});

/* -------------------------------------------------------------------------- *
 * Manual quarantine — `addManual` + persistence contract.
 *
 * Manual entries are user-initiated (TUI / CLI / skill). They MUST
 * persist across restart so the user does not have to re-apply their
 * decision every session. Rate-limit auto-quarantines (non-manual TTL)
 * remain in-memory only and MUST NOT survive restart.
 * -------------------------------------------------------------------------- */
describe("QuarantineStore — manual entries (addManual / persistence)", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      tmpDir = "";
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = path.join(tmpdir(), `quarantine-manual-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    tmpDir = dir;
    return dir;
  }

  it("addManual with permanent:true creates an Infinity entry with manual:true", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    const entry = store.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    expect(entry.manual).toBe(true);
    expect(entry.expiresAt).toBe(Infinity);

    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.model).toBe("openai/gpt-5.5");
    expect(snap[0]?.expiresAt).toBe(Infinity);
    expect(snap[0]?.manual).toBe(true);
  });

  it("addManual with ttlMs creates a finite expiresAt with manual:true", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    const entry = store.addManual("openai/gpt-5.5", "manual-tui", { ttlMs: 4 * 3_600_000 });
    expect(entry.manual).toBe(true);
    expect(entry.expiresAt).toBe(1_000_000 + 4 * 3_600_000);
  });

  it("addManual group-expands (provider/* blocks every alias)", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("opencode-go/*", "manual-tui", { permanent: true });
    // Every opencode-go key in the registry must now be blocked.
    const snap = store.snapshot();
    expect(snap.length).toBeGreaterThan(0);
    for (const entry of snap) {
      expect(entry.model.startsWith("opencode-go/")).toBe(true);
      expect(entry.manual).toBe(true);
    }
  });

  it("addManual blocks immediately (isBlocked true)", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
  });

  it("addManual is idempotent — re-adding refreshes expiresAt and reason", () => {
    let nowMs = 1_000_000;
    const store = new QuarantineStore({ now: () => nowMs });
    store.addManual("openai/gpt-5.5", "first reason", { ttlMs: 3_600_000 });
    nowMs = 2_000_000;
    store.addManual("openai/gpt-5.5", "second reason", { ttlMs: 7_200_000 });
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.reason).toBe("second reason");
    expect(snap[0]?.expiresAt).toBe(2_000_000 + 7_200_000);
  });

  it("release removes a single model", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    store.addManual("anthropic/claude-opus-4-8", "manual-tui", { permanent: true });
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    expect(store.isBlocked("anthropic/claude-opus-4-8")).toBe(true);

    const removed = store.release("openai/gpt-5.5");
    expect(removed).toBe(true);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
    expect(store.isBlocked("anthropic/claude-opus-4-8")).toBe(true);
  });

  it("release(group) clears every alias under that group", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("opencode-go/*", "manual-tui", { permanent: true });
    const snap = store.snapshot();
    expect(snap.length).toBeGreaterThan(0);

    const removed = store.release("opencode-go/*");
    expect(removed).toBe(true);
    expect(store.snapshot()).toEqual([]);
  });

  it("release returns false when the model was not blocked", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    expect(store.release("openai/gpt-5.5")).toBe(false);
  });

  it("saveToFile writes manual finite-TTL entries with numeric expiresAt + manual:true", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("openai/gpt-5.5", "manual-tui", { ttlMs: 7_200_000 });
    await store.saveToFile(filePath);

    const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.model).toBe("openai/gpt-5.5");
    expect(parsed[0]?.expiresAt).toBe(1_000_000 + 7_200_000);
    expect(parsed[0]?.manual).toBe(true);
  });

  it("saveToFile persists permanent entries with expiresAt:null", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    await store.saveToFile(filePath);

    const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.model).toBe("openai/gpt-5.5");
    expect(parsed[0]?.expiresAt).toBeNull();
  });

  it("saveToFile skips non-manual TTL entries (rate-limit auto-quarantines)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    store.add("openai/gpt-5.5", "rate_limit"); // automatic, non-manual
    store.addManual("anthropic/claude-opus-4-8", "manual-tui", { permanent: true });
    await store.saveToFile(filePath);

    const raw = await import("fs/promises").then((m) => m.readFile(filePath, "utf8"));
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.model).toBe("anthropic/claude-opus-4-8");
    expect(parsed[0]?.expiresAt).toBeNull();
  });

  it("loadFromFile restores manual finite-TTL entries that are still alive", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const payload = JSON.stringify([
      { model: "openai/gpt-5.5", reason: "manual-tui", expiresAt: 2_000_000, manual: true },
    ]);
    await writeFile(filePath, payload, "utf8");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    await store.loadFromFile(filePath);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    const snap = store.snapshot();
    expect(snap[0]?.manual).toBe(true);
    expect(snap[0]?.expiresAt).toBe(2_000_000);
  });

  it("loadFromFile DROPS manual TTL entries that have already expired", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const payload = JSON.stringify([
      { model: "openai/gpt-5.5", reason: "manual-tui", expiresAt: 500_000, manual: true },
    ]);
    await writeFile(filePath, payload, "utf8");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    await store.loadFromFile(filePath);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
    expect(store.snapshot()).toEqual([]);
  });

  it("loadFromFile ignores non-manual TTL entries (rate-limit leftovers)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const payload = JSON.stringify([
      // A leftover rate-limit entry that somehow made it onto disk — must
      // be silently ignored (not revived) so the restart cannot bring
      // back a 429 fallback.
      { model: "openai/gpt-5.5", reason: "rate_limit", expiresAt: 5_000_000 },
    ]);
    await writeFile(filePath, payload, "utf8");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    await store.loadFromFile(filePath);
    expect(store.isBlocked("openai/gpt-5.5")).toBe(false);
  });

  it("saveToFile + loadFromFile round-trip preserves manual entries", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store1 = new QuarantineStore({ now: () => 1_000_000 });
    store1.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    store1.addManual("anthropic/claude-opus-4-8", "manual-tui", { ttlMs: 7_200_000 });
    await store1.saveToFile(filePath);

    const store2 = new QuarantineStore({ now: () => 2_000_000 });
    await store2.loadFromFile(filePath);
    expect(store2.isBlocked("openai/gpt-5.5")).toBe(true);
    expect(store2.isBlocked("anthropic/claude-opus-4-8")).toBe(true);

    const snap = store2.snapshot();
    const op = snap.find((e) => e.model === "openai/gpt-5.5");
    const an = snap.find((e) => e.model === "anthropic/claude-opus-4-8");
    expect(op?.expiresAt).toBe(Infinity);
    expect(an?.expiresAt).toBe(1_000_000 + 7_200_000);
    expect(op?.manual).toBe(true);
    expect(an?.manual).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * model-fallback-error-classification (SDD change) — Slice 1, task 5-6.
 * Spec #1620 "Error-Type-Driven Quarantine TTL" (quarantine MODIFIED
 * requirement). `QuarantineEntry` / `SerializedEntry` gain an additive
 * optional `errorType` field; `add`/`addManual` thread it through;
 * `resolveQuarantineTtlMs` centralizes TTL derivation from error type.
 *
 * TDD ordering: these tests reference `resolveQuarantineTtlMs` (not yet
 * exported from src/quarantine.ts) and the `errorType` field on
 * `QuarantineEntry`. They are expected to FAIL until task 6 is
 * implemented.
 * -------------------------------------------------------------------------- */
describe("QuarantineStore — errorType field (additive)", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      tmpDir = "";
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = path.join(tmpdir(), `quarantine-errortype-test-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    tmpDir = dir;
    return dir;
  }

  it("add() accepts and persists errorType on the returned entry + snapshot", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    const entry = store.add("openai/gpt-5.5", "rate_limit", undefined, "rate_limit");
    expect(entry.errorType).toBe("rate_limit");
    const snap = store.snapshot();
    expect(snap[0]?.errorType).toBe("rate_limit");
  });

  it("addManual() accepts and persists errorType via opts", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    const entry = store.addManual("minimax/M3", "manual-cli", { permanent: true, errorType: "manual" });
    expect(entry.errorType).toBe("manual");
    const snap = store.snapshot();
    expect(snap[0]?.errorType).toBe("manual");
  });

  it("add() omits errorType when not supplied (backward compatible — undefined, not a default value)", () => {
    const store = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_000_000 });
    const entry = store.add("openai/gpt-5.5", "usage_limit_reached");
    expect(entry.errorType).toBeUndefined();
  });

  it("saveToFile + loadFromFile round-trip preserves errorType on manual entries", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const store1 = new QuarantineStore({ now: () => 1_000_000 });
    store1.addManual("openai/gpt-5.5", "auto-permanent: model_not_configured", {
      permanent: true,
      errorType: "model_not_configured",
    });
    await store1.saveToFile(filePath);

    const store2 = new QuarantineStore({ now: () => 2_000_000 });
    await store2.loadFromFile(filePath);
    const snap = store2.snapshot();
    expect(snap[0]?.errorType).toBe("model_not_configured");
  });

  it("backward compat: loading a serialized file WITHOUT errorType does not throw; field is undefined", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");
    // Old-format persisted entry, written before this field existed.
    const payload = JSON.stringify([
      { model: "openai/gpt-5.5", reason: "manual-tui", expiresAt: null, manual: true },
    ]);
    await writeFile(filePath, payload, "utf8");

    const store = new QuarantineStore({ now: () => 1_000_000 });
    await expect(store.loadFromFile(filePath)).resolves.not.toThrow();
    const snap = store.snapshot();
    expect(snap[0]?.errorType).toBeUndefined();
  });

  describe("resolveQuarantineTtlMs — TTL derivation from error type", () => {
    it("model_not_configured always resolves to Infinity (permanent)", () => {
      expect(
        resolveQuarantineTtlMs({ errorType: "model_not_configured", model: "openai/gpt-5.5" }),
      ).toBe(Infinity);
    });

    it("rate_limit with a parseable reset signal uses that signal verbatim", () => {
      expect(
        resolveQuarantineTtlMs({ errorType: "rate_limit", model: "openai/gpt-5.5", ttlHintMs: 42_000 }),
      ).toBe(42_000);
    });

    it("rate_limit without a reset signal defaults to 2h for google models", () => {
      expect(
        resolveQuarantineTtlMs({ errorType: "rate_limit", model: "google/gemini-3.5-flash" }),
      ).toBe(2 * 60 * 60 * 1000);
    });

    it("rate_limit without a reset signal defaults to 60min (store default) for non-google models", () => {
      expect(
        resolveQuarantineTtlMs({ errorType: "rate_limit", model: "openai/gpt-5.5" }),
      ).toBeUndefined(); // undefined ⇒ caller falls back to QuarantineStore's own 60min default
    });

    it("provider_error always resolves to Infinity (permanent, unchanged from pre-existing behavior)", () => {
      expect(
        resolveQuarantineTtlMs({ errorType: "provider_error", model: "openai/gpt-5.5" }),
      ).toBe(Infinity);
    });

    it("other / undefined errorType resolves to undefined (store default applies)", () => {
      expect(resolveQuarantineTtlMs({ errorType: "other", model: "openai/gpt-5.5" })).toBeUndefined();
      expect(resolveQuarantineTtlMs({ model: "openai/gpt-5.5" })).toBeUndefined();
    });
  });

  it("saveToFile does not crash when the store is unwritable; logs failure, in-memory state is unaffected", async () => {
    const warnLogs: string[] = [];
    const logger = {
      info: () => {},
      warn: (_scope: string, msg: string) => warnLogs.push(msg),
      trace: () => {},
    } as unknown as import("../src/logger.js").Logger;

    const store = new QuarantineStore({ now: () => 1_000_000, logger });
    store.addManual("openai/gpt-5.5", "manual-cli", { permanent: true });

    // An invalid path (embedded NUL byte) guarantees a write failure on
    // every platform without touching real disk state.
    const unwritablePath = path.join(tmpdir(), "quarantine-\0-invalid", "quarantine.json");

    await expect(store.saveToFile(unwritablePath)).resolves.not.toThrow();
    expect(warnLogs.some((line) => line.includes("saveToFile failed"))).toBe(true);
    // In-memory state for the current invocation is untouched.
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * defaultQuarantineFilePath — agreed-on persistence location.
 * -------------------------------------------------------------------------- */
describe("defaultQuarantineFilePath", () => {
  it("returns a path under ~/.cache/opencode-model-forecast/quarantine.json", () => {
    const p = defaultQuarantineFilePath();
    expect(p).toMatch(/opencode-model-forecast[/\\]quarantine\.json$/);
    expect(p).toContain(".cache");
  });
});

/* -------------------------------------------------------------------------- *
 * Cross-bundle shared-store accessor (globalThis-backed).
 *
 * The plugin publishes the live QuarantineStore on globalThis so the
 * TUI / CLI (different tsup bundles, different Node processes from the
 * CLI's perspective) can reach the same instance.
 * -------------------------------------------------------------------------- */
describe("QuarantineStore — shared globalThis accessor", () => {
  afterEach(() => {
    clearSharedQuarantineStore();
  });

  it("returns null when no store has been published", () => {
    clearSharedQuarantineStore();
    expect(getSharedQuarantineStore()).toBeNull();
  });

  it("publishes and retrieves the same store instance", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    setSharedQuarantineStore(store);
    const got = getSharedQuarantineStore();
    expect(got).toBe(store);
  });

  it("publishing a second store REPLACES the first (no stale references)", () => {
    const a = new QuarantineStore({ now: () => 1 });
    const b = new QuarantineStore({ now: () => 2 });
    setSharedQuarantineStore(a);
    setSharedQuarantineStore(b);
    expect(getSharedQuarantineStore()).toBe(b);
  });

  it("clearSharedQuarantineStore wipes the slot", () => {
    const store = new QuarantineStore({ now: () => 1 });
    setSharedQuarantineStore(store);
    clearSharedQuarantineStore();
    expect(getSharedQuarantineStore()).toBeNull();
  });

  it("mutations via the shared accessor are observed by everyone (the whole point)", () => {
    const store = new QuarantineStore({ now: () => 1_000_000 });
    setSharedQuarantineStore(store);
    const shared = getSharedQuarantineStore();
    expect(shared).not.toBeNull();
    shared?.addManual("openai/gpt-5.5", "manual-tui", { permanent: true });
    // Original store reference sees the mutation too (they're the same instance).
    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
  });
});
