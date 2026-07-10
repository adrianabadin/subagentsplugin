/**
 * PR1 — Deterministic weighted scoring engine.
 *
 * Spec contract (`explainable-scoring` capability):
 *   - Compute model fit using deterministic weighted rules.
 *   - Cite the evidence used (source + date per factor).
 *   - Lower confidence when evidence is missing or stale.
 *   - Return a ranked list; the top entry is the recommended model.
 *
 * Design: pure function, no I/O, no randomness, no LLM. Same inputs always
 * produce the same ranked output. Factor weights are pinned as exported
 * constants so refactors can re-use them.
 *
 * Named factors (S2 acceptance — task 1.6 / 1.8):
 *   - context-fit  : how well the model's contextWindow covers the signals.
 *   - cost         : lower input+output cost → higher score.
 *   - benchmark    : average of the model's documented benchmark scores.
 *   - availability : `available` > `unknown` > `unavailable`.
 *
 * Missing-evidence candidates are still ranked (last) so callers see them
 * as a last-resort fallback; their confidence carries the missing penalty.
 */

import type { TaskSignals } from "./context.js";
import type { EvidenceRecord } from "./evidence.js";
import { resolvePhaseBenchmarks } from "./benchmark-phases.js";

/**
 * Named factor names. The order here is the order citations are emitted.
 * Add a new factor here AND to `SCORING_WEIGHTS` AND to the citation loop.
 */
export const SCORING_FACTORS = [
  "context-fit",
  "cost",
  "benchmark",
  "availability",
] as const;

/** Union of factor names. */
export type ScoringFactor = (typeof SCORING_FACTORS)[number];

/**
 * Deterministic weights per factor. Sum to 1.0 so a candidate's `score`
 * stays in [0, 1].
 *
 * Weights rationale (MVP):
 *   - benchmark 0.30 — primary signal of model capability.
 *   - context-fit 0.25 — large windows matter for wide-context work units.
 *   - cost 0.25 — explicit user concern; non-Anthropic models can win here.
 *   - availability 0.20 — must not recommend a retired model.
 */
export const SCORING_WEIGHTS: Readonly<Record<ScoringFactor, number>> = {
  "context-fit": 0.25,
  cost: 0.25,
  benchmark: 0.3,
  availability: 0.2,
};

/**
 * Phase-specific additive offsets to `SCORING_WEIGHTS`. Each entry names
 * a phase (SDD or JD) and supplies a partial factor → delta map; the
 * delta is SUBTRACTED from the global weight, then the remaining weights
 * renormalize to 1.0. Use this to silence a factor for phases where it
 * is irrelevant — e.g., reasoning-heavy phases should not penalise
 * expensive models since the user prioritises correctness over cost.
 *
 * Convention: a negative delta (e.g., `cost: -0.25`) zeros the factor;
 * a partial delta (e.g., `cost: -0.10`) reduces it proportionally.
 *
 * The `costWeight` field on `PHASE_BENCHMARKS` in benchmark-phases.ts is
 * documented but not wired through here — it remains a forward-compat
 * knob for a future phase-aware cost tuning pass.
 */
export const PHASE_FACTOR_OVERRIDES: Readonly<
  Record<string, Readonly<Partial<Record<ScoringFactor, number>>>>
> = {
  // Reasoning phases: prioritise benchmark/context-fit; cost is irrelevant
  // for one-shot specification/architecture decisions.
  "sdd-design": { cost: -0.25 },
  "sdd-propose": { cost: -0.25 },
  "sdd-spec": { cost: -0.25 },
};

/**
 * Resolves the effective per-factor weights for the given signals.
 * Starts from `SCORING_WEIGHTS`, applies the matching `PHASE_FACTOR_OVERRIDES`
 * entry as additive deltas, then renormalizes so the result still sums
 * to 1.0. Returns the global table when no override is registered.
 *
 * Pure, never throws. When renormalization would divide by zero (all
 * weights zeroed out — shouldn't happen with sensible inputs), falls back
 * to the global table.
 */
