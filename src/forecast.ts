/**
 * PR4 — Pure forecast engine.
 *
 * Algorithm:
 *   1. Resolve `input.phase` to a difficulty tier via phases.ts. Unknown
 *      phases fall back to the lowest tier and surface a warning string
 *      that ends up in `reasoning`.
 *   2. Resolve the user's preset (unknown → default "balanced") and pick
 *      the Claude model alias (opus/sonnet/haiku/fable) for the phase
 *      from the preset table.
 *   3. Try to read the cache. If it's missing, unreadable, or older than
 *      the engine TTL, fall back to `DEFAULT_MODEL_FOR_ALIAS[alias]` and
 *      set `fallback: true`.
 *   4. If the cache is fresh, search the providers for a model whose id
 *      contains the alias. If none is found, fall back to the preset
 *      default model.
 *   5. Compute the baseline effort from the phase tier
 *      (low → "", medium → "medium", high → "high") and clamp to the
 *      cache model's variant list. Clamping notes are reflected in
 *      `reasoning`.
 *   6. Build the `reasoning` string from the parts above and return.
 *
 * The function is `async` because the cache read is filesystem I/O;
 * otherwise the logic is pure — same `input` + same cache content yields
 * the same `Forecast`.
 *
 * PR2 — evidence-based-forecasting (additive):
 *   - When `input.verbose === true` OR `input.context` is supplied, the
 *     engine runs the deterministic scoring pipeline
 *     (`normalizeTaskContext` + `getEvidenceRegistry` + `scoreCandidates`)
 *     to compute evidence citations, confidence, and ranked alternatives.
 *   - The chosen `model`/`effort`/`fallback` come from the existing
 *     phase/cache path (unchanged). The scoring-derived data is ADDITIVE.
 *   - When `input.verbose === true`, the return type is `VerboseForecast`
 *     (a strict superset of `Forecast`). When `verbose === false`, the
 *     return type is plain `Forecast` — preserving the 4-field JSON
 *     contract for callers that don't opt in.
 *   - The reasoning string is augmented with a one-line evidence summary
 *     when context/verbose triggers scoring, so non-verbose callers still
 *     get a signal that scoring was performed.
 */

import { readCache, isCacheFresh, defaultCachePath } from "./cache.js";
import { resolvePhase } from "./phases.js";
import {
  DEFAULT_MODEL_FOR_ALIAS,
  DEFAULT_PRESET,
  EFFORT_ORDER,
  PRESETS,
  clampEffort,
  effortsForModel,
  getPreset,
  type ClaudeModelAlias,
} from "./rubric.js";
import { normalizeTaskContext } from "./context.js";
import { getEvidenceRegistry } from "./evidence.js";
import { scoreCandidatesAt } from "./scoring.js";
import type {
  DifficultyTier,
  Effort,
  Forecast,
  ForecastAlternative,
  ForecastInput,
  ModelDataCache,
  VerboseForecast,
} from "./types.js";

/** TTL the engine treats as "fresh" for the ModelDataCache. 24h. */
export const FORECAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maps a phase difficulty tier to a baseline effort request. Conservative
 * by design: low-tier phases get the empty (default) effort so the model
 * picks its own; higher tiers explicitly upgrade.
 *
 * `low → ""`, `medium → "medium"`, `high → "high"`.
 */
export function baselineEffortForTier(tier: DifficultyTier): Effort {
  switch (tier) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "";
  }
}

/**
 * Searches `cache.providers` for the first model whose id contains
 * `alias`. The match is case-insensitive substring. Returns `null` when
 * no provider/model pair matches.
 *
 * Internal — exposed only for tests in the same package.
 */
export function findModelForAlias(
  cache: ModelDataCache,
  alias: ClaudeModelAlias,
): {
  providerId: string;
  modelId: string;
  variants: Effort[];
} | null {
  for (const [providerId, models] of Object.entries(cache.providers)) {
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue;
      if (modelId.toLowerCase().includes(alias)) {
        return {
          providerId,
          modelId,
          variants: Array.isArray(model.variants) ? model.variants : [],
        };
      }
    }
  }
  return null;
}

