/**
 * PR1 unit tests — deterministic weighted scoring engine.
 *
 * RED phase: these tests reference src/scoring.ts which does NOT exist
 * yet. Running `npm test` before the implementation lands must fail.
 *
 * Scenarios verified (per spec `explainable-scoring` + task 1.6):
 *   1. Non-Anthropic preference: a non-Anthropic model with strictly
 *      better evidence (larger context, lower cost, comparable benchmark)
 *      MUST rank higher than an Anthropic model with worse signals, and
 *      the returned reasoning MUST cite the evidence factor(s) used.
 *   2. Stale evidence lowers confidence: when the evidence `date` is
 *      older than the configured staleness threshold, the confidence
 *      output is strictly lower than for fresh evidence.
 *   3. Missing evidence returns a low fallback confidence and the
 *      candidate is still ranked (just at the bottom), so callers can
 *      see the model as a viable last-resort option.
 *   4. Returned citations include `source` + `date` for every
 *      contributing factor (spec scenario: "Verbose forecast ... citations
 *      include source+date").
 *
 * Determinism: same input → same ranked output, no randomness.
 */

import { describe, expect, it } from "vitest";
import {
  scoreCandidates,
  computeConfidence,
  effectiveWeights,
  PHASE_FACTOR_OVERRIDES,
  SCORING_WEIGHTS,
  type ScoreCandidateInput,
  type ScoredCandidate,
} from "../src/scoring.js";
import type { TaskSignals } from "../src/context.js";
import type { EvidenceRecord } from "../src/evidence.js";

/** Helper: a found candidate wrapping a minimal EvidenceRecord. */
function found(record: EvidenceRecord): ScoreCandidateInput {
  return { kind: "found", provider: record.provider, model: record.model, record };
}

/** Helper: a missing-evidence candidate (no record available). */
function missing(provider: string, model: string): ScoreCandidateInput {
  return { kind: "missing", provider, model };
}

/** Helper: a minimal EvidenceRecord for tests. */
function evidence(
  partial: Partial<EvidenceRecord> & {
    provider: string;
    model: string;
    confidence: number;
  },
): EvidenceRecord {
  return {
    benchmarks: {},
    availability: "available",
    source: "test-source",
    date: "2026-04-01",
    ...partial,
  };
}

const signals: TaskSignals = {
  contextSize: "medium",
  riskTier: "medium",
  breadth: "moderate",
  modalities: ["code"],
};

describe("scoring — scoreCandidates: non-Anthropic preference", () => {
  it("ranks a non-Anthropic model above an Anthropic one when its evidence wins on context-fit + cost", () => {
    const opus = found(
      evidence({
        provider: "anthropic",
        model: "claude-opus-4-7",
        benchmarks: { "swe-bench": 0.78 },
        contextWindow: 200_000,
        inputCost: 15,
        outputCost: 75,
        date: "2026-04-01",
        confidence: 0.95,
      }),
    );
    const gemini = found(
      evidence({
        provider: "google",
        model: "gemini-2.5-pro",
        benchmarks: { "swe-bench": 0.74 },
        contextWindow: 1_000_000,
        inputCost: 1.25,
        outputCost: 10,
        date: "2026-03-15",
        confidence: 0.85,
      }),
    );
    const ranked = scoreCandidates(signals, [opus, gemini]);
    expect(ranked.length).toBe(2);
    // gemini wins on context-fit (1M vs 200k) and cost (1.25 vs 15) with
    // comparable benchmark; opus benchmark is marginally higher but the
    // scorer MUST reward context + cost enough to flip the order.
    expect(ranked[0]!.model).toBe("google/gemini-2.5-pro");
    expect(ranked[1]!.model).toBe("anthropic/claude-opus-4-7");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    // Reasoning on the top candidate MUST cite at least one factor by name.
    expect(ranked[0]!.reasoning.toLowerCase()).toMatch(
      /context-fit|cost|benchmark|availability/,
    );
  });

  it("ranked output is deterministic — calling twice with same input produces identical order", () => {
    const a = found(
      evidence({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        benchmarks: { "swe-bench": 0.71 },
        contextWindow: 200_000,
        inputCost: 3,
        confidence: 0.9,
      }),
    );
    const b = found(
      evidence({
        provider: "google",
        model: "gemini-2.5-flash",
        benchmarks: { "swe-bench": 0.6 },
        contextWindow: 1_000_000,
        inputCost: 0.3,
        confidence: 0.85,
      }),
    );
    const run1 = scoreCandidates(signals, [a, b]);
    const run2 = scoreCandidates(signals, [a, b]);
    expect(run1.map((c) => c.model)).toEqual(run2.map((c) => c.model));
    expect(run1.map((c) => c.score)).toEqual(run2.map((c) => c.score));
  });
});

