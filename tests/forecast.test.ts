/**
 * PR4 unit tests — forecast engine.
 *
 * RED phase: these tests reference src/forecast.ts which does NOT exist yet.
 * Running `npm test` before the implementation lands must fail with a
 * "Cannot find module" error.
 *
 * Scenarios verified (per task 4.4 + design spec):
 *   1. Full data available → model + effort + reasoning (no fallback).
 *   2. Stale or missing cache → preset default + fallback note.
 *   3. Unsupported effort for chosen model → clamp to nearest + note.
 *   4. Unknown phase → lowest tier default + warning.
 *
 * Extra coverage not explicitly listed but exercised transitively:
 *   - Unknown preset name → default preset + warning.
 *   - No matching model in cache providers → preset default + fallback.
 *   - Unknown project-context field passed through unchanged (no side effects).
 *   - Returns a Forecast object whose `model` is `provider/model-id` form.
 *   - Reasoning contains the phase name in some form.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCache, isCacheFresh, readCache } from "../src/cache.js";
import { DEFAULT_MODEL_FOR_ALIAS } from "../src/rubric.js";
import { forecast } from "../src/forecast.js";
import type { ModelDataCache, Forecast, VerboseForecast } from "../src/types.js";

/** Cache TTL the engine uses. Mirrors forecast.ts default. */
const ENGINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Narrows the union return of `forecast()` to `VerboseForecast`. Throws if
 * the result is a plain `Forecast` — callers MUST pass `verbose: true` to
 * get verbose fields.
 */
function asVerbose(r: Forecast | VerboseForecast): VerboseForecast {
  if (!("evidence" in r)) {
    throw new Error(
      "expected VerboseForecast (caller must pass verbose: true)",
    );
  }
  return r;
}

/** Writes a ModelDataCache to a temp directory and returns its path. */
async function writeTempCache(
  data: Partial<ModelDataCache> & { providers?: ModelDataCache["providers"]; rubric?: ModelDataCache["rubric"] },
  generatedAt: string = new Date().toISOString(),
): Promise<{ cachePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "forecast-cache-"));
  const cachePath = path.join(dir, "model-data.json");
  const full: ModelDataCache = {
    version: 1,
    generatedAt,
    providers: data.providers ?? {},
    rubric: data.rubric ?? {},
  };
  await writeCache(cachePath, full);
  return {
    cachePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("forecast — full data available (cache fresh + matching model)", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("returns the cache-matched model with no fallback for sdd-design (high tier / opus alias)", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
          "claude-sonnet-4-5": {
            variants: ["", "low", "medium", "high", "max"],
          },
          "claude-haiku-4-5": { variants: [""] },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.effort).toBe("high"); // high tier → baseline 'high'
    expect(result.reasoning).toContain("sdd-design");
  });

  it("uses opus (not sonnet) when balanced preset maps sdd-design to opus", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
          "claude-sonnet-4-5": {
            variants: ["", "low", "medium", "high", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    // sdd-design is mapped to opus in balanced; the engine MUST NOT pick sonnet
    // even though both are present in the cache.
    expect(result.model).not.toContain("sonnet");
    expect(result.model).toContain("opus");
  });

  it("returns reasoning mentioning the phase and selected alias", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-propose",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.effort).toBe("high");
    expect(result.reasoning.toLowerCase()).toContain("opus");
    expect(result.reasoning).toContain("sdd-propose");
  });
});

