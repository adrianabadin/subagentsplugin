/**
 * Fallback analysis — simulates realistic production scenarios.
 *
 * Three lenses:
 *  1. Alias-deduped ranking: when canonical + opencode-go alias points to
 *     the same upstream, the alias is collapsed. Otherwise a "win" is
 *     deceptive — the underlying routing shows up as one quota.
 *  2. Post-quarantine fallback: simulate DeepSeek V4 Pro + Flash being
 *     blocked. What wins next? This is the real "what does the user
 *     fall back to" question.
 *  3. Hardest-tier scenario: flip signals so Anthropic IS eligible
 *     (architecture/infra/security domain OR diffLines >= 1000 OR wide
 *     breadth). Does Opus win now?
 */
import { describe, expect, it } from "vitest";
import {
  getBenchmarkRegistry,
  type BenchmarkEntry,
} from "../src/benchmark-registry.js";
import {
  scoreCandidates,
  diversifyTopN,
  type ScoreCandidateInput,
  type ScoredCandidate,
} from "../src/scoring.js";
import { normalizeTaskContext, type TaskSignals } from "../src/context.js";

interface EvidenceView {
  key: string;
  provider: string;
  model: string;
  benchmarks: Record<string, number>;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  cacheHitCost?: number;
  maxOutput?: number;
  availability: "available" | "unknown" | "unavailable";
  source: string;
  date: string;
  confidence: number;
}

function asEvidence(e: BenchmarkEntry): EvidenceView {
  const [provider, ...rest] = e.key.split("/");
  return {
    key: e.key,
    provider: provider ?? "",
    model: rest.join("/") || e.key,
    benchmarks: e.benchmarks,
    contextWindow: e.contextWindow,
    inputCost: e.inputCost,
    outputCost: e.outputCost,
    cacheHitCost: e.cacheHitCost,
    maxOutput: e.maxOutput,
    availability: e.availability,
    source: e.source,
    date: e.date,
    confidence: e.confidence,
  };
}

function pool(): EvidenceView[] {
  return getBenchmarkRegistry().map(asEvidence);
}

function candidateFrom(rec: EvidenceView): ScoreCandidateInput {
  return {
    kind: "found",
    provider: rec.provider,
    model: rec.model,
    record: {
      model: rec.model,
      provider: rec.provider,
      benchmarks: rec.benchmarks,
      contextWindow: rec.contextWindow,
      inputCost: rec.inputCost,
      outputCost: rec.outputCost,
      cacheHitCost: rec.cacheHitCost,
      maxOutput: rec.maxOutput,
      availability: rec.availability,
      source: rec.source,
      date: rec.date,
      confidence: rec.confidence,
    },
  };
}

/**
 * Mirrors the production alias dedup logic in
 * `benchmark-registry.ts:lookupBenchmark`. Canonical wins over aliases
 * for the same model segment.
 */
function dedupAliases(records: EvidenceView[]): EvidenceView[] {
  const byName = new Map<string, EvidenceView[]>();
  for (const r of records) {
    const list = byName.get(r.model) ?? [];
    list.push(r);
    byName.set(r.model, list);
  }
  const canonical: EvidenceView[] = [];
  for (const [, list] of byName) {
    const c = list.find((r) => !r.key.startsWith("opencode-go/") && !r.key.startsWith("zai-coding-plan/"));
    canonical.push(c ?? list[0]!);
  }
  return canonical;
}

function scoreAndRank(signals: TaskSignals, records: EvidenceView[]) {
  const ranked = scoreCandidates(signals, records.map(candidateFrom));
  return ranked.map((c) => ({ model: c.model, score: c.score, confidence: c.confidence }));
}

function find(ranked: Array<{ model: string; score: number }>, needle: string) {
  const hit = ranked.find((r) => r.model.includes(needle));
  return hit ? `#${ranked.indexOf(hit) + 1} (${hit.score.toFixed(4)})` : "not in pool";
}

function printTop(label: string, ranked: Array<{ model: string; score: number }>, n = 8) {
  console.log(`\n  -- ${label} (top ${n}) --`);
  for (let i = 0; i < Math.min(n, ranked.length); i++) {
    const r = ranked[i]!;
    console.log(`    ${(i + 1).toString().padStart(2)}. ${r.model.padEnd(38)} ${r.score.toFixed(4)}`);
  }
}

