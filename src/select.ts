/**
 * PR1 — selection-decision engine (forecast-orchestration-layer).
 *
 * Spec contract (spec #1274 "Stable advisory selection decision" +
 * "Threshold-gated no-op" + "Cost-ordered deterministic candidate
 * choice"):
 *   - Returns exactly `{action, subagent_type, model, effort, reason,
 *     confidence, evidence}`. `action` ∈ {`switch`, `keep-default`}.
 *   - Switch iff `confidence >= policy.confidenceThreshold`. Below
 *     threshold → `keep-default` with the current configuration
 *     untouched (subagent_type = "").
 *   - Cheapest capable candidate wins: walk the cost ladder in order,
 *     pick the first rung whose best candidate clears the threshold.
 *   - Pure: same inputs → identical decision. No I/O, no clock, no
 *     randomness.
 *
 * The runner does NOT score candidates itself. Scoring is the
 * orchestrator's responsibility (it calls `src/scoring.ts` ahead of
 * time and passes the result as `candidates`). This keeps `select`
 * trivially testable and lets the policy layer own candidate ranking
 * rules in future slices.
 *
 * PR3 — added triage (spec #1274 'Uncurated or missing evidence blocks
 * switch' + 'reserve the anthropic rung for the hardest tier'):
 *   - Uncurated candidates (those whose `evidence` marks them as
 *     missing) have their effective confidence floored at
 *     MISSING_EVIDENCE_CONFIDENCE before the threshold gate. This
 *     guarantees a high-but-uncurated number cannot slip past.
 *   - The anthropic rung is ONLY consulted when the task context
 *     signals the "hardest tier". In any other signal profile, the
 *     runner skips anthropic candidates as if they were below
 *     threshold — the spec reservation is enforced silently.
 */

import type {
  Effort,
  LadderRung,
  SelectCandidate,
  SelectDecision,
  SelectInput,
  TaskContext,
} from "./types.js";

/**
 * The MISSING_EVIDENCE confidence floor. Mirrors
 * `MISSING_EVIDENCE_CONFIDENCE` in src/evidence.ts (which the scoring
 * engine uses to cap uncurated evidence). Re-declared here (instead of
 * imported) to keep `select` a pure leaf module that doesn't pull in
 * the evidence registry.
 */
export const SELECT_MISSING_EVIDENCE_CONFIDENCE = 0.1;

/**
 * Risk domains that count as "hardest tier" — high-stakes tasks where
 * the most expensive model is justified. Modelled as a closed set so
 * the runner remains deterministic.
 *
 * PR4 addition: "remediation" represents error-correction/bug-fixing
 * tasks, which are safety-critical and always escalates to the highest rung.
 */
const HARDEST_TIER_RISK_DOMAINS = new Set<string>([
  "security",
  "infra",
  "data",
  "remediation",
]);

/**
 * Verify/judge phase family (slice 2, design #1623 "Verify exemption").
 * These phases are validation-only — they must always pick the MOST
 * CAPABLE available model, independent of any other complexity signal.
 * `context.phase` is normalized upstream by `normalizePhase` (phases.ts)
 * before it reaches `select`, so `sdd-verify-alto` etc. arrive here
 * already collapsed to `sdd-verify`; `jd-judge-a`/`jd-judge-b` are
 * KNOWN_PHASES and match verbatim.
 */
export const VERIFY_FAMILY: ReadonlySet<string> = new Set<string>([
  "sdd-verify",
  "jd-judge-a",
  "jd-judge-b",
]);

/**
 * Sentinel "no candidate cleared the bar" reason. Always contains the
 * word "threshold" so callers can grep reasoning text for the
 * skip-cases (covered by `select.test.ts`).
 */
const REASON_THRESHOLD = "below threshold";

/**
 * Sentinel "no candidates supplied" reason. Used by the empty-input
 * branch — defensiveness contract from the spec ("never throws on
 * malformed input").
 */
const REASON_EMPTY = "no candidates available";

