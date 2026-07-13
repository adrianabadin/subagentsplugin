/**
 * PR2 — Core shared types for the model-forecast plugin.
 *
 * W2 fix: ForecastInput is now an explicit interface (not inferred) with
 * `phase` required and `projectContext`, `preset`, `cachePath` optional.
 * Stale/missing context behavior is documented on the type.
 *
 * W1 fix: ModelDataCache.rubric holds phase → difficulty-tier ONLY.
 * Benchmark scores live as static records in src/rubric.ts.
 *
 * S1 fix: Effort is a TS literal union re-encoded from gentle-ai's
 * internal/model/claude_model.go (ClaudeEffort constants).
 *
 * PR1 (evidence-based-forecasting, change #1229): ADDS evidence-related
 * types (`EvidenceCitation`, `VerboseForecast`) and the optional
 * `verbose?` / `context?` fields on `ForecastInput`. ALL additions are
 * purely additive — no existing field is changed, renamed, or removed.
 * The default 4-field `Forecast` shape is preserved.
 */

/**
 * Claude Code subagent effort frontmatter value.
 *
 * Mirrors gentle-ai ClaudeEffort constants. The empty string is the
 * default/inherit value and means "use the session/model default effort";
 * it MUST NOT be written as frontmatter by callers.
 *
 * Source: gentle-ai/internal/model/claude_model.go lines 51-58.
 */
export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** Difficulty tier used by the phase rubric. */
export type DifficultyTier = "low" | "medium" | "high";

/**
 * ForecastInput — the request shape consumed by the forecast engine
 * (src/forecast.ts, PR4 task 4.1).
 *
 * Required:
 * - `phase` — SDD/JD phase identifier (e.g. "sdd-design", "jd-judge-a").
 *
 * Optional:
 * - `projectContext` — natural-language project context supplied by the
 *   orchestrator (PMC/Engram snapshot). When omitted, the forecast falls
 *   back to phase-only reasoning (per spec scenario "Missing project
 *   context").
 * - `preset` — preset name ("balanced" | "performance" | "economy" |
 *   "diversity"). Unknown names fall back to "balanced" with a warning in
 *   the reasoning.
 * - `cachePath` — path to the ModelDataCache JSON. When omitted, the
 *   engine uses the default cache location. If the cache file is missing
 *   or older than TTL, the forecast falls back to the static rubric (per
 *   spec scenario "Partial or stale cache").
 */
export interface ForecastInput {
  phase: string;
  projectContext?: string;
  preset?: string;
  cachePath?: string;
  /**
   * PR1 — evidence-based-forecasting (additive).
   * When `true`, the engine MAY return a `VerboseForecast` (a strict
   * superset of `Forecast`) including `evidence[]`, `confidence`, and
   * `alternatives[]`. Defaults to `false` — the default forecast still
   * returns the canonical 4-field shape.
   */
  verbose?: boolean;
  /**
   * PR1 — evidence-based-forecasting (additive).
   * Optional explicit task context for the evidence-based scorer. When
   * omitted, the scorer falls back to phase-only reasoning.
   */
  context?: import("./context.js").TaskContextInput;
}

/**
 * Forecast — the engine's recommendation.
 *
 * - `model` is `provider/model-id` (e.g. "anthropic/claude-opus-4-7").
 * - `effort` is a ClaudeEffort literal. Clamping to model-supported efforts
 *   is the engine's responsibility; the value returned here is always valid
 *   for `model`.
 * - `reasoning` is a human-readable string that includes any fallback
 *   ("cache stale; using preset default") or clamp notes
 *   ("sonnet does not support xhigh; clamped to max").
 * - `fallback` is `true` when the preset default was used instead of a
 *   matched cache entry.
 */
export interface Forecast {
  model: string;
  effort: Effort;
  reasoning: string;
  fallback: boolean;
}

/**
 * PR1 — evidence-based-forecasting (additive).
 * A single evidence citation explaining WHY a factor received its score.
 * Sourced from `src/scoring.ts` `ScoreCitation`. Re-declared here (rather
 * than imported) so `src/types.ts` remains a leaf module that other
 * modules depend on — keeps the dependency direction one-way.
 */
export interface EvidenceCitation {
  /** Model id in `provider/model` form. */
  model: string;
  /** Factor name driving this citation (context-fit | cost | benchmark | availability). */
  factor: "context-fit" | "cost" | "benchmark" | "availability";
  /** Normalised factor value in [0, 1] (informational). */
  value: number;
  /** Source label / URL of the evidence that drove this factor. */
  source: string;
  /** ISO-8601 date of the evidence. */
  date: string;
  /** Confidence carried by this citation (0..1). */
  confidence: number;
}

/**
 * PR1 — evidence-based-forecasting (additive).
 * A single alternative recommendation surfaced in verbose mode. Strictly
 * a richer superset of `Forecast`'s identifiers plus score + reasoning.
 */
