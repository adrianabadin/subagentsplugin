/**
 * Phase → benchmark relevance mapping.
 *
 * Each SDD phase delegates to 2-3 benchmarks that measure the
 * capabilities most relevant to that phase's task type. The weights
 * determine the contribution of each benchmark to the composite score.
 *
 * When a model lacks a score for a relevant benchmark, that benchmark
 * contributes 0 for that model (no penalty for missing specific
 * benchmarks, but the model ranks lower than peers that DO have the
 * benchmark).
 */

export interface PhaseBenchmarkWeights {
  /** Which benchmarks are relevant for this phase, with per-benchmark weight. */
  benchmarks: Record<string, number>;
  /** Additional weight for context window size (0-1, ~0 means irrelevant). */
  contextWindowWeight: number;
  /** Additional weight for cost (0-1, ~0 means irrelevant). */
  costWeight: number;
}

/**
 * Ordered by relevance for each SDD phase. The weights per benchmark
 * sum to 1.0 so the composite benchmark score stays in [0, 1].
 */
export const PHASE_BENCHMARKS: Readonly<Record<string, PhaseBenchmarkWeights>> = {
  /** Architecture, design decisions — reasoning + planning heavy. */
  "sdd-design": {
    benchmarks: { gpqa: 0.40, mmlu: 0.35, bbh: 0.25 },
    contextWindowWeight: 0.3,
    costWeight: 0.3,
  },
  /** Proposal creation — similar to design, needs broad reasoning. */
  "sdd-propose": {
    benchmarks: { gpqa: 0.45, mmlu: 0.30, bbh: 0.25 },
    contextWindowWeight: 0.3,
    costWeight: 0.3,
  },
  /** Specification writing — structured reasoning + breadth. */
  "sdd-spec": {
    benchmarks: { mmlu: 0.40, bbh: 0.35, gpqa: 0.25 },
    contextWindowWeight: 0.3,
    costWeight: 0.4,
  },
  /** Task breakdown — planning. */
  "sdd-tasks": {
    benchmarks: { gpqa: 0.40, mmlu: 0.35, bbh: 0.25 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  /** Code implementation — coding benchmarks dominate. */
  "sdd-apply": {
    benchmarks: { humaneval: 0.30, "swe-bench": 0.40, gpqa: 0.30 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  /** Verification — testing + code review. */
  "sdd-verify": {
    benchmarks: { humaneval: 0.35, mmlu: 0.35, gpqa: 0.30 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  /** Exploration — broad research, long-context matters. */
  "sdd-explore": {
    benchmarks: { mmlu: 0.35, gpqa: 0.35, multineedle: 0.30 },
    contextWindowWeight: 0.5,
    costWeight: 0.3,
  },
  /** Archival — simple, any model works. */
  "sdd-archive": {
    benchmarks: { mmlu: 1.0 },
    contextWindowWeight: 0.1,
    costWeight: 0.6,
  },
  /** Onboarding — guided walkthrough. */
  "sdd-onboard": {
    benchmarks: { mmlu: 0.50, gpqa: 0.50 },
    contextWindowWeight: 0.2,
    costWeight: 0.5,
  },
  /** Code review judges — balanced coding + reasoning. */
  "jd-judge-a": {
    benchmarks: { humaneval: 0.35, "swe-bench": 0.35, gpqa: 0.30 },
    contextWindowWeight: 0.2,
    costWeight: 0.3,
  },
  "jd-judge-b": {
    benchmarks: { humaneval: 0.35, "swe-bench": 0.35, gpqa: 0.30 },
    contextWindowWeight: 0.2,
    costWeight: 0.3,
  },
  "jd-fix-agent": {
    benchmarks: { humaneval: 0.35, "swe-bench": 0.35, gpqa: 0.30 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  /** Review phases — readability needs reasoning, reliability needs coding. */
  "review-readability": {
    benchmarks: { mmlu: 0.50, gpqa: 0.50 },
    contextWindowWeight: 0.3,
    costWeight: 0.4,
  },
  "review-reliability": {
    benchmarks: { humaneval: 0.50, gpqa: 0.50 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  "review-resilience": {
    benchmarks: { "swe-bench": 0.50, gpqa: 0.50 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
  "review-risk": {
    benchmarks: { "swe-bench": 0.50, gpqa: 0.50 },
    contextWindowWeight: 0.2,
    costWeight: 0.4,
  },
};

/** Default weights when no phase-specific mapping exists. */
export const DEFAULT_PHASE_BENCHMARKS: PhaseBenchmarkWeights = {
  benchmarks: { mmlu: 0.40, humaneval: 0.30, gpqa: 0.30 },
  contextWindowWeight: 0.3,
  costWeight: 0.4,
};

/** Resolves phase → benchmark weights, falling back to defaults. */
export function resolvePhaseBenchmarks(
  phase: string,
): PhaseBenchmarkWeights {
  return PHASE_BENCHMARKS[phase] ?? DEFAULT_PHASE_BENCHMARKS;
}
