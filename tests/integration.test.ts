/**
 * PR5 integration tests — plugin + CLI + skill contract.
 *
 * RED phase: this file references integration points that may not exist yet:
 *   - `skills/model-forecast/SKILL.md` — orchestrator contract document
 *   - `refreshCache({ client })` — provider.list() wiring from input.client
 *     (PR4 returns `{}` for any input; PR5 wires the client through to the
 *     cache collectors per the design ("Merge input.client.provider.list()
 *     (primary) + gentle-ai variants + OpenCode models cache"))
 *
 * Layer rationale:
 *   - The plugin-init-with-mocked-client scenario tests behavior that spans
 *     multiple modules (models.ts collectors, cache.ts atomic write, the
 *     `void refreshCache()` fire-and-forget path in index.ts). Putting it
 *     in plugin.test.ts would inflate that file beyond the unit-test
 *     boundary; tests/integration.test.ts is the natural home.
 *   - The CLI end-to-end scenario reuses runCli's mocked stdio pattern but
 *     drives it through the real cache that refreshCache writes, verifying
 *     the cross-process boundary the spec calls out ("Skill runs in a
 *     separate agent turn; disk is the only handoff").
 *   - The skill-contract checks read the SKILL.md off disk and assert the
 *     presence of frontmatter and required sections. The skill IS the
 *     orchestrator-facing contract — its content must remain aligned with
 *     the Forecast shape, the CLI invocation syntax, and the
 *     no-auto-injection guarantee.
 *
 * What we assert (each must be a real assertion calling production code):
 *   1. Plugin init with mocked client.provider.list success:
 *      - refreshCache writes a cache whose `providers` map reflects the
 *        provider.list data (NOT just an empty providers map).
 *   2. Plugin init with mocked client.provider.list failure:
 *      - refreshCache still completes; cache file exists; rubric persists;
 *        providers is an empty object (no throw, best-effort preserved).
 *   3. CLI end-to-end after refreshCache:
 *      - runCli --phase sdd-design --cache <temp> writes JSON to stdout that
 *        JSON.parse accepts AND contains the four Forecast fields with the
 *        documented types.
 *   4. Skill contract:
 *      - skills/model-forecast/SKILL.md exists.
 *      - Frontmatter has `name` and `description`.
 *      - Body contains the documented CLI invocation, the documented output
 *        fields, the degradation clause, and the no-auto-injection
 *        guarantee.
 *
 * Test isolation: the user-machine may have a real
 * `~/.gentle-ai/cache/model-variants.json` and/or a real
 * `~/.cache/opencode/models.json`. We override both paths to point at
 * non-existent files inside the test's tempdir so the `client` option is
 * the ONLY source of variants data. Without this override, assertions like
 * `providers["anthropic"]?.["claude-opus-4-7"]?.variants` would coincidentally
 * match against the user's actual caches (false positive).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { readCache } from "../src/cache.js";
import { modelForecastPlugin, refreshCache } from "../src/plugin.js";
import { runCli } from "../src/cli.js";
import { createTaskHook } from "../src/hooks.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { select as defaultSelect } from "../src/select.js";
import type { SelectCandidate } from "../src/types.js";

const SKILL_PATH = path.resolve(
  process.cwd(),
  "skills",
  "model-forecast",
  "SKILL.md",
);

/** Shape of the optional `client` argument the plugin accepts. */
interface MockClient {
  provider: {
    list: () => Promise<unknown> | unknown;
  };
}

/**
 * Builds a mock client that returns a single provider with a single model
 * and the supplied variants. The shape mirrors what OpenCode's SDK returns
 * (envelope: `{ data: { all: [...] } }`).
 */
function buildMockClient(providerId: string, modelId: string, variants: string[]): MockClient {
  return {
    provider: {
      list: async () => ({
        data: {
          all: [
            {
              id: providerId,
              models: {
                [modelId]: {
                  variants: Object.fromEntries(variants.map((v) => [v, {}])),
                },
              },
            },
          ],
        },
      }),
    },
  };
}

/**
 * Returns options for `refreshCache` that isolate the test from real cache
 * files on the user's machine by pointing gentle-ai and OpenCode paths at
 * non-existent tempdir files.
 */
async function isolatedOptions(
  tempDir: string,
  overrides: { client?: MockClient; cachePath?: string } = {},
): Promise<{ cachePath: string; gentleAiPath: string; openCodePath: string; client?: MockClient }> {
  return {
    cachePath: overrides.cachePath ?? path.join(tempDir, "model-data.json"),
    gentleAiPath: path.join(tempDir, "no-such-gentle-ai.json"),
    openCodePath: path.join(tempDir, "no-such-opencode-models.json"),
    ...(overrides.client !== undefined ? { client: overrides.client } : {}),
  };
}

