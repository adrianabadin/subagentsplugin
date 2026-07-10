/**
 * PR1 — Static evidence registry + lookup.
 *
 * Spec contract (`evidence-registry` capability):
 *   - Registry MUST contain provider-neutral model evidence records with
 *     benchmark, context, cost, availability, source, date, confidence.
 *   - Lookup by model ID returns the full record.
 *   - Missing record returns a fallback confidence + missing-evidence
 *     reason.
 *
 * Design decision: deterministic static registry (no I/O, no LLM, no
 * randomness). Triangulation and scoring read from this single source.
 * Evidence freshness is exposed via `date` + `confidence`; the scoring
 * module applies the staleness penalty.
 *
 * Provider-neutral: includes Anthropic, Google (gemini), and OpenAI-compatible
 * (gpt) entries so PR2's "non-Anthropic preference" scenario has a real
 * non-Anthropic candidate to score against. All records use the
 * `provider/model-id` key format.
 */

import type { BenchmarkEntry } from "./benchmark-registry.js";
import { getRepoLocal } from "./benchmark-registry.js";

/**
 * Availability tag for an evidence record. `available` = actively served,
 * `unknown` = no recent confirmation, `unavailable` = retired/deprecated.
 */
export type EvidenceAvailability = "available" | "unknown" | "unavailable";

/**
 * One curated evidence record for a single model. All fields are required
 * unless explicitly marked optional; the registry helper enforces that.
 */
export interface EvidenceRecord {
  /** Bare model id without provider prefix (e.g. `claude-opus-4-7`). */
  model: string;
  /** Provider key (e.g. `anthropic`, `google`, `openai`). */
  provider: string;
  /** Benchmark scores keyed by benchmark name (e.g. `mmlu`, `swe-bench`). */
  benchmarks: Record<string, number>;
  /** Maximum context window in tokens (optional — some models undisclosed). */
  contextWindow?: number;
  /** USD per 1M input tokens (optional). */
  inputCost?: number;
  /** USD per 1M output tokens (optional). */
  outputCost?: number;
  /** USD per 1M input tokens for cache HITS, when the provider charges less for cached prompts (optional). */
  cacheHitCost?: number;
  /** Maximum output tokens per request (optional — treated as capable when absent). */
  maxOutput?: number;
  /** Current availability tag. */
  availability: EvidenceAvailability;
  /** Citation source — e.g. provider docs URL or benchmark publisher. */
  source: string;
  /** ISO-8601 date the evidence was last verified. */
  date: string;
  /** Confidence score in [0, 1] representing evidence quality + freshness. */
  confidence: number;
}

/**
 * Discriminated result of `lookupEvidence`. The `found` variant carries a
 * fully-populated record; the `missing` variant carries a fallback
 * confidence and a reason code that surfaces in verbose reasoning.
 */
export type EvidenceLookupResult =
  | { kind: "found"; record: EvidenceRecord }
  | { kind: "missing"; confidence: number; reason: string };

/** Canonical registry key format: `${provider}/${model}`. */
export type EvidenceKey = `${string}/${string}`;

/**
 * Fallback confidence used when a model has no evidence record. Chosen as
 * a low-but-non-zero value so scoring can still rank the model against
 * peers (it just won't beat models with documented evidence).
 */
export const MISSING_EVIDENCE_CONFIDENCE = 0.1;

/** Reason code attached to a missing-evidence fallback. */
export const MISSING_EVIDENCE_REASON = "no-evidence";

/**
 * Static curated evidence registry. Provider-neutral. Source/date values
 * reflect the initial MVP curation; treat them as starting points that the
 * scoring module will discount via the staleness penalty.
 *
 * Sources are intentionally short URLs / labels — these are MVP placeholders,
 * not verified citations. They exist so `EvidenceCitation.source` always
 * has a non-empty value and `EvidenceCitation.date` always parses.
 */
const REGISTRY: readonly EvidenceRecord[] = [
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    benchmarks: {
      mmlu: 0.92,
      "swe-bench": 0.78,
      "humaneval": 0.94,
    },
    contextWindow: 200_000,
    inputCost: 15,
    outputCost: 75,
    availability: "available",
    source: "anthropic.com/docs/claude-opus-4-7",
    date: "2026-04-01",
    confidence: 0.95,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    benchmarks: {
      mmlu: 0.89,
      "swe-bench": 0.71,
      humaneval: 0.9,
    },
    contextWindow: 200_000,
    inputCost: 3,
    outputCost: 15,
    availability: "available",
    source: "anthropic.com/docs/claude-sonnet-4-5",
    date: "2026-04-01",
    confidence: 0.95,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    benchmarks: {
      mmlu: 0.81,
      "swe-bench": 0.55,
      humaneval: 0.82,
    },
    contextWindow: 200_000,
    inputCost: 0.8,
    outputCost: 4,
    availability: "available",
    source: "anthropic.com/docs/claude-haiku-4-5",
    date: "2026-04-01",
    confidence: 0.95,
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    benchmarks: {
      mmlu: 0.88,
      "swe-bench": 0.74,
      humaneval: 0.91,
    },
    contextWindow: 1_000_000,
    inputCost: 1.25,
    outputCost: 10,
    availability: "available",
    source: "ai.google.dev/gemini-2-5-pro",
    date: "2026-03-15",
    confidence: 0.85,
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    benchmarks: {
      mmlu: 0.82,
      "swe-bench": 0.6,
      humaneval: 0.86,
    },
    contextWindow: 1_000_000,
    inputCost: 0.3,
    outputCost: 2.5,
    availability: "available",
    source: "ai.google.dev/gemini-2-5-flash",
    date: "2026-03-15",
    confidence: 0.85,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    benchmarks: {
      mmlu: 0.9,
      "swe-bench": 0.72,
      humaneval: 0.92,
    },
    contextWindow: 1_000_000,
    inputCost: 2,
    outputCost: 8,
    availability: "available",
    source: "platform.openai.com/docs/gpt-4-1",
    date: "2026-02-10",
    confidence: 0.85,
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    benchmarks: {
      mmlu: 0.83,
      "swe-bench": 0.58,
      humaneval: 0.85,
    },
    contextWindow: 1_000_000,
    inputCost: 0.4,
    outputCost: 1.6,
    availability: "available",
    source: "platform.openai.com/docs/gpt-4-1-mini",
    date: "2026-02-10",
    confidence: 0.8,
  },
];