export function effectiveWeights(
  signals: Pick<TaskSignals, "phase">,
): Readonly<Record<ScoringFactor, number>> {
  if (!signals.phase) return SCORING_WEIGHTS;
  const override = PHASE_FACTOR_OVERRIDES[signals.phase];
  if (override === undefined) return SCORING_WEIGHTS;
  const adjusted: Record<ScoringFactor, number> = { ...SCORING_WEIGHTS };
  for (const [factor, delta] of Object.entries(override) as Array<
    [ScoringFactor, number]
  >) {
    adjusted[factor] = Math.max(0, adjusted[factor] + delta);
  }
  let sum = 0;
  for (const f of SCORING_FACTORS) sum += adjusted[f];
  if (sum <= 0) return SCORING_WEIGHTS;
  for (const f of SCORING_FACTORS) adjusted[f] = adjusted[f] / sum;
  return adjusted;
}

/** Public alias for tests that want to introspect the schema. */
export type ScoringFactors = ScoringFactor;

/**
 * Single citation entry surfaced by the verbose forecast. Carries the
 * source + date of the evidence that drove a particular factor's score.
 */
export interface ScoreCitation {
  /** Model id in `provider/model` form. */
  model: string;
  /** Factor whose score this citation supports. */
  factor: ScoringFactor;
  /** Normalised value for the factor in [0, 1] (informational). */
  value: number;
  /** Source label/URL of the evidence that drove this factor. */
  source: string;
  /** ISO-8601 date of the evidence. */
  date: string;
  /** Confidence carried by this citation (from `computeConfidence`). */
  confidence: number;
}

/** Ranked candidate emitted by `scoreCandidates`. */
export interface ScoredCandidate {
  /** Canonical `provider/model` id. */
  model: string;
  /** Weighted composite score in [0, 1] — higher is better. */
  score: number;
  /** Per-factor citations that drove this candidate's score. */
  citations: ScoreCitation[];
  /** Confidence carried into the verbose output (0..1). */
  confidence: number;
  /** Human-readable reasoning citing the dominant factors. */
  reasoning: string;
}

/**
 * Discriminated candidate input. `found` carries the full evidence record;
 * `missing` represents a model that the registry does not know.
 */
export type ScoreCandidateInput =
  | {
      kind: "found";
      provider: string;
      model: string;
      record: EvidenceRecord;
    }
  | {
      kind: "missing";
      provider: string;
      model: string;
    };

/** Inputs for `computeConfidence`. */
export interface ConfidenceInput {
  /** Days since the evidence was last verified (0 when `present=false`). */
  freshnessDays: number;
  /** `false` when no evidence record is available. */
  present: boolean;
}

/** Threshold (days) at which evidence is considered "fresh" — no penalty. */
export const CONFIDENCE_FRESH_DAYS = 30;
/** Threshold (days) at which evidence drops to the floor (zero penalty). */
export const CONFIDENCE_STALE_DAYS = 365;
/** Fallback confidence when evidence is missing. */
export const CONFIDENCE_MISSING = 0.1;
/** Base confidence for fresh, present evidence. */
export const CONFIDENCE_FRESH = 1.0;

/** Helper: clamps a number into [0, 1]. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Computes a confidence score in [0, 1] from evidence freshness + presence.
 *
 *   - present=true, freshnessDays <= CONFIDENCE_FRESH_DAYS → CONFIDENCE_FRESH (1.0).
 *   - present=true, freshnessDays >= CONFIDENCE_STALE_DAYS → CONFIDENCE_MISSING (0.1).
 *   - in between → linear interpolation between those two anchors.
 *   - present=false → CONFIDENCE_MISSING regardless of freshnessDays.
 */