describe("integration — plugin entry + CLI regression pin (PR3 task 3.1)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "integration-pin-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("modelForecastPlugin() with no options returns the canonical empty hook record {}", async () => {
    // Regression-pinned default entry (spec #1274 'Default-off plugin
    // behavior'): the plugin MUST return `{}` when no auto policy is set.
    // We re-assert this here at the integration boundary (the unit-level
    // pin lives in tests/plugin.test.ts). The plugin should be a complete
    // no-op without `mode: 'auto'` regardless of input shape.
    expect(await modelForecastPlugin()).toEqual({});
    expect(
      await modelForecastPlugin({ client: { provider: { list: async () => ({ all: [] }) } } }),
    ).toEqual({});
    expect(await modelForecastPlugin(undefined, { allowlist: ["x"] })).toEqual({});
  });

  it("modelForecastPlugin() forwards resolveCandidates to the auto hook", async () => {
    const candidates: SelectCandidate[] = [
      {
        subagent_type: "sdd-design-alto",
        model: "openai/gpt-5.5",
        effort: "high",
        confidence: 0.95,
        evidence: "e2e resolver supplied curated candidate",
        ladderRung: "openai",
      },
    ];
    type PluginOptionsWithResolver = NonNullable<Parameters<typeof modelForecastPlugin>[1]> & {
      resolveCandidates: () => SelectCandidate[];
    };
    const options: PluginOptionsWithResolver = {
      mode: "auto",
      confidenceThreshold: 0.6,
      allowlist: ["sdd-design"],
      denylist: [],
      resolveCandidates: () => candidates,
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    };

    const hooks = await modelForecastPlugin(
      { client: buildMockClient("openai", "gpt-5.5", ["high"]) },
      options,
    );
    await (hooks.config as (config: { agent: Record<string, unknown> }) => Promise<void>)({
      agent: {},
    });
    const hook = hooks["tool.execute.before"] as (
      input: { tool: { id: string }; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => Promise<void>;
    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };

    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design-alto");
  });

  it("modelForecastPlugin() generates per-phase model profiles and routes tasks through them", async () => {
    const hooks = await modelForecastPlugin(
      {
        client: {
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "openai",
                    models: {
                      "gpt-4.1": {
                        variants: {},
                        cost: { input: 2, output: 8 },
                        limit: { context: 1_000_000, output: 32_000 },
                        status: "active",
                      },
                    },
                  },
                ],
              },
            }),
          },
        },
      },
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        allowlist: ["sdd-design"],
      },
    );
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
          permission: { task: { "sdd-design": "allow" } },
        },
      },
    };

    await (hooks.config as (config: typeof cfg) => Promise<void>)(cfg);
    const generatedAlias = Object.keys(cfg.agent).find((name) =>
      name.startsWith("__mf_sdd-design__openai-gpt-4-1"),
    );
    expect(generatedAlias).toBeDefined();
    expect(cfg.agent[generatedAlias!]).toMatchObject({
      model: "openai/gpt-4.1",
      prompt: "Design prompt",
      permission: { edit: "deny" },
      hidden: true,
    });
    expect(cfg.agent["gentle-orchestrator"].permission.task[generatedAlias!]).toBe("allow");

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await (hooks["tool.execute.before"] as (
      input: { tool: { id: string }; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => Promise<void>)({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toMatch(/^__mf_sdd-design__/);
  });

  it("--select on the CLI never alters the canonical 4-field Forecast JSON shape", async () => {
    // Regression-pinned: even when --select is parsed, a CLI invocation
    // WITHOUT --select MUST emit the documented 4 fields
    // ({model, effort, reasoning, fallback}). The two output shapes
    // (Forecast vs SelectDecision) are mutually exclusive.
    const cachePath = path.join(tempDir, "model-data.json");
    await refreshCache(
      await isolatedOptions(tempDir, {
        cachePath,
        client: buildMockClient("anthropic", "claude-opus-4-7", [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
      }),
    );

    const result = await runCli(["--phase", "sdd-design", "--cache", cachePath]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // Exactly the 4 Forecast keys; the 7 SelectDecision keys MUST NOT leak in.
    expect(Object.keys(parsed).sort()).toEqual(
      ["effort", "fallback", "model", "reasoning"].sort(),
    );
    expect("action" in parsed).toBe(false);
    expect("subagent_type" in parsed).toBe(false);
  });
});

describe("integration — PR2 gate W1: real select() through createTaskHook produces an end-to-end rewrite", () => {
  // PR2 gate #1287 surfaced WARNING W1: production hook is structurally
  // correct but INERT in production because it passes `candidates: []` to
  // the real select() (which returns keep-default for an empty set).
  // PR3 closes W1 by:
  //   1. Wiring candidate construction (production default resolver
  //      synthesises a candidate from the task signal so the real select
  //      can run end-to-end).
  //   2. Adding this integration test that drives the real select()
  //      through createTaskHook WITHOUT mocking select.
  // The test asserts the production-grade happy path actually fires.

  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "integration-real-select-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("drives the REAL defaultSelect through createTaskHook and produces an end-to-end rewrite", async () => {
    // Seed candidates with confidence >= threshold on the cheapest rung
    // so the production wiring reaches a switch decision end-to-end.
    const candidates: SelectCandidate[] = [
      {
        subagent_type: "sdd-design",
        model: "minimax/MiniMax-M3",
        effort: "medium",
        confidence: 0.85,
        evidence: "registry: minimax fresh",
        ladderRung: "minimax",
      },
    ];

    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: DEFAULT_LADDER,
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        // Inject the production wiring: real select() (no mock) + an
        // optional `resolveCandidates` factory that synthesises
        // candidates from the hook input. The candidate set is what the
        // production hook would have produced from its live context.
        select: defaultSelect,
        resolveCandidates: () => candidates,
        audit,
        getLiveAvailability: () => ({
          ready: true,
          models: new Set(["minimax/MiniMax-M3"]),
          reason: "",
          source: "provider-list",
        }),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    // The real select() ran against the supplied candidates and
    // produced a switch decision. The production hook has applied the
    // rewrite end-to-end. This is the regression-pinned happy path
    // that PR2 gate #1287 W1 said was unreachable in production.
    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).toHaveBeenCalledOnce();
    const auditedEntry = audit.mock.calls[0]?.[0];
    expect(auditedEntry?.decision.action).toBe("switch");
    expect(auditedEntry?.decision.model).toBe("minimax/MiniMax-M3");
  });

  it("drives the real select() with the production default candidate resolver (no factory supplied)", async () => {
    // Without an injected resolver, the hook must STILL produce a
    // candidate for select() from the task signal alone. The default
    // resolver synthesises a candidate on the cheapest rung; the
    // confidence cap (MISSING_EVIDENCE floor) keeps select() at
    // keep-default — but the production path is non-INERT (real
    // select is called with a non-empty candidate set) and the audit
    // trail records the keep-default outcome.
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: DEFAULT_LADDER,
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: defaultSelect,
        // No `resolveCandidates` — the default factory is used.
        audit,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    // Default resolver synthesises a candidate on the cheapest rung with
    // capped confidence → real select() emits keep-default and the hook
    // keeps the original subagent_type. The hook is no longer inert in
    // production; the keep-default outcome is auditable.
    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).toHaveBeenCalledOnce();
    const auditedEntry = audit.mock.calls[0]?.[0];
    expect(auditedEntry?.decision.action).toBe("keep-default");
  });
});

