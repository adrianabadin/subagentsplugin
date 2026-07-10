/**
 * Repo-local benchmark override tests.
 *
 * Contract under test (per `sdd/forecast-ux-maintenance/spec.md`):
 *   - `forecast-data/benchmarks.json` provides repo-local entries that
 *     override compiled entries by key (replace-by-key, NOT deep merge).
 *   - Missing dir → compiled fallback, no error.
 *   - Malformed JSON → compiled fallback, warning logged.
 *   - `setRepoLocal(null)` clears the override for tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  getBenchmarkRegistry,
  lookupBenchmark,
  setRepoLocal,
} from "../src/benchmark-registry.js";
import { getEvidenceRegistry, lookupEvidence } from "../src/evidence.js";
import {
  globalBenchmarksPath,
  loadEffectiveBenchmarks,
  loadGlobalBenchmarks,
  loadRepoBenchmarks,
  loadRepoOverrides,
  saveGlobalBenchmarks,
} from "../src/repo-data.js";

describe("repo-data — loadRepoBenchmarks", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "repo-data-"));
  });
  afterEach(async () => {
    setRepoLocal(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when forecast-data/ is absent (compiled fallback only)", async () => {
    const entries = await loadRepoBenchmarks(tmpRoot);
    expect(entries).toBeNull();
  });

  it("returns parsed entries when benchmarks.json is valid", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "benchmarks.json"),
      JSON.stringify([
        {
          key: "openai/gpt-5.5",
          benchmarks: { mmlu: 0.99 },
          availability: "available",
          source: "test",
          date: "2026-07-08",
          confidence: 0.9,
        },
      ]),
      "utf8",
    );
    const entries = await loadRepoBenchmarks(tmpRoot);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.key).toBe("openai/gpt-5.5");
  });

  it("returns null when benchmarks.json is malformed", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "benchmarks.json"), "{ not valid json", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = await loadRepoBenchmarks(tmpRoot);
      expect(entries).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("is malformed");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("repo-data — loadRepoOverrides", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "repo-overrides-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when overrides.json is absent", async () => {
    expect(await loadRepoOverrides(tmpRoot)).toBeNull();
  });

  it("returns parsed overrides when overrides.json is valid", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "overrides.json"),
      JSON.stringify({
        preset: "aggressive",
        ladder: [{ rung: "anthropic", modelId: "anthropic/claude-opus-4-8" }],
        quarantine: { permanent: ["anthropic/claude-fable-5"] },
      }),
      "utf8",
    );
    const overrides = await loadRepoOverrides(tmpRoot);
    expect(overrides?.preset).toBe("aggressive");
    expect(overrides?.ladder?.[0]?.rung).toBe("anthropic");
    expect(overrides?.quarantine?.permanent?.[0]).toBe("anthropic/claude-fable-5");
  });

  it("returns null when overrides.json is malformed", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "overrides.json"), "{ broken", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadRepoOverrides(tmpRoot)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("is malformed");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("repo-data — isBenchmarkEntry validator", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "repo-validate-"));
  });
  afterEach(async () => {
    setRepoLocal(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("drops entries missing required availability / source / date / confidence fields", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "benchmarks.json"),
      JSON.stringify([
        {
          key: "openai/gpt-5.5",
          benchmarks: { mmlu: 0.9 },
        },
      ]),
      "utf8",
    );
    const entries = await loadRepoBenchmarks(tmpRoot);
    expect(entries).toEqual([]);
  });

  it("accepts empty arrays", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "benchmarks.json"), "[]", "utf8");
    expect(await loadRepoBenchmarks(tmpRoot)).toEqual([]);
  });

  it("warns when payload is not an array", async () => {
    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "benchmarks.json"), JSON.stringify({ key: "x" }), "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadRepoBenchmarks(tmpRoot)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("must be a JSON array");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("repo-data - global + repo-local effective benchmarks", () => {
  let tmpRoot: string;
  let globalPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "repo-effective-"));
    globalPath = path.join(tmpRoot, "global", "benchmarks.json");
  });

  afterEach(async () => {
    setRepoLocal(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("uses a stable config path under the user home by default", () => {
    expect(globalBenchmarksPath()).toContain("opencode-model-forecast");
    expect(globalBenchmarksPath()).toMatch(/benchmarks\.json$/);
  });

  it("loads and saves global benchmark overrides", async () => {
    await saveGlobalBenchmarks([
      {
        key: "opencode-go/deepseek-v4-pro",
        benchmarks: { mmlu: 0.91 },
        availability: "unavailable",
        source: "global-test",
        date: "2026-07-09",
        confidence: 0.95,
      },
    ], globalPath);

    const loaded = await loadGlobalBenchmarks(globalPath);

    expect(loaded).toHaveLength(1);
    expect(loaded?.[0]?.key).toBe("opencode-go/deepseek-v4-pro");
    expect(loaded?.[0]?.availability).toBe("unavailable");
  });

  it("loads effective overrides with precedence compiled < global < repo-local", async () => {
    await saveGlobalBenchmarks([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.11 },
        availability: "available",
        source: "global-override",
        date: "2026-07-09",
        confidence: 0.4,
      },
      {
        key: "opencode-go/deepseek-v4-pro",
        benchmarks: { mmlu: 0.91 },
        availability: "unavailable",
        source: "global-only",
        date: "2026-07-09",
        confidence: 0.95,
      },
    ], globalPath);

    const dir = path.join(tmpRoot, "forecast-data");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "benchmarks.json"),
      JSON.stringify([
        {
          key: "openai/gpt-5.5",
          benchmarks: { mmlu: 0.99 },
          availability: "available",
          source: "repo-local-override",
          date: "2026-07-09",
          confidence: 0.99,
        },
      ]),
      "utf8",
    );

    const effective = await loadEffectiveBenchmarks({ rootDir: tmpRoot, globalPath });

    expect(effective.find((entry) => entry.key === "openai/gpt-5.5")?.source).toBe("repo-local-override");
    expect(effective.find((entry) => entry.key === "opencode-go/deepseek-v4-pro")?.source).toBe("global-only");
    expect(lookupBenchmark("openai/gpt-5.5")?.source).toBe("repo-local-override");
    expect(lookupBenchmark("opencode-go/deepseek-v4-pro")?.availability).toBe("unavailable");
  });
});

describe("benchmark-registry — setRepoLocal replace-by-key", () => {
  beforeEach(() => {
    setRepoLocal(null);
  });
  afterEach(() => {
    setRepoLocal(null);
  });

  it("repo-local entry replaces compiled entry with the same key", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99, custom: 1 },
        contextWindow: 500_000,
        inputCost: 1,
        outputCost: 2,
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);

    const entry = lookupBenchmark("openai/gpt-5.5");
    expect(entry?.source).toBe("repo-local");
    expect(entry?.confidence).toBe(0.99);
    expect(entry?.benchmarks.custom).toBe(1);
  });

  it("compiled entry is preserved when no repo-local override exists for that key", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);

    const entry = lookupBenchmark("anthropic/claude-opus-4-7");
    expect(entry?.source).not.toBe("repo-local");
  });

  it("getBenchmarkRegistry() exposes the effective (merged) registry so model-groups sees overrides", () => {
    setRepoLocal([
      {
        key: "google/gemini-3.5-flash",
        benchmarks: { mmlu: 0.9 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.95,
      },
    ]);
    const registry = getBenchmarkRegistry();
    expect(registry.some((e) => e.source === "repo-local" && e.key === "google/gemini-3.5-flash")).toBe(true);
  });

  it("setRepoLocal(null) restores compiled registry and lookup returns compiled values", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);
    setRepoLocal(null);
    const entry = lookupBenchmark("openai/gpt-5.5");
    expect(entry?.source).not.toBe("repo-local");
  });

  it("lookupEvidence reflects repo-local benchmark override when the key matches", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);
    const result = lookupEvidence("openai/gpt-5.5");
    if (result.kind !== "found") throw new Error("expected found");
    expect(result.record.confidence).toBe(0.99);
  });

  it("repo-local override beats compiled registry for an existing registry key", () => {
    // Regression: lookupEvidence used to consult REGISTRY before repo-local,
    // so a compiled entry would shadow the override. Now repo-local wins.
    setRepoLocal([
      {
        key: "openai/gpt-4.1",
        benchmarks: { mmlu: 0.99, custom: 1 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);
    const result = lookupEvidence("openai/gpt-4.1");
    if (result.kind !== "found") throw new Error("expected found");
    expect(result.record.source).toBe("repo-local");
    expect(result.record.confidence).toBe(0.99);
  });

  it("lookupBenchmark honors repo-local override for stripped multi-segment keys", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);
    const entry = lookupBenchmark("vercel/openai/gpt-5.5");
    expect(entry?.source).toBe("repo-local");
  });

  it("getEvidenceRegistry() exposes the effective view including repo-local entries", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.99,
      },
    ]);
    const registry = getEvidenceRegistry();
    expect(registry.some((r) => r.provider === "openai" && r.model === "gpt-5.5" && r.source === "repo-local")).toBe(true);
  });
});