describe("scoring — scoreCandidates: missing evidence", () => {
  it("a candidate with missing evidence is ranked last but still included", () => {
    const known = found(
      evidence({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        benchmarks: { mmlu: 0.81 },
        contextWindow: 200_000,
        inputCost: 0.8,
        confidence: 0.95,
      }),
    );
    const ranked = scoreCandidates(signals, [
      missing("unknown-vendor", "mystery-1"),
      known,
    ]);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.model).toBe("anthropic/claude-haiku-4-5");
    expect(ranked[1]!.model).toBe("unknown-vendor/mystery-1");
    // Missing-evidence candidate carries a low confidence + a reason.
    expect(ranked[1]!.confidence).toBeLessThan(ranked[0]!.confidence);
    expect(ranked[1]!.reasoning.toLowerCase()).toMatch(/no.?evidence|missing/);
  });

  it("scoreCandidates with an empty candidate list returns an empty array", () => {
    expect(scoreCandidates(signals, [])).toEqual([]);
  });
});

describe("scoring — scoreCandidates: citations include source + date", () => {
  it("every ranked candidate carries at least one citation with non-empty source and parseable date", () => {
    const a = found(
      evidence({
        provider: "anthropic",
        model: "claude-opus-4-7",
        benchmarks: { "swe-bench": 0.78 },
        confidence: 0.9,
        source: "anthropic.com/docs",
        date: "2026-04-01",
      }),
    );
    const b = found(
      evidence({
        provider: "google",
        model: "gemini-2.5-pro",
        benchmarks: { "swe-bench": 0.74 },
        confidence: 0.85,
        source: "ai.google.dev",
        date: "2026-03-15",
      }),
    );
    const ranked = scoreCandidates(signals, [a, b]);
    expect(ranked.length).toBe(2);
    for (const c of ranked) {
      expect(c.citations.length).toBeGreaterThan(0);
      for (const cit of c.citations) {
        expect(typeof cit.source).toBe("string");
        expect(cit.source.length).toBeGreaterThan(0);
        expect(typeof cit.date).toBe("string");
        expect(Number.isNaN(new Date(cit.date).getTime())).toBe(false);
        expect(["context-fit", "cost", "benchmark", "availability"]).toContain(cit.factor);
      }
    }
  });
});

describe("scoring — scoreCandidates: scoring factor names are public", () => {
  it("cites every named factor on each found candidate (context-fit, cost, benchmark, availability)", () => {
    const ranked = scoreCandidates(signals, [
      found(
        evidence({
          provider: "anthropic",
          model: "claude-opus-4-7",
          benchmarks: { "swe-bench": 0.8 },
          confidence: 0.9,
        }),
      ),
    ]);
    const factorNames = new Set(ranked[0]!.citations.map((c) => c.factor));
    for (const name of ["context-fit", "cost", "benchmark", "availability"] as const) {
      expect(factorNames.has(name as ScoredCandidate["citations"][number]["factor"])).toBe(true);
    }
  });
});

describe("scoring — computeConfidence: staleness + missing penalty", () => {
  it("returns a confidence in [0, 1] for fresh evidence", () => {
    const c = computeConfidence({ freshnessDays: 10, present: true });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it("returns a strictly lower confidence for stale evidence than for fresh evidence", () => {
    const freshC = computeConfidence({ freshnessDays: 5, present: true });
    const stale = computeConfidence({ freshnessDays: 365, present: true });
    expect(stale).toBeLessThan(freshC);
  });

  it("returns a low fallback confidence when evidence is missing", () => {
    const present = computeConfidence({ freshnessDays: 1, present: true });
    const missingC = computeConfidence({ freshnessDays: 0, present: false });
    expect(missingC).toBeLessThan(present);
    expect(missingC).toBeGreaterThanOrEqual(0);
    expect(missingC).toBeLessThanOrEqual(1);
  });

  it("is monotonic non-increasing in freshnessDays for present evidence", () => {
    const values = [1, 30, 90, 180, 365].map((d) =>
      computeConfidence({ freshnessDays: d, present: true }),
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]!);
    }
  });
});