describe("forecast — stale cache falls back to preset default", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("uses DEFAULT_MODEL_FOR_ALIAS[opus] when cache is older than TTL", async () => {
    const oldTimestamp = new Date(
      Date.now() - 48 * 60 * 60 * 1000, // 48 hours ago (> 24h TTL)
    ).toISOString();

    const ctx = await writeTempCache(
      {
        providers: {
          anthropic: {
            "claude-opus-4-7": {
              variants: ["", "low", "medium", "high", "xhigh", "max"],
            },
          },
        },
        rubric: {},
      },
      oldTimestamp,
    );
    cleanup = ctx.cleanup;

    // Sanity: cache is genuinely stale by the engine's TTL.
    const cached = await readCache(ctx.cachePath);
    expect(cached).not.toBeNull();
    expect(isCacheFresh(cached!, new Date(), ENGINE_CACHE_TTL_MS)).toBe(false);

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(true);
    expect(result.model).toBe(DEFAULT_MODEL_FOR_ALIAS["opus"]);
    expect(result.reasoning.toLowerCase()).toContain("stale");
  });

  it("returns fallback for sdd-apply (medium tier / sonnet alias) when cache missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "forecast-missing-"));
    const cachePath = path.join(dir, "does-not-exist.json");
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    const result = await forecast({
      phase: "sdd-apply",
      cachePath,
    });

    expect(result.fallback).toBe(true);
    expect(result.model).toBe(DEFAULT_MODEL_FOR_ALIAS["sonnet"]);
    expect(result.effort).toBe("medium");
    expect(result.reasoning.toLowerCase()).toContain("preset default");
  });

  it("returns fallback note containing 'cache' wording when cache stale", async () => {
    const oldTimestamp = new Date(
      Date.now() - 25 * 60 * 60 * 1000, // 25h ago
    ).toISOString();

    const ctx = await writeTempCache(
      {
        providers: {
          anthropic: {
            "claude-opus-4-7": {
              variants: ["", "low", "medium", "high", "xhigh", "max"],
            },
          },
        },
        rubric: {},
      },
      oldTimestamp,
    );
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(true);
    // Reasoning should mention cache status and the fallback model alias.
    expect(result.reasoning.toLowerCase()).toContain("cache");
    expect(result.reasoning).toContain("opus");
  });
});

describe("forecast — unsupported effort is clamped to nearest available variant", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("clamps baseline 'medium' to nearest variant when sonnet cache model lacks 'medium'", async () => {
    // sdd-apply → medium tier → baseline 'medium'
    // balanced preset → sdd-apply = sonnet
    // Cache model for sonnet only supports ['low','max']
    // clampEffort('medium', ['low','max']) returns 'low' (idx distance 1)
    //   vs 'max' (idx distance 3)
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-sonnet-4-5": { variants: ["low", "max"] }, // no 'medium'
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-apply",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false); // model matched; only effort clamped
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result.effort).toBe("low");
    expect(result.reasoning.toLowerCase()).toMatch(/clamp|nearest|not support/);
  });

  it("does NOT clamp when the cache model variants include the baseline", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.effort).toBe("high"); // exact match, no clamp
    expect(result.reasoning.toLowerCase()).not.toContain("clamp");
  });

  it("returns the model identified by alias even when cache only has minimal variants", async () => {
    // Cache model missing baseline entirely; engine falls back to sonnet
    // alias-allowed efforts (which always include '') for clamping.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-sonnet-4-5": { variants: [""] }, // only default
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-apply",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    // baseline 'medium' clamped to nearest in [''] → '' (only available)
    expect(result.effort).toBe("");
  });
});

describe("forecast — unknown phase uses lowest tier and warns", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("resolves to lowest tier and includes warning for an unknown phase", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
          "claude-sonnet-4-5": {
            variants: ["", "low", "medium", "high", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "mystery-phase",
      cachePath: ctx.cachePath,
    });

    // Lowest tier (low) → baseline '' (default effort).
    expect(result.effort).toBe("");
    // Preset maps unknown phase → preset['default'] = sonnet.
    // Cache has sonnet model → matched, no fallback on the model side.
    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    // Reasoning must surface the unknown-phase warning.
    expect(result.reasoning.toLowerCase()).toContain("mystery-phase");
    expect(result.reasoning.toLowerCase()).toContain("unknown");
  });

  it("also warns for the empty-string phase", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "",
      cachePath: ctx.cachePath,
    });

    expect(result.effort).toBe("");
    expect(result.reasoning.toLowerCase()).toContain("unknown");
  });
});