export function computeConfidence(input: ConfidenceInput): number {
  if (!input.present) return CONFIDENCE_MISSING;
  const days = Math.max(0, input.freshnessDays);
  if (days <= CONFIDENCE_FRESH_DAYS) return CONFIDENCE_FRESH;
  if (days >= CONFIDENCE_STALE_DAYS) return CONFIDENCE_MISSING;
  const span = CONFIDENCE_STALE_DAYS - CONFIDENCE_FRESH_DAYS;
  const over = days - CONFIDENCE_FRESH_DAYS;
  const t = over / span;
  return clamp01(CONFIDENCE_FRESH + t * (CONFIDENCE_MISSING - CONFIDENCE_FRESH));
}

/** Days between two ISO-8601 dates. Negative or NaN → 0 (treat as fresh-ish). */
function freshnessDaysFromNow(dateIso: string, now: Date): number {
  const ms = new Date(dateIso).getTime();
  if (Number.isNaN(ms)) return 0;
  const diffMs = now.getTime() - ms;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Returns the average benchmark across the record's `benchmarks` map.
 * Missing benchmarks → 0; this is the raw contribution before weighting.
 * Used as fallback when no phase-specific benchmark weights are available.
 */
function averageBenchmark(record: EvidenceRecord): number {
  const values = Object.values(record.benchmarks);
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += typeof v === "number" && Number.isFinite(v) ? v : 0;
  return sum / values.length;
}

/**
 * Computes a phase-aware benchmark score using the phase → benchmark
 * weight mapping. Only the benchmarks relevant to the phase contribute;
 * missing benchmarks contribute 0. The result is in [0, 1].
 */
function phaseBenchmarkScore(
  benchmarks: Record<string, number>,
  phaseWeights: Record<string, number>,
): number {
  const entries = Object.entries(phaseWeights);
  if (entries.length === 0) return 0;
  let score = 0;
  for (const [name, weight] of entries) {
    const raw = benchmarks[name];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      score += weight * clamp01(raw);
    }
    // Missing benchmark → contributes 0 (no penalty, but model ranks lower).
  }
  return clamp01(score);
}

/**
 * Computes a 0..1 score for a single factor against a record + signals.
 * Pure; the returned value is later weighted by `SCORING_WEIGHTS[factor]`.
 */