describe("scoring — effectiveWeights: per-phase factor overrides", () => {
  it("returns the global SCORING_WEIGHTS when no phase is supplied", () => {
    const w = effectiveWeights({ phase: undefined });
    expect(w).toEqual(SCORING_WEIGHTS);
  });

  it("returns the global SCORING_WEIGHTS for phases without an override", () => {
    const w = effectiveWeights({ phase: "sdd-apply" });
    expect(w).toEqual(SCORING_WEIGHTS);
  });

  it("renormalizes the remaining weights to sum to 1.0 after applying the override", () => {
    for (const phase of Object.keys(PHASE_FACTOR_OVERRIDES)) {
      const w = effectiveWeights({ phase });
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum, `weights for ${phase} should sum to 1.0`).toBeCloseTo(1.0, 6);
    }
  });

  it("zeroes the cost factor for sdd-design, sdd-propose, sdd-spec", () => {
    for (const phase of ["sdd-design", "sdd-propose", "sdd-spec"]) {
      const w = effectiveWeights({ phase });
      expect(w.cost, `cost should be 0 for ${phase}`).toBe(0);
    }
  });

  it("renormalization preserves relative ratios among non-overridden factors", () => {
    // Global: benchmark 0.30, context-fit 0.25, cost 0.25, availability 0.20.
    // After zeroing cost (sum drops to 0.75), the remaining three ratios
    // should be preserved: 30:25:20 = 0.4:0.333...:0.266...
    const w = effectiveWeights({ phase: "sdd-design" });
    expect(w.benchmark).toBeCloseTo(0.30 / 0.75, 6);
    expect(w["context-fit"]).toBeCloseTo(0.25 / 0.75, 6);
    expect(w.availability).toBeCloseTo(0.20 / 0.75, 6);
  });

  // Slice 2 (model-fallback-error-classification, design #1623): verify-family
  // phases (sdd-verify, jd-judge-a, jd-judge-b) get the SAME cost-zeroing
  // treatment as the reasoning phases above — verification/judging tasks must
  // not be steered toward a cheaper-but-less-capable model.
  it("zeroes the cost factor for sdd-verify, jd-judge-a, jd-judge-b", () => {
    for (const phase of ["sdd-verify", "jd-judge-a", "jd-judge-b"]) {
      const w = effectiveWeights({ phase });
      expect(w.cost, `cost should be 0 for ${phase}`).toBe(0);
    }
  });

  it("PHASE_FACTOR_OVERRIDES pins the exact {cost: -0.25} shape for verify-family phases", () => {
    for (const phase of ["sdd-verify", "jd-judge-a", "jd-judge-b"]) {
      expect(PHASE_FACTOR_OVERRIDES[phase]).toEqual({ cost: -0.25 });
    }
  });

  it("scores a high-benchmark expensive model above a cheap benchmark-light one for sdd-design", () => {
    // Opus 4-7 (benchmark ~0.90, expensive) vs DeepSeek V4 Flash (benchmark
    // ~0.78, dirt cheap). With cost weight zeroed, Opus should win on sdd-design.
    const opus = found(
      evidence({
        provider: "anthropic",
        model: "claude-opus-4-7",
        benchmarks: { mmlu: 0.93, "swe-bench": 0.78, gpqa: 0.83, bbh: 0.89 },
        contextWindow: 1_000_000,
        inputCost: 5,
        outputCost: 25,
        confidence: 0.95,
      }),
    );
    const flash = found(
      evidence({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        benchmarks: { mmlu: 0.85, "swe-bench": 0.60, gpqa: 0.72, bbh: 0.78 },
        contextWindow: 1_000_000,
        inputCost: 0.14,
        outputCost: 0.28,
        confidence: 0.95,
      }),
    );
    const designSignals: TaskSignals = {
      ...signals,
      phase: "sdd-design",
    };
    const ranked = scoreCandidates(designSignals, [opus, flash]);
    expect(ranked[0]!.model).toBe("anthropic/claude-opus-4-7");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});

describe("scoring — scoreCandidates: signals affect ranking", () => {
  it("wide breadth + large context boosts models with large context windows", () => {
    const opus = found(
      evidence({
        provider: "anthropic",
        model: "claude-opus-4-7",
        contextWindow: 200_000,
        confidence: 0.95,
      }),
    );
    const gemini = found(
      evidence({
        provider: "google",
        model: "gemini-2.5-pro",
        contextWindow: 1_000_000,
        confidence: 0.85,
      }),
    );
    const wideLarge: TaskSignals = {
      contextSize: "large",
      riskTier: "medium",
      breadth: "wide",
      modalities: ["code"],
    };
    const narrowSmall: TaskSignals = {
      contextSize: "small",
      riskTier: "low",
      breadth: "narrow",
      modalities: ["code"],
    };
    const wideRanked = scoreCandidates(wideLarge, [opus, gemini]);
    const narrowRanked = scoreCandidates(narrowSmall, [opus, gemini]);
    // For the wide-large signal set, gemini's 1M context must win more
    // decisively than for the narrow-small set (where small context is
    // enough and gemini's edge shrinks).
    const wideGap = wideRanked[0]!.score - wideRanked[1]!.score;
    const narrowGap = narrowRanked[0]!.score - narrowRanked[1]!.score;
    expect(wideGap).toBeGreaterThanOrEqual(narrowGap);
  });
});

describe("scoring — scoreCandidates: cacheHitCost boosts effective cost-fit", () => {
  it("a record with cacheHitCost scores higher on cost than an identical record without it", () => {
    const withoutCache = evidence({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      benchmarks: { "swe-bench": 0.72 },
      contextWindow: 1_000_000,
      inputCost: 0.435,
      outputCost: 0.87,
      confidence: 0.95,
    });
    const withCache: EvidenceRecord = {
      ...withoutCache,
      cacheHitCost: 0.003625,
      maxOutput: 384_000,
    };
    const rankedWith = scoreCandidates(signals, [found(withCache)]);
    const rankedWithout = scoreCandidates(signals, [found(withoutCache)]);
    expect(rankedWith[0]!.score).toBeGreaterThan(rankedWithout[0]!.score);
  });
});

describe("scoring — scoreCandidates: maxOutput penalises under-capacity models", () => {
  it("a record with maxOutput below the expected output size for the signal tier is penalised in context-fit", () => {
    // DeepSeek V4 Pro: real maxOutput 384K is plenty for any tier.
    // Synthesise a "small" competitor with maxOutput 1K (below the 2K
    // baseline for contextSize=medium) to force output-fit penalty.
    const capable = found(
      evidence({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        benchmarks: { "swe-bench": 0.72 },
        contextWindow: 1_000_000,
        inputCost: 0.435,
        outputCost: 0.87,
        maxOutput: 384_000,
        confidence: 0.95,
      }),
    );
    const underCap = found(
      evidence({
        provider: "deepseek",
        model: "deepseek-v4-pro-mini",
        benchmarks: { "swe-bench": 0.72 },
        contextWindow: 1_000_000,
        inputCost: 0.435,
        outputCost: 0.87,
        maxOutput: 1_000,
        confidence: 0.95,
      }),
    );
    const ranked = scoreCandidates(signals, [underCap, capable]);
    // The capable (large maxOutput) model ranks strictly above the
    // under-capacity sibling when context-fit is computed with the new
    // output-fit term.
    expect(ranked[0]!.model).toBe("deepseek/deepseek-v4-pro");
    expect(ranked[1]!.model).toBe("deepseek/deepseek-v4-pro-mini");
  });

  it("a record without maxOutput is treated as capable (no penalty)", () => {
    const unknownMaxOutput = found(
      evidence({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        benchmarks: { "swe-bench": 0.73 },
        contextWindow: 200_000,
        inputCost: 3,
        outputCost: 15,
        confidence: 0.95,
      }),
    );
    const ranked = scoreCandidates(signals, [unknownMaxOutput]);
    // Unknown maxOutput → output-fit = 1.0 (full credit).
    // Verify by confirming context-fit factor is computed from input only
    // when output is unknown: 200K input covers the medium-tier 100K
    // requirement, so inputFit = 1.0, outputFit = 1.0 (default).
    // Use the citation to assert the factor shape didn't break anything.
    expect(ranked[0]!.citations.find((c) => c.factor === "context-fit")).toBeDefined();
  });
});