export interface ForecastAlternative {
  model: string;
  score: number;
  reasoning: string;
}

/**
 * PR1 — evidence-based-forecasting (additive).
 * `VerboseForecast` extends the canonical 4-field `Forecast` with
 * evidence citations, a confidence score, and a ranked list of
 * alternatives. Surfaced ONLY when `ForecastInput.verbose === true`;
 * the default forecast shape is unchanged.
 */
export interface VerboseForecast extends Forecast {
  evidence: EvidenceCitation[];
  confidence: number;
  alternatives: ForecastAlternative[];
}

/**
 * ModelDataCache — the on-disk cache schema written by the plugin
 * (PR3 task 3.1) and read by the forecast engine (PR4 task 4.1).
 *
 * W1 contract: `rubric` here is phase → difficulty tier ONLY. Benchmark
 * scores per rubric category live in src/rubric.ts as static records.
 *
 * `generatedAt` is ISO-8601. TTL enforcement is the reader's responsibility.
 */
export interface ModelDataCache {
  version: 1;
  generatedAt: string;
  providers: Record<string, Record<string, { variants: Effort[] }>>;
  rubric: Record<string, DifficultyTier>;
}

/* -------------------------------------------------------------------------- *
 * forecast-orchestration-layer (PR1) — selection + policy types.
 *
 * Additive over the existing 4-field Forecast contract (#1244 archive).
 * All types are exported from src/types.ts so PR1 modules (src/select.ts,
 * src/policy.ts) and the CLI can share a single source of truth.
 * -------------------------------------------------------------------------- */

/**
 * Binary action emitted by `select()`. Refused auto-mode rewrites and
 * threshold-below keep-default decisions both surface as `keep-default`
 * with a reason string — there is no third action value.
 */
export type Action = "switch" | "keep-default";

/**
 * Public advisory selection decision — emitted by `select(input)` and the
 * `--select` CLI flag.
 *
 * Field shape is Pinned by the spec #1274 "Stable advisory selection
 * decision" + design #1273 C1 fix. The seven keys MUST be present and
 * MUST NOT drift in spelling. `evidence` is a single short string
 * (single-line summary) per design #1273 — not an array. `effort` uses
 * the existing `Effort` literal union so it is always a value the
 * resolved model can honour.
 */
export interface SelectDecision {
  action: Action;
  subagent_type: string;
  model: string;
  effort: Effort;
  reason: string;
  confidence: number;
  evidence: string;
}

/**
 * Three-tier mode for selection. Default is `advisory` (no hooks) which
 * preserves the MVP `{}` plugin entry. `auto` enables the PR2 hook path.
 * `off` is an explicit kill-switch that returns `{}` even with policy
 * set.
 */
export type SelectionMode = "off" | "advisory" | "auto";

/**
 * The runtime selection policy. Pinned in spec #1274 "Layered policy
 * resolution" — built-in defaults are `mode: "advisory"`,
 * `confidenceThreshold: 0.6`. Per-key project overrides are allowed.
 */
export interface SelectionPolicy {
  mode: SelectionMode;
  confidenceThreshold: number;
}

/**
 * Resolved task context consumed by `select()` and the policy evaluator.
 * Distinct from `TaskContextInput` (the user-supplied input in
 * `context.ts`): `TaskContext` is the canonical, fully-populated form
 * the selection pipeline operates on. `phase` is always present; the
 * other fields are optional signals.
 */
export interface TaskContext {
  phase: string;
  diffLines?: number;
  files?: string[];
  symbols?: string[];
  riskDomain?: string;
  contextBreadth?: "narrow" | "moderate" | "wide";
  modality?: string[];
}

/**
 * A rung in the cost ladder. A `LadderRung` names the provider family;
 * concrete model ids are resolved against the live cache. The first
 * rung (`minimax`) is the cheapest; the last (`anthropic`) is reserved
 * for the hardest tasks.
 */
export type LadderRung =
  | "minimax"
  | "google-antigravity"
  | "openai"
  | "glm-5.2"
  | "anthropic";

/**
 * The cost ladder is a project-overridable ordered list of provider
 * families (cheapest first). The built-in default per spec #1274 is
 * `[minimax, google-antigravity, openai, glm-5.2, anthropic]`.
 */
export type Ladder = readonly LadderRung[];

/**
 * Dependencies passed to a `PolicyLayer.evaluate` (PR1: the static
 * resolver). `context` and `policy` are required; `ladder` is the
 * active cost ladder, may be the default when none is configured.
 */
export interface SelectionDependencies {
  context: TaskContext;
  policy: SelectionPolicy;
  ladder: Ladder;
}

/**
 * A pluggable policy evaluator. PR1 ships a single built-in default;
 * the interface exists so PR2 (or future slices) can register layered
 * evaluators without changing the public shape.
 */
export interface PolicyLayer {
  /** Stable identifier — used in audit entries and debug logs. */
  name: string;
  /** Returns a decision for the given dependencies. */
  evaluate(deps: SelectionDependencies): SelectDecision;
}

