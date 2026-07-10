/**
 * Phase-winner evaluation harness.
 *
 * One-shot script that imports the freshly-patched benchmark registry,
 * runs `scoreCandidates` against the three SDD planning phases
 * (sdd-propose, sdd-design, sdd-spec), and prints the top-5 per phase.
 *
 * Lives in tests/ so it can use direct source imports — dist API does
 * NOT re-export benchmark-registry.
 *
 * Not a regression assertion; assertions are kept loose (>= 0 etc.) so
 * the harness is robust to score drift as the registry evolves.
 */
import { describe, expect, it } from "vitest";
import {
  getBenchmarkRegistry,
  type BenchmarkEntry,
} from "../src/benchmark-registry.js";
import { scoreCandidates } from "../src/scoring.js";
import { normalizeTaskContext } from "../src/context.js";
import type { LadderRung } from "../src/types.js";

interface RegistryAsEvidence {
  key: string;
  provider: string;
  model: string;
  benchmarks: Record<string, number>;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  cacheHitCost?: number;
  maxOutput?: number;
  availability: "available" | "unknown" | "unavailable";
  source: string;
  date: string;
  confidence: number;
  ladderRung: LadderRung;
}

const LADDER_RUNG_BY_PROVIDER: Record<string, LadderRung> = {
  minimax: "minimax",
  google: "google-antigravity",
  "google-antigravity": "google-antigravity",
  openai: "openai",
  zai: "glm-5.2",
  anthropic: "anthropic",
  deepseek: "openai", // proxy rung; DeepSeek is competitive on $/quality
  xai: "openai",
  nvidia: "openai",
  meta: "openai",
  mistral: "openai",
  xiaomi: "minimax",
  hf: "minimax",
  "opencode-go": "openai",
  "zai-coding-plan": "glm-5.2",
};

function deriveRung(provider: string): LadderRung {
  return LADDER_RUNG_BY_PROVIDER[provider] ?? "minimax";
}

function registryToEvidence(): RegistryAsEvidence[] {
  return getBenchmarkRegistry().map((e: BenchmarkEntry) => {
    const [provider, ...rest] = e.key.split("/");
    const prov = provider ?? "";
    return {
      key: e.key,
      provider: prov,
      model: rest.join("/") || e.key,
      benchmarks: e.benchmarks,
      contextWindow: e.contextWindow,
      inputCost: e.inputCost,
      outputCost: e.outputCost,
      cacheHitCost: e.cacheHitCost,
      maxOutput: e.maxOutput,
      availability: e.availability,
      source: e.source,
      date: e.date,
      confidence: e.confidence,
      ladderRung: deriveRung(prov),
    };
  });
}

function printTopN(phase: string, top: Array<{ key: string; score: number; confidence: number; rung: string }>) {
  console.log(`\n==[ ${phase} ]=========================================`);
  for (let i = 0; i < top.length; i++) {
    const r = top[i]!;
    console.log(
      `  ${i + 1}. ${r.key.padEnd(38)} score=${r.score.toFixed(4)} conf=${r.confidence.toFixed(3)} rung=${r.rung}`,
    );
  }
}

function lookupRank(
  ranked: Array<{ model: string; score: number; confidence: number; ladderRung: LadderRung }>,
  needle: string,
): { rank: number; score: number } | null {
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i]!.model.includes(needle)) return { rank: i + 1, score: ranked[i]!.score };
  }
  return null;
}

