/**
 * PR2 — SDD/JD phase → difficulty tier mapping.
 *
 * Spec scenario "Known phase": configured phase returns its tier.
 * Spec scenario "Unknown phase": unknown phase returns the lowest tier
 * AND a warning string the forecast engine can echo into `reasoning`.
 *
 * The phase → tier mapping is new for the forecast plugin (gentle-ai's
 * Go presets go phase → model alias directly, not through a tier
 * intermediate). The tier assignment mirrors the per-phase model choice
 * in `ClaudeModelPresetBalanced`:
 *
 *   high   → opus    in balanced  (orchestrator, sdd-propose, sdd-design)
 *   medium → sonnet  in balanced  (sdd-explore, sdd-spec, sdd-tasks,
 *                                  sdd-apply, sdd-verify, jd-judge-a,
 *                                  jd-judge-b, jd-fix-agent)
 *   low    → haiku   in balanced  (sdd-archive, sdd-onboard)
 */

import type { DifficultyTier } from "./types.js";

/** Difficulty tier assigned to each known SDD/JD phase. */
export const PHASE_DIFFICULTY: Readonly<Record<string, DifficultyTier>> = {
  // High — architecture/planning decisions
  orchestrator: "high",
  "sdd-propose": "high",
  "sdd-design": "high",

  // Medium — standard reasoning phases
  "sdd-explore": "medium",
  "sdd-spec": "medium",
  "sdd-tasks": "medium",
  "sdd-apply": "medium",
  "sdd-verify": "medium",
  "jd-judge-a": "medium",
  "jd-judge-b": "medium",
  "jd-fix-agent": "medium",

  // Low — mechanical phases
  "sdd-archive": "low",
  "sdd-onboard": "low",
} as const;

/** The tier assigned to unknown phases (lowest tier). */
export const LOWEST_TIER: DifficultyTier = "low";

/**
 * The canonical SDD/JD phase keys (the keys of `PHASE_DIFFICULTY`). Used
 * by `normalizePhase` to map real-world variant agent names back to a
 * base phase.
 */
export const KNOWN_PHASES: readonly string[] = Object.keys(PHASE_DIFFICULTY);

/** Result of `normalizePhase`. */
export interface NormalizedPhase {
  /** The canonical base phase when matched; otherwise the raw input. */
  phase: string;
  /** True when the subagent_type resolved to a known canonical phase. */
  matched: boolean;
}

/**
 * Normalizes a `task` `subagent_type` to its canonical SDD/JD phase.
 *
 * Real-world orchestrators dispatch escalation variants the difficulty
 * rubric does not know verbatim — e.g. `sdd-propose-alto`,
 * `sdd-tasks-fallback`, or arbitrary trailing qualifiers. This maps any
 * such variant back to its base phase (`sdd-propose`, `sdd-tasks`) so the
 * rubric and evidence scoring key on the phase, not the variant.
 *
 * Matching is exact-or-base-prefix against `KNOWN_PHASES`, evaluated
 * longest-phase-first so the most specific canonical phase wins.
 *
 * Unknown names (e.g. `sdd-init`, `custom-agent`, or `""`) are returned
 * verbatim with `matched: false` — the caller keeps the task flowing and
 * records the miss rather than blocking.
 */
export function normalizePhase(subagentType: string): NormalizedPhase {
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    return { phase: typeof subagentType === "string" ? subagentType : "", matched: false };
  }
  const byLengthDesc = [...KNOWN_PHASES].sort((a, b) => b.length - a.length);
  for (const base of byLengthDesc) {
    if (subagentType === base || subagentType.startsWith(`${base}-`)) {
      return { phase: base, matched: true };
    }
  }
  return { phase: subagentType, matched: false };
}

/**
 * Result of resolving a phase string. `warning` is non-null only when
 * the phase was unknown and the engine fell back to the lowest tier.
 */
export interface PhaseResolution {
  tier: DifficultyTier;
  warning: string | null;
}

/**
 * Resolves `phase` to its difficulty tier.
 *
 * - Known phase: returns `{ tier, warning: null }`.
 * - Unknown phase (including the empty string): returns the lowest tier
 *   and a warning naming the offending phase string so callers can echo
 *   it into `Forecast.reasoning`.
 */
export function resolvePhase(phase: string): PhaseResolution {
  const tier = PHASE_DIFFICULTY[phase];
  if (tier !== undefined) {
    return { tier, warning: null };
  }
  return {
    tier: LOWEST_TIER,
    warning: `Unknown phase '${phase}' — defaulting to lowest tier ('${LOWEST_TIER}').`,
  };
}