/**
 * Input shape for `select()` in src/select.ts. The runner consults the
 * candidate set, the active policy, and the cost ladder, and produces a
 * single `SelectDecision`.
 *
 * `candidates` are the pre-computed (or orchestrator-supplied) options
 * for the current phase. The runner filters/orders them by ladder
 * position and confidence — it does NOT score them itself (scoring
 * lives in src/scoring.ts and is called by the orchestrator before
 * passing candidates in).
 */
export interface SelectInput {
  context: TaskContext;
  policy: SelectionPolicy;
  ladder: Ladder;
  candidates: SelectCandidate[];
}

/**
 * A single selectable candidate. The runner treats `confidence` as the
 * gating signal against `policy.confidenceThreshold` and `ladderRung`
 * as the position in the cost ladder.
 *
 * `ladderRung` is explicit (not inferred from the model provider) so the
 * orchestrator can express policy overrides (e.g. "this model is on the
 * `glm-5.2` rung even though its provider is openai-compatible").
 */
export interface SelectCandidate {
  /** Agent alias this candidate would resolve to. */
  subagent_type: string;
  /** `provider/model-id` form. */
  model: string;
  /** Effort the candidate supports (must be a valid Effort literal). */
  effort: Effort;
  /** Confidence in [0, 1] from upstream scoring. */
  confidence: number;
  /** Short evidence string explaining the candidate's score. */
  evidence: string;
  /** Which rung of the cost ladder this candidate occupies. */
  ladderRung: LadderRung;
}

/* -------------------------------------------------------------------------- *
 * forecast-orchestration-layer (PR2) — hooks + audit types.
 *
 * Declared here in PR1 so the types module remains the single source
 * of truth. PR1 does NOT register any hooks; it only adds the type
 * surface so PR2 can plug in without re-touching this file.
 * -------------------------------------------------------------------------- */

/**
 * Per-decision audit trail entry. PR2 writes one of these to Engram
 * and (optionally) appends it to the JSONL audit sink on every switch,
 * keep-default, and refused rewrite.
 *
 * 429-fallback: PR adds a `QuarantineAuditEntry` variant carrying
 * `kind: "quarantine"`. The union is discriminated by the optional
 * `kind` field — the selection variant is the existing 6-field shape
 * (untouched) and is identifiable by the absence of `kind: "quarantine"`.
 * All previously-valid `AuditEntry` values still satisfy this type
 * (R12 — design #1317).
 */
export interface SelectionAuditEntry {
  /** ISO-8601 timestamp of the decision. */
  timestamp: string;
  /** SDD/JD phase key (e.g. "sdd-design"). */
  phase: string;
  /** Original `subagent_type` requested by the orchestrator. */
  originalSubagentType: string;
  /** Final decision emitted by `select()`. */
  decision: SelectDecision;
  /** "advisory" | "auto" | "off" — which mode produced the decision. */
  mode: SelectionMode;
  /** Optional hook sessionID, when the decision fires from a hook. */
  sessionID?: string;
  /**
   * Optional phase-detection signal. `true` when `originalSubagentType`
   * resolved to a known canonical SDD/JD phase; `false` when the pattern
   * was unmatched (the task still proceeds — this is a structured
   * warning, not a block). Absent on entries written before this field
   * existed.
   */
  phaseMatched?: boolean;
  /**
   * Optional discriminator. Existing selection audit entries omit
   * this field; new code may explicitly tag them with
   * `"selection"` for forward-compat consumers.
   */
  kind?: "selection";
}

export type RecoveryAuditEvent =
  | "failure_detected"
  | "abort_requested"
  | "fallback_started"
  | "fallback_succeeded"
  | "fallback_exhausted"
  | "cancelled"
  | "parent_recovery"
  | "invalid_transition";

/** Best-effort operational record for one supervised recovery event. */
export interface RecoveryAuditEntry {
  kind: "recovery";
  timestamp: string;
  callID: string;
  event: RecoveryAuditEvent;
  originalModel: string;
  fallbackModel?: string | null;
  terminal: boolean;
  state?: import("./recovery-types.js").TaskRecoveryState;
  result?: "success" | "exhausted" | "cancelled";
  message?: string;
}

/**
 * Discriminated audit-entry union. Consumers narrow with
 * `entry.kind === "quarantine"`; the selection variant is the default.
 */
export type AuditEntry = SelectionAuditEntry | import("./hooks.js").QuarantineAuditEntry | RecoveryAuditEntry;

/**
 * Configuration for the PR2 hook surface. In PR1, the plugin entry
 * returns `{}` regardless of this struct. The type exists so the
 * auto-hook path can read it in PR2 without re-touching this file.
 */
export interface HooksConfig {
  mode: SelectionMode;
  confidenceThreshold: number;
  ladder: Ladder;
  allowlist: string[];
  denylist: string[];
  projectPolicyPath?: string;
  userPolicyPath?: string;
}
