/**
 * Public / programmatic API barrel.
 *
 * The package-root entry (`src/index.ts` → `dist/index.js`) is a clean
 * OpenCode plugin module that exposes ONLY the default plugin function, so
 * OpenCode's plugin loader accepts it. Consumers that want the programmatic
 * surface (the plugin factory, `refreshCache`, the forecast pipeline, and
 * the scoring/rubric/evidence helpers) import from this module instead
 * (package export `./api`).
 */

// Plugin factory + cache refresh (also the OpenCode plugin default).
export { fibonacci } from "./fibonacci.js";
export {
  default as modelForecastPlugin,
  refreshCache,
} from "./plugin.js";
export type {
  PluginInput,
  PluginClient,
  RefreshCacheOptions,
  ModelForecastPluginOptions,
} from "./plugin.js";

// PR2 — evidence-based-forecasting (PR1 gate suggestion S2):
// Re-export the public API surface so package consumers can use
// `forecast()` and the supporting modules without reaching into
// individual source files.
//
// `forecast` is the main entry point. The other exports are useful for
// callers that want to compose the pipeline (e.g. for benchmarking or
// custom SKILL.md docs).
export { forecast } from "./forecast.js";
export { baselineEffortForTier, findModelForAlias } from "./forecast.js";
export {
  getEvidenceRegistry,
  lookupEvidence,
  MISSING_EVIDENCE_CONFIDENCE,
  MISSING_EVIDENCE_REASON,
} from "./evidence.js";
export { normalizeTaskContext, CONTEXT_SIZE_THRESHOLDS } from "./context.js";
export {
  scoreCandidates,
  scoreCandidatesAt,
  computeConfidence,
  diversifyTopN,
  SCORING_FACTORS,
  SCORING_WEIGHTS,
} from "./scoring.js";
export {
  SCORING_FACTOR_WEIGHTS,
  DEFAULT_MODEL_FOR_ALIAS,
  DEFAULT_PRESET,
  PRESETS,
  clampEffort,
  EFFORT_ORDER,
  effortsForModel,
  effortAllowedForModel,
  getPreset,
} from "./rubric.js";
export type {
  EvidenceRecord,
  EvidenceLookupResult,
  EvidenceAvailability,
} from "./evidence.js";
export type { TaskContextInput, TaskSignals } from "./context.js";
export type {
  ScoredCandidate,
  ScoreCitation,
  ScoreCandidateInput,
  ScoringFactor,
  ConfidenceInput,
} from "./scoring.js";
export type { ClaudeModelAlias, PresetTable } from "./rubric.js";
export type {
  Effort,
  DifficultyTier,
  EvidenceCitation,
  Forecast,
  ForecastAlternative,
  ForecastInput,
  VerboseForecast,
  ModelDataCache,
} from "./types.js";
