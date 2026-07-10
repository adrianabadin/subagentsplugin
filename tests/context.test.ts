/**
 * PR1 unit tests — task-context normalisation.
 *
 * RED phase: these tests reference src/context.ts which does NOT exist
 * yet. Running `npm test` before the implementation lands must fail.
 *
 * Scenarios verified (per spec `task-context-analysis` + task 1.3):
 *   1. Full explicit context (diffLines, files, symbols, riskDomain,
 *      contextBreadth, modality) → normalized signals carrying contextSize,
 *      riskTier, breadth, modalities.
 *   2. Absent context (undefined input) → safe defaults that do NOT
 *      penalise any model (e.g. contextSize='medium', riskTier='low',
 *      breadth='moderate', modalities=[]).
 *
 * Threshold values for context-size bucketing are pinned by these tests so
 * the scorer can rely on them deterministically.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeTaskContext,
  type TaskContextInput,
  type TaskSignals,
} from "../src/context.js";

describe("context — normalizeTaskContext: full explicit context", () => {
  it("emits contextSize='large' for diffLines >= 500", () => {
    const signals: TaskSignals = normalizeTaskContext({
      diffLines: 500,
      files: ["src/a.ts"],
      symbols: ["alpha"],
      riskDomain: "architecture",
      contextBreadth: "wide",
      modality: ["code"],
    });
    expect(signals.contextSize).toBe("large");
    // architecture maps to high; this confirms the risk tier is read from
    // riskDomain even when other fields are present.
    expect(signals.riskTier).toBe("high");
    expect(signals.breadth).toBe("wide");
    expect(signals.modalities).toEqual(["code"]);
  });

  it("emits contextSize='medium' for diffLines between 100 and 499 (inclusive)", () => {
    const at = normalizeTaskContext({ diffLines: 100 });
    expect(at.contextSize).toBe("medium");
    const at499 = normalizeTaskContext({ diffLines: 499 });
    expect(at499.contextSize).toBe("medium");
  });

  it("emits contextSize='small' for diffLines < 100", () => {
    expect(normalizeTaskContext({ diffLines: 0 }).contextSize).toBe("small");
    expect(normalizeTaskContext({ diffLines: 99 }).contextSize).toBe("small");
  });

  it("derives riskTier from riskDomain (architecture/infra → high, security → high, test → low, other → medium)", () => {
    expect(normalizeTaskContext({ riskDomain: "architecture" }).riskTier).toBe("high");
    expect(normalizeTaskContext({ riskDomain: "infra" }).riskTier).toBe("high");
    expect(normalizeTaskContext({ riskDomain: "security" }).riskTier).toBe("high");
    expect(normalizeTaskContext({ riskDomain: "test" }).riskTier).toBe("low");
    expect(normalizeTaskContext({ riskDomain: "docs" }).riskTier).toBe("low");
    expect(normalizeTaskContext({ riskDomain: "performance" }).riskTier).toBe("medium");
  });

  it("echoes contextBreadth verbatim (narrow / moderate / wide)", () => {
    expect(normalizeTaskContext({ contextBreadth: "narrow" }).breadth).toBe("narrow");
    expect(normalizeTaskContext({ contextBreadth: "moderate" }).breadth).toBe("moderate");
    expect(normalizeTaskContext({ contextBreadth: "wide" }).breadth).toBe("wide");
  });

  it("copies the modality array as-is (order preserved, no dedupe)", () => {
    const signals = normalizeTaskContext({ modality: ["code", "docs", "diagram"] });
    expect(signals.modalities).toEqual(["code", "docs", "diagram"]);
  });

  it("derives contextSize from file count when diffLines is absent but files are present (>= 20 → large)", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    const signals = normalizeTaskContext({ files });
    expect(signals.contextSize).toBe("large");
  });

  it("derives riskTier from symbols when riskDomain is absent (heuristic: 0 symbols → low, >=5 → high)", () => {
    expect(normalizeTaskContext({ symbols: [] }).riskTier).toBe("low");
    expect(normalizeTaskContext({ symbols: ["a"] }).riskTier).toBe("low");
    expect(
      normalizeTaskContext({ symbols: ["a", "b", "c", "d", "e"] }).riskTier,
    ).toBe("high");
  });
});

describe("context — normalizeTaskContext: absent context returns non-penalising defaults", () => {
  it("returns defaults when called with no argument (undefined)", () => {
    const signals = normalizeTaskContext();
    // Defaults MUST NOT penalise any model: medium/size, low/risk,
    // moderate/breadth, empty modalities.
    expect(signals.contextSize).toBe("medium");
    expect(signals.riskTier).toBe("low");
    expect(signals.breadth).toBe("moderate");
    expect(signals.modalities).toEqual([]);
  });

  it("returns defaults when called with an empty object", () => {
    const signals = normalizeTaskContext({});
    expect(signals.contextSize).toBe("medium");
    expect(signals.riskTier).toBe("low");
    expect(signals.breadth).toBe("moderate");
    expect(signals.modalities).toEqual([]);
  });

  it("returned default signals are pure data (no functions, no nested objects)", () => {
    const signals = normalizeTaskContext();
    for (const value of Object.values(signals)) {
      if (Array.isArray(value)) {
        expect(value).toEqual([]);
      } else {
        expect(typeof value === "string" || value === undefined).toBe(true);
      }
    }
  });
});

describe("context — normalizeTaskContext: determinism + purity", () => {
  it("calling normalizeTaskContext with the same input twice returns identical signals", () => {
    const input: TaskContextInput = {
      diffLines: 150,
      files: ["a.ts", "b.ts"],
      symbols: ["x", "y"],
      riskDomain: "performance",
      contextBreadth: "wide",
      modality: ["code"],
    };
    expect(normalizeTaskContext(input)).toEqual(normalizeTaskContext(input));
  });

  it("does not mutate the input object", () => {
    const input: TaskContextInput = {
      diffLines: 200,
      files: ["a.ts"],
      symbols: ["s"],
      riskDomain: "architecture",
      contextBreadth: "narrow",
      modality: ["code", "docs"],
    };
    const snapshot = JSON.stringify(input);
    normalizeTaskContext(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});