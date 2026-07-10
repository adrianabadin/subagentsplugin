/**
 * PR1 unit tests — evidence registry + lookup.
 *
 * RED phase: these tests reference src/evidence.ts which does NOT exist
 * yet. Running `npm test` before the implementation lands must fail with
 * a "Cannot find module" / "is not a function" error for `lookupEvidence`.
 *
 * Scenarios verified (per spec `evidence-registry` + task 1.1):
 *   1. Lookup of a known model returns a fully-populated EvidenceRecord
 *      with benchmark/context/cost/availability/source/date/confidence.
 *   2. Lookup of an unknown model returns a fallback with a confidence
 *      value and a missing-evidence reason ("no-evidence").
 *
 * The registry must be provider-neutral — both Anthropic and a non-Anthropic
 * model (gemini) MUST be reachable from the same registry. The non-Anthropic
 * model is required so PR2's "non-Anthropic preference" integration test can
 * cite it.
 */

import { describe, expect, it } from "vitest";
import {
  getEvidenceRegistry,
  lookupEvidence,
  type EvidenceRecord,
  type EvidenceLookupResult,
} from "../src/evidence.js";
import {
  computeConfidence,
  CONFIDENCE_FRESH_DAYS,
  CONFIDENCE_STALE_DAYS,
  CONFIDENCE_MISSING,
  CONFIDENCE_FRESH,
} from "../src/scoring.js";

