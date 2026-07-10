/**
 * PR2 — Static rubric + preset tables.
 *
 * W1 fix under test: benchmark/preset tables and the effort-support table
 * live here as TypeScript literals, NOT in cache.rubric (which is reserved
 * for phase → difficulty tier in src/types.ts).
 *
 * S1 fix under test: ClaudeEffortsForModel is re-encoded as TS literals
 * from gentle-ai/internal/model/claude_model.go (lines 70-83). It is NOT
 * imported from the Go source.
 *
 * Values verified accurate against the Go source on 2026-07-02:
 *   - fable/opus: all 6 efforts (default, low, medium, high, xhigh, max)
 *   - sonnet:     default, low, medium, high, max (NO xhigh)
 *   - haiku:      default only
 *   - unknown:    default only (fallback)
 */

import type { Effort } from "./types.js";

/** Claude model tier alias — mirrors gentle-ai ClaudeModelAlias. */
export type ClaudeModelAlias = "fable" | "opus" | "sonnet" | "haiku";

/** Canonical model alias list, in declaration order. */
export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

/**
 * Effort support table per model tier.
 *
 * Re-encoded from gentle-ai/internal/model/claude_model.go
 * `ClaudeEffortsForModel` (lines 70-83). The empty string is always first
 * to match the Go convention.
 */
export const CLAUDE_EFFORTS_FOR_MODEL: Readonly<
  Record<ClaudeModelAlias, readonly Effort[]>
> = {
  fable: ["", "low", "medium", "high", "xhigh", "max"],
  opus: ["", "low", "medium", "high", "xhigh", "max"],
  sonnet: ["", "low", "medium", "high", "max"],
  haiku: [""],
} as const;

/** Returns the supported effort list for a model alias. */
export function effortsForModel(alias: ClaudeModelAlias): readonly Effort[] {
  return CLAUDE_EFFORTS_FOR_MODEL[alias] ?? ([""] as const);
}

/** Reports whether `effort` is supported by `alias`. */
export function effortAllowedForModel(
  alias: ClaudeModelAlias,
  effort: Effort,
): boolean {
  return effortsForModel(alias).includes(effort);
}

/** A single preset table — maps phase key → Claude model alias. */
export type PresetTable = Readonly<Record<string, ClaudeModelAlias>>;

/**
 * Balanced preset — default. Architecture phases use opus; standard
 * implementation phases use sonnet; archiving uses haiku.
 *
 * Source: gentle-ai/internal/model/claude_model.go
 * `ClaudeModelPresetBalanced` (lines 132-152).
 */
export const PRESET_BALANCED: PresetTable = {
  orchestrator: "opus",
  "sdd-explore": "sonnet",
  "sdd-propose": "opus",
  "sdd-spec": "sonnet",
  "sdd-design": "opus",
  "sdd-tasks": "sonnet",
  "sdd-apply": "sonnet",
  "sdd-verify": "sonnet",
  "sdd-archive": "haiku",
  "sdd-onboard": "haiku",
  "jd-judge-a": "sonnet",
  "jd-judge-b": "sonnet",
  "jd-fix-agent": "sonnet",
  default: "sonnet",
} as const;

/**
 * Performance preset — output-quality optimised. Architecture, planning,
 * and verification phases all use opus.
 *
 * Source: gentle-ai/internal/model/claude_model.go
 * `ClaudeModelPresetPerformance` (lines 154-173).
 */
export const PRESET_PERFORMANCE: PresetTable = {
  orchestrator: "opus",
  "sdd-explore": "sonnet",
  "sdd-propose": "opus",
  "sdd-spec": "sonnet",
  "sdd-design": "opus",
  "sdd-tasks": "sonnet",
  "sdd-apply": "sonnet",
  "sdd-verify": "opus",
  "sdd-archive": "haiku",
  "sdd-onboard": "haiku",
  "jd-judge-a": "opus",
  "jd-judge-b": "opus",
  "jd-fix-agent": "opus",
  default: "sonnet",
} as const;

/**
 * Economy preset — cost-optimised. SDD phases use sonnet except archive;
 * JD agents use haiku for maximum savings.
 *
 * Source: gentle-ai/internal/model/claude_model.go
 * `ClaudeModelPresetEconomy` (lines 175-194).
 */
export const PRESET_ECONOMY: PresetTable = {
  orchestrator: "sonnet",
  "sdd-explore": "sonnet",
  "sdd-propose": "sonnet",
  "sdd-spec": "sonnet",
  "sdd-design": "sonnet",
  "sdd-tasks": "sonnet",
  "sdd-apply": "sonnet",
  "sdd-verify": "sonnet",
  "sdd-archive": "haiku",
  "sdd-onboard": "haiku",
  "jd-judge-a": "haiku",
  "jd-judge-b": "haiku",
  "jd-fix-agent": "haiku",
  default: "sonnet",
} as const;

