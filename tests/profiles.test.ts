import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  GENERATED_PROFILE_PREFIX,
  connectedModelsFromProviderList,
  createGeneratedProfileResolver,
  generatedProfileAlias,
  generateProfilesForConfig,
} from "../src/profiles.js";
import { QuarantineStore } from "../src/quarantine.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { setRepoLocal } from "../src/benchmark-registry.js";
import { loadEffectiveBenchmarks } from "../src/repo-data.js";

afterEach(() => {
  setRepoLocal(null);
});

describe("profiles — generated phase × model aliases", () => {
  it("rebuilds generated profiles from connected models while preserving base phase config", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
          permission: { edit: "deny" },
        },
        "sdd-design-alto": {
          mode: "subagent",
          model: "anthropic/claude-opus-4-8",
          prompt: "Design prompt",
        },
        "sdd-apply": {
          mode: "subagent",
          model: "minimax/MiniMax-M3",
          prompt: "Apply prompt",
          permission: { edit: "allow" },
        },
        [`${GENERATED_PROFILE_PREFIX}stale`]: {
          mode: "subagent",
          model: "openai/old",
        },
        "gentle-orchestrator": {
          mode: "primary",
          permission: {
            task: {
              "sdd-design": "allow",
              "sdd-apply": "allow",
            },
          },
        },
      },
    };
    const connectedModels = [
      {
        provider: "openai",
        model: "gpt-4.1-mini",
        modelId: "openai/gpt-4.1-mini",
        ladderRung: "openai" as const,
        evidence: {
          provider: "openai",
          model: "gpt-4.1-mini",
          benchmarks: { mmlu: 0.85 },
          contextWindow: 1_000_000,
          inputCost: 0.4,
          outputCost: 1.6,
          availability: "available" as const,
          source: "opencode provider.list",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        ladderRung: "anthropic" as const,
        evidence: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          benchmarks: { mmlu: 0.93 },
          contextWindow: 200_000,
          inputCost: 15,
          outputCost: 75,
          availability: "available" as const,
          source: "opencode provider.list",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    const designOpenAiAlias = generatedProfileAlias(
      "sdd-design",
      "openai/gpt-4.1-mini",
    );
    const applyOpenAiAlias = generatedProfileAlias(
      "sdd-apply",
      "openai/gpt-4.1-mini",
    );

    expect(cfg.agent[`${GENERATED_PROFILE_PREFIX}stale`]).toBeUndefined();
    expect(cfg.agent[designOpenAiAlias]).toMatchObject({
      mode: "subagent",
      model: "openai/gpt-4.1-mini",
      prompt: "Design prompt",
      permission: { edit: "deny" },
      hidden: true,
    });
    expect(cfg.agent[applyOpenAiAlias]).toMatchObject({
      mode: "subagent",
      model: "openai/gpt-4.1-mini",
      prompt: "Apply prompt",
      permission: { edit: "allow" },
      hidden: true,
    });
    expect(cfg.agent["gentle-orchestrator"].permission.task[designOpenAiAlias]).toBe("allow");
    expect(cfg.agent["gentle-orchestrator"].permission.task[applyOpenAiAlias]).toBe("allow");
    expect(catalog.byBase["sdd-design"].map((profile) => profile.alias)).toContain(
      designOpenAiAlias,
    );
  });

  it("resolves generated profiles into scored selection candidates for the requested phase", () => {
    const alias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const resolver = createGeneratedProfileResolver({
      byBase: {
        "sdd-design": [
          {
            baseAgent: "sdd-design",
            alias,
            provider: "openai",
            model: "gpt-4.1-mini",
            modelId: "openai/gpt-4.1-mini",
            ladderRung: "openai",
            evidence: {
              provider: "openai",
              model: "gpt-4.1-mini",
              benchmarks: {},
              contextWindow: 1_000_000,
              inputCost: 0.4,
              outputCost: 1.6,
              availability: "available",
              source: "opencode provider.list",
              date: "2026-07-03",
              confidence: 0.7,
            },
          },
        ],
      },
    });

    const candidates = resolver({
      originalSubagentType: "sdd-design",
      ladder: DEFAULT_LADDER,
      context: { phase: "sdd-design" },
      policy: { mode: "auto", confidenceThreshold: 0.6 },
      args: { subagent_type: "sdd-design" },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      subagent_type: alias,
      model: "openai/gpt-4.1-mini",
      effort: "",
      ladderRung: "openai",
    });
    expect(candidates[0].confidence).toBeGreaterThan(0.5);
    expect(candidates[0].evidence).toContain("openai/gpt-4.1-mini");
  });

  it("resolves an '-alto'/'-fallback' variant dispatch to the BASE phase's generated profiles", () => {
    // Real-world orchestrators dispatch escalation variants like
    // `sdd-design-alto`. Profiles are only generated for the BASE phase
    // agent (`sdd-design`), so a raw lookup on the variant name misses.
    // The resolver must fall back to the normalized base phase so the
    // hook can still evaluate evidence-based alternatives.
    const alias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const resolver = createGeneratedProfileResolver({
      byBase: {
        "sdd-design": [
          {
            baseAgent: "sdd-design",
            alias,
            provider: "openai",
            model: "gpt-4.1-mini",
            modelId: "openai/gpt-4.1-mini",
            ladderRung: "openai",
            evidence: {
              provider: "openai",
              model: "gpt-4.1-mini",
              benchmarks: {},
              contextWindow: 1_000_000,
              inputCost: 0.4,
              outputCost: 1.6,
              availability: "available",
              source: "opencode provider.list",
              date: "2026-07-03",
              confidence: 0.7,
            },
          },
        ],
      },
    });

    const candidates = resolver({
      originalSubagentType: "sdd-design-alto",
      ladder: DEFAULT_LADDER,
      context: { phase: "sdd-design" },
      policy: { mode: "auto", confidenceThreshold: 0.6 },
      args: { subagent_type: "sdd-design-alto" },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      subagent_type: alias,
      model: "openai/gpt-4.1-mini",
    });
  });

  it("returns [] for a truly unknown variant with no base phase in the catalog", () => {
    const resolver = createGeneratedProfileResolver({
      byBase: {
        "sdd-design": [
          {
            baseAgent: "sdd-design",
            alias: generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini"),
            provider: "openai",
            model: "gpt-4.1-mini",
            modelId: "openai/gpt-4.1-mini",
            ladderRung: "openai",
          },
        ],
      },
    });

    const candidates = resolver({
      originalSubagentType: "sdd-init",
      ladder: DEFAULT_LADDER,
      context: { phase: "sdd-init" },
      policy: { mode: "auto", confidenceThreshold: 0.6 },
      args: { subagent_type: "sdd-init" },
    });

    expect(candidates).toEqual([]);
  });

  it("verifies unconditional deduplication for fewer than 3 models and grouping for models not in benchmark registry", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
          permission: { edit: "deny" },
        },
        "gentle-orchestrator": {
          mode: "primary",
          permission: {
            task: {
              "sdd-design": "allow",
            },
          },
        },
      },
    };

    // We have 2 models with the same model name segment, e.g., 'custom-unknown-model'.
    // They are not in the benchmark registry.
    // Provider ranking should choose 'deepseek/custom-unknown-model' (rank 0) over 'opencode-go/custom-unknown-model' (rank 1).
    const connectedModels = [
      {
        provider: "opencode-go",
        model: "custom-unknown-model",
        modelId: "opencode-go/custom-unknown-model",
        ladderRung: "openai" as const,
        evidence: {
          provider: "opencode-go",
          model: "custom-unknown-model",
          benchmarks: { mmlu: 0.8 },
          contextWindow: 128_000,
          inputCost: 0.14,
          outputCost: 0.28,
          availability: "available" as const,
          source: "custom",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
      {
        provider: "deepseek",
        model: "custom-unknown-model",
        modelId: "deepseek/custom-unknown-model",
        ladderRung: "openai" as const,
        evidence: {
          provider: "deepseek",
          model: "custom-unknown-model",
          benchmarks: { mmlu: 0.8 },
          contextWindow: 128_000,
          inputCost: 0.14,
          outputCost: 0.28,
          availability: "available" as const,
          source: "custom",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    const expectedAlias = generatedProfileAlias(
      "sdd-design",
      "deepseek/custom-unknown-model",
    );
    const rejectedAlias = generatedProfileAlias(
      "sdd-design",
      "opencode-go/custom-unknown-model",
    );

    // Grouping by segment works, resulting in a single deduplicated profile.
    expect(catalog.byBase["sdd-design"]).toHaveLength(1);
    expect(catalog.byBase["sdd-design"][0].alias).toBe(expectedAlias);
    expect(catalog.byBase["sdd-design"][0].modelId).toBe("deepseek/custom-unknown-model");

    // Agent config should only contain the selected profile's agent configuration.
    expect(cfg.agent[expectedAlias]).toBeDefined();
    expect(cfg.agent[rejectedAlias]).toBeUndefined();
    expect(cfg.agent["gentle-orchestrator"].permission.task[expectedAlias]).toBe("allow");
    expect(cfg.agent["gentle-orchestrator"].permission.task[rejectedAlias]).toBeUndefined();
  });

  it("verifies fallback profile generation when at least 2 profiles are registered", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
          permission: { edit: "deny" },
        },
        "gentle-orchestrator": {
          mode: "primary",
          permission: {
            task: {
              "sdd-design": "allow",
            },
          },
        },
      },
    };

    // We have 2 connected models that won't group together (different canonical keys).
    const connectedModels = [
      {
        provider: "openai",
        model: "gpt-4.1-mini",
        modelId: "openai/gpt-4.1-mini",
        ladderRung: "openai" as const,
        evidence: {
          provider: "openai",
          model: "gpt-4.1-mini",
          benchmarks: { mmlu: 0.85 },
          contextWindow: 1_000_000,
          inputCost: 0.4,
          outputCost: 1.6,
          availability: "available" as const,
          source: "opencode provider.list",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        ladderRung: "anthropic" as const,
        evidence: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          benchmarks: { mmlu: 0.93 },
          contextWindow: 200_000,
          inputCost: 15,
          outputCost: 75,
          availability: "available" as const,
          source: "opencode provider.list",
          date: "2026-07-03",
          confidence: 0.7,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    // Check we got 2 base profiles.
    expect(catalog.byBase["sdd-design"]).toHaveLength(2);

    const firstProfile = catalog.byBase["sdd-design"][0];
    const secondProfile = catalog.byBase["sdd-design"][1];

    const expectedFallbackAlias = `${firstProfile.alias}-fallback`;

    // The fallback profile must be registered and use the second model.
    expect(cfg.agent[expectedFallbackAlias]).toBeDefined();
    expect(cfg.agent[expectedFallbackAlias].model).toBe(secondProfile.modelId);
    expect(cfg.agent[expectedFallbackAlias].hidden).toBe(true);

    // It should be allowed where the base agent is allowed.
    expect(cfg.agent["gentle-orchestrator"].permission.task[expectedFallbackAlias]).toBe("allow");
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — Resolver skips quarantined rungs.
 * Spec #1316 requirement 3. When the resolver is built with a
 * `quarantine` dep, candidates whose `modelId` is blocked are filtered
 * out. The output shape + ordering are unchanged when quarantine is
 * empty/disabled.
 * -------------------------------------------------------------------------- */
describe("createGeneratedProfileResolver() — 429-fallback quarantine filter", () => {
  function makeProfile(modelId: string, ladderRung: "minimax" | "google-antigravity" | "openai" | "glm-5.2" | "anthropic") {
    return {
      baseAgent: "sdd-design",
      alias: generatedProfileAlias("sdd-design", modelId),
      provider: modelId.split("/")[0] ?? "",
      model: modelId.split("/")[1] ?? modelId,
      modelId,
      ladderRung,
      evidence: {
        provider: modelId.split("/")[0] ?? "",
        model: modelId.split("/")[1] ?? modelId,
        benchmarks: {},
        contextWindow: 1_000_000,
        inputCost: 0.4,
        outputCost: 1.6,
        availability: "available" as const,
        source: "opencode provider.list",
        date: "2026-07-03",
        confidence: 0.7,
      },
    };
  }

  const deps = {
    originalSubagentType: "sdd-design",
    ladder: DEFAULT_LADDER,
    context: { phase: "sdd-design" },
    policy: { mode: "auto" as const, confidenceThreshold: 0.6 },
    args: { subagent_type: "sdd-design" },
  };

  it("filters a single blocked candidate (one-blocked scenario)", () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    quarantine.add("minimax/M3", "usage_limit_reached");
    const resolver = createGeneratedProfileResolver(
      {
        byBase: {
          "sdd-design": [
            makeProfile("minimax/M3", "minimax"),
            makeProfile("openai/gpt-4.1-mini", "openai"),
            makeProfile("anthropic/claude-opus-4-8", "anthropic"),
          ],
        },
      },
      { quarantine },
    );

    const candidates = resolver(deps);
    const ids = candidates.map((c) => c.model);
    expect(ids).toContain("openai/gpt-4.1-mini");
    expect(ids).toContain("anthropic/claude-opus-4-8");
    expect(ids).not.toContain("minimax/M3");
  });

  it("returns [] when ALL candidates are blocked (all-blocked scenario)", () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    quarantine.add("minimax/M3", "rate_limit");
    quarantine.add("openai/gpt-4.1-mini", "rate_limit");
    const resolver = createGeneratedProfileResolver(
      {
        byBase: {
          "sdd-design": [
            makeProfile("minimax/M3", "minimax"),
            makeProfile("openai/gpt-4.1-mini", "openai"),
          ],
        },
      },
      { quarantine },
    );

    const candidates = resolver(deps);
    expect(candidates).toEqual([]);
  });

  it("returns all candidates verbatim when the resolver has no quarantine dep (disabled scenario)", () => {
    const resolver = createGeneratedProfileResolver({
      byBase: {
        "sdd-design": [
          makeProfile("minimax/M3", "minimax"),
          makeProfile("openai/gpt-4.1-mini", "openai"),
        ],
      },
    });
    const candidates = resolver(deps);
    expect(candidates).toHaveLength(2);
  });

  it("returns all candidates verbatim when the quarantine store is empty (empty-quarantine scenario)", () => {
    const resolver = createGeneratedProfileResolver(
      {
        byBase: {
          "sdd-design": [
            makeProfile("minimax/M3", "minimax"),
            makeProfile("openai/gpt-4.1-mini", "openai"),
          ],
        },
      },
      { quarantine: new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 }) },
    );
    const candidates = resolver(deps);
    expect(candidates).toHaveLength(2);
  });

  it("falls back from a blocked generated alias dispatch to unblocked base profiles", () => {
    const blocked = makeProfile("opencode-go/deepseek-v4-pro", "openai");
    const fallback = makeProfile("openai/gpt-5.5", "openai");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    quarantine.add("opencode-go/deepseek-v4-pro", "manual_permanent_quarantine");

    const resolver = createGeneratedProfileResolver(
      {
        byBase: {
          "sdd-design": [blocked, fallback],
        },
      },
      { quarantine },
    );

    const candidates = resolver({
      ...deps,
      originalSubagentType: blocked.alias,
      args: { subagent_type: blocked.alias },
    });

    expect(candidates.map((c) => c.model)).toEqual(["openai/gpt-5.5"]);
    expect(candidates[0]?.subagent_type).toBe(fallback.alias);
  });
});