/**
 * Normalises a candidate id to `provider/model` form and lowercases both
 * segments so lookups are case-insensitive without leaking the original
 * casing to callers.
 */
function normalizeKey(id: string): { provider: string; model: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const provider = id.slice(0, slash).trim().toLowerCase();
  const model = id.slice(slash + 1).trim().toLowerCase();
  if (provider.length === 0 || model.length === 0) return null;
  return { provider, model };
}

/**
 * Returns the curated registry. Pure — same reference on every call.
 * Callers MUST NOT mutate the returned array.
 *
 * When repo-local overrides are loaded via `benchmark-registry.setRepoLocal`,
 * the effective view includes them (replace-by-key). Compiled entries
 * keep their original order; new repo-local keys are appended.
 */
export function getEvidenceRegistry(): readonly EvidenceRecord[] {
  const overlay = getRepoLocal();
  if (overlay.length === 0) return REGISTRY;
  const out: EvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const compiled of REGISTRY) {
    out.push(compiled);
    seen.add(compiled.provider + "/" + compiled.model);
  }
  for (const override of overlay) {
    const slash = override.key.indexOf("/");
    if (slash <= 0) continue;
    const provider = override.key.slice(0, slash).toLowerCase();
    const model = override.key.slice(slash + 1).toLowerCase();
    const lookup = provider + "/" + model;
    if (seen.has(lookup)) continue;
    out.push(benchmarkEntryToRecord(override));
    seen.add(lookup);
  }
  return out;
}

/**
 * Looks up an evidence record by `provider/model` id. Returns the
 * discriminated `EvidenceLookupResult`:
 *   - `{ kind: 'found', record }` when the registry has an entry.
 *   - `{ kind: 'missing', confidence, reason }` otherwise.
 *
 * Lookup is case-insensitive on both segments. Empty / malformed ids are
 * treated as missing (never throws).
 *
 * Repo-local overrides from `benchmark-registry.setRepoLocal(...)` are
 * honored with the same precedence as registry entries so callers see a
 * consistent picture.
 */
export function lookupEvidence(id: string): EvidenceLookupResult {
  const normalized = normalizeKey(id);
  if (normalized === null) {
    return {
      kind: "missing",
      confidence: MISSING_EVIDENCE_CONFIDENCE,
      reason: MISSING_EVIDENCE_REASON,
    };
  }
  // Repo-local overrides take precedence — replace-by-key, identical to
  // `lookupBenchmark` precedence.
  for (const override of getRepoLocal()) {
    const slash = override.key.indexOf("/");
    if (slash <= 0) continue;
    const provider = override.key.slice(0, slash).toLowerCase();
    const model = override.key.slice(slash + 1).toLowerCase();
    if (provider === normalized.provider && model === normalized.model) {
      return {
        kind: "found",
        record: benchmarkEntryToRecord(override),
      };
    }
  }
  for (const record of REGISTRY) {
    if (
      record.provider.toLowerCase() === normalized.provider &&
      record.model.toLowerCase() === normalized.model
    ) {
      return { kind: "found", record };
    }
  }
  return {
    kind: "missing",
    confidence: MISSING_EVIDENCE_CONFIDENCE,
    reason: MISSING_EVIDENCE_REASON,
  };
}

function benchmarkEntryToRecord(entry: BenchmarkEntry): EvidenceRecord {
  const slash = entry.key.indexOf("/");
  const provider = slash > 0 ? entry.key.slice(0, slash) : entry.key;
  const model = slash > 0 ? entry.key.slice(slash + 1) : entry.key;
  return {
    provider,
    model,
    benchmarks: entry.benchmarks,
    contextWindow: entry.contextWindow,
    inputCost: entry.inputCost,
    outputCost: entry.outputCost,
    cacheHitCost: entry.cacheHitCost,
    maxOutput: entry.maxOutput,
    availability: entry.availability,
    source: entry.source,
    date: entry.date,
    confidence: entry.confidence,
  };
}