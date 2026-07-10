/**
 * PR2 unit tests — static rubric + preset tables.
 *
 * RED phase: these tests reference src/rubric.ts which does NOT exist yet.
 * Running `npm test` before the implementation lands should fail with a
 * module resolution / compile error.
 *
 * W1 fix under test: benchmark scores are static records in rubric.ts, NOT
 * in cache.rubric (which is reserved for phase → tier).
 * S1 fix under test: effort support table is re-encoded as TS literals from
 * gentle-ai/internal/model/claude_model.go (NOT imported).
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_EFFORTS_FOR_MODEL,
  CLAUDE_MODEL_ALIASES,
  DEFAULT_PRESET,
  PRESETS,
  SCORING_FACTOR_WEIGHTS,
  effortAllowedForModel,
  effortsForModel,
  getPreset,
} from "../src/rubric.js";
import type { Effort } from "../src/types.js";

describe("rubric — preset tables", () => {
  it("exposes exactly the four gentle-ai presets (Balanced/Performance/Economy/Diversity)", () => {
    const keys = Object.keys(PRESETS).sort();
    expect(keys).toEqual(["balanced", "diversity", "economy", "performance"]);
  });

  it("exports a DEFAULT_PRESET string and getPreset() returns it for unknown names", () => {
    expect(DEFAULT_PRESET).toBe("balanced");
    const fallback = getPreset("does-not-exist");
    const balanced = getPreset("balanced");
    expect(fallback).toEqual(balanced);
  });

  it("balanced preset maps the four critical phases correctly", () => {
    const balanced = getPreset("balanced");
    expect(balanced["orchestrator"]).toBe("opus");
    expect(balanced["sdd-design"]).toBe("opus");
    expect(balanced["sdd-archive"]).toBe("haiku");
    expect(balanced["default"]).toBe("sonnet");
  });

  it("performance preset elevates sdd-verify, jd-judge-a, jd-judge-b, jd-fix-agent to opus", () => {
    const perf = getPreset("performance");
    expect(perf["sdd-verify"]).toBe("opus");
    expect(perf["jd-judge-a"]).toBe("opus");
    expect(perf["jd-judge-b"]).toBe("opus");
    expect(perf["jd-fix-agent"]).toBe("opus");
  });

  it("economy preset drops everything but sdd-archive/sdd-onboard to sonnet or haiku", () => {
    const economy = getPreset("economy");
    expect(economy["orchestrator"]).toBe("sonnet");
    expect(economy["sdd-design"]).toBe("sonnet");
    expect(economy["jd-judge-a"]).toBe("haiku");
    expect(economy["sdd-archive"]).toBe("haiku");
  });

  it("diversity preset splits judge A (opus) vs judge B (haiku) on top of balanced", () => {
    const diversity = getPreset("diversity");
    expect(diversity["jd-judge-a"]).toBe("opus");
    expect(diversity["jd-judge-b"]).toBe("haiku");
    expect(diversity["jd-fix-agent"]).toBe("sonnet");
    // Sanity: still inherits balanced base for non-judge phases.
    expect(diversity["sdd-design"]).toBe("opus");
    expect(diversity["sdd-archive"]).toBe("haiku");
  });
});

describe("rubric — effort support per model tier", () => {
  it("fable and opus support every documented effort value", () => {
    const expected: Effort[] = ["", "low", "medium", "high", "xhigh", "max"];
    expect([...effortsForModel("fable")]).toEqual(expected);
    expect([...effortsForModel("opus")]).toEqual(expected);
  });

  it("sonnet does NOT support 'xhigh' but DOES support 'max'", () => {
    const sonnet = [...effortsForModel("sonnet")];
    expect(sonnet).not.toContain("xhigh");
    expect(sonnet).toContain("max");
    expect(sonnet).toContain("high");
    expect(sonnet).toContain("");
    expect(sonnet).toContain("low");
    expect(sonnet).toContain("medium");
  });

  it("haiku only supports the default (empty) effort", () => {
    expect([...effortsForModel("haiku")]).toEqual([""]);
  });

  it("CLAUDE_MODEL_ALIASES lists fable, opus, sonnet, haiku", () => {
    expect([...CLAUDE_MODEL_ALIASES].sort()).toEqual([
      "fable",
      "haiku",
      "opus",
      "sonnet",
    ]);
  });
});

describe("rubric — effortAllowedForModel()", () => {
  it("returns true for every (alias, effort) pair in CLAUDE_EFFORTS_FOR_MODEL", () => {
    for (const alias of CLAUDE_MODEL_ALIASES) {
      for (const effort of CLAUDE_EFFORTS_FOR_MODEL[alias]) {
        expect(effortAllowedForModel(alias, effort)).toBe(true);
      }
    }
  });

  it("returns false for sonnet + xhigh (clamping required upstream)", () => {
    expect(effortAllowedForModel("sonnet", "xhigh")).toBe(false);
  });

  it("returns false for haiku + any non-default effort", () => {
    expect(effortAllowedForModel("haiku", "low")).toBe(false);
    expect(effortAllowedForModel("haiku", "medium")).toBe(false);
    expect(effortAllowedForModel("haiku", "high")).toBe(false);
    expect(effortAllowedForModel("haiku", "max")).toBe(false);
    expect(effortAllowedForModel("haiku", "xhigh")).toBe(false);
    // Only the default effort is allowed.
    expect(effortAllowedForModel("haiku", "")).toBe(true);
  });
});

describe("rubric — SCORING_FACTOR_WEIGHTS (PR2 evidence-based-forecasting)", () => {
  it("exports a SCORING_FACTOR_WEIGHTS object with the four named factors", () => {
    expect(SCORING_FACTOR_WEIGHTS).toBeDefined();
    expect(SCORING_FACTOR_WEIGHTS["context-fit"]).toBeDefined();
    expect(SCORING_FACTOR_WEIGHTS["cost"]).toBeDefined();
    expect(SCORING_FACTOR_WEIGHTS["benchmark"]).toBeDefined();
    expect(SCORING_FACTOR_WEIGHTS["availability"]).toBeDefined();
  });

  it("uses provider-neutral factor names (context-fit, cost, benchmark, availability)", () => {
    const keys = Object.keys(SCORING_FACTOR_WEIGHTS).sort();
    expect(keys).toEqual(
      ["availability", "benchmark", "context-fit", "cost"],
    );
  });

  it("weights are non-negative finite numbers", () => {
    for (const factor of Object.keys(SCORING_FACTOR_WEIGHTS)) {
      const w = SCORING_FACTOR_WEIGHTS[factor as keyof typeof SCORING_FACTOR_WEIGHTS];
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it("weights sum to 1.0 so a candidate's composite score stays in [0, 1]", () => {
    const sum =
      SCORING_FACTOR_WEIGHTS["context-fit"] +
      SCORING_FACTOR_WEIGHTS["cost"] +
      SCORING_FACTOR_WEIGHTS["benchmark"] +
      SCORING_FACTOR_WEIGHTS["availability"];
    expect(sum).toBeCloseTo(1.0, 5);
  });
});