/**
 * Tests for the `quarantine` CLI subcommand.
 *
 * Covers:
 *   - Argument parsing (`parseQuarantineArgs`)
 *   - File round-trip (`runQuarantine` add / list / release)
 *   - Pure helpers (`parseQuarantineFile`, `mergeAddEntries`,
 *     `applyRelease`, `resolveAddExpiresAt`, `formatQuarantineEntry`)
 *
 * The CLI runs in a separate process from the plugin, so its tests use
 * a temp file path (`--file`) and never touch the real global cache.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  parseQuarantineArgs,
  runQuarantine,
  parseQuarantineFile,
  mergeAddEntries,
  applyRelease,
  resolveAddExpiresAt,
  formatQuarantineEntry,
  loadQuarantineFile,
  writeQuarantineFile,
} from "../src/cli-quarantine.js";
import type { QuarantineEntry } from "../src/quarantine.js";

const FIXED_NOW = 1_700_000_000_000; // a fixed timestamp for deterministic tests

describe("parseQuarantineArgs", () => {
  it("rejects empty args (no action)", () => {
    const r = parseQuarantineArgs([]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown action", () => {
    const r = parseQuarantineArgs(["bogus"]);
    expect(r.ok).toBe(false);
  });

  it("parses add with --permanent", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--permanent"]);
    expect(r).toEqual({ ok: true, action: "add", target: "openai/gpt-5.5", permanent: true });
  });

  it("parses add with --ttl-hours", () => {
    const r = parseQuarantineArgs(["add", "openai/*", "--ttl-hours", "24"]);
    expect(r).toEqual({
      ok: true,
      action: "add",
      target: "openai/*",
      permanent: false,
      ttlHours: 24,
    });
  });

  it("parses add with --reason", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--permanent", "--reason", "test reason"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reason).toBe("test reason");
  });

  it("parses add with --file", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--permanent", "--file", "/tmp/q.json"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filePath).toBe("/tmp/q.json");
  });

  it("parses add with --root", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--permanent", "--root", "/tmp/proj"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root).toBe("/tmp/proj");
  });

  it("rejects add without target", () => {
    const r = parseQuarantineArgs(["add", "--permanent"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --permanent + --ttl-hours (mutually exclusive)", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--permanent", "--ttl-hours", "24"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --ttl-hours without value", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--ttl-hours"]);
    expect(r.ok).toBe(false);
  });

  it("rejects non-positive --ttl-hours", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--ttl-hours", "0"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --permanent on list/release", () => {
    const r = parseQuarantineArgs(["list", "--permanent"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --ttl-hours on list/release", () => {
    const r = parseQuarantineArgs(["release", "openai/gpt-5.5", "--ttl-hours", "1"]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects extra positional argument", () => {
    const r = parseQuarantineArgs(["add", "openai/gpt-5.5", "extra-positional"]);
    expect(r.ok).toBe(false);
  });

  it("parses list with no target", () => {
    const r = parseQuarantineArgs(["list"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toBe("list");
  });

  it("parses release with target", () => {
    const r = parseQuarantineArgs(["release", "openai/gpt-5.5"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("release");
      expect(r.target).toBe("openai/gpt-5.5");
    }
  });

  it("rejects release without target", () => {
    const r = parseQuarantineArgs(["release"]);
    expect(r.ok).toBe(false);
  });
});

describe("resolveAddExpiresAt", () => {
  it("returns Infinity for permanent", () => {
    const r = resolveAddExpiresAt(FIXED_NOW, { permanent: true });
    expect(r.expiresAt).toBe(Infinity);
    expect(r.permanent).toBe(true);
  });

  it("computes expiresAt for ttlHours", () => {
    const r = resolveAddExpiresAt(FIXED_NOW, { permanent: false, ttlHours: 24 });
    expect(r.expiresAt).toBe(FIXED_NOW + 24 * 3_600_000);
    expect(r.permanent).toBe(false);
  });

  it("defaults to 24 hours when ttlHours is omitted and not permanent", () => {
    const r = resolveAddExpiresAt(FIXED_NOW, { permanent: false });
    expect(r.expiresAt).toBe(FIXED_NOW + 24 * 3_600_000);
  });

  it("caps ttlHours at 1 year (8760)", () => {
    const r = resolveAddExpiresAt(FIXED_NOW, { permanent: false, ttlHours: 99999 });
    expect(r.expiresAt).toBe(FIXED_NOW + 8760 * 3_600_000);
  });
});

describe("mergeAddEntries", () => {
  it("merges non-overlapping sets", () => {
    const existing: QuarantineEntry[] = [
      { model: "openai/a", reason: "old", expiresAt: 1 },
    ];
    const toAdd: QuarantineEntry[] = [
      { model: "openai/b", reason: "new", expiresAt: 2 },
    ];
    const merged = mergeAddEntries(existing, toAdd);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.model)).toEqual(["openai/a", "openai/b"]);
  });

  it("replaces existing entries for the same model (idempotent re-add)", () => {
    const existing: QuarantineEntry[] = [
      { model: "openai/a", reason: "old", expiresAt: 1 },
    ];
    const toAdd: QuarantineEntry[] = [
      { model: "openai/a", reason: "new", expiresAt: 2 },
    ];
    const merged = mergeAddEntries(existing, toAdd);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.reason).toBe("new");
    expect(merged[0]?.expiresAt).toBe(2);
  });

  it("returns sorted by model id", () => {
    const existing: QuarantineEntry[] = [
      { model: "openai/z", reason: "r", expiresAt: 1 },
      { model: "openai/a", reason: "r", expiresAt: 1 },
    ];
    const toAdd: QuarantineEntry[] = [
      { model: "openai/m", reason: "r", expiresAt: 1 },
    ];
    const merged = mergeAddEntries(existing, toAdd);
    expect(merged.map((e) => e.model)).toEqual(["openai/a", "openai/m", "openai/z"]);
  });
});

describe("applyRelease", () => {
  it("removes entries whose model is in the target list", () => {
    const existing: QuarantineEntry[] = [
      { model: "openai/a", reason: "r", expiresAt: 1 },
      { model: "openai/b", reason: "r", expiresAt: 1 },
    ];
    const { kept, removedCount } = applyRelease(existing, ["openai/a"]);
    expect(removedCount).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.model).toBe("openai/b");
  });

  it("removes nothing when no overlap", () => {
    const existing: QuarantineEntry[] = [
      { model: "openai/a", reason: "r", expiresAt: 1 },
    ];
    const { kept, removedCount } = applyRelease(existing, ["openai/b"]);
    expect(removedCount).toBe(0);
    expect(kept).toHaveLength(1);
  });
});

describe("formatQuarantineEntry", () => {
  it("renders permanent as 'permanent'", () => {
    expect(formatQuarantineEntry({ model: "a/b", reason: "r", expiresAt: Infinity }, FIXED_NOW)).toContain("permanent");
  });

  it("renders future expiresAt as ISO", () => {
    const line = formatQuarantineEntry(
      { model: "a/b", reason: "r", expiresAt: FIXED_NOW + 1000 },
      FIXED_NOW,
    );
    expect(line).toContain(new Date(FIXED_NOW + 1000).toISOString());
  });

  it("renders past expiresAt as 'expired'", () => {
    expect(
      formatQuarantineEntry({ model: "a/b", reason: "r", expiresAt: FIXED_NOW - 1 }, FIXED_NOW),
    ).toContain("expired");
  });
});

describe("parseQuarantineFile", () => {
  it("returns [] for empty string", () => {
    expect(parseQuarantineFile("", FIXED_NOW)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseQuarantineFile("not json", FIXED_NOW)).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseQuarantineFile('{"key":"value"}', FIXED_NOW)).toEqual([]);
  });

  it("restores permanent entries (expiresAt:null → Infinity)", () => {
    const raw = JSON.stringify([
      { model: "openai/a", reason: "manual", expiresAt: null },
    ]);
    const entries = parseQuarantineFile(raw, FIXED_NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.expiresAt).toBe(Infinity);
  });

  it("drops non-manual TTL entries", () => {
    const raw = JSON.stringify([
      { model: "openai/a", reason: "rate_limit", expiresAt: FIXED_NOW + 60_000 },
    ]);
    expect(parseQuarantineFile(raw, FIXED_NOW)).toEqual([]);
  });

  it("drops manual TTL entries that have expired", () => {
    const raw = JSON.stringify([
      { model: "openai/a", reason: "manual", expiresAt: FIXED_NOW - 1000, manual: true },
    ]);
    expect(parseQuarantineFile(raw, FIXED_NOW)).toEqual([]);
  });

  it("keeps manual TTL entries that are still alive", () => {
    const raw = JSON.stringify([
      { model: "openai/a", reason: "manual", expiresAt: FIXED_NOW + 60_000, manual: true },
    ]);
    const entries = parseQuarantineFile(raw, FIXED_NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.expiresAt).toBe(FIXED_NOW + 60_000);
    expect(entries[0]?.manual).toBe(true);
  });

  it("skips entries missing required fields", () => {
    const raw = JSON.stringify([
      { reason: "manual", expiresAt: null }, // missing model
      { model: "openai/a", expiresAt: null }, // missing reason
      { model: "openai/b", reason: "r" }, // missing expiresAt
    ]);
    const entries = parseQuarantineFile(raw, FIXED_NOW);
    expect(entries).toEqual([]);
  });
});

describe("runQuarantine — add / list / release round-trip", () => {
  let tmpRoot: string;
  let filePath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cli-quarantine-"));
    filePath = path.join(tmpRoot, "quarantine.json");
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("add writes a permanent entry to the file", async () => {
    const result = await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "openai/gpt-5.5",
        permanent: true,
        reason: "test",
        filePath,
      },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "add") return;
    expect(result.expandedCount).toBe(1);
    expect(result.permanent).toBe(true);
    expect(result.filePath).toBe(filePath);

    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]?.model).toBe("openai/gpt-5.5");
    expect(written[0]?.expiresAt).toBeNull();
    expect(written[0]?.reason).toBe("test");
  });

  it("add with --ttl-hours writes a finite TTL entry", async () => {
    const result = await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "openai/gpt-5.5",
        permanent: false,
        ttlHours: 4,
        filePath,
      },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "add") return;
    expect(result.expandedCount).toBe(1);
    expect(result.permanent).toBe(false);
    expect(result.expiresAt).toBe(FIXED_NOW + 4 * 3_600_000);

    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]?.expiresAt).toBe(FIXED_NOW + 4 * 3_600_000);
    expect(written[0]?.manual).toBe(true);
  });

  it("add with provider/* expands to every registry key under that provider", async () => {
    const result = await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "opencode-go/*",
        permanent: true,
        reason: "group block",
        filePath,
      },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "add") return;
    expect(result.expandedCount).toBeGreaterThan(1);

    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written.length).toBe(result.expandedCount);
    for (const entry of written) {
      expect(entry.model.startsWith("opencode-go/")).toBe(true);
      expect(entry.expiresAt).toBeNull();
    }
  });

  it("add to an unknown target returns ok=false", async () => {
    const result = await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "nonexistent/*",
        permanent: true,
        filePath,
      },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("list returns the entries from the file", async () => {
    await writeFile(
      filePath,
      JSON.stringify([
        { model: "openai/a", reason: "manual", expiresAt: null },
        { model: "anthropic/b", reason: "manual", expiresAt: FIXED_NOW + 60_000, manual: true },
      ]),
      "utf8",
    );
    const result = await runQuarantine(
      { ok: true, action: "list", permanent: false, filePath },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "list") return;
    expect(result.entries).toHaveLength(2);
  });

  it("list on missing file returns ok:true with empty entries", async () => {
    const result = await runQuarantine(
      { ok: true, action: "list", permanent: false, filePath },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "list") return;
    expect(result.entries).toEqual([]);
  });

  it("release removes matching entries from the file", async () => {
    await writeFile(
      filePath,
      JSON.stringify([
        { model: "openai/a", reason: "manual", expiresAt: null },
        { model: "anthropic/b", reason: "manual", expiresAt: null },
      ]),
      "utf8",
    );
    const result = await runQuarantine(
      { ok: true, action: "release", target: "openai/a", permanent: false, filePath },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "release") return;
    expect(result.removedCount).toBe(1);

    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]?.model).toBe("anthropic/b");
  });

  it("release with provider/* clears the whole group", async () => {
    // Use real registry keys so resolveProviderGroup finds them. The
    // release path group-expands via the benchmark registry — fake
    // keys would not match.
    await writeFile(
      filePath,
      JSON.stringify([
        { model: "opencode-go/deepseek-v4-pro", reason: "manual", expiresAt: null },
        { model: "opencode-go/glm-5.2", reason: "manual", expiresAt: null },
        { model: "openai/gpt-5.5", reason: "manual", expiresAt: null },
      ]),
      "utf8",
    );
    const result = await runQuarantine(
      { ok: true, action: "release", target: "opencode-go/*", permanent: false, filePath },
      () => FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== "release") return;
    expect(result.removedCount).toBe(2);

    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]?.model).toBe("openai/gpt-5.5");
  });

  it("add preserves existing entries when expanding a single model", async () => {
    await writeFile(
      filePath,
      JSON.stringify([
        { model: "anthropic/a", reason: "old", expiresAt: null },
      ]),
      "utf8",
    );
    await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "openai/gpt-5.5",
        permanent: true,
        reason: "new",
        filePath,
      },
      () => FIXED_NOW,
    );
    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toHaveLength(2);
    expect(written.map((e: { model: string }) => e.model).sort()).toEqual([
      "anthropic/a",
      "openai/gpt-5.5",
    ]);
  });

  it("uses the explicit --file path when supplied", async () => {
    const explicitPath = path.join(tmpRoot, "explicit.json");
    await runQuarantine(
      {
        ok: true,
        action: "add",
        target: "openai/gpt-5.5",
        permanent: true,
        filePath: explicitPath,
      },
      () => FIXED_NOW,
    );
    const written = JSON.parse(await readFile(explicitPath, "utf8"));
    expect(written).toHaveLength(1);
  });
});

describe("loadQuarantineFile / writeQuarantineFile", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cli-quarantine-file-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates parent dirs when writing", async () => {
    const filePath = path.join(tmpRoot, "nested", "deeper", "quarantine.json");
    await writeQuarantineFile(filePath, [
      { model: "openai/a", reason: "manual", expiresAt: Infinity },
    ]);
    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written[0]?.expiresAt).toBeNull();
    expect(written[0]?.manual).toBeUndefined();
  });

  it("returns [] when the file is missing", async () => {
    expect(await loadQuarantineFile(path.join(tmpRoot, "missing.json"))).toEqual([]);
  });

  it("write then load round-trips manual entries", async () => {
    const filePath = path.join(tmpRoot, "quarantine.json");
    const original: QuarantineEntry[] = [
      { model: "openai/a", reason: "r", expiresAt: Infinity },
      { model: "anthropic/b", reason: "r", expiresAt: FIXED_NOW + 60_000, manual: true },
    ];
    await writeQuarantineFile(filePath, original);
    const loaded = await loadQuarantineFile(filePath, FIXED_NOW);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((e) => e.model === "openai/a")?.expiresAt).toBe(Infinity);
    expect(loaded.find((e) => e.model === "anthropic/b")?.expiresAt).toBe(FIXED_NOW + 60_000);
  });
});