interface PresetResolution {
  /** Resolved preset name — falls back to DEFAULT_PRESET when unknown. */
  presetName: string;
  /** Alias chosen for the phase via the preset table. */
  alias: ClaudeModelAlias;
  /** True when the user supplied a preset name that is not in PRESETS. */
  unknownPreset: boolean;
}

/** Resolves the user's preset input and picks the alias for the phase. */
function resolvePreset(input: ForecastInput): PresetResolution {
  const requested = input.preset;
  const presetName =
    requested !== undefined && requested in PRESETS ? requested : DEFAULT_PRESET;
  const unknownPreset = requested !== undefined && !(requested in PRESETS);
  const preset = getPreset(presetName);
  const fromPreset = preset[input.phase];
  const alias = (fromPreset ?? preset["default"]!) as ClaudeModelAlias;
  return { presetName, alias, unknownPreset };
}

interface CacheResolution {
  cache: ModelDataCache | null;
  /** "fresh" — readable and within TTL. "stale" — too old. "missing" — absent. */
  status: "fresh" | "stale" | "missing";
  cachePath: string;
}

/** Reads the cache and classifies its freshness in one go. */
async function readCacheForForecast(
  cachePath: string | undefined,
  now: Date,
): Promise<CacheResolution> {
  const target = cachePath ?? defaultCachePath();
  let cache: ModelDataCache | null = null;
  try {
    cache = await readCache(target);
  } catch {
    return { cache: null, status: "missing", cachePath: target };
  }
  if (cache === null) {
    return { cache: null, status: "missing", cachePath: target };
  }
  if (!isCacheFresh(cache, now, FORECAST_CACHE_TTL_MS)) {
    return { cache: null, status: "stale", cachePath: target };
  }
  return { cache, status: "fresh", cachePath: target };
}

interface FallbackHints {
  cachePath: string;
  cacheStatus: "fresh" | "stale" | "missing";
  unknownPreset: boolean;
  noModelMatch: boolean;
  requestedPreset: string | undefined;
  baseline: Effort;
  chosen: Effort;
  alias: ClaudeModelAlias;
  presetName: string;
  phase: string;
  tier: DifficultyTier;
  matched: { providerId: string; modelId: string } | null;
}

/**
 * PR2 — Augments a Forecast with verbose evidence fields when
 * `input.verbose` is set. When `input.context` is supplied but
 * `verbose` is false, the reasoning string is augmented with a one-line
 * evidence summary so non-verbose callers still see the scoring signal.
 *
 * Pure: no I/O. The scoring pipeline is deterministic with `now = new Date(0)`
 * (Unix epoch); all evidence dates are 2026 which is treated as "very fresh"
 * from epoch's perspective, yielding high confidence.
 *
 * S4 acceptance: the underlying `result` (model / effort / reasoning /
 * fallback) is NEVER modified by the scoring pipeline — the existing
 * effort-clamp path remains untouched. Verbose only adds fields on top.
 */