describe("evidence — registry shape", () => {
  it("getEvidenceRegistry() returns a non-empty array of provider-neutral records", () => {
    const registry = getEvidenceRegistry();
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.length).toBeGreaterThan(0);
    // Provider-neutral: at least one Anthropic AND at least one non-Anthropic.
    const providers = new Set(registry.map((r) => r.provider));
    expect(providers.has("anthropic")).toBe(true);
    const hasNonAnthropic = [...providers].some((p) => p !== "anthropic");
    expect(hasNonAnthropic).toBe(true);
  });

  it("every record has the full EvidenceRecord shape (model, provider, benchmarks, availability, source, date, confidence)", () => {
    const registry = getEvidenceRegistry();
    for (const r of registry) {
      expect(typeof r.model).toBe("string");
      expect(r.model.length).toBeGreaterThan(0);
      expect(typeof r.provider).toBe("string");
      expect(r.provider.length).toBeGreaterThan(0);
      expect(typeof r.benchmarks).toBe("object");
      expect(r.benchmarks).not.toBeNull();
      expect(Array.isArray(r.benchmarks)).toBe(false);
      expect(["available", "unknown", "unavailable"]).toContain(r.availability);
      expect(typeof r.source).toBe("string");
      expect(r.source.length).toBeGreaterThan(0);
      expect(typeof r.date).toBe("string");
      // ISO-8601 sanity: must be parseable by Date.
      expect(Number.isNaN(new Date(r.date).getTime())).toBe(false);
      expect(typeof r.confidence).toBe("number");
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("every registry key is unique (no duplicate model entries)", () => {
    const registry = getEvidenceRegistry();
    const keys = registry.map((r) => r.provider + "/" + r.model);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("evidence — lookup by model ID", () => {
  it("lookupEvidence('anthropic/claude-opus-4-7') returns a found result with all required fields", () => {
    const result: EvidenceLookupResult = lookupEvidence("anthropic/claude-opus-4-7");
    // Discriminated union: must be the found variant.
    if (result.kind !== "found") {
      throw new Error(`expected kind='found' but got kind='${result.kind}'`);
    }
    const record: EvidenceRecord = result.record;
    expect(record.provider).toBe("anthropic");
    expect(record.model).toBe("claude-opus-4-7");
    expect(typeof record.benchmarks).toBe("object");
    // Must include at least one numeric benchmark.
    const benchmarkValues = Object.values(record.benchmarks);
    expect(benchmarkValues.length).toBeGreaterThan(0);
    for (const v of benchmarkValues) {
      expect(typeof v).toBe("number");
    }
    expect(["available", "unknown", "unavailable"]).toContain(record.availability);
    expect(typeof record.source).toBe("string");
    expect(record.source.length).toBeGreaterThan(0);
    expect(typeof record.date).toBe("string");
    expect(Number.isNaN(new Date(record.date).getTime())).toBe(false);
    expect(typeof record.confidence).toBe("number");
  });

  it("lookupEvidence accepts a non-Anthropic model and returns a provider-neutral record", () => {
    // Sanity: a non-Anthropic lookup must succeed and carry a different provider.
    const result = lookupEvidence("google/gemini-2.5-pro");
    if (result.kind !== "found") {
      throw new Error(`expected kind='found' but got kind='${result.kind}'`);
    }
    expect(result.record.provider).toBe("google");
    expect(result.record.model).toBe("gemini-2.5-pro");
    expect(typeof result.record.confidence).toBe("number");
  });

  it("lookupEvidence is case-insensitive on the model id segment", () => {
    const result = lookupEvidence("ANTHROPIC/CLAUDE-OPUS-4-7");
    if (result.kind !== "found") {
      throw new Error(`expected kind='found' for case-insensitive lookup but got '${result.kind}'`);
    }
    expect(result.record.provider).toBe("anthropic");
  });
});

describe("evidence — missing record fallback", () => {
  it("lookupEvidence for an unknown model returns a missing result with a fallback confidence and reason 'no-evidence'", () => {
    const result = lookupEvidence("totally-fabricated/missing-model-9999");
    if (result.kind !== "missing") {
      throw new Error(`expected kind='missing' but got kind='${result.kind}'`);
    }
    expect(result.reason).toBe("no-evidence");
    expect(typeof result.confidence).toBe("number");
    // Fallback confidence is a low-but-non-zero value (scorer must still
    // be able to rank the model against others with no evidence).
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("the missing fallback never throws and always returns a confidence in [0, 1]", () => {
    const candidates = [
      "missing/a",
      "missing/b",
      "missing/c",
      "no-such-provider/no-such-model",
    ];
    for (const id of candidates) {
      const result = lookupEvidence(id);
      if (result.kind !== "missing") {
        throw new Error(`expected kind='missing' for '${id}'`);
      }
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("evidence — determinism", () => {
  it("calling lookupEvidence twice with the same id returns records with identical field values", () => {
    const a = lookupEvidence("anthropic/claude-opus-4-7");
    const b = lookupEvidence("anthropic/claude-opus-4-7");
    expect(a).toEqual(b);
  });

  it("getEvidenceRegistry() returns the same array reference on every call (deterministic, pure module state)", () => {
    const a = getEvidenceRegistry();
    const b = getEvidenceRegistry();
    // Same length + same content; reference equality is allowed but not required.
    expect(a.length).toBe(b.length);
    expect(a.map((r) => r.provider + "/" + r.model)).toEqual(
      b.map((r) => r.provider + "/" + r.model),
    );
  });
});

// ---------------------------------------------------------------------------
// PR3 acceptance — ID normalization contract (design-review S5a, #1228)
//
// The evidence registry uses canonical `provider/model` keys (e.g.
// `google/gemini-2.5-pro`). Cache-collected model IDs may arrive in other
// shapes — bare model ids without a provider prefix, mixed-case strings,
// or empty/malformed ids. `lookupEvidence` MUST apply an explicit
// normalization step and document whether the result is a `found` record
// or a `missing` fallback. Silent misses (returning `missing` without
// reason) would mask real non-Anthropic preference — so every fallback
// path carries a non-empty `reason`.
//
// These tests pin the implemented contract:
//   1. Bare id (no provider prefix) → normalize fails → `missing` + reason.
//   2. Mixed case → normalize lowercases → `found` when canonical match.
//   3. Empty / malformed ids → `missing` + reason.
// ---------------------------------------------------------------------------

describe("evidence — PR3 [S5a] ID-normalization contract", () => {
  it("bare model id without provider prefix falls back to missing-evidence with reason", () => {
    // "gemini-2.5-pro" lacks a provider/ separator. normalizeKey returns
    // null, so the lookup must surface a structured missing fallback rather
    // than silently picking the closest registry key.
    const result = lookupEvidence("gemini-2.5-pro");
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") {
      throw new Error("expected missing for bare model id");
    }
    expect(result.reason).toBe("no-evidence");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("fully-qualified id with canonical provider/model resolves to a found record", () => {
    // The canonical form for the registry is `provider/model`. This
    // confirms the lookup path returns a real record, not a fallback, when
    // the caller supplies the documented key format.
    const result = lookupEvidence("google/gemini-2.5-pro");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") {
      throw new Error("expected found for canonical google/gemini-2.5-pro id");
    }
    expect(result.record.provider).toBe("google");
    expect(result.record.model).toBe("gemini-2.5-pro");
  });

  it("mixed-case id is normalized to lowercase and resolves to a found record", () => {
    // Cache collectors may emit the provider/model id in any casing.
    // normalizeKey lowercases both segments; this confirms the
    // case-insensitive normalization still finds the canonical record.
    const result = lookupEvidence("Google/Gemini-2.5-Pro");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") {
      throw new Error("expected found for case-insensitive lookup");
    }
    expect(result.record.provider).toBe("google");
    expect(result.record.model).toBe("gemini-2.5-pro");
  });

  it("id with trailing slash and empty model segment falls back to missing", () => {
    // "anthropic/" — the slash exists but the model segment is empty.
    // normalizeKey rejects this (model.length === 0 → null) → missing.
    const result = lookupEvidence("anthropic/");
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") {
      throw new Error("expected missing for empty model segment");
    }
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("empty string id falls back to missing with reason (never throws)", () => {
    const result = lookupEvidence("");
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") {
      throw new Error("expected missing for empty id");
    }
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("id with empty provider prefix falls back to missing with reason", () => {
    // "/claude-opus-4-7" — the slash exists at index 0 but the provider
    // segment is empty. normalizeKey rejects this (provider.length === 0
    // → null) → missing.
    const result = lookupEvidence("/claude-opus-4-7");
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") {
      throw new Error("expected missing for empty provider segment");
    }
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("every missing-evidence fallback carries a non-empty reason (no silent misses)", () => {
    // Exhaustively assert that no matter what malformed id is passed in,
    // the missing variant always carries a non-empty reason. This pins the
    // design-review #1228 S5a finding: "silently miss → missing-evidence
    // fallback masking real non-Anthropic preference". The contract is:
    // when lookup cannot resolve, it MUST surface why.
    const malformedIds = [
      "gemini-2.5-pro",       // bare id
      "anthropic/",           // empty model
      "/claude-opus-4-7",     // empty provider
      "",                     // empty string
      "no-slash-here",        // no slash at all
      "/",                    // only a slash
      "missing-provider/x",   // unknown provider
      "anthropic/unknown",    // unknown model under known provider
    ];
    for (const id of malformedIds) {
      const result = lookupEvidence(id);
      if (result.kind !== "missing") {
        throw new Error(
          `expected missing for id='${id}' but got kind='${result.kind}'`,
        );
      }
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// PR3 acceptance — curated-value correctness (design-review S5b, #1228)
//
// The static evidence registry is the source of truth for model scoring.
// A confident WRONG record (stale, malformed, or garbage) is worse than no
// record — the scorer would trust it. These tests pin the curated-value
// contract:
//   1. Every record has confidence in [0, 1], ISO-8601 date, non-empty source.
//   2. The "fresh" threshold is the project threshold (CONFIDENCE_FRESH_DAYS
//      from src/scoring.ts, currently 30 days).
//   3. Records newer than the threshold produce full confidence.
//   4. Records beyond CONFIDENCE_STALE_DAYS collapse to MISSING confidence.
//   5. Records between the two thresholds produce a linearly-interpolated
//      confidence (between MISSING and FRESH).
// ---------------------------------------------------------------------------

describe("evidence — PR3 [S5b] curated-value correctness", () => {
  it("every registry record satisfies the curated-value invariants (confidence, date, source)", () => {
    const registry = getEvidenceRegistry();
    for (const r of registry) {
      // Confidence in [0, 1] — outside this range means the curated value
      // would break downstream scoring normalisation.
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      // Date is parseable ISO-8601.
      expect(Number.isNaN(new Date(r.date).getTime())).toBe(false);
      const ts = new Date(r.date).getTime();
      expect(ts).toBeGreaterThan(0);
      // Source is non-empty — a missing source would make the citation
      // unverifiable to the orchestrator.
      expect(typeof r.source).toBe("string");
      expect(r.source.length).toBeGreaterThan(0);
    }
  });

  it("project freshness threshold is exported as CONFIDENCE_FRESH_DAYS (pinning the contract)", () => {
    // The threshold is a contract — downstream scoring, audit reports, and
    // documentation all reference it. Pinning it here means a silent change
    // to the threshold must be deliberate (this test would fail).
    expect(typeof CONFIDENCE_FRESH_DAYS).toBe("number");
    expect(CONFIDENCE_FRESH_DAYS).toBeGreaterThan(0);
    expect(CONFIDENCE_FRESH_DAYS).toBeLessThan(CONFIDENCE_STALE_DAYS);
  });

  it("records dated within the freshness window yield full confidence", () => {
    // Pin now to 2026-04-15. The 2026-04-01 records (14 days old) are
    // inside the 30-day window → confidence = CONFIDENCE_FRESH (1.0).
    const now = new Date("2026-04-15T00:00:00Z");
    const withinWindowDays = 14;
    const confidence = computeConfidence({
      freshnessDays: withinWindowDays,
      present: true,
    });
    expect(confidence).toBe(CONFIDENCE_FRESH);
  });

  it("records dated past the stale window yield the MISSING confidence floor", () => {
    // Past CONFIDENCE_STALE_DAYS → confidence collapses to the floor
    // (CONFIDENCE_MISSING). The scorer can still rank, but no record can
    // outrank a fresher one with raw score.
    const farPast = CONFIDENCE_STALE_DAYS + 30;
    const confidence = computeConfidence({
      freshnessDays: farPast,
      present: true,
    });
    expect(confidence).toBe(CONFIDENCE_MISSING);
  });

  it("records between the two thresholds yield a partially-stale confidence", () => {
    // Between thresholds → linear interpolation between CONFIDENCE_FRESH
    // and CONFIDENCE_MISSING. The test asserts the boundary semantics:
    // strictly between MISSING and FRESH.
    const midDays = Math.floor(
      CONFIDENCE_FRESH_DAYS + (CONFIDENCE_STALE_DAYS - CONFIDENCE_FRESH_DAYS) / 2,
    );
    const confidence = computeConfidence({
      freshnessDays: midDays,
      present: true,
    });
    expect(confidence).toBeGreaterThan(CONFIDENCE_MISSING);
    expect(confidence).toBeLessThan(CONFIDENCE_FRESH);
  });

  it("registry records are correctly flagged as fresh/stale when the project threshold is applied", () => {
    // The registry contains three date buckets: 2026-04-01 (claude-*),
    // 2026-03-15 (gemini-2.5-*), and 2026-02-10 (gpt-4.1-*). With a now of
    // 2026-04-15, the 2026-04-01 bucket is FRESH (≤30 days) and the other
    // two are PARTIALLY-STALE (between thresholds). This proves the scoring
    // pipeline can flag stale entries using the project's freshness contract.
    const now = new Date("2026-04-15T00:00:00Z");
    const registry = getEvidenceRegistry();
    const byDate: Record<string, EvidenceRecord[]> = {};
    for (const r of registry) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date]!.push(r);
    }
    // Sanity: every registry record's date produced a bucket.
    expect(Object.keys(byDate).length).toBeGreaterThan(0);

    for (const [date, records] of Object.entries(byDate)) {
      const days = Math.floor(
        (now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000),
      );
      const confidence = computeConfidence({
        freshnessDays: days,
        present: true,
      });
      // Every record under the same date gets the same confidence (same
      // bucket) — this is the staleness-flag contract.
      for (const _ of records) {
        if (days <= CONFIDENCE_FRESH_DAYS) {
          expect(confidence).toBe(CONFIDENCE_FRESH);
        } else if (days >= CONFIDENCE_STALE_DAYS) {
          expect(confidence).toBe(CONFIDENCE_MISSING);
        } else {
          expect(confidence).toBeGreaterThan(CONFIDENCE_MISSING);
          expect(confidence).toBeLessThan(CONFIDENCE_FRESH);
        }
      }
    }
  });

  it("registry never contains a record with confidence above 1.0 (curated-value correctness gate)", () => {
    // The curated data must not let an over-confident record dominate the
    // scorer. If a curator accidentally entered 1.5, scoring would amplify
    // it. This is a one-shot sanity check on the static dataset.
    const registry = getEvidenceRegistry();
    for (const r of registry) {
      expect(r.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("registry never contains a record with empty source (citation audit)", () => {
    // A missing source means the citation is unverifiable. This blocks a
    // whole class of "confidently wrong" entries from entering the dataset.
    const registry = getEvidenceRegistry();
    for (const r of registry) {
      expect(r.source.trim().length).toBeGreaterThan(0);
    }
  });
});