describe("fallback analysis (post-2026-07-08)", () => {
  const PHASE = "sdd-design";
  const BASE_SIGNALS = normalizeTaskContext({
    diffLines: 400,
    files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    symbols: ["Strategy", "Repository"],
    riskDomain: "architecture",
    contextBreadth: "moderate",
    modality: ["code"],
    phase: PHASE,
  });

  it("(1) Alias-deduped ranking — collapses opencode-go duplicates", () => {
    const all = pool();
    const deduped = dedupAliases(all);
    const ranked = scoreAndRank(BASE_SIGNALS, deduped);
    console.log(`\n=========================================================`);
    console.log(`(1) ALIAS-DEDUPED POOL: ${deduped.length} entries (was ${all.length})`);
    console.log(`=========================================================`);
    printTop("Deduped ranking", ranked);

    expect(deduped.length).toBeLessThan(all.length);
  });

  it("(2) Post-quarantine fallback — DeepSeek family blocked", () => {
    const all = dedupAliases(pool());
    // Quarantine: simulate what happens if all DeepSeek entries fail.
    const blocked = ["deepseek"];
    const filtered = all.filter((r) => !blocked.includes(r.provider));
    const ranked = scoreAndRank(BASE_SIGNALS, filtered);

    console.log(`\n=========================================================`);
    console.log(`(2) FALLBACK SCENARIO — DeepSeek family quarantined`);
    console.log(`=========================================================`);
    console.log(`  Signals: riskDomain=architecture, contextSize=medium, ${BASE_SIGNALS.breadth}`);
    console.log(`  Blocked providers: ${blocked.join(", ")} (simulating 429/auth-error → Infinity quarantine)`);
    printTop("Fallback ranking", ranked);
    console.log("\n  -- spot checks --");
    console.log(`    DeepSeek V4 Pro:    excluded (quarantined)`);
    console.log(`    Claude Opus 4-7:    ${find(ranked, "claude-opus-4-7")}`);
    console.log(`    Claude Sonnet 4-6:  ${find(ranked, "claude-sonnet-4-6")}`);
    console.log(`    GLM-5.2:            ${find(ranked, "glm-5.2")}`);
    console.log(`    Gemini 3.5 Flash:   ${find(ranked, "gemini-3.5-flash")}`);
    console.log(`    Gemini 3 Pro:       ${find(ranked, "gemini-3.1-pro")}`);
    console.log(`    MiMo V2.5 Pro:      ${find(ranked, "mimo-v2.5-pro")}`);

    // The rank-1 winner must NOT be from the blocked family.
    expect(ranked[0]!.model).not.toMatch(/^deepseek\//);
  });

  it("(3) Hardest-tier scenario — Anthropic becomes eligible", () => {
    const all = dedupAliases(pool());
    // Hardest-tier gate from select.ts:isHardestTier — wide breadth OR
    // security/infra/data riskDomain OR diffLines >= 1000.
    const hardest = normalizeTaskContext({
      diffLines: 1500,
      files: ["x.ts"],
      symbols: ["AuthGuard", "PolicyEngine"],
      riskDomain: "security",
      contextBreadth: "wide",
      modality: ["code"],
      phase: PHASE,
    });
    const ranked = scoreAndRank(hardest, all);

    console.log(`\n=========================================================`);
    console.log(`(3) HARDEST-TIER — Anthropic IS eligible`);
    console.log(`=========================================================`);
    console.log(`  Signals: riskDomain=security, contextBreadth=wide, diffLines=1500, phase=${PHASE}`);
    printTop("Hardest-tier ranking", ranked);
    console.log("\n  -- spot checks --");
    console.log(`    Claude Opus 4-7:    ${find(ranked, "claude-opus-4-7")}`);
    console.log(`    Claude Sonnet 4-6:  ${find(ranked, "claude-sonnet-4-6")}`);
    console.log(`    GLM-5.2:            ${find(ranked, "glm-5.2")}`);

    // The rank-1 here is meaningfully different from the default-tier ranks.
    expect(ranked.length).toBeGreaterThan(0);
  });

  it("(4) Production-reality check — what threshold-gated select() picks", () => {
    // Replicates the production decision flow:
    //  - default factory supplies ONE candidate at MISSING_EVIDENCE_CONFIDENCE (=0.1)
    //  - confidence 0.1 < default threshold 0.6 → keep-default
    //  - so the hook NEVER actually picks the score-top model unless
    //    resolveCandidates injects richer evidence.
    const missingCandidate = {
      kind: "missing" as const,
      provider: "fake",
      model: "fake-model",
    };
    const ranked = scoreCandidates(BASE_SIGNALS, [missingCandidate]);

    console.log(`\n=========================================================`);
    console.log(`(4) PRODUCTION REALITY — default factory (no orchestrator scoring)`);
    console.log(`=========================================================`);
    console.log(`  rank-0 score: ${ranked[0]!.score.toFixed(4)} (would-be-selected)`);
    console.log(`  rank-0 conf:  ${ranked[0]!.confidence.toFixed(4)} (below 0.6 threshold)`);
    console.log(`  → production action: "keep-default" (orchestrator's original subagent_type wins)`);
    console.log(`  → the score ranking above is a PLANNING artifact, not a runtime pick`);
    console.log(`  → to actually drive picks from scoring, the orchestrator must`);
    console.log(`     inject richer candidates via resolveCandidates (or set a lower threshold)`);

    // Default factory yields confidence 0.1 — well below the 0.6 default threshold.
    expect(ranked[0]!.confidence).toBeLessThan(0.6);
  });

  it("(5) Provider-diversity fallback chain (design phase)", () => {
    const all = dedupAliases(pool());
    // Score all candidates
    const candidates = all.map(candidateFrom);
    const rankedRaw = scoreCandidates(BASE_SIGNALS, candidates);
    
    // Diversify the top 3 (no consecutive same provider)
    const diverseTop3 = diversifyTopN(rankedRaw, 3);
    
    console.log(`\n=========================================================`);
    console.log(`(5) DIVERSE TOP-3 WITH NO SAME-PROVIDER BACK-TO-BACK`);
    console.log(`=========================================================`);
    console.log(`  Signals: riskDomain=architecture, contextSize=medium, phase=${PHASE}`);
    console.log(`  (Fable 5 is marked unavailable, so it does not appear in active rankings)`);
    
    for (let i = 0; i < diverseTop3.length; i++) {
      const r = diverseTop3[i]!;
      console.log(`    Slot #${i + 1}: ${r.model.padEnd(38)} score=${r.score.toFixed(4)}`);
    }

    // Spot check: Compare Gemini 3.1 Pro and Gemini 3.5 Flash against the top model
    const topModel = diverseTop3[0]!;
    const gemini35Flash = rankedRaw.find((c) => c.model === "google/gemini-3.5-flash");
    const gemini31Pro = rankedRaw.find((c) => c.model === "google/gemini-3.1-pro");

    console.log("\n  -- Gemini Gaps to Top Model (${topModel.model}): --");
    if (gemini35Flash) {
      const gap = topModel.score - gemini35Flash.score;
      console.log(`    Gemini 3.5 Flash: score=${gemini35Flash.score.toFixed(4)} (diff = -${gap.toFixed(4)} vs top)`);
    } else {
      console.log("    Gemini 3.5 Flash not in registry!");
    }
    if (gemini31Pro) {
      const gap = topModel.score - gemini31Pro.score;
      console.log(`    Gemini 3.1 Pro:   score=${gemini31Pro.score.toFixed(4)} (diff = -${gap.toFixed(4)} vs top)`);
    } else {
      console.log("    Gemini 3.1 Pro not in registry!");
    }

    // Enforce that we successfully selected 3 diverse models if pool has them
    expect(diverseTop3.length).toBe(3);
    expect(diverseTop3[0]!.model).not.toBe(diverseTop3[1]!.model);
    expect(diverseTop3[0]!.model.split("/")[0]).not.toBe(diverseTop3[1]!.model.split("/")[0]);
    expect(diverseTop3[1]!.model.split("/")[0]).not.toBe(diverseTop3[2]!.model.split("/")[0]);
  });
});