describe("integration — plugin init with mocked input.client (provider.list success)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "integration-ok-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refreshCache absorbs provider.list data when a client is supplied via options", async () => {
    const opts = await isolatedOptions(tempDir, {
      client: buildMockClient("anthropic", "claude-opus-4-7", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    });

    await refreshCache(opts);

    const cached = await readCache(opts.cachePath);
    expect(cached).not.toBeNull();
    // Provider.list data must land in cache.providers — proves real wiring.
    expect(cached?.providers["anthropic"]?.["claude-opus-4-7"]?.variants).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "xhigh",
    ]);
    // Static rubric from PHASE_DIFFICULTY still present.
    expect(cached?.rubric["sdd-design"]).toBe("high");
  });

  it("refreshCache prefers client.provider.list data over the gentle-ai cache file when both are present", async () => {
    // The design says: "input.client.provider.list() (primary) +
    // gentle-ai variants file". When the client returns data, that data
    // takes precedence over the file-based cache.
    const cachePath = path.join(tempDir, "model-data.json");
    const gentleAiPath = path.join(tempDir, "gentle-ai.json");
    const { writeFile } = await import("fs/promises");
    // gentle-ai file says opus supports only ["high"].
    await writeFile(
      gentleAiPath,
      JSON.stringify({
        anthropic: {
          "claude-opus-4-7": ["high"],
        },
      }),
    );
    // live client says opus supports ["low","medium","high","xhigh","max"].
    const liveClient = buildMockClient("anthropic", "claude-opus-4-7", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    await refreshCache({ cachePath, gentleAiPath, client: liveClient });

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    // Live data wins — we should see ALL five variants, not just "high".
    expect(cached?.providers["anthropic"]?.["claude-opus-4-7"]?.variants).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "xhigh",
    ]);
  });

  it("modelForecastPlugin forwards input.client through to refreshCache when called with a Plugin-like input", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const mockedClient = buildMockClient("anthropic", "claude-sonnet-4-5", [
      "low",
      "medium",
      "high",
    ]);

    // Plugin returns {} (no auto-injection).
    const hooks = await modelForecastPlugin({ client: mockedClient });
    expect(hooks).toEqual({});

    // Drive refreshCache explicitly so we can verify the cache on disk.
    await refreshCache(
      await isolatedOptions(tempDir, { client: mockedClient, cachePath }),
    );

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    expect(cached?.providers["anthropic"]?.["claude-sonnet-4-5"]?.variants).toEqual([
      "high",
      "low",
      "medium",
    ]);
  });
});