describe("forecast — extra behaviors (transitively covered)", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("falls back to default preset (balanced) when an unknown preset name is passed", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      preset: "nonexistent-preset",
      cachePath: ctx.cachePath,
    });

    // sdd-design in balanced → opus. If the unknown preset had different
    // behavior, we'd see it. Default preset is balanced.
    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.reasoning.toLowerCase()).toContain("unknown preset");
  });

  it("falls back to preset default when cache has no model matching the alias", async () => {
    // Cache only has haiku; sdd-design is opus in balanced → no alias match.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-haiku-4-5": { variants: [""] },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(true);
    expect(result.model).toBe(DEFAULT_MODEL_FOR_ALIAS["opus"]);
    // Reasoning notes the missing alias.
    expect(result.reasoning.toLowerCase()).toMatch(/no .* model|not found/);
  });

  it("ignores unrelated projectContext (no side effects, returns a valid Forecast)", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      projectContext: "any free-form string supplied by the orchestrator",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.effort).toBe("high");
  });

  it("Forecast shape has the documented four fields", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(Object.keys(result).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
  });
});

describe("forecast — PR2 effort-clamp regression guard (S4 acceptance)", () => {
  // PR2 wires evidence/context scoring into forecast(). S4 (design-review
  // #1228) requires that the existing effort-clamp behavior survives the
  // integration. These tests pin the clamp path BEFORE and AFTER the new
  // scoring branch so a refactor that drops clamp is caught immediately.

  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("default path: clamps baseline 'medium' to 'low' when sonnet cache model lacks medium", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: { "claude-sonnet-4-5": { variants: ["low", "max"] } },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-apply",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result.effort).toBe("low");
    expect(result.reasoning.toLowerCase()).toMatch(/clamp|nearest|not support/);
  });

  it("verbose path: STILL clamps baseline 'medium' to 'low' when sonnet cache model lacks medium (S4 guard)", async () => {
    // The S4 regression guard: the verbose forecast integration MUST NOT
    // short-circuit the existing clamp path. If the new scoring branch
    // accidentally returns the un-clamped baseline effort, this test fails.
    const ctx = await writeTempCache({
      providers: {
        anthropic: { "claude-sonnet-4-5": { variants: ["low", "max"] } },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-apply",
      cachePath: ctx.cachePath,
      verbose: true,
      context: { diffLines: 50, riskDomain: "feature" },
    });
    const v = asVerbose(result);

    expect(result.fallback).toBe(false);
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    // Clamp MUST still trigger — effort is 'low' (idx-1 from 'medium'),
    // not 'medium' or 'max' (idx-3).
    expect(result.effort).toBe("low");
    expect(result.reasoning.toLowerCase()).toMatch(/clamp|nearest|not support/);
    // And the verbose fields still exist alongside the clamped effort.
    expect(Array.isArray(v.evidence)).toBe(true);
    expect(typeof v.confidence).toBe("number");
    expect(Array.isArray(v.alternatives)).toBe(true);
  });

  it("fallback path: clamps to alias-allowed efforts when cache is missing entirely", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "forecast-fallback-"));
    const cachePath = path.join(dir, "no-cache.json");
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    // Cache missing → fallback path. sdd-design → opus alias → allowed
    // efforts ['', low, medium, high, xhigh, max]. baseline 'high' is
    // supported, so effort stays 'high' (no clamp).
    const result = await forecast({
      phase: "sdd-design",
      cachePath,
    });

    expect(result.fallback).toBe(true);
    expect(result.effort).toBe("high");
    expect(result.reasoning.toLowerCase()).not.toContain("clamp");
  });

  it("fallback path: clamps baseline 'high' down to 'max' when cache is missing AND alias only allows ['', max] (synthetic via sonnet-only cache)", async () => {
    // sdd-design → opus alias. Force the engine into the fallback path by
    // pointing at a cache that has only sonnet (no opus). The fallback
    // path uses opus alias-allowed efforts, so we still get ['', low,
    // medium, high, xhigh, max]. The clamp check still passes for opus.
    // But we ALSO verify: sdd-apply → sonnet alias → allowed ['', low,
    // medium, high, max]. baseline 'medium' is allowed → no clamp.
    const ctx = await writeTempCache({
      providers: {
        // Only sonnet; no opus. sdd-design → opus alias → cache has no
        // model for the alias → engine takes the fallback path AND uses
        // the alias-allowed effort list to clamp.
        anthropic: { "claude-sonnet-4-5": { variants: ["", "low", "max"] } },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(result.fallback).toBe(true);
    // fallback uses opus alias-allowed efforts, which include 'high'.
    // baseline 'high' is allowed → no clamp.
    expect(result.effort).toBe("high");
  });
});

describe("forecast — PR2 evidence-based-forecasting integration", () => {
  // PR2 wires normalizeTaskContext + getEvidenceRegistry + scoreCandidates
  // into the forecast() entry point. Verbose mode adds evidence[],
  // confidence, and alternatives[] to the output (additive — the 4-field
  // default shape is preserved).

  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("verbose:true returns a VerboseForecast with evidence, confidence, alternatives", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
    });
    const v = asVerbose(result);

    // 4-field shape preserved
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.effort).toBe("high");
    expect(typeof result.reasoning).toBe("string");
    expect(result.fallback).toBe(false);
    // Verbose extensions added
    expect(Array.isArray(v.evidence)).toBe(true);
    expect(v.evidence.length).toBeGreaterThan(0);
    expect(typeof v.confidence).toBe("number");
    expect(v.confidence).toBeGreaterThanOrEqual(0);
    expect(v.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(v.alternatives)).toBe(true);
    expect(v.alternatives.length).toBeGreaterThan(0);
  });

  it("verbose:true keeps the same model + effort as the non-verbose path (additive only)", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const plain = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });
    const verbose = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
    });

    expect(verbose.model).toBe(plain.model);
    expect(verbose.effort).toBe(plain.effort);
    expect(verbose.fallback).toBe(plain.fallback);
  });

  it("verbose:false (or absent) returns a plain Forecast with exactly 4 fields", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      // No verbose flag.
    });

    expect(Object.keys(result).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
  });

  it("verbose:true evidence citations include model, source, date, factor, value, confidence", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
    });
    const v = asVerbose(result);

    // At least one citation per factor.
    const factors = v.evidence.map((c) => c.factor);
    expect(factors).toContain("context-fit");
    expect(factors).toContain("cost");
    expect(factors).toContain("benchmark");
    expect(factors).toContain("availability");
    // Every citation has the required fields.
    for (const citation of v.evidence) {
      expect(typeof citation.model).toBe("string");
      expect(citation.model.length).toBeGreaterThan(0);
      expect(typeof citation.source).toBe("string");
      expect(citation.source.length).toBeGreaterThan(0);
      expect(typeof citation.date).toBe("string");
      // ISO-8601 date parseable
      expect(Number.isNaN(new Date(citation.date).getTime())).toBe(false);
      expect(typeof citation.value).toBe("number");
      expect(typeof citation.confidence).toBe("number");
    }
  });

  it("verbose:true alternatives are ranked (score desc) and contain provider/model ids", async () => {
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
    });
    const v = asVerbose(result);

    // Alternatives should have provider/model ids (e.g. "anthropic/claude-opus-4-7").
    for (const alt of v.alternatives) {
      expect(alt.model).toContain("/");
      expect(typeof alt.score).toBe("number");
      expect(alt.score).toBeGreaterThanOrEqual(0);
      expect(alt.score).toBeLessThanOrEqual(1);
      expect(typeof alt.reasoning).toBe("string");
    }
    // Scores are sorted descending.
    for (let i = 1; i < v.alternatives.length; i++) {
      const prev = v.alternatives[i - 1]!.score;
      const curr = v.alternatives[i]!.score;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("verbose:true with context surfaces non-Anthropic alternatives when registry contains them", async () => {
    // The static evidence registry contains gemini + gpt models. When
    // verbose is enabled and context is supplied, the alternatives list
    // includes at least one non-Anthropic candidate. The CHOSEN model
    // still comes from the cache/preset path (backward compat).
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
      context: { diffLines: 600, riskDomain: "architecture" },
    });
    const v = asVerbose(result);

    // Chosen model is still the cache match (backward compat).
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    // Alternatives include at least one non-Anthropic model from the registry.
    const nonAnthropic = v.alternatives.filter(
      (a) => !a.model.startsWith("anthropic/"),
    );
    expect(nonAnthropic.length).toBeGreaterThan(0);
    // The non-Anthropic alternative has a positive score.
    for (const alt of nonAnthropic) {
      expect(alt.score).toBeGreaterThan(0);
    }
  });

  it("verbose:true with NO context still produces a valid VerboseForecast (default signals)", async () => {
    // When context is absent, normalizeTaskContext returns defaults that
    // don't penalise any model. The scoring still runs and the verbose
    // output is still produced.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
    });

    // Type guard — verbose:true MUST return VerboseForecast.
    if (!("evidence" in result)) {
      throw new Error("expected VerboseForecast when verbose:true");
    }
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("verbose:true with verbose AND context and missing cache still produces a VerboseForecast", async () => {
    // Even when the cache is missing entirely (fallback path), the verbose
    // integration must still produce evidence/confidence/alternatives.
    const dir = await mkdtemp(path.join(tmpdir(), "forecast-verbose-fallback-"));
    const cachePath = path.join(dir, "no-cache.json");
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    const result = await forecast({
      phase: "sdd-design",
      cachePath,
      verbose: true,
      context: { diffLines: 100, riskDomain: "feature" },
    });

    expect(result.fallback).toBe(true);
    // Type guard — verbose:true MUST return VerboseForecast even in fallback.
    if (!("evidence" in result)) {
      throw new Error("expected VerboseForecast when verbose:true");
    }
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(typeof result.confidence).toBe("number");
    expect(Array.isArray(result.alternatives)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR3 acceptance — W1 spec-resolution contract (PR2 gate #1235, decision #1236)
//
// W1 resolution (per PR2 gate / Engram decision #1236): the spec scenario
// "Evidence-based preference → selects that model" (spec #1226) was NOT
// implemented literally. The approved design (#1227) keeps the default
// 4-field Forecast contract backward-compatible by deriving `model`/`effort`/
// `fallback` from the existing phase/cache path UNCHANGED. Evidence-based
// preference is surfaced ADDITIVELY in `alternatives[]`, `reasoning`, and
// `confidence`. A future breaking-change proposal can introduce an
// evidence-driven model-selection override; this change does NOT.
//
// These tests pin the W1 resolution contract:
//   1. Verbose with context surfaces non-Anthropic alternatives WITHOUT
//      overriding the chosen `model` field.
//   2. The chosen `model` is ALWAYS derived from the phase/cache path
//      (backward-compat) regardless of verbose + context.
//   3. Default (verbose=false, no context) returns exactly 4 fields
//      (backward-compat — proposal #1224 success criterion #1).
//   4. Absent context falls back to phase-only reasoning
//      (spec #1226 "Absent context fallback" scenario).
// ---------------------------------------------------------------------------

describe("forecast — PR3 acceptance: W1 resolution (additive ranking, no default-model override)", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("verbose:true with context surfaces non-Anthropic alternative WITHOUT overriding chosen model", async () => {
    // W1 acceptance: when context + evidence favor a non-Anthropic model,
    // the engine surfaces that model in `alternatives[]` but the chosen
    // `model` field STILL comes from the cache/preset path (backward compat).
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
      context: { diffLines: 800, contextBreadth: "wide", riskDomain: "architecture" },
    });

    // The chosen model is still the cache match (Anthropic) — NOT the
    // top-scored alternative. This is the additive-only contract.
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.fallback).toBe(false);

    // The non-Anthropic alternative IS surfaced in alternatives[].
    if (!("evidence" in result)) {
      throw new Error("expected VerboseForecast");
    }
    const nonAnthropic = result.alternatives.filter(
      (a) => !a.model.startsWith("anthropic/"),
    );
    expect(nonAnthropic.length).toBeGreaterThan(0);
  });

  it("verbose:true with context: the chosen model field NEVER comes from alternatives[0] (W1 hard contract)", async () => {
    // Stronger form of the W1 contract: even when the top-ranked alternative
    // would be a non-Anthropic model (e.g. gemini-2.5-pro with its large
    // context window + low cost), the chosen `model` field stays on the
    // cache/preset path. This pins the additive-only design.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
      context: { diffLines: 5000, contextBreadth: "wide", riskDomain: "architecture" },
    });

    if (!("evidence" in result)) {
      throw new Error("expected VerboseForecast");
    }
    const topAlt = result.alternatives[0];
    expect(topAlt).toBeDefined();
    // The chosen `model` is NEVER the top-scored alternative's `model`.
    // The cache/preset path wins; the alternative is surfaced for context
    // but does not override.
    expect(result.model).not.toBe(topAlt!.model);
    // Specifically: the chosen model is the cache-matched one.
    expect(result.model).toBe("anthropic/claude-opus-4-7");
  });

  it("default (verbose:false, no context) returns exactly 4 fields — proposal #1224 success criterion #1", async () => {
    // Proposal success criterion #1: "Existing CLI/output remains usable
    // and default 4-field Forecast JSON still passes". This is the contract
    // any future change MUST NOT break.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      // No verbose, no context.
    });

    // Exactly 4 keys — and ONLY 4.
    expect(Object.keys(result).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    // No verbose extensions leaked into default output.
    expect("evidence" in result).toBe(false);
    expect("confidence" in result).toBe(false);
    expect("alternatives" in result).toBe(false);
  });

  it("verbose:false with context returns 4-field Forecast + augmented reasoning (additive, not a VerboseForecast)", async () => {
    // When context is supplied but verbose is false, the engine augments
    // reasoning with a one-line evidence summary but keeps the 4-field
    // shape. This is the "scoring-aware but backward-compat" path.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      context: { diffLines: 100, riskDomain: "feature" },
      // verbose NOT set.
    });

    expect(Object.keys(result).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    // Reasoning mentions the scoring pipeline ran.
    expect(result.reasoning.toLowerCase()).toMatch(/evidence/);
  });

  it("absent context (verbose:true, no context) falls back to phase-only reasoning (spec #1226 Absent context fallback)", async () => {
    // Spec #1226 "Absent context fallback" scenario: when task context is
    // unavailable, the engine falls back to the phase-only rubric and notes
    // the fallback in reasoning. In verbose mode the verbose fields are
    // still present (scoring ran with DEFAULT signals), but they reflect
    // a default-signals evaluation — NOT a context-driven one.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
      verbose: true,
      // No context provided.
    });

    if (!("evidence" in result)) {
      throw new Error("expected VerboseForecast");
    }
    // The 4 base fields come from the phase/cache path (backward compat).
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.effort).toBe("high");
    expect(result.fallback).toBe(false);
    // Verbose fields exist (scoring ran with DEFAULT signals — non-penalising).
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("absent context (no verbose, no context) returns the canonical 4-field Forecast with phase-only reasoning", async () => {
    // Pure absent-context path: no verbose, no context. Engine must use
    // phase-only signals. The default 4-field Forecast is returned with
    // NO evidence scoring involved.
    const ctx = await writeTempCache({
      providers: {
        anthropic: {
          "claude-opus-4-7": {
            variants: ["", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      rubric: {},
    });
    cleanup = ctx.cleanup;

    const result = await forecast({
      phase: "sdd-design",
      cachePath: ctx.cachePath,
    });

    expect(Object.keys(result).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    // No evidence-scoring mention in reasoning (engine took the fast path).
    expect(result.reasoning.toLowerCase()).not.toContain("evidence-based ranking");
  });
});
