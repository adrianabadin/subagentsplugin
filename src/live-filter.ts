/**
 * Design v4 — Live-gate filter (contract C).
 *
 * Pure helper that applies the EXACT live filter to a candidate set
 * BEFORE scoring/ranking. This reverses the previous design (which
 * validated only the single selected candidate at the rewrite
 * boundary): under v4 a disconnected candidate is removed up-front so
 * it can neither win nor block a connected lower-scoring candidate.
 *
 * Ordering inside the pipeline (contract C):
 *   exact live filter -> quarantine -> scoring/ranking/diversity/...
 * The default resolver receives validated live IDs before it scores; this
 * helper re-validates all resolver output, including injected candidates,
 * before the final `select()` forecast ranking.
 *
 * Fail-safe: when live is `required` but unavailable, the pipeline must
 * keep the original subagent_type. The filter signals that by emptying
 * the candidate set and returning `live_snapshot_unavailable`.
 */
import type { SelectCandidate, SelectionRefusalCause } from "./types.js";

/** Production policy (`required`) vs compatibility bypass (`disabled`). */
export type LiveGatePolicy = "required" | "disabled";

/**
 * Live availability snapshot consumed by the filter. Mirrors the
 * resolver outcome shape without importing the resolver module.
 */
export type LiveOutcomeSnapshot =
  | Readonly<{ status: "ready"; models: readonly string[] }>
  | Readonly<{ status: "unavailable"; models?: readonly string[] }>;

export interface LiveFilterResult {
  /** Candidates surviving the exact live filter. */
  candidates: SelectCandidate[];
  /**
   * Set when the live gate itself forces a keep-default (no switch).
   * `live_snapshot_unavailable` when required + unavailable;
   * `candidate_not_live` when required + ready but every candidate was
   * disconnected.
   */
  refusalCause?: SelectionRefusalCause;
}

/** Runtime trust boundary for injected/live resolver results. */
export function readyLiveModels(outcome: unknown): readonly string[] | undefined {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    return undefined;
  }
  const record = outcome as { status?: unknown; models?: unknown };
  if (record.status !== "ready" || !Array.isArray(record.models) || record.models.length === 0) {
    return undefined;
  }
  if (!record.models.every((model) => typeof model === "string" && model.trim().length > 0)) {
    return undefined;
  }
  return record.models;
}

/**
 * Apply the live gate to a candidate set.
 *
 * - `disabled` policy OR no outcome: candidates pass through unchanged
 *   (legacy behavior — no live authorization).
 * - `required` + unavailable: empty set + `live_snapshot_unavailable`
 *   (the pipeline keeps the original subagent_type).
 * - `required` + ready: keep only candidates whose `model` is an EXACT,
 *   case-preserving member of the connected set. No family/alias
 *   equivalence. If every candidate was disconnected, return an empty
 *   set + `candidate_not_live`.
 */
export function applyLiveGate(
  candidates: readonly SelectCandidate[],
  outcome: unknown,
  policy: LiveGatePolicy,
): LiveFilterResult {
  if (policy === "disabled") {
    return { candidates: [...candidates] };
  }
  const connected = readyLiveModels(outcome);
  if (connected === undefined) {
    return { candidates: [], refusalCause: "live_snapshot_unavailable" };
  }
  // Exact, case-preserving membership. O(n*m) is fine — candidate sets and
  // the connected list are both small (<= low hundreds).
  const filtered = candidates.filter((c) =>
    connected.some((id) => id === c.model),
  );
  if (filtered.length === 0 && candidates.length > 0) {
    return { candidates: [], refusalCause: "candidate_not_live" };
  }
  return { candidates: filtered };
}