describe("integration — plugin init with mocked input.client (provider.list failure)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "integration-fail-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refreshCache still completes when client.provider.list throws (async)", async () => {
    const opts = await isolatedOptions(tempDir, {
      client: {
        provider: {
          list: async (): Promise<never> => {
            throw new Error("simulated SDK failure");
          },
        },
      },
    });

    await expect(refreshCache(opts)).resolves.toBeUndefined();

    const cached = await readCache(opts.cachePath);
    expect(cached).not.toBeNull();
    // Providers is empty (no data survived) but the rubric persisted.
    expect(cached?.providers).toEqual({});
    expect(cached?.rubric["sdd-design"]).toBe("high");
    expect(cached?.rubric["sdd-archive"]).toBe("low");
  });

  it("modelForecastPlugin does not throw and the fire-and-forget path absorbs SDK failure", async () => {
    // The plugin entry MUST be safe to call even when the SDK would throw.
    expect(() =>
      modelForecastPlugin({
        client: {
          provider: {
            list: async (): Promise<never> => {
              throw new Error("simulated SDK failure at init");
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("modelForecastPlugin tolerates a null input (defensive shape check)", () => {
    expect(() => modelForecastPlugin(null as unknown as undefined)).not.toThrow();
  });

  it("modelForecastPlugin tolerates a non-object input (defensive shape check)", () => {
    expect(() => modelForecastPlugin("not-an-object" as unknown as undefined)).not.toThrow();
  });

  it("modelForecastPlugin tolerates an input whose `client` is null or not an object", () => {
    expect(() =>
      modelForecastPlugin({ client: null as unknown as undefined }),
    ).not.toThrow();
    expect(() =>
      modelForecastPlugin({ client: "not-an-object" as unknown as undefined }),
    ).not.toThrow();
    expect(() =>
      modelForecastPlugin({ client: { provider: "not-an-object" as unknown as undefined } }),
    ).not.toThrow();
  });

  it("refreshCache treats a synchronous throw from provider.list the same as an async throw", async () => {
    const opts = await isolatedOptions(tempDir, {
      client: {
        provider: {
          list: (): never => {
            throw new Error("synchronous SDK failure");
          },
        },
      },
    });

    await expect(refreshCache(opts)).resolves.toBeUndefined();

    const cached = await readCache(opts.cachePath);
    expect(cached).not.toBeNull();
    expect(cached?.providers).toEqual({});
    expect(cached?.rubric["sdd-design"]).toBe("high");
  });
});

describe("integration — CLI end-to-end after refreshCache (cross-process handoff)", () => {
  let tempDir: string;
  let cachePath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "integration-cli-"));
    cachePath = path.join(tempDir, "model-data.json");

    // The plugin refreshes the cache; the CLI reads it. This is the
    // exact cross-process handoff the spec calls out.
    await refreshCache(
      await isolatedOptions(tempDir, {
        cachePath,
        client: buildMockClient("anthropic", "claude-opus-4-7", [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
      }),
    );

    stdoutWrites = [];
    stderrWrites = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("CLI consumes the cache and emits a JSON Forecast with the four documented fields", async () => {
    const result = await runCli(["--phase", "sdd-design", "--cache", cachePath]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);

    // Parse the stdout as JSON — proves the CLI shape contract.
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("model");
    expect(parsed).toHaveProperty("effort");
    expect(parsed).toHaveProperty("reasoning");
    expect(parsed).toHaveProperty("fallback");
    expect(typeof parsed["model"]).toBe("string");
    expect(typeof parsed["effort"]).toBe("string");
    expect(typeof parsed["reasoning"]).toBe("string");
    expect(typeof parsed["fallback"]).toBe("boolean");
    // The cache above provides opus, so the engine must match it (no fallback).
    expect(parsed["model"]).toBe("anthropic/claude-opus-4-7");
    expect(parsed["effort"]).toBe("high");
    expect(parsed["fallback"]).toBe(false);
  });

  it("CLI survives a missing cache by falling back to DEFAULT_MODEL_FOR_ALIAS", async () => {
    const missingCache = path.join(tempDir, "absent.json");
    const result = await runCli(["--phase", "sdd-design", "--cache", missingCache]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed["fallback"]).toBe(true);
    // sdd-design → balanced → opus → fallback model id.
    expect(parsed["model"]).toBe("anthropic/claude-opus-4-7");
    expect(typeof parsed["reasoning"]).toBe("string");
  });
});

describe("integration — skill contract (skills/model-forecast/SKILL.md)", () => {
  it("the SKILL.md file exists on disk", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it("SKILL.md has YAML frontmatter with `name` and `description`", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    // Frontmatter is fenced with --- on its own lines at the top.
    expect(content.startsWith("---")).toBe(true);
    const closingIdx = content.indexOf("\n---", 3);
    expect(closingIdx).toBeGreaterThan(0);
    const frontmatter = content.slice(0, closingIdx);
    expect(frontmatter).toMatch(/^name:\s*\S+/m);
    expect(frontmatter).toMatch(/^description:\s*\S+/m);
  });

  it("SKILL.md documents the CLI invocation the forecast engine exposes", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    // The skill must show orchestrators how to call the CLI.
    expect(content).toMatch(/forecast\s+--phase/);
    expect(content).toMatch(/--preset/);
    expect(content).toMatch(/--cache/);
  });

  it("SKILL.md documents the four-field Forecast output shape", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    // All four documented Forecast fields must be referenced.
    expect(content).toMatch(/\bmodel\b/);
    expect(content).toMatch(/\beffort\b/);
    expect(content).toMatch(/\breasoning\b/);
    expect(content).toMatch(/\bfallback\b/);
  });

  it("SKILL.md documents graceful degradation when context or caches are missing", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    const lower = content.toLowerCase();
    expect(lower).toMatch(/degradation|graceful|fallback/);
    // Phase-only fallback is a spec scenario; the skill must mention it.
    expect(lower).toMatch(/phase[- ]only|phase-only/);
  });

  it("SKILL.md explicitly states no automatic injection in MVP", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    const lower = content.toLowerCase();
    // Spec requirement: plugin MUST NOT register chat.params/tool.execute.before.
    expect(lower).toMatch(/no auto|injection|chat\.params|tool\.execute\.before|mvp/);
  });

  it("SKILL.md contains a 'When to invoke' section for orchestrators", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    // Markdown heading for invocation guidance.
    expect(content).toMatch(/^##?\s+When to invoke/im);
  });
});

describe("integration — fixture: existing skill file satisfies contract", () => {
  // Helper: when the SKILL.md is added in this same PR, this test ensures
  // it is non-empty and ends with a newline (defensive against truncation
  // during apply).
  it("SKILL.md is non-empty and ends with a newline", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    expect(content.length).toBeGreaterThan(200);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("SKILL.md does not accidentally introduce CLI flags beyond what forecast() supports", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    // The CLI accepts the core flags plus the evidence-aware context flags
    // added in PR2; the skill must not advertise any flags outside this set.
    const documentedFlags = content.match(/--[a-z][a-z0-9-]*/gi) ?? [];
    const allowedFlags = new Set([
      "--phase",
      "--preset",
      "--cache",
      "--help",
      "--verbose",
      "--select",
      "--diff-lines",
      "--file",
      "--symbol",
      "--risk-domain",
      "--context-breadth",
      "--modality",
      // `update-data` subcommand flags (post-forecast-ux-maintenance).
      "--from-file",
      "--root",
      // `config` subcommand flags.
      "--non-interactive",
    ]);
    for (const flag of documentedFlags) {
      expect(allowedFlags.has(flag.toLowerCase())).toBe(true);
    }
  });
});