/**
 * Detects a "missing evidence" marker in a candidate's `evidence`
 * string. The marker can be either the literal prefix
 * "MISSING_EVIDENCE" (the upstream scoring convention) or the case-
 * insensitive substring "no-evidence"/"no evidence".
 *
 * The runner does NOT consult the live evidence registry — it works
 * purely off the supplied evidence string. This keeps `select` pure
 * and lets the orchestrator stamp candidates with the same marker
 * shape the scoring engine uses downstream.
 */
export function isMissingEvidence(evidence: string): boolean {
  if (evidence.length === 0) return true;
  const lower = evidence.toLowerCase();
  if (lower.startsWith("missing_evidence") || lower.startsWith("missing evidence")) {
    return true;
  }
  if (lower.includes("no-evidence") || lower.includes("no evidence")) {
    return true;
  }
  return false;
}

/**
 * Caps an effective confidence at the MISSING_EVIDENCE floor when the
 * candidate's evidence marks it as uncurated. Returns the candidate's
 * confidence verbatim for curated candidates.
 *
 * Pure. No I/O.
 */
export function capMissingEvidence(
  candidate: SelectCandidate,
): SelectCandidate {
  if (!isMissingEvidence(candidate.evidence)) return candidate;
  if (candidate.confidence <= SELECT_MISSING_EVIDENCE_CONFIDENCE) {
    return candidate;
  }
  return {
    ...candidate,
    confidence: SELECT_MISSING_EVIDENCE_CONFIDENCE,
  };
}

/**
 * Returns true when the task context signals the "hardest tier" — wide
 * breadth, high diff volume, OR a security/infra/data risk domain.
 * The threshold values are pinned constants so behaviour is
 * deterministic; the gates are intentionally coarse.
 *
 * Pure. No I/O. Reads ONLY the supplied context.
 */
export function isHardestTier(context: TaskContext): boolean {
  // Slice 2: verify-family phases (sdd-verify, jd-judge-a, jd-judge-b)
  // always count as hardest tier — this unlocks the anthropic rung for
  // them independent of any other signal (spec scenario: verify picks
  // capability over cost).
  if (VERIFY_FAMILY.has(context.phase)) return true;
  if (context.contextBreadth === "wide") return true;
  if (
    context.diffLines !== undefined &&
    Number.isFinite(context.diffLines) &&
    context.diffLines >= 1000
  ) {
    return true;
  }
  if (
    typeof context.riskDomain === "string" &&
    HARDEST_TIER_RISK_DOMAINS.has(context.riskDomain.toLowerCase())
  ) {
    return true;
  }
  return false;
}

/**
 * Sorts candidates on a single rung by (confidence desc, model asc).
 * Pure and stable; same input always yields the same order so the
 * runner's pick is fully deterministic.
 */
function rankOnRung(candidates: readonly SelectCandidate[]): SelectCandidate {
  if (candidates.length === 1) return candidates[0]!;
  const sorted = [...candidates].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.model.localeCompare(b.model);
  });
  return sorted[0]!;
}

/**
 * Returns the best candidate on `rung`, or `null` if none.
 *
 * PR3: when `rung === "anthropic"` and the context does not signal the
 * hardest tier, the candidates on the rung are filtered out before
 * ranking. This enforces the spec reservation silently — anthropic is
 * reserved for the hardest tier.
 */
function bestOnRung(
  candidates: readonly SelectCandidate[],
  rung: LadderRung,
  context: TaskContext,
): SelectCandidate | null {
  let eligible = candidates.filter((c) => c.ladderRung === rung);
  if (rung === "anthropic" && !isHardestTier(context)) {
    eligible = [];
  }
  if (eligible.length === 0) return null;
  return rankOnRung(eligible);
}

/**
 * Walks the ladder in order; returns the first rung that has at least
 * one candidate clearing the threshold. Returns `null` if no rung does.
 *
 * PR3: each candidate is first passed through `capMissingEvidence`
 * so uncurated entries can't slip past the bar.
 */
function firstCapableRung(
  candidates: readonly SelectCandidate[],
  ladder: SelectInput["ladder"],
  threshold: number,
  context: TaskContext,
): { rung: LadderRung; candidate: SelectCandidate } | null {
  for (const rung of ladder) {
    const best = bestOnRung(candidates, rung, context);
    if (best === null) continue;
    if (best.confidence >= threshold) {
      return { rung, candidate: best };
    }
  }
  return null;
}