describe("phase winners (post-2026-07-08 patches)", () => {
  it("ranks the registry for sdd-propose / sdd-design / sdd-spec and prints winners", () => {
    const records = registryToEvidence();
    const phases = ["sdd-propose", "sdd-design", "sdd-spec"] as const;
    const winnerByPhase: Record<string, string> = {};

    console.log("\n=========================================================");
    console.log("FULL POOL (37 registry entries) per phase");
    console.log("=========================================================");

    for (const phase of phases) {
      const signals = normalizeTaskContext({
        diffLines: 400,
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        symbols: ["Strategy", "Repository"],
        riskDomain: "architecture",
        contextBreadth: "moderate",
        modality: ["code"],
        phase,
      });
      const candidates = records.map((r) => ({
        kind: "found" as const,
        provider: r.provider,
        model: r.model,
        record: {
          model: r.model,
          provider: r.provider,
          benchmarks: r.benchmarks,
          contextWindow: r.contextWindow,
          inputCost: r.inputCost,
          outputCost: r.outputCost,
          cacheHitCost: r.cacheHitCost,
          maxOutput: r.maxOutput,
          availability: r.availability,
          source: r.source,
          date: r.date,
          confidence: r.confidence,
        },
      }));
      const ranked = scoreCandidates(signals, candidates);
      const fullRanked = ranked.map((c, idx) => {
        // find ladderRung from registry by matching model+provider
        const foundRec = records.find(
          (r) => r.provider === c.citations[0]?.model.split("/")[0] && r.model === c.model.split("/")[1],
        );
        return {
          model: c.model,
          score: c.score,
          confidence: c.confidence,
          ladderRung: foundRec?.ladderRung ?? ("minimax" as LadderRung),
          rank: idx + 1,
        };
      });
      const top = fullRanked.slice(0, 6);
      printTopN(phase, top.map((r) => ({ key: r.model, score: r.score, confidence: r.confidence, rung: r.ladderRung })));
      winnerByPhase[phase] = top[0]!.model;

      // Headline lookups for the user's question
      const glm = lookupRank(fullRanked, "glm-5.2");
      const gemini = lookupRank(fullRanked, "gemini-3.5-flash");
      const claudeSonnet = lookupRank(fullRanked, "claude-sonnet");
      const deepseekPro = lookupRank(fullRanked, "deepseek-v4-pro");
      console.log(`  -- spot checks --`);
      console.log(`     GLM-5.2 rank:           ${glm ? `#${glm.rank} (score=${glm.score.toFixed(4)})` : "not in pool"}`);
      console.log(`     Gemini 3.5 Flash rank:  ${gemini ? `#${gemini.rank} (score=${gemini.score.toFixed(4)})` : "not in pool"}`);
      console.log(`     Claude Sonnet rank:     ${claudeSonnet ? `#${claudeSonnet.rank} (score=${claudeSonnet.score.toFixed(4)})` : "not in pool"}`);
      console.log(`     DeepSeek V4 Pro rank:   ${deepseekPro ? `#${deepseekPro.rank} (score=${deepseekPro.score.toFixed(4)})` : "not in pool"}`);
    }

    expect(Object.keys(winnerByPhase).length).toBe(phases.length);
    for (const phase of phases) {
      expect(winnerByPhase[phase]).toMatch(/\/.+/);
    }

    // Regression guard: with cost weight zeroed for sdd-design/propose/spec,
    // Anthropic reasoning-class models (Opus 4-7+, Sonnet 5+) MUST outrank
    // the cheap DeepSeek V4 Flash. Pre-patch this assertion would fail
    // because DeepSeek V4 Flash topped all three phases.
    const anthropicTop3 = ["sdd-propose", "sdd-design", "sdd-spec"].map((phase) =>
      rankedFor(phase).slice(0, 3).every((r) => /anthropic\//.test(r.key) || /gpt-5\.5/.test(r.key))
    );
    // (Reach into each phase's ranking through the test closure — the
    // outer scope's `records` and `phases` are captured. We use a
    // re-ranking pass to assert.)
    expect(true).toBe(true); // sentinel; the strict assertion lives below.

    console.log("\n=========================================================");
    console.log("WINNERS SUMMARY");
    console.log("=========================================================");
    for (const phase of phases) {
      console.log(`  ${phase.padEnd(14)} → ${winnerByPhase[phase]}`);
    }
    for (const phase of phases) {
      const top = rankedFor(phase);
      const opusRank = top.findIndex((r) => /claude-opus|claude-fable/i.test(r.key));
      const deepseekRank = top.findIndex((r) => /deepseek-v4-flash/.test(r.key));
      console.log(
        `  ${phase.padEnd(14)} opus/fable@${opusRank >= 0 ? opusRank + 1 : "—"}, deepseek-flash@${
          deepseekRank >= 0 ? deepseekRank + 1 : "—"
        }`,
      );
    }

    // Strict guard: for every reasoning phase, an Anthropic reasoning-class
    // model beats deepseek-v4-flash. (Fable 5 / Opus 4-8 / Opus 4-7 / Sonnet
    // 5 — any one is enough.)
    for (const phase of phases) {
      const top = rankedFor(phase);
      const anthropicBestRank = Math.min(
        ...["claude-fable", "claude-opus", "claude-sonnet-5"].map((needle) => {
          const idx = top.findIndex((r) => r.key.includes(needle));
          return idx === -1 ? Number.POSITIVE_INFINITY : idx;
        }),
      );
      const deepseekFlashRank = top.findIndex((r) => r.key.includes("deepseek-v4-flash"));
      expect(anthropicBestRank, `anthropic must beat deepseek-flash in ${phase}`).toBeLessThan(
        deepseekFlashRank === -1 ? Number.POSITIVE_INFINITY : deepseekFlashRank,
      );
    }
  });
});

function rankedFor(phase: string) {
  // Re-rank lazily for assertions; cheaper than threading the original
  // `ranked` array through closures. Only invoked by assertion paths.
  const records = getBenchmarkRegistry().map((e) => {
    const [provider, ...rest] = e.key.split("/");
    return {
      provider: provider ?? "",
      model: rest.join("/") || e.key,
      record: {
        model: rest.join("/") || e.key,
        provider: provider ?? "",
        benchmarks: e.benchmarks,
        contextWindow: e.contextWindow,
        inputCost: e.inputCost,
        outputCost: e.outputCost,
        cacheHitCost: e.cacheHitCost,
        maxOutput: e.maxOutput,
        availability: e.availability,
        source: e.source,
        date: e.date,
        confidence: e.confidence,
      },
    } as unknown as { provider: string; model: string };
  });
  const signals = normalizeTaskContext({
    diffLines: 400,
    files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    symbols: ["Strategy", "Repository"],
    riskDomain: "architecture",
    contextBreadth: "moderate",
    modality: ["code"],
    phase,
  });
  const candidates = records.map((r) => ({
    kind: "found" as const,
    provider: r.provider,
    model: r.model,
    record: r.record,
  }));
  const ranked = scoreCandidates(signals, candidates);
  return ranked.map((c) => ({ key: c.model, score: c.score, confidence: c.confidence }));
}
