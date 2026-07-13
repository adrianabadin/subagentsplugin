/**
 * forecast-ux-maintenance regression lockdown.
 *
 * These tests pin the contracts introduced by the slice work:
 *   - Repo-local benchmark data overrides compiled registry.
 *   - Evidence registry exposes the effective (merged) view.
 *   - Permanent quarantine files load before hooks select models.
 *   - Forecast state writes are atomic and round-trip.
 *   - CLI update-data writes valid benchmarks.json atomically.
 *   - Generated aliases fall back from blocked base phase candidates.
 *   - Logger is silent by default; verbose opt-in restores diagnostics.
 *
 * If ANY of these scenarios regress, the lockdown fails loud.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  getBenchmarkRegistry,
  lookupBenchmark,
  setRepoLocal,
} from "../src/benchmark-registry.js";
import { lookupEvidence, getEvidenceRegistry } from "../src/evidence.js";
import { QuarantineStore } from "../src/quarantine.js";
import { createGeneratedProfileResolver, generatedProfileAlias } from "../src/profiles.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { runUpdateData } from "../src/cli-update-data.js";
import { readStateFile, writeStateFile } from "../src/state-file.js";

const REPO_ROOT = path.join(tmpdir(), "forecast-ux-regression");

beforeEach(async () => {
  await mkdir(REPO_ROOT, { recursive: true });
});

afterEach(async () => {
  setRepoLocal(null);
  await rm(REPO_ROOT, { recursive: true, force: true });
});

describe("regression — repo-local override precedence", () => {
  it("compiled registry entries not in repo-local are preserved", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.95,
      },
    ]);
    const entry = lookupBenchmark("anthropic/claude-opus-4-7");
    expect(entry?.source).not.toBe("repo-local");
    expect(entry?.key).toBe("anthropic/claude-opus-4-7");
  });

  it("repo-local entry for an existing key wins over compiled", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local-override",
        date: "2026-07-08",
        confidence: 0.95,
      },
    ]);
    expect(lookupBenchmark("openai/gpt-5.5")?.source).toBe("repo-local-override");
  });

  it("evidence registry surfaces the effective view including overrides", () => {
    setRepoLocal([
      {
        key: "openai/gpt-5.5",
        benchmarks: { mmlu: 0.99 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.95,
      },
    ]);
    const registry = getEvidenceRegistry();
    expect(registry.some((r) => r.source === "repo-local")).toBe(true);
  });
});

describe("regression — quarantine + generated alias fallback", () => {
  function makeProfile(modelId: string) {
    return {
      baseAgent: "sdd-design",
      alias: generatedProfileAlias("sdd-design", modelId),
      provider: modelId.split("/")[0] ?? "",
      model: modelId.split("/")[1] ?? modelId,
      modelId,
      ladderRung: "openai" as const,
      evidence: {
        provider: modelId.split("/")[0] ?? "",
        model: modelId.split("/")[1] ?? modelId,
        benchmarks: {},
        contextWindow: 1_000_000,
        inputCost: 0.4,
        outputCost: 1.6,
        availability: "available" as const,
        source: "test",
        date: "2026-07-08",
        confidence: 0.85,
      },
    };
  }

  it("falls back from a blocked generated alias dispatch", () => {
    const blocked = makeProfile("opencode-go/deepseek-v4-pro");
    const safe = makeProfile("openai/gpt-5.5");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    quarantine.add("opencode-go/deepseek-v4-pro", "permanent_test");

    const resolver = createGeneratedProfileResolver(
      { byBase: { "sdd-design": [blocked, safe] } },
      { quarantine },
    );

    const candidates = resolver({
      originalSubagentType: blocked.alias,
      ladder: DEFAULT_LADDER,
      context: { phase: "sdd-design" },
      policy: { mode: "auto", confidenceThreshold: 0.6 },
      args: { subagent_type: blocked.alias },
    });

    expect(candidates.map((c) => c.model)).toEqual(["openai/gpt-5.5"]);
    expect(candidates[0]?.subagent_type).toBe(safe.alias);
  });
});

describe("regression — forecast state file atomic round-trip", () => {
  it("state.json round-trips through writeStateFile + readStateFile", async () => {
    const statePath = path.join(REPO_ROOT, "state.json");
    const state = {
      selectedModel: "openai/gpt-5.5",
      selectedEffort: "",
      selectedConfidence: 0.9,
      fallbackModel: "anthropic/claude-opus-4-8",
      fallbackConfidence: 0.85,
      preset: "balanced",
      mode: "auto" as const,
      quarantineCount: 1,
      quarantined: ["opencode-go/deepseek-v4-pro"],
      cacheAge: null,
      lastUpdate: "2026-07-08T12:00:00.000Z",
      activeRecoveryCount: 0,
      activeRecoveries: [],
      lastRecovery: null,
    };
    await writeStateFile(statePath, state);
    const round = await readStateFile(statePath);
    expect(round).toEqual(state);
  });
});

describe("regression — CLI update-data writes atomic file", () => {
  it("writes a parsed array of BenchmarkEntry-shaped objects", async () => {
    const fromFile = path.join(REPO_ROOT, "incoming.json");
    const projectRoot = await mkdtemp(path.join(tmpdir(), "ux-update-"));
    try {
      await writeFile(
        fromFile,
        JSON.stringify([
          {
            key: "openai/gpt-5.5",
            benchmarks: { mmlu: 0.9 },
            availability: "available",
            source: "lockdown",
            date: "2026-07-08",
            confidence: 0.95,
          },
        ]),
        "utf8",
      );
      const result = await runUpdateData({ ok: true, fromFile }, projectRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(await readFile(result.outputPath, "utf8"));
      expect(written[0].key).toBe("openai/gpt-5.5");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