function maybeVerbose(
  result: Forecast,
  input: ForecastInput,
): Forecast | VerboseForecast {
  const hasContext = input.context !== undefined;
  if (!input.verbose && !hasContext) {
    // Fast path — preserves the canonical 4-field Forecast shape.
    return result;
  }

  // Run the scoring pipeline.
  const signals = normalizeTaskContext(input.context);
  const registry = getEvidenceRegistry();
  const candidates = registry.map((record) => ({
    kind: "found" as const,
    provider: record.provider,
    model: record.model,
    record,
  }));
  const scored = scoreCandidatesAt(signals, candidates, new Date(0));

  // Top-ranked model + its citations.
  const top = scored[0];

  if (!input.verbose) {
    // Non-verbose path: keep 4-field shape; surface a one-line evidence
    // summary in reasoning so the caller still sees the scoring signal.
    if (top !== undefined) {
      const summary =
        ` Evidence-based ranking: '${top.model}' ` +
        `(score=${top.score.toFixed(3)}, confidence=${top.confidence.toFixed(2)}, ` +
        `top-${scored.length}).`;
      return { ...result, reasoning: `${result.reasoning}${summary}` };
    }
    return result;
  }

  // Verbose path: build the full VerboseForecast.
  const evidence = top?.citations ?? [];
  const confidence = top?.confidence ?? 0;
  const alternatives: ForecastAlternative[] = scored.map((s) => ({
    model: s.model,
    score: s.score,
    reasoning: s.reasoning,
  }));

  const verbose: VerboseForecast = {
    ...result,
    evidence,
    confidence,
    alternatives,
  };
  return verbose;
}

/**
 * Builds a Forecast in the fallback path — either when the cache is
 * stale/missing OR when no model in the cache matches the alias. The
 * `fallback` flag is always true here.
 */
function buildFallback(hints: FallbackHints): Forecast {
  const notes: string[] = [];
  if (hints.unknownPreset && hints.requestedPreset !== undefined) {
    notes.push(
      `Unknown preset '${hints.requestedPreset}'; using default '${hints.presetName}'.`,
    );
  }
  if (hints.cacheStatus === "stale") {
    notes.push(
      `Cache stale at '${hints.cachePath}' (older than ${FORECAST_CACHE_TTL_MS}ms TTL); using preset default.`,
    );
  } else if (hints.cacheStatus === "missing") {
    notes.push(
      `Cache missing at '${hints.cachePath}'; using preset default.`,
    );
  }
  if (hints.noModelMatch) {
    notes.push(
      `No model for alias '${hints.alias}' found in cache providers; using preset default.`,
    );
  }
  if (hints.chosen !== hints.baseline) {
    notes.push(
      `Effort '${hints.baseline}' not supported by alias '${hints.alias}' (allowed: ${EFFORT_ORDER.filter((e) => effortsForModel(hints.alias).includes(e)).join(", ")}); clamped to '${hints.chosen}'.`,
    );
  }
  notes.push(
    `Phase '${hints.phase}' → tier '${hints.tier}' → preset '${hints.presetName}' → alias '${hints.alias}' → model '${DEFAULT_MODEL_FOR_ALIAS[hints.alias]}' (fallback).`,
  );
  return {
    model: DEFAULT_MODEL_FOR_ALIAS[hints.alias],
    effort: hints.chosen,
    reasoning: notes.join(" "),
    fallback: true,
  };
}

/**
 * Builds a Forecast when a cache model matched the alias.
 */
function buildMatched(hints: FallbackHints): Forecast {
  const notes: string[] = [];
  if (hints.unknownPreset && hints.requestedPreset !== undefined) {
    notes.push(
      `Unknown preset '${hints.requestedPreset}'; using default '${hints.presetName}'.`,
    );
  }
  if (hints.chosen !== hints.baseline) {
    const matchedModel = hints.matched
      ? `${hints.matched.providerId}/${hints.matched.modelId}`
      : "unknown";
    notes.push(
      `Effort '${hints.baseline}' not in cache model '${matchedModel}' variants; clamped to '${hints.chosen}'.`,
    );
  }
  notes.push(
    `Phase '${hints.phase}' → tier '${hints.tier}' → preset '${hints.presetName}' → alias '${hints.alias}' → cache model '${hints.matched!.providerId}/${hints.matched!.modelId}' matched.`,
  );
  return {
    model: `${hints.matched!.providerId}/${hints.matched!.modelId}`,
    effort: hints.chosen,
    reasoning: notes.join(" "),
    fallback: false,
  };
}