/* -------------------------------------------------------------------------- *
 * Direct-provider exclusion — models with availability "unavailable" must be
 * filtered from profile generation so they can never be selected by forecast/
 * fallback. opencode-go and other routing providers are NOT blocked.
 * -------------------------------------------------------------------------- */
describe("generateProfilesForConfig() — availability filtering", () => {
  it("excludes a connected model marked unavailable by global benchmark config", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "profiles-global-"));
    try {
      const globalPath = path.join(tmpRoot, "global", "benchmarks.json");
      await mkdir(path.dirname(globalPath), { recursive: true });
      await writeFile(
        globalPath,
        JSON.stringify([
          {
            key: "opencode-go/deepseek-v4-pro",
            benchmarks: { mmlu: 0.91 },
            contextWindow: 1_000_000,
            inputCost: 0.435,
            outputCost: 0.87,
            availability: "unavailable",
            source: "global-config",
            date: "2026-07-09",
            confidence: 0.95,
          },
        ]),
        "utf8",
      );
      await loadEffectiveBenchmarks({ rootDir: tmpRoot, globalPath });

      const cfg: { agent: Record<string, any> } = {
        agent: {
          "sdd-design": { mode: "subagent", model: "openai/gpt-4.1-mini", prompt: "ok" },
        },
      };
      const connectedModels = connectedModelsFromProviderList([
        {
          id: "opencode-go",
          models: {
            "deepseek-v4-pro": { variants: { medium: {}, high: {} } },
          },
        },
      ]);

      const catalog = generateProfilesForConfig(cfg, connectedModels, {
        phasePrefixes: ["sdd-"],
      });

      expect(catalog.byBase["sdd-design"]).toEqual([]);
      expect(Object.values(cfg.agent).some((agent) => agent?.model === "opencode-go/deepseek-v4-pro")).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("excludes models with availability 'unavailable' from profile generation", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": { mode: "subagent", model: "openai/gpt-4.1-mini", prompt: "ok" },
      },
    };
    // Two models: one unavailable (direct deepseek), one available (opencode-go)
    const connectedModels = [
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        modelId: "deepseek/deepseek-v4-pro",
        ladderRung: "openai" as const,
        evidence: {
          provider: "deepseek", model: "deepseek-v4-pro",
          benchmarks: { mmlu: 0.91 },
          contextWindow: 1_000_000, inputCost: 0.435, outputCost: 0.87,
          availability: "unavailable" as const,
          source: "api-docs.deepseek.com", date: "2026-07-08", confidence: 0.95,
        },
      },
      {
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        modelId: "opencode-go/deepseek-v4-pro",
        ladderRung: "openai" as const,
        evidence: {
          provider: "opencode-go", model: "deepseek-v4-pro",
          benchmarks: { mmlu: 0.91 },
          contextWindow: 1_000_000, inputCost: 0.435, outputCost: 0.87,
          availability: "available" as const,
          source: "api-docs.deepseek.com", date: "2026-07-08", confidence: 0.95,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    const profiles = catalog.byBase["sdd-design"];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.modelId).toBe("opencode-go/deepseek-v4-pro");
  });

  it("excludes all unavailable models even when no routing-provider alternative exists", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-apply": { mode: "subagent", model: "anthropic/claude-opus-4-8", prompt: "ok" },
      },
    };
    const connectedModels = [
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        modelId: "deepseek/deepseek-v4-flash",
        ladderRung: "openai" as const,
        evidence: {
          provider: "deepseek", model: "deepseek-v4-flash",
          benchmarks: { mmlu: 0.85 },
          contextWindow: 1_000_000, inputCost: 0.14, outputCost: 0.28,
          availability: "unavailable" as const,
          source: "api-docs.deepseek.com", date: "2026-04-24", confidence: 0.90,
        },
      },
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        ladderRung: "anthropic" as const,
        evidence: {
          provider: "anthropic", model: "claude-opus-4-8",
          benchmarks: { mmlu: 0.93 },
          contextWindow: 200_000, inputCost: 15, outputCost: 75,
          availability: "available" as const,
          source: "anthropic.com", date: "2026-04-01", confidence: 0.95,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    const profiles = catalog.byBase["sdd-apply"];
    // Only anthropic should survive; deepseek is excluded.
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.modelId).toBe("anthropic/claude-opus-4-8");
  });

  it("does NOT exclude models with availability 'available' or 'unknown'", () => {
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": { mode: "subagent", model: "openai/gpt-4.1-mini", prompt: "ok" },
      },
    };
    const connectedModels = [
      {
        provider: "openai", model: "gpt-4.1-mini", modelId: "openai/gpt-4.1-mini",
        ladderRung: "openai" as const,
        evidence: {
          provider: "openai", model: "gpt-4.1-mini",
          benchmarks: { mmlu: 0.85 },
          contextWindow: 1_000_000, inputCost: 0.4, outputCost: 1.6,
          availability: "available" as const,
          source: "opencode provider.list", date: "2026-07-03", confidence: 0.7,
        },
      },
      {
        provider: "unknown", model: "unknown-model", modelId: "unknown/unknown-model",
        ladderRung: "openai" as const,
        evidence: {
          provider: "unknown", model: "unknown-model",
          benchmarks: { mmlu: 0.5 },
          contextWindow: 128_000, inputCost: 0, outputCost: 0,
          availability: "unknown" as const,
          source: "unknown", date: "2026-01-01", confidence: 0.3,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    const profiles = catalog.byBase["sdd-design"];
    // Both should be included: available and unknown are NOT filtered.
    expect(profiles).toHaveLength(2);
  });

  it("does not pick the cheapest model for reasoning-heavy phases (regression: phase was missing from profile scoring)", () => {
    // Bug: generateProfilesForConfig scored ALL base agents with
    // signals.phase = undefined. The phase-specific cost override
    // (cost: -0.25 for sdd-design/propose/spec in PHASE_FACTOR_OVERRIDES)
    // never fired, so ultra-cheap flash models beat reasoning-class models
    // for architecture decisions — the exact scenario the override prevents.
    const cfg: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "anthropic/claude-opus-4-8",
          prompt: "Design",
        },
        "sdd-apply": {
          mode: "subagent",
          model: "openai/gpt-4.1",
          prompt: "Apply",
        },
      },
    };

    // Fake IDs so lookupEvidence/lookupBenchmark return nothing — the only
    // benchmarks come from profile.evidence, making the test deterministic.
    const connectedModels = [
      {
        provider: "fake",
        model: "cheap-flash",
        modelId: "fake/cheap-flash",
        ladderRung: "minimax" as const,
        evidence: {
          provider: "fake",
          model: "cheap-flash",
          benchmarks: { gpqa: 0.70, mmlu: 0.80, bbh: 0.75, humaneval: 0.85, "swe-bench": 0.55 },
          contextWindow: 1_000_000,
          inputCost: 0.15,
          outputCost: 0.60,
          availability: "available" as const,
          source: "test",
          date: "2026-07-09",
          confidence: 0.9,
        },
      },
      {
        provider: "fake",
        model: "reasoning-pro",
        modelId: "fake/reasoning-pro",
        ladderRung: "anthropic" as const,
        evidence: {
          provider: "fake",
          model: "reasoning-pro",
          benchmarks: { gpqa: 0.88, mmlu: 0.93, bbh: 0.91, humaneval: 0.90, "swe-bench": 0.72 },
          contextWindow: 200_000,
          inputCost: 15,
          outputCost: 75,
          availability: "available" as const,
          source: "test",
          date: "2026-07-09",
          confidence: 0.9,
        },
      },
    ];

    const catalog = generateProfilesForConfig(cfg, connectedModels, {
      phasePrefixes: ["sdd-"],
    });

    // sdd-design: cost override zeroes cost factor → reasoning-pro MUST win.
    const designProfiles = catalog.byBase["sdd-design"];
    expect(designProfiles.length).toBeGreaterThanOrEqual(2);
    expect(designProfiles[0]!.modelId).toBe("fake/reasoning-pro");

    // sdd-apply: no cost override → cheapest model CAN win (proves the fix
    // is phase-aware, not a blanket cheap-model block).
    const applyProfiles = catalog.byBase["sdd-apply"];
    expect(applyProfiles.length).toBeGreaterThanOrEqual(2);
    expect(applyProfiles[0]!.modelId).toBe("fake/cheap-flash");
  });
});
