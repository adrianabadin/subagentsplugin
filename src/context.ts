/**
 * PR1 — Task context analysis.
 *
 * Spec contract (`task-context-analysis` capability):
 *   - Normalise explicit context inputs (`diffLines`, `files`, `symbols`,
 *     `riskDomain`, `contextBreadth`, `modality`) into scoring signals.
 *   - When the input is absent (undefined / empty object), emit default
 *     signals that do NOT penalise any model.
 *
 * Design: pure function, no I/O, no randomness, no side effects on the
 * input object. Thresholds for context-size bucketing are pinned in the
 * module (`CONTEXT_SIZE_THRESHOLDS`) so tests + scoring reference the same
 * numbers. Risk tiers are inferred from `riskDomain` first, falling back
 * to a symbols-count heuristic when no `riskDomain` is supplied.
 */

/**
 * Explicit task context supplied by the orchestrator / CLI. All fields
 * are optional — omitting them MUST produce non-penalising defaults.
 *
 * Additive extension: this interface is consumed by `src/scoring.ts` and
 * referenced (optionally) from `ForecastInput` in src/types.ts (PR1 task 1.9).
 */
export interface TaskContextInput {
  /** Total diff lines (added + removed) for the work unit. */
  diffLines?: number;
  /** Files touched by the work unit. */
  files?: string[];
  /** Symbols (functions, classes, identifiers) involved. */
  symbols?: string[];
  /** Domain hint (e.g. "architecture", "test", "docs"). */
  riskDomain?: string;
  /** Breadth hint from the orchestrator. */
  contextBreadth?: "narrow" | "moderate" | "wide";
  /** Modality tags (e.g. ["code"], ["docs"], ["diagram"]). */
  modality?: string[];
  /** SDD/JD phase for benchmark selection (e.g. "sdd-apply"). */
  phase?: string;
}

/**
 * Normalised scoring signals. Every field is a finite enum so the
 * downstream scorer can do deterministic table lookups (no fuzzy matching).
 */
export interface TaskSignals {
  /** Bucketed size hint for the work unit. */
  contextSize: "small" | "medium" | "large";
  /** Inferred risk tier (0 = no risk penalty; 1 = safety-critical). */
  riskTier: "low" | "medium" | "high";
  /** Echoed context breadth (defaults to "moderate"). */
  breadth: "narrow" | "moderate" | "wide";
  /** Modality tags copied verbatim (empty array when absent). */
  modalities: string[];
  /** SDD/JD phase identifier for benchmark selection (e.g. "sdd-apply"). */
  phase?: string;
}

/**
 * Bucketing thresholds for `contextSize`. Pinned by tests:
 *   - diffLines >= 500 OR files.length >= 20 → "large"
 *   - diffLines in [100, 499] OR files.length in [5, 19] → "medium"
 *   - everything else → "small"
 *
 * `files` is consulted only when `diffLines` is not provided, because the
 * diff size is a stronger signal than file count.
 */
export const CONTEXT_SIZE_THRESHOLDS = {
  /** diffLines >= LARGE_MIN → large */
  largeMin: 500,
  /** diffLines >= MEDIUM_MIN → medium (when < LARGE_MIN) */
  mediumMin: 100,
  /** files.length >= FILES_LARGE_MIN → large (when diffLines absent) */
  filesLargeMin: 20,
  /** files.length >= FILES_MEDIUM_MIN → medium (when diffLines absent) */
  filesMediumMin: 5,
} as const;

/**
 * Risk-domain → risk-tier mapping. Unknown domains fall back to "medium".
 * The set covers the orchestrator's documented domain hints and maps
 * safety-critical domains (architecture / infra / security) to "high".
 */
const RISK_DOMAIN_TO_TIER: Readonly<Record<string, TaskSignals["riskTier"]>> = {
  architecture: "high",
  infra: "high",
  security: "high",
  performance: "medium",
  refactor: "medium",
  feature: "medium",
  docs: "low",
  test: "low",
  chore: "low",
};

/** Symbols-count heuristic when `riskDomain` is absent. */
const SYMBOLS_HIGH_THRESHOLD = 5;

/** Defaults applied when context is absent (undefined / empty object). */
const DEFAULT_SIGNALS: TaskSignals = {
  contextSize: "medium",
  riskTier: "low",
  breadth: "moderate",
  modalities: [],
  phase: undefined,
};

/**
 * Buckets a numeric diff-size (or file-count fallback) into the canonical
 * size tier. Pure; never throws on negative / non-numeric inputs. When
 * neither signal is supplied, returns the neutral "medium" default so the
 * scorer does not penalise models for absent context.
 */
function bucketContextSize(
  diffLines: number | undefined,
  files: readonly string[] | undefined,
): TaskSignals["contextSize"] {
  const hasDiff =
    typeof diffLines === "number" && Number.isFinite(diffLines) && diffLines >= 0;
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!hasDiff && !hasFiles) return DEFAULT_SIGNALS.contextSize;
  if (hasDiff && diffLines !== undefined) {
    if (diffLines >= CONTEXT_SIZE_THRESHOLDS.largeMin) return "large";
    if (diffLines >= CONTEXT_SIZE_THRESHOLDS.mediumMin) return "medium";
    return "small";
  }
  const fileCount = files?.length ?? 0;
  if (fileCount >= CONTEXT_SIZE_THRESHOLDS.filesLargeMin) return "large";
  if (fileCount >= CONTEXT_SIZE_THRESHOLDS.filesMediumMin) return "medium";
  return "small";
}

/**
 * Resolves the risk tier from `riskDomain` first, falling back to a
 * symbols-count heuristic when no domain is supplied. When neither signal
 * is present, returns the neutral "low" default.
 */
function resolveRiskTier(
  riskDomain: string | undefined,
  symbols: readonly string[] | undefined,
): TaskSignals["riskTier"] {
  const hasDomain = typeof riskDomain === "string" && riskDomain.length > 0;
  const hasSymbols = Array.isArray(symbols) && symbols.length > 0;
  if (!hasDomain && !hasSymbols) return DEFAULT_SIGNALS.riskTier;
  if (hasDomain && riskDomain !== undefined) {
    const lower = riskDomain.toLowerCase();
    const direct = RISK_DOMAIN_TO_TIER[lower];
    if (direct !== undefined) return direct;
    return "medium";
  }
  const symbolCount = symbols?.length ?? 0;
  if (symbolCount >= SYMBOLS_HIGH_THRESHOLD) return "high";
  return "low";
}

/**
 * Normalises `input` into deterministic scoring signals. Pure: does not
 * mutate `input`. Omitting the argument or passing `{}` returns the
 * documented defaults (contextSize='medium', riskTier='low',
 * breadth='moderate', modalities=[]).
 */
export function normalizeTaskContext(input?: TaskContextInput): TaskSignals {
  if (input === undefined) return { ...DEFAULT_SIGNALS, modalities: [], phase: undefined };
  const contextSize = bucketContextSize(input.diffLines, input.files);
  const riskTier = resolveRiskTier(input.riskDomain, input.symbols);
  const breadth: TaskSignals["breadth"] =
    input.contextBreadth ?? DEFAULT_SIGNALS.breadth;
  const modalities = Array.isArray(input.modality) ? [...input.modality] : [];
  const phase = typeof input.phase === "string" && input.phase.length > 0 ? input.phase : undefined;
  return { contextSize, riskTier, breadth, modalities, phase };
}