/**
 * The public forecast entry point. Pure modulo cache I/O. Always returns
 * a well-formed `Forecast` (when verbose is off) or `VerboseForecast`
 * (when verbose is on); never throws on missing/stale cache.
 *
 * PR2 contract: when `input.verbose === true` or `input.context` is
 * supplied, the engine also runs the scoring pipeline and either:
 *   - augments `reasoning` with a one-line evidence summary
 *     (verbose === false but evidence available), OR
 *   - returns a `VerboseForecast` with `evidence[]`, `confidence`, and
 *     `alternatives[]` populated (verbose === true).
 *
 * The chosen `model` / `effort` / `fallback` always come from the
 * existing phase/cache path — the scoring pipeline is additive only.
 */
export async function forecast(
  input: ForecastInput,
): Promise<Forecast | VerboseForecast> {
  // 1. Phase → tier (unknown phase → lowest tier + warning).
  const phaseResolution = resolvePhase(input.phase);
  const tier: DifficultyTier = phaseResolution.tier;

  // 2. Preset resolution.
  const presetResolution = resolvePreset(input);

  // 3. Baseline effort from tier.
  const baseline = baselineEffortForTier(tier);

  // 4. Cache resolution.
  const now = new Date();
  const cacheResolution = await readCacheForForecast(input.cachePath, now);

  // 5. Fallback path: stale or missing cache.
  if (cacheResolution.status !== "fresh" || !cacheResolution.cache) {
    const allowed = effortsForModel(presetResolution.alias);
    const chosen = clampEffort(baseline, allowed);
    const result = buildFallback({
      cachePath: cacheResolution.cachePath,
      cacheStatus: cacheResolution.status,
      unknownPreset: presetResolution.unknownPreset,
      noModelMatch: false,
      requestedPreset: input.preset,
      baseline,
      chosen,
      alias: presetResolution.alias,
      presetName: presetResolution.presetName,
      phase: input.phase,
      tier,
      matched: null,
    });
    if (phaseResolution.warning !== null) {
      result.reasoning = `${phaseResolution.warning} ${result.reasoning}`;
    }
    return maybeVerbose(result, input);
  }

  // 6. Cache fresh — try to find a model matching the alias.
  const matched = findModelForAlias(
    cacheResolution.cache,
    presetResolution.alias,
  );
  if (!matched) {
    const allowed = effortsForModel(presetResolution.alias);
    const chosen = clampEffort(baseline, allowed);
    const result = buildFallback({
      cachePath: cacheResolution.cachePath,
      cacheStatus: cacheResolution.status,
      unknownPreset: presetResolution.unknownPreset,
      noModelMatch: true,
      requestedPreset: input.preset,
      baseline,
      chosen,
      alias: presetResolution.alias,
      presetName: presetResolution.presetName,
      phase: input.phase,
      tier,
      matched: null,
    });
    if (phaseResolution.warning !== null) {
      result.reasoning = `${phaseResolution.warning} ${result.reasoning}`;
    }
    return maybeVerbose(result, input);
  }

  // 7. Cache model matched — clamp effort to its variant list.
  const chosen = clampEffort(baseline, matched.variants);

  // 8. Surface the unknown-phase warning as well, even when cache matched.
  const matchedResult = buildMatched({
    cachePath: cacheResolution.cachePath,
    cacheStatus: cacheResolution.status,
    unknownPreset: presetResolution.unknownPreset,
    noModelMatch: false,
    requestedPreset: input.preset,
    baseline,
    chosen,
    alias: presetResolution.alias,
    presetName: presetResolution.presetName,
    phase: input.phase,
    tier,
    matched: { providerId: matched.providerId, modelId: matched.modelId },
  });

  // Prepend phaseResolution.warning if present so it shows up in reasoning.
  if (phaseResolution.warning !== null) {
    matchedResult.reasoning = `${phaseResolution.warning} ${matchedResult.reasoning}`;
  }
  return maybeVerbose(matchedResult, input);
}