/**
 * Diversity preset — perspective-diversity optimised for judgment-day.
 * Starts from balanced; Judge A → opus (deep architecture), Judge B →
 * haiku (fast pattern matching), fix agent → sonnet (balanced).
 *
 * Source: gentle-ai/internal/model/claude_model.go
 * `ClaudeModelPresetDiversity` (lines 196-206).
 */
export const PRESET_DIVERSITY: PresetTable = {
  ...PRESET_BALANCED,
  "jd-judge-a": "opus",
  "jd-judge-b": "haiku",
  "jd-fix-agent": "sonnet",
} as const;

/** All preset tables keyed by canonical preset name. */
export const PRESETS: Readonly<Record<string, PresetTable>> = {
  balanced: PRESET_BALANCED,
  performance: PRESET_PERFORMANCE,
  economy: PRESET_ECONOMY,
  diversity: PRESET_DIVERSITY,
} as const;

/** Default preset when no name is provided or the name is unknown. */
export const DEFAULT_PRESET = "balanced";

/**
 * Returns the preset table for `name`. Unknown names fall back to
 * `DEFAULT_PRESET`; callers should surface a warning in reasoning.
 */
export function getPreset(name: string): PresetTable {
  return PRESETS[name] ?? PRESETS[DEFAULT_PRESET]!;
}

/**
 * PR4 — fallback model identifier (provider/model-id) per Claude model alias.
 *
 * Used by the forecast engine (src/forecast.ts) when the cache is stale,
 * missing, or does not contain a model matching the alias chosen by the
 * preset. Mirrors the model IDs referenced by the effort-support table
 * (`CLAUDE_EFFORTS_FOR_MODEL`); these are the canonical defaults until the
 * plugin refreshes the runtime cache with live SDK data.
 */
export const DEFAULT_MODEL_FOR_ALIAS: Readonly<
  Record<ClaudeModelAlias, string>
> = {
  opus: "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-5",
  haiku: "anthropic/claude-haiku-4-5",
  fable: "anthropic/claude-fable",
} as const;

/**
 * Canonical ordering of effort values. Used by `clampEffort` to compute
 * the "nearest" effort to a requested value when the requested value is
 * not in the allowed list.
 *
 * Index assignment: 0=default (""), 1=low, 2=medium, 3=high, 4=xhigh,
 * 5=max. Lower index = lower capability cost.
 */
export const EFFORT_ORDER: readonly Effort[] = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * PR2 — evidence-based-forecasting.
 * Provider-neutral capability category weights used by the scoring engine
 * (`src/scoring.ts`). Exported from `rubric.ts` so the canonical
 * weighted-factor table lives next to the rest of the static rubric data
 * (preset tables, effort support, etc.).
 *
 * Factor names are pinned here (S2 acceptance from design-review #1228):
 *   - context-fit  : how well the model's contextWindow covers the signals.
 *   - cost         : lower input+output cost → higher score.
 *   - benchmark    : average of the model's documented benchmark scores.
 *   - availability : `available` > `unknown` > `unavailable`.
 *
 * Sum is 1.0 so a candidate's weighted composite score stays in [0, 1].
 * These values are mirrored by `SCORING_WEIGHTS` in `src/scoring.ts` —
 * the scoring module is the runtime authority; this constant exists so
 * the rubric module is the single static table source for review.
 */
export const SCORING_FACTOR_WEIGHTS: Readonly<
  Record<
    "context-fit" | "cost" | "benchmark" | "availability",
    number
  >
> = {
  "context-fit": 0.25,
  cost: 0.25,
  benchmark: 0.3,
  availability: 0.2,
} as const;

/**
 * Returns the closest effort in `allowed` to `desired`. Ties prefer the
 * LOWER effort (conservative — never accidentally over-promises work).
 *
 * - If `allowed` is empty, returns the empty string (default effort).
 * - If `desired` is in `allowed`, returns `desired` unchanged.
 * - Otherwise returns whichever effort in `allowed` minimises the index
 *   distance in `EFFORT_ORDER`.
 *
 * Pure. Does not throw on unknown values — values that are not in
 * `EFFORT_ORDER` are ignored when measuring distance (treated as
 * infinitely far from every requested effort).
 */
export function clampEffort(
  desired: Effort,
  allowed: readonly Effort[],
): Effort {
  if (allowed.length === 0) return "";
  if (allowed.includes(desired)) return desired;
  const desiredIdx = EFFORT_ORDER.indexOf(desired);
  let best: Effort = "";
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const candidateIdx = EFFORT_ORDER.indexOf(candidate);
    if (candidateIdx === -1) continue;
    const dist = Math.abs(candidateIdx - desiredIdx);
    if (
      dist < bestDist ||
      (dist === bestDist && candidateIdx < EFFORT_ORDER.indexOf(best))
    ) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}