function factorValue(
  factor: ScoringFactor,
  record: EvidenceRecord,
  signals: TaskSignals,
): number {
  switch (factor) {
    case "benchmark": {
      // Phase-aware benchmark scoring when phase is known; falls back
      // to flat average when no phase signal is available.
      if (signals.phase && record.benchmarks) {
        const phaseCfg = resolvePhaseBenchmarks(signals.phase);
        return clamp01(phaseBenchmarkScore(record.benchmarks, phaseCfg.benchmarks));
      }
      return clamp01(averageBenchmark(record));
    }
    case "availability":
      // available = 1.0; unknown = 0.5; unavailable = 0.0.
      switch (record.availability) {
        case "available":
          return 1.0;
        case "unknown":
          return 0.5;
        case "unavailable":
          return 0.0;
      }
      return 0;
    case "context-fit": {
      // Bucket the required INPUT window by signals; score against the
      // record's documented window. Bigger is better — diminishing
      // returns above the required threshold.
      const requiredInput =
        signals.contextSize === "large"
          ? 500_000
          : signals.contextSize === "medium"
            ? 100_000
            : 30_000;
      const haveInput =
        typeof record.contextWindow === "number" ? record.contextWindow : 0;
      const inputFit =
        haveInput <= 0 ? 0 : haveInput >= requiredInput ? 1.0 : haveInput / requiredInput;

      // Output capacity is a separate constraint from input window. If the
      // record declares `maxOutput` and it's smaller than the expected
      // output size for the signal tier, penalize proportionally. Unknown
      // maxOutput (undefined) is treated as capable to avoid penalising
      // models we simply haven't catalogued.
      const expectedOutput =
        signals.contextSize === "large"
          ? 32_000
          : signals.contextSize === "medium"
            ? 8_000
            : 2_000;
      const haveOutput =
        typeof record.maxOutput === "number" && record.maxOutput > 0
          ? record.maxOutput
          : Number.POSITIVE_INFINITY;
      const outputFit =
        haveOutput >= expectedOutput ? 1.0 : haveOutput / expectedOutput;

      // Weight input 60% / output 40% — agents read more than they emit,
      // but cap-bounded output is a hard failure mode we don't ignore.
      return clamp01(inputFit * 0.6 + outputFit * 0.4);
    }
    case "cost": {
      // Lower input + output cost → higher score. Reference point: $15/M in
      // is "expensive", $0.30/M in is "cheap". We average input and output
      // cost for a single representative figure.
      //
      // Cache-hit discount: when the record declares `cacheHitCost`, we
      // blend it with `inputCost` assuming a typical ~70% cache-hit ratio
      // for chat workloads (system prompts, tool definitions, file context
      // are re-sent across turns). Falls back to raw inputCost when
      // cacheHitCost is missing — keeping the legacy behaviour intact for
      // records that don't model cache pricing (e.g., Anthropic, Google).
      const inputCost =
        typeof record.inputCost === "number" && record.inputCost > 0 ? record.inputCost : 0;
      const outputCost =
        typeof record.outputCost === "number" && record.outputCost > 0 ? record.outputCost : 0;
      const TYPICAL_CACHE_HIT_RATIO = 0.7;
      const effectiveInputCost =
        typeof record.cacheHitCost === "number" && record.cacheHitCost > 0
          ? TYPICAL_CACHE_HIT_RATIO * record.cacheHitCost +
            (1 - TYPICAL_CACHE_HIT_RATIO) * inputCost
          : inputCost;
      const avg = (effectiveInputCost + outputCost) / 2;
      if (avg <= 0) return 0.5; // unknown cost → neutral
      // Map avg in [0.1, 30] → score in [1, 0] using a log scale so very
      // cheap and very expensive are clearly distinguished but mid-range
      // is forgiving.
      const logAvg = Math.log10(avg);
      // log10(0.1) = -1 → 1.0; log10(30) ≈ 1.477 → 0.0; linear in between.
      const norm = (logAvg - 1.477) / (-1 - 1.477);
      return clamp01(norm);
    }
  }
}

/** Picks the dominant factor (highest weighted contribution) for reasoning. */
function dominantFactor(scored: Record<ScoringFactor, number>): ScoringFactor {
  let best: ScoringFactor = "benchmark";
  let bestVal = -Infinity;
  for (const factor of SCORING_FACTORS) {
    const v = SCORING_WEIGHTS[factor] * scored[factor];
    if (v > bestVal) {
      bestVal = v;
      best = factor;
    }
  }
  return best;
}

/**
 * Extracts the provider prefix from a canonical `provider/model` key.
 * For multi-segment keys (e.g. `openrouter/anthropic/claude-opus-4-8`)
 * returns the FIRST segment so the diversity rule groups by routing
 * provider family rather than upstream model family.
 */
function providerOf(model: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0) return "";
  return model.slice(0, slash);
}

/**
 * Provider-diverse top-N selector. Takes a ranked list of candidates
 * (highest score first) and returns up to `n` entries where no two
 * consecutive entries share the same provider. Preserves score order
 * within the available slots — the highest-scoring candidate always
 * wins slot #1, then slot #2 picks the highest-scoring candidate whose
 * provider differs from #1, and so on.
 *
 * `excludeProviders` is an optional set; candidates whose provider is
 * in this set are skipped entirely. Use it for "the previous call
 * failed on provider X — do not retry that family". The after-hook's
 * fallback chain passes the just-failed provider here.
 *
 * Pure; never throws. When the pool is exhausted before `n` entries
 * are picked, the returned list is shorter than `n`.
 */
export function diversifyTopN(
  ranked: readonly ScoredCandidate[],
  n: number,
  excludeProviders?: ReadonlySet<string>,
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  const used = new Set<string>();
  if (excludeProviders !== undefined) {
    for (const p of excludeProviders) used.add(p);
  }
  for (const c of ranked) {
    if (out.length >= n) break;
    const provider = providerOf(c.model);
    if (used.has(provider)) continue;
    out.push(c);
    used.add(provider);
  }
  return out;
}