/**
 * Returns the cheapest candidate from the input, used to populate the
 * `keep-default` decision's `model`/`effort`/`evidence` fields when no
 * candidate cleared the threshold. `null` when the candidate set is
 * empty. Anthropic candidates are still skipped here unless the context
 * signals hardest tier (the keep-default path must echo which candidate
 * was cheapest CAPABLE — anthropic only counts when reserved).
 */
function cheapestCapableCandidate(
  candidates: readonly SelectCandidate[],
  ladder: SelectInput["ladder"],
  context: TaskContext,
): SelectCandidate | null {
  for (const rung of ladder) {
    const best = bestOnRung(candidates, rung, context);
    if (best !== null) return best;
  }
  return null;
}

/**
 * The public `select()` entry. Pure; never throws.
 *
 * Returns a `SelectDecision` with the seven documented fields. When
 * the chosen candidate clears the threshold, the action is `switch`
 * and the model / effort / subagent_type mirror the chosen candidate.
 * Otherwise the action is `keep-default`, the subagent_type is the
 * empty string (signal to the caller: "do not rewrite the agent
 * alias"), and the reason explains the skip.
 *
 * PR3 confidence-floor + anthropic-reservation are applied INSIDE
 * this function; the caller passes unadjusted candidates and reads
 * the (possibly capped) decisions back. The function remains pure.
 */
export function select(input: SelectInput): SelectDecision {
  const { policy, ladder, candidates, context } = input;

  // PR3: floor uncurated evidence before any threshold check.
  const adjusted = candidates.map(capMissingEvidence);

  // Empty candidate set — defensiveness contract.
  if (adjusted.length === 0) {
    return {
      action: "keep-default",
      subagent_type: "",
      model: "",
      effort: "" as Effort,
      reason: REASON_EMPTY,
      confidence: 0,
      evidence: REASON_EMPTY,
    };
  }

  // PR4: Dynamic complexity scaling. If the task context signals high
  // complexity (wide contextBreadth or remediation/error-fixing risk domain),
  // we reverse the candidate search order (ladder) so the most powerful
  // models (like Anthropic) are checked first instead of cheapest-first.
  // This guarantees we use the best model for hard tasks and the cheapest
  // capable model for simple tasks.
  // Slice 2: verify-family phases always use capability-first ordering —
  // the ladder/rung is consulted ONLY as a tie-breaker among equally
  // capable candidates (via `rankOnRung`'s confidence-desc/name-asc
  // sort), never as the primary cost-driven selector.
  const isHighComplexity =
    VERIFY_FAMILY.has(context.phase) ||
    context.contextBreadth === "wide" ||
    context.riskDomain === "remediation" ||
    (context.diffLines !== undefined && context.diffLines >= 1000);

  const activeLadder = [...ladder];
  if (isHighComplexity) {
    activeLadder.reverse();
  }

  // Walk the ladder; the first capable rung wins.
  const capable = firstCapableRung(adjusted, activeLadder, policy.confidenceThreshold, context);
  if (capable !== null) {
    const c = capable.candidate;
    const orderStr = isHighComplexity ? "highest-capability first" : "cheapest-first";
    return {
      action: "switch",
      subagent_type: c.subagent_type,
      model: c.model,
      effort: c.effort,
      reason: `capable candidate on rung '${capable.rung}' clears threshold ${policy.confidenceThreshold} (${orderStr})`,
      confidence: c.confidence,
      evidence: c.evidence,
    };
  }

  // No candidate cleared the bar — keep default.
  // Use cheapest capable candidate for the keep-default reasoning.
  const cheapest = cheapestCapableCandidate(adjusted, ladder, context);
  return {
    action: "keep-default",
    subagent_type: "",
    model: cheapest?.model ?? "",
    effort: cheapest?.effort ?? ("" as Effort),
    reason: `${REASON_THRESHOLD} ${policy.confidenceThreshold}; best candidate '${
      cheapest?.model ?? "none"
    }' at confidence ${(cheapest?.confidence ?? 0).toFixed(2)}`,
    confidence: cheapest?.confidence ?? 0,
    evidence: cheapest?.evidence ?? REASON_EMPTY,
  };
}