/** Renders the canonical `provider/model` key. */
function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Scores a list of candidates against the task signals. Returns candidates
 * ranked descending by composite score. Missing-evidence candidates are
 * ranked last with a low confidence + a "no-evidence" reason.
 *
 * Pure: same `signals` + same `candidates` → identical output. The
 * `now` parameter is the only time-dependent input; tests can pin it via
 * `scoreCandidatesAt` if determinism across real-world clocks matters.
 */
export function scoreCandidates(
  signals: TaskSignals,
  candidates: readonly ScoreCandidateInput[],
  now: Date = new Date(0),
): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  const scored: ScoredCandidate[] = candidates.map((c) =>
    scoreOne(c, signals, now),
  );
  // Stable sort by score desc; ties broken by confidence desc, then by
  // canonical model key for full determinism.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.model.localeCompare(b.model);
  });
  return scored;
}

/** Scores a single candidate. Exported via `scoreCandidates`. */
function scoreOne(
  candidate: ScoreCandidateInput,
  signals: TaskSignals,
  now: Date,
): ScoredCandidate {
  const model = modelKey(candidate.provider, candidate.model);
  if (candidate.kind === "missing") {
    const confidence = computeConfidence({ freshnessDays: 0, present: false });
    return {
      model,
      score: 0,
      confidence,
      citations: [
        {
          model,
          factor: "availability",
          value: 0,
          source: "registry",
          date: now.toISOString().slice(0, 10),
          confidence,
        },
      ],
      reasoning:
        "No evidence record for this model; ranked last with low confidence.",
    };
  }
  const record = candidate.record;
  const freshness = freshnessDaysFromNow(record.date, now);
  const confidence = computeConfidence({ freshnessDays: freshness, present: true });
  const perFactor: Record<ScoringFactor, number> = {
    "context-fit": factorValue("context-fit", record, signals),
    cost: factorValue("cost", record, signals),
    benchmark: factorValue("benchmark", record, signals),
    availability: factorValue("availability", record, signals),
  };
  // Per-phase weight overrides (e.g. sdd-design zeroes the cost factor
  // for reasoning-heavy phases). Pure renormalisation; result still
  // sums to 1.0 so the composite stays in [0, 1].
  const weights = effectiveWeights(signals);
  let composite = 0;
  for (const factor of SCORING_FACTORS) {
    composite += weights[factor] * perFactor[factor];
  }
  // Confidence gates the composite: an unreliable model cannot outrank
  // a reliable one even if its raw numbers are higher. We blend linearly:
  //   score = composite * confidence + composite * (1 - confidence) * 0.5
  // i.e. when confidence = 1 → score = composite; when confidence = 0.1
  // → score = composite * 0.55. This keeps relative order but penalises
  // missing/stale evidence as the spec requires.
  const adjustedScore = composite * (0.5 + 0.5 * confidence);
  const citations: ScoreCitation[] = SCORING_FACTORS.map((factor) => ({
    model,
    factor,
    value: perFactor[factor],
    source: record.source,
    date: record.date,
    confidence,
  }));
  const dominant = dominantFactor(perFactor);
  const phaseTag = signals.phase ? ` phase=${signals.phase}` : "";
  const reasoning =
    `${record.provider}/${record.model}: dominant factor '${dominant}'` +
    ` (composite=${composite.toFixed(3)}, confidence=${confidence.toFixed(2)}, ` +
    `evidence date=${record.date})${phaseTag}.`;
  return {
    model,
    score: clamp01(adjustedScore),
    confidence,
    citations,
    reasoning,
  };
}

/**
 * Deterministic entry point that pins `now` to a fixed date. Useful in
 * tests where freshness-based confidence depends on the current clock.
 */
export function scoreCandidatesAt(
  signals: TaskSignals,
  candidates: readonly ScoreCandidateInput[],
  now: Date,
): ScoredCandidate[] {
  return scoreCandidates(signals, candidates, now);
}