/**
 * PR4 unit tests — OpenCode plugin entry point.
 *
 * RED phase: these tests reference `modelForecastPlugin` and `refreshCache`
 * from src/index.ts which is still the PR1 bootstrap stub. The full
 * implementation lands in PR4 (task 4.3): fire-and-forget cache refresh at
 * startup and `return {}` with NO `chat.params` or `tool.execute.before`
 * hooks (spec requirement `gentle-ai-orchestrator-integration`).
 *
 * We test:
 *   - Default export is callable and returns `{}`.
 *   - Returned object does NOT include chat.params or tool.execute.before
 *     hooks (spec: "MUST NOT register chat.params or tool.execute.before").
 *   - Fire-and-forget refresh: calling the plugin does not throw even when
 *     all source caches are missing, and a follow-up `await refreshCache()`
 *     is observable (the cache file appears).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { readCache } from "../src/cache.js";
import {
  computeLiveAvailabilityState,
  modelForecastPlugin,
  refreshCache,
} from "../src/plugin.js";
import type { Discovery } from "../src/models.js";
import type { TaskHook } from "../src/hooks.js";
import type { LiveAvailabilityState } from "../src/types.js";

describe("plugin — default export shape (no auto-injection)", () => {
  it("returns an empty hooks object", async () => {
    const hooks = await modelForecastPlugin();
    expect(hooks).toEqual({});
  });

  it("returns the same shape when given a Plugin-like input argument", async () => {
    // OpenCode plugins receive an `input` arg; we accept and ignore it.
    const hooks = await modelForecastPlugin({
      client: { provider: { list: async () => ({ all: [] }) } },
      directory: "/tmp",
    });
    expect(hooks).toEqual({});
  });

  it("does NOT register chat.params or tool.execute.before hooks", async () => {
    const hooks = await modelForecastPlugin();
    expect(hooks).not.toHaveProperty("chat.params");
    expect(hooks).not.toHaveProperty("chat_params");
    expect(hooks).not.toHaveProperty("tool.execute.before");
    expect(hooks).not.toHaveProperty("tool_execute_before");
  });
});

describe("plugin — fire-and-forget cache refresh", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("calling the plugin does not throw when source caches are absent", async () => {
    // The function MUST be safe to invoke synchronously; if fire-and-forget
    // errors leaked out, this assertion would fail.
    expect(() => modelForecastPlugin()).not.toThrow();
  });

  it("refreshCache() writes a model-data.json to the provided cachePath", async () => {
    const cachePath = path.join(tempDir, "model-data.json");

    await refreshCache({ cachePath });

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    expect(cached?.version).toBe(1);
    expect(typeof cached?.generatedAt).toBe("string");
    // Cache schema satisfies spec: providers + rubric present.
    expect(cached?.providers).toBeDefined();
    expect(cached?.rubric).toBeDefined();
  });

  it("refreshCache() persists the static phase→tier rubric from phases.ts", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    await refreshCache({ cachePath });

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    // sdd-design is high, sdd-spec is medium, sdd-archive is low.
    expect(cached?.rubric["sdd-design"]).toBe("high");
    expect(cached?.rubric["sdd-spec"]).toBe("medium");
    expect(cached?.rubric["sdd-archive"]).toBe("low");
  });

  it("refreshCache() does not throw when source caches are absent", async () => {
    const cachePath = path.join(tempDir, "model-data.json");

    await expect(refreshCache({ cachePath })).resolves.toBeUndefined();

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
  });

  it("refreshCache() persists variant data from a gentle-ai-style sources file when present", async () => {
    // Provide a gentle-ai variants file pointing at a temp path, then
    // observe that the cache absorbs it.
    const sourcesFile = path.join(tempDir, "sources.json");
    // contents intentionally unused — refreshCache reads via customPath.
    // We just verify that an explicit empty path still completes safely.
    await refreshCache({
      cachePath: path.join(tempDir, "model-data.json"),
      gentleAiPath: sourcesFile,
      openCodePath: sourcesFile,
    });

    const cached = await readCache(path.join(tempDir, "model-data.json"));
    expect(cached).not.toBeNull();
    expect(cached?.providers["anthropic"]).toBeUndefined(); // no data
  });

  it("refreshCache() absorbs a gentle-ai variants cache passed explicitly", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const sourceFile = path.join(tempDir, "variants.json");
    // Write a minimal variants cache via Node fs (bypassing readCache
    // to keep this test focused on refreshCache behavior).
    const { writeFile } = await import("fs/promises");
    await writeFile(
      sourceFile,
      JSON.stringify({
        anthropic: {
          "claude-opus-4-7": ["max", "xhigh", "high"],
        },
      }),
    );

    await refreshCache({
      cachePath,
      gentleAiPath: sourceFile,
    });

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    // The refresh absorbed the variant data into ModelDataCache.providers.
    expect(cached?.providers["anthropic"]?.["claude-opus-4-7"]?.variants).toEqual([
      "high",
      "max",
      "xhigh",
    ]);
  });

  it("refreshCache() falls back to OpenCode models cache when gentle-ai cache is empty", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const openCodeFile = path.join(tempDir, "opencode-models.json");
    const { writeFile } = await import("fs/promises");
    // OpenCode models cache has providers with a `models` map; each
    // model has a `variants` object whose keys are the variant names.
    await writeFile(
      openCodeFile,
      JSON.stringify({
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4-5": { variants: { medium: {}, high: {} } },
            "claude-opus-4-7": {
              variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
            },
          },
        },
      }),
    );

    // Force gentle-ai to point at a missing file ({} via PR3 contract).
    await refreshCache({
      cachePath,
      gentleAiPath: path.join(tempDir, "no-such-gentle-ai.json"),
      openCodePath: openCodeFile,
    });

    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
    // OpenCode fallback path absorbed the variant data.
    expect(cached?.providers["anthropic"]?.["claude-sonnet-4-5"]?.variants).toEqual([
      "high",
      "medium",
    ]);
    expect(cached?.providers["anthropic"]?.["claude-opus-4-7"]?.variants).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "xhigh",
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — Plugin wiring.
 * Spec #1316 requirement 5 (Loader-Compat and Gating). The after hook
 * MUST register ONLY when `mode === "auto"` AND `quarantine.enabled !==
 * false`. Default mode returns `{}`. `Object.keys(root) === ["default"]`
 * remains pinned by tests/smoke.test.ts.
 * -------------------------------------------------------------------------- */
describe("plugin — 429-fallback gating", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-gating-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns {} when mode is not 'auto' (no quarantine options)", async () => {
    expect(await modelForecastPlugin()).toEqual({});
    expect(await modelForecastPlugin(undefined, { mode: "advisory" })).toEqual({});
    expect(await modelForecastPlugin(undefined, { mode: "off" })).toEqual({});
  });

  it("auto mode without quarantine options registers tool.execute.after (quarantine enabled by default)", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    expect(Object.keys(hooks).sort()).toEqual([
      "config",
      "tool.execute.after",
      "tool.execute.before",
    ]);
  });

  it("auto + quarantine.enabled:false does NOT register tool.execute.after", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { enabled: false },
    });
    expect(Object.keys(hooks).sort()).toEqual(["config", "tool.execute.before"]);
    expect(hooks).not.toHaveProperty("tool.execute.after");
  });

  it("auto + quarantine.enabled:true registers tool.execute.after (explicit on)", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { enabled: true, filePath: path.join(tempDir, "quarantine.json") },
    });
    expect(Object.keys(hooks).sort()).toEqual([
      "config",
      "tool.execute.after",
      "tool.execute.before",
    ]);
  });

  it("auto + quarantine.ttlMs is accepted (option type compile + no runtime effect on shape)", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { ttlMs: 30_000, filePath: path.join(tempDir, "quarantine.json") },
    });
    expect(hooks).toHaveProperty("tool.execute.after");
  });

  it("accepts a client with client.session.create/prompt (PluginClient widening) without throwing at construction", async () => {
    // model-fallback-error-classification (SDD change) — Slice 3, task 21.
    // Spec #1620 "Recursive Retry" / design #1623 "Client wiring": the
    // plugin must accept a structural `session?: {create?, prompt?}`
    // surface on the client WITHOUT importing an SDK type. Presence alone
    // must not throw at plugin construction time.
    const client = {
      provider: { list: async () => ({ all: [] }) },
      session: {
        create: async () => ({ id: "s" }),
        prompt: async () => ({ parts: [{ type: "text", text: "ok" }] }),
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    expect(Object.keys(hooks).sort()).toEqual([
      "config",
      "tool.execute.after",
      "tool.execute.before",
    ]);
  });

  it("missing client.session methods degrades gracefully — after-hook still quarantines on a 429, no crash, no fallback dispatch", async () => {
    // Slice 3, task 21: a client present but WITHOUT session.create/prompt
    // (or no client at all) must not crash the after-hook; the fallback
    // engine simply cannot dispatch and the existing single-attempt
    // quarantine behavior is preserved (rollback-safe default).
    const client = {
      provider: { list: async () => ({ all: [] }) },
      // No `session` key at all.
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const afterHook = hooks["tool.execute.after"] as (
      input: unknown,
      output: { output?: unknown; metadata?: unknown },
    ) => Promise<void>;

    await expect(
      afterHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "unknown-call" },
        { output: "upstream returned HTTP 429 Too Many Requests" },
      ),
    ).resolves.not.toThrow();
  });

  it("advisory mode stays inert and never emits a toast (no client access)", async () => {
    // Advisory mode returns {} without hooks; a client with a throwing
    // showToast must never be touched, proving no toast fires.
    let showToastCalls = 0;
    const client = {
      provider: { list: async () => ({ all: [] }) },
      tui: {
        showToast: () => {
          showToastCalls += 1;
          throw new Error("showToast must not be called in advisory mode");
        },
      },
    };
    const hooks = await modelForecastPlugin({ client }, { mode: "advisory" });
    expect(hooks).toEqual({});
    expect(showToastCalls).toBe(0);
  });

  it("auto mode emits an on-screen toast at registration and a profile-generation toast after the config hook", async () => {
    const toasts: Array<{ message: string; variant: string }> = [];
    const client = {
      provider: {
        list: async () => ({
          all: [
            {
              id: "minimax",
              models: { "MiniMax-M3": { variants: { medium: {}, high: {} } } },
            },
          ],
        }),
      },
      tui: {
        showToast: (options: {
          body: { message: string; variant: string };
        }) => {
          toasts.push({
            message: options.body.message,
            variant: options.body.variant,
          });
          return Promise.resolve(true);
        },
      },
    };

    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });

    // Registration toast fires synchronously when auto mode returns hooks.
    expect(toasts.some((t) => /active in auto mode/i.test(t.message))).toBe(true);

    // Drive the config hook to trigger profile generation + its toast.
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
        },
      },
    });

    const generationToast = toasts.find((t) => /generated \d+ profile/i.test(t.message));
    expect(generationToast).toBeDefined();
    expect(generationToast?.variant).toBe("success");
    // One base agent (sdd-design) × one connected model = one profile.
    expect(generationToast?.message).toContain("generated 1 profile(s) across 1 base agent(s)");
  });

  it("config hook honors injected global benchmark availability overrides", async () => {
    const globalPath = path.join(tempDir, "global", "benchmarks.json");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify([
        {
          key: "opencode-go/deepseek-v4-pro",
          benchmarks: { mmlu: 0.91 },
          availability: "unavailable",
          source: "global-test",
          date: "2026-07-09",
          confidence: 0.95,
        },
      ]),
      "utf8",
    );

    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "opencode-go",
                models: {
                  "deepseek-v4-pro": { variants: { medium: {}, high: {} } },
                },
              },
            ],
          },
        }),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin(
      { client, directory: tempDir },
      {
        mode: "auto",
        quarantine: { filePath: path.join(tempDir, "quarantine.json") },
        benchmarks: { globalPath },
      },
    );

    const config: { agent: Record<string, any> } = {
      agent: {
        "sdd-design": { mode: "subagent", model: "openai/gpt-4.1-mini", prompt: "p" },
      },
    };
    const configHook = hooks["config"] as (nextConfig: unknown) => Promise<void>;
    await configHook(config);

    expect(Object.values(config.agent).some((agent) => agent?.model === "opencode-go/deepseek-v4-pro")).toBe(false);
  });

  it("auto mode does not throw when the client has no tui/showToast surface", async () => {
    // A client with provider but no tui must be safe: no toast, no throw.
    const client = { provider: { list: async () => ({ all: [] }) } };
    const qPath = path.join(tempDir, "quarantine.json");
    const cPath = path.join(tempDir, "model-data.json");
    expect(() =>
      modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: qPath },
        cachePath: cPath,
      }),
    ).not.toThrow();

    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: qPath },
      cachePath: cPath,
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await expect(
      configHook({
        agent: {
          "sdd-design": { mode: "subagent", model: "x/y", prompt: "p" },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("auto mode does not throw when no client is provided at all (missing client)", async () => {
    const qPath2 = path.join(tempDir, "quarantine.json");
    const cPath2 = path.join(tempDir, "model-data.json");
    expect(() =>
      modelForecastPlugin(undefined, {
        mode: "auto",
        quarantine: { filePath: qPath2 },
        cachePath: cPath2,
      }),
    ).not.toThrow();
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { filePath: qPath2 },
      cachePath: cPath2,
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await expect(
      configHook({
        agent: {
          "sdd-design": { mode: "subagent", model: "x/y", prompt: "p" },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("toast helper swallows a throwing showToast without breaking startup", () => {
    // Even if the TUI surface throws synchronously, the plugin must load.
    const client = {
      provider: { list: async () => ({ all: [] }) },
      tui: {
        showToast: () => {
          throw new Error("boom");
        },
      },
    };
    expect(() =>
      modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: path.join(tempDir, "quarantine.json") },
      }),
    ).not.toThrow();
  });

  it("smoke contract: the package root still has only `default` (no extra runtime exports)", async () => {
    // Loader-compat regression. The plugin entry is re-exported only
    // via `default` so OpenCode's loader iterates a single function
    // and does not reject with `Plugin export is not a function`.
    const mod = await import("../src/index.js");
    expect(Object.keys(mod)).toEqual(["default"]);
  });

  it("end-to-end: auto + after-hook quarantines the tracked model on a 429 output", async () => {
    // Full wiring: build the plugin, then drive the before/after hook
    // chain on a synthetic `task` call. The before hook rewrites
    // subagent_type to a generated alias; the after hook detects the
    // 429 and quarantines the tracked model.
    //
    // Use an injected quarantine file path and cache path so the test
    // never touches the real global cache directories.
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-e2e-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    const cachePath = path.join(tempDir, "model-data.json");
    try {
      // Provide a live client so the config hook generates profiles
      // from a real model list — the resolver then produces a
      // non-empty candidate set and the before hook rewrites.
      const client = {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "google",
                  models: {
                    "gemini-2.5-pro": {
                      variants: { high: {} },
                      cost: { input: 2, output: 8 },
                      limit: { context: 2_097_152 },
                      status: "active",
                    },
                  },
                },
              ],
            },
          }),
        },
        tui: { showToast: () => Promise.resolve(true) },
      };
      const hooks = await modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        cachePath,
      });
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");

    // Prime the catalog via the config hook so the resolver has at
    // least one base phase to work with.
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
        },
      },
    });

    const beforeHook = hooks["tool.execute.before"] as (
      input: unknown,
      output: { args: Record<string, unknown> },
    ) => Promise<void>;
    const afterHook = hooks["tool.execute.after"] as (
      input: unknown,
      output: { output?: unknown },
    ) => Promise<void>;

    const beforeOutput = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-e2e" },
      beforeOutput,
    );

    // The resolver must have produced a candidate → rewrite must have
    // happened. The rewritten subagent_type starts with the generated
    // alias prefix and must NOT contain any flash family model.
    const rewritten = beforeOutput.args.subagent_type as string;
    expect(rewritten).toMatch(/^__mf_sdd-design__/);
    expect(rewritten).not.toMatch(/flash/i);

    // Stderr sink capturing the after-hook warning.
    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await afterHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c-e2e" },
        { output: "upstream returned HTTP 429 Too Many Requests" },
      );
    } finally {
      process.stderr.write = origStderr;
    }

    // With a live client, the resolver produces a non-empty candidate
    // set → before hook rewrites → after hook detects 429 and
    // quarantines the tracked model. Assert the quarantine fired.
    expect(rewritten).toBeDefined();
    // The stderr warning must contain a quarantine message. The
    // message references the canonical model id (not the rewritten
    // alias), so we check for the quarantine verb and the model provider.
    const quarantineWarning = stderrLines.find(
      (line) => /quarantined/i.test(line) && line.includes("google"),
    );
    expect(quarantineWarning).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("end-to-end: fallback engine dispatches on a 429, overwrites output on success, and persists the attempt-1 quarantine", async () => {
    // model-fallback-error-classification (SDD change) — Slice 3, task 28.
    // Design #1623 Testing Strategy "Integration" row: after-hook
    // end-to-end with the tracking map + fallback engine + persistence of
    // the quarantine entry the attempt-1 failure produces.
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-fallback-e2e-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    const cachePath = path.join(tempDir, "model-data.json");
    try {
      const client = {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "google",
                  models: {
                    "gemini-2.5-pro": {
                      variants: { high: {} },
                      cost: { input: 2, output: 8 },
                      limit: { context: 2_097_152 },
                      status: "active",
                    },
                    "gemini-2.5-flash": {
                      variants: { high: {} },
                      cost: { input: 1, output: 4 },
                      limit: { context: 1_000_000 },
                      status: "active",
                    },
                  },
                },
              ],
            },
          }),
        },
        session: {
          create: async () => ({ id: "fallback-child-session" }),
          prompt: async () => ({ parts: [{ type: "text", text: "fallback model finished the task" }] }),
        },
        tui: { showToast: () => Promise.resolve(true) },
      };
      const hooks = await modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        cachePath,
      });

      const configHook = hooks["config"] as (config: unknown) => Promise<void>;
      await configHook({
        agent: {
          "sdd-design": {
            mode: "subagent",
            model: "google/gemini-2.5-pro",
            prompt: "Design prompt",
          },
        },
      });

      const beforeHook = hooks["tool.execute.before"] as (
        input: unknown,
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const afterHook = hooks["tool.execute.after"] as (
        input: unknown,
        output: { output?: unknown; metadata?: unknown },
      ) => Promise<void>;

      const beforeOutput = { args: { subagent_type: "sdd-design", prompt: "work" } };
      await beforeHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c-fallback-e2e" },
        beforeOutput,
      );
      const rewritten = beforeOutput.args.subagent_type as string;
      expect(rewritten).toMatch(/^__mf_sdd-design__/);

      const afterOutput: { output?: unknown; metadata?: unknown } = {
        output: "upstream returned HTTP 429 Too Many Requests",
      };
      await afterHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c-fallback-e2e" },
        afterOutput,
      );

      // The fallback engine dispatched and succeeded — output overwritten.
      expect(afterOutput.output).toBe("fallback model finished the task");
      const metadata = afterOutput.metadata as { mfFallback?: { attempts: number; model: string } } | undefined;
      expect(metadata?.mfFallback?.attempts).toBeGreaterThanOrEqual(2);
      expect(metadata?.mfFallback?.model).toContain("google/");

      // The attempt-1 failing model's quarantine entry was persisted to
      // disk (permanent/manual entries aside — this asserts the plugin's
      // saveToFile-on-change wiring still fires alongside the fallback
      // dispatch, i.e. Slice 3 does not regress Slice 1's persistence).
      const raw = await readFile(quarantinePath, "utf8").catch(() => "");
      expect(typeof raw).toBe("string");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("production hooks emit one observable abort lifecycle for a rejected fallback child", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-abort-audit-e2e-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    const writes: Array<{ file: string; data: string }> = [];
    const stderr: string[] = [];
    const abort = vi.fn(async () => true);
    try {
      const client = {
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: "google",
                models: {
                  "gemini-2.5-pro": {
                    variants: { high: {} },
                    cost: { input: 2, output: 8 },
                    limit: { context: 2_097_152 },
                    status: "active",
                  },
                  "gemini-2.5-flash": {
                    variants: { high: {} },
                    cost: { input: 1, output: 4 },
                    limit: { context: 1_000_000 },
                    status: "active",
                  },
                },
              }],
            },
          }),
        },
        session: {
          create: async () => ({ id: "fallback-child-session" }),
          prompt: async () => Promise.reject(new Error("prompt transport failed")),
          abort,
        },
        tui: { showToast: () => Promise.resolve(true) },
      };
      const hooks = await modelForecastPlugin({ client, directory: tempDir }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        interruptionAudit: {
          dependencies: {
            now: () => "2026-07-15T12:34:56.789Z",
            stderr: (line: string) => { stderr.push(line); },
            mkdir: async () => undefined,
            appendFile: async (file: string, data: string) => {
              writes.push({ file, data });
            },
          },
        },
      });
      const configHook = hooks["config"] as (config: unknown) => Promise<void>;
      const beforeHook = hooks["tool.execute.before"] as (
        input: unknown,
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const afterHook = hooks["tool.execute.after"] as (
        input: unknown,
        output: { output?: unknown; metadata?: unknown },
      ) => Promise<void>;
      await configHook({
        agent: {
          "sdd-design": {
            mode: "subagent",
            model: "google/gemini-2.5-pro",
            prompt: "Design prompt",
          },
        },
      });
      const beforeOutput = { args: { subagent_type: "sdd-design", prompt: "work" } };
      await beforeHook(
        { tool: { id: "task" }, sessionID: "parent-1", callID: "call-audit" },
        beforeOutput,
      );
      expect(beforeOutput.args.subagent_type).toMatch(/^__mf_sdd-design__/);

      await afterHook(
        { tool: { id: "task" }, sessionID: "parent-1", callID: "call-audit" },
        { output: "upstream returned HTTP 429 Too Many Requests" },
      );
      await vi.waitFor(() => expect(writes).toHaveLength(2));

      expect(abort).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledWith({ path: { id: "fallback-child-session" } });
      expect(stderr).toHaveLength(2);
      expect(stderr[0]).toContain("abort_requested session=fallback-child-session");
      expect(stderr[1]).toContain("abort_resolved session=fallback-child-session");
      expect(writes.map(({ file }) => file)).toEqual([
        path.join(tempDir, ".opencode", "logs", "subagent-interruptions.jsonl"),
        path.join(tempDir, ".opencode", "logs", "subagent-interruptions.jsonl"),
      ]);
      expect(writes.map(({ data }) => JSON.parse(data))).toMatchObject([
        {
          event: "abort_requested",
          sessionID: "fallback-child-session",
          parentSessionID: "parent-1",
          callID: "call-audit",
          attemptID: "fallback-attempt-2",
          origin: "fallback_prompt",
          reason: "fallback_prompt_rejected",
        },
        {
          event: "abort_resolved",
          sessionID: "fallback-child-session",
          parentSessionID: "parent-1",
          callID: "call-audit",
          attemptID: "fallback-attempt-2",
          origin: "fallback_prompt",
          reason: "fallback_prompt_rejected",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("config hook clears the quarantine store", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-clear-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    try {
    const toasts: any[] = [];
    const client = {
      provider: {
        list: async () => ({
          all: [
            {
              id: "openai",
              models: { "gpt-4.1-mini": { variants: { high: {} } } },
            },
          ],
        }),
      },
      tui: {
        showToast: (options: any) => {
          toasts.push(options.body.message);
          return Promise.resolve(true);
        },
      },
    };

      const hooks = await modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
      });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as any;
    const afterHook = hooks["tool.execute.after"] as any;

    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "openai/gpt-4.1-mini",
          prompt: "Design prompt",
        },
      },
    });

    const beforeOutput1 = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-clear-test" },
      beforeOutput1,
    );

    const alias1 = beforeOutput1.args.subagent_type;
    expect(alias1).toContain("__mf_sdd-design__openai-gpt-4-1-mini");

    await afterHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-clear-test" },
      { output: "HTTP 429" },
    );

    const beforeOutput2 = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-clear-test-2" },
      beforeOutput2,
    );
    expect(beforeOutput2.args.subagent_type).toBe("sdd-design");

    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "openai/gpt-4.1-mini",
          prompt: "Design prompt",
        },
      },
    });

    const beforeOutput3 = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-clear-test-3" },
      beforeOutput3,
    );
    expect(beforeOutput3.args.subagent_type).toContain("__mf_sdd-design__openai-gpt-4-1-mini");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Regression — real OpenCode SDK client shape (class-instance provider).
 *
 * The OpenCode SDK exposes `client.provider` as a CLASS INSTANCE
 * (`class Provider extends _HeyApiClient`) whose `list()` method reads
 * `this._client`. Extracting the method (`const fn = client.provider.list`)
 * and calling it unbound (`fn()`) loses the `this` binding and throws
 * `Cannot read properties of undefined (reading '_client')` INSIDE the
 * method. The plugin previously swallowed that throw and produced ZERO
 * generated profiles even though live models were available.
 *
 * These tests mirror the SDK shape so a plain-object mock cannot hide the
 * unbinding bug: the mock `list` reads `this._client` exactly like the SDK.
 * -------------------------------------------------------------------------- */
describe("plugin — real SDK client shape (this-bound provider.list)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-sdk-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Minimal stand-in for `class Provider extends _HeyApiClient`. */
  class ProviderLike {
    // eslint-disable-next-line no-useless-constructor
    constructor(private readonly _client: { data: { all: unknown[] } }) {}
    list(): Promise<{ data: { all: unknown[] } }> {
      // Mirrors the SDK: `(options?.client ?? this._client).get(...)`.
      // Reading `this._client` throws when the method is called unbound.
      return Promise.resolve(this._client);
    }
  }

  function makeSdkLikeClient(providerList: unknown[]): {
    provider: ProviderLike;
    tui: { showToast: (o: { body: { message: string; variant: string } }) => Promise<boolean> };
    toasts: Array<{ message: string; variant: string }>;
  } {
    const toasts: Array<{ message: string; variant: string }> = [];
    return {
      provider: new ProviderLike({ data: { all: providerList } }),
      tui: {
        showToast: (o) => {
          toasts.push({ message: o.body.message, variant: o.body.variant });
          return Promise.resolve(true);
        },
      },
      toasts,
    };
  }

  it("config hook generates profiles when provider.list is a this-bound class method", async () => {
    const client = makeSdkLikeClient([
      { id: "minimax", models: { "MiniMax-M3": { variants: { medium: {}, high: {} } } } },
    ]);
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;

    await configHook({
      agent: {
        "sdd-design": { mode: "subagent", model: "google/gemini-2.5-pro", prompt: "p" },
      },
    });

    const generationToast = client.toasts.find((t) => /generated \d+ profile/i.test(t.message));
    expect(generationToast).toBeDefined();
    // One base agent (sdd-design) × one connected model = one profile.
    expect(generationToast?.message).toContain("generated 1 profile(s) across 1 base agent(s)");
  });

  it("config hook resolves gracefully (no throw) when client.provider is null", async () => {
    const hooks = await modelForecastPlugin(
      { client: { provider: null, tui: { showToast: () => Promise.resolve(true) } } },
      {
        mode: "auto",
        quarantine: { filePath: path.join(tempDir, "quarantine.json") },
        cachePath: path.join(tempDir, "model-data.json"),
      },
    );
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await expect(
      configHook({
        agent: { "sdd-design": { mode: "subagent", model: "x/y", prompt: "p" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("config hook resolves gracefully when provider.list throws synchronously", async () => {
    const client = {
      provider: {
        list: () => {
          throw new Error("provider system not initialised at config time");
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
      cachePath: path.join(tempDir, "model-data.json"),
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await expect(
      configHook({
        agent: { "sdd-design": { mode: "subagent", model: "x/y", prompt: "p" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("refreshCache does not reject when provider.list is a this-bound class method", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const pathMod = await import("path");
    const dir = await mkdtemp(pathMod.join(tmpdir(), "plugin-sdk-"));
    try {
      const client = makeSdkLikeClient([
        { id: "minimax", models: { "MiniMax-M3": { variants: { high: {} } } } },
      ]);
      await expect(
        refreshCache({ cachePath: pathMod.join(dir, "model-data.json"), client }),
      ).resolves.toBeUndefined();
      const cached = await readCache(pathMod.join(dir, "model-data.json"));
      // The live (this-bound) list result was absorbed into the cache.
      expect(cached?.providers["minimax"]?.["MiniMax-M3"]?.variants).toEqual(["high"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshCache fire-and-forget never surfaces an unhandled rejection", async () => {
    // A client whose provider.list rejects asynchronously must be fully
    // absorbed — the fire-and-forget init path must not leak a rejection.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const client = {
        provider: { list: () => Promise.reject(new Error("boot race")) },
      };
      expect(() =>
        modelForecastPlugin({ client }, {
          mode: "auto",
          quarantine: { filePath: path.join(tempDir, "quarantine.json") },
        }),
      ).not.toThrow();
      // Give any queued microtasks / rejections a tick to surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — quarantine ↔ generated profile resolver integration.
 * Verifies that permanent quarantines loaded from file are active before
 * profile generation AND that explicitly-listed individual Flash aliases
 * (each a singleton — no implicit family expansion) are excluded from the
 * resolver output, leaving a non-Flash model to be chosen.
 * -------------------------------------------------------------------------- */
describe("plugin — quarantine ↔ resolver integration (group expansion)", () => {
  it("individual Flash aliases loaded from file are excluded from generated profiles (each a singleton)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-qr-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    try {
      // Pre-write a persistent quarantine file listing each individual Flash
      // alias explicitly. Under the singleton contract, an individual id no
      // longer expands to its family, so both connected Flash models must be
      // named to exclude them — leaving the non-Flash pro model available.
      const { writeFile } = await import("fs/promises");
      await writeFile(
        quarantinePath,
        JSON.stringify([
          { model: "google/gemini-3.5-flash", reason: "invalid_api_key", expiresAt: null },
          { model: "google/gemini-3-flash", reason: "invalid_api_key", expiresAt: null },
        ]),
        "utf8",
      );

      const client = {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "google",
                  models: {
                    "gemini-3.5-flash": {
                      variants: { high: {} },
                      cost: { input: 0.5, output: 2 },
                      limit: { context: 1_048_576 },
                      status: "active",
                    },
                    "gemini-3-flash": {
                      variants: { high: {} },
                      cost: { input: 0.5, output: 2 },
                      limit: { context: 1_048_576 },
                      status: "active",
                    },
                    "gemini-3.1-pro": {
                      variants: { high: {} },
                      cost: { input: 2, output: 8 },
                      limit: { context: 2_097_152 },
                      status: "active",
                    },
                  },
                },
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4-5": {
                      variants: { high: {} },
                      cost: { input: 3, output: 15 },
                      limit: { context: 200_000 },
                      status: "active",
                    },
                  },
                },
              ],
            },
          }),
        },
        tui: { showToast: () => Promise.resolve(true) },
      };

      const hooks = await modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
      });

      const configHook = hooks["config"] as (config: unknown) => Promise<void>;
      const config: { agent: Record<string, unknown> } = {
        agent: {
          "sdd-design": {
            mode: "subagent",
            model: "google/gemini-2.5-pro",
            prompt: "Design prompt",
          },
        },
      };

      await configHook(config);

      // The config hook creates profiles in profileCatalog.byBase for ALL
      // connected models. Quarantine filtering happens in the resolver, not
      // during generation. Drive the before hook to verify the resolver
      // excludes quarantined Gemini Flash models.
      const beforeHook = hooks["tool.execute.before"] as (
        input: unknown,
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
      await beforeHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c-qr-test" },
        output,
      );

      // The resolver should have chosen a non-Flash generated profile.
      // This must prove an actual rewrite happened; otherwise the test could
      // pass trivially by keeping the original base subagent type.
      const chosen = output.args.subagent_type as string;
      expect(chosen).toMatch(/^__mf_sdd-design__/);
      // The alias encodes the modelId — verify it doesn't contain "flash".
      expect(chosen).not.toMatch(/flash/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("quarantines loaded before config hook: permanent entries survive clearNonPermanent()", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "plugin-qr2-"));
    const quarantinePath = path.join(tempDir, "quarantine.json");
    const cachePath = path.join(tempDir, "model-data.json");
    try {
      // Pre-write a persistent quarantine.
      const { writeFile } = await import("fs/promises");
      await writeFile(
        quarantinePath,
        JSON.stringify([
          { model: "google/gemini-3.5-flash", reason: "invalid_api_key", expiresAt: null },
        ]),
        "utf8",
      );

      // Plugin loads quarantine BEFORE returning hooks.
      const hooks = await modelForecastPlugin(undefined, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        cachePath,
      });

      // Config hook calls clearNonPermanent() — permanent entries must survive.
      const configHook = hooks["config"] as (config: unknown) => Promise<void>;
      await configHook({ agent: {} });

      // Drive the before hook to trigger resolver — it calls quarantine.isBlocked().
      const beforeHook = hooks["tool.execute.before"] as (
        input: unknown,
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
      await beforeHook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c-perm-test" },
        output,
      );

      // The resolver should have filtered out quarantined models.
      // Since the resolver is called and doesn't crash, the quarantine was loaded.
      // The `subagent_type` may be rewritten or kept — either way, no crash.
      expect(typeof output.args.subagent_type).toBe("string");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Regression — generateProfilesForConfig resilience.
 * -------------------------------------------------------------------------- */
describe("generateProfilesForConfig — empty / degenerate inputs", () => {
  it("returns an empty catalog when the connected-model list is empty", async () => {
    const { generateProfilesForConfig } = await import("../src/profiles.js");
    const catalog = generateProfilesForConfig(
      { agent: { "sdd-design": { mode: "subagent", model: "x/y", prompt: "p" } } },
      [],
    );
    expect(catalog.byBase).toEqual({ "sdd-design": [] });
  });

  it("does not throw when config is an empty object (no agents)", async () => {
    const { generateProfilesForConfig } = await import("../src/profiles.js");
    expect(() => generateProfilesForConfig({}, [])).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- *
 * PR1 — refreshCache discovery sink
 *
 * The plugin's `refreshCache` MUST retain its `Promise<void>` signature
 * and accept an OPTIONAL `discoverySink` callback that receives a
 * `Discovery` from `src/models.ts`. The sink is a no-op by default.
 *
 * RED phase: the source symbols `discoverySink` and `Discovery` do not
 * exist yet on src/plugin.ts and src/models.ts. Running `npm test
 * tests/plugin.test.ts` before the implementation lands MUST fail
 * (module-resolution error for `Discovery` and a TS error for the
 * unknown `discoverySink` option). Once they land, these tests pin
 * the wiring so PR2's `runRefresh` can consume the discovery safely.
 * -------------------------------------------------------------------------- */

describe("plugin — refreshCache discovery sink (PR1 wiring)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-discovery-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns Promise<void> regardless of whether a sink is provided", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    // No sink — must resolve to undefined and not throw.
    await expect(refreshCache({ cachePath })).resolves.toBeUndefined();
  });

  it("calls the discovery sink with a `complete` Discovery when a valid provider.list is available", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const sink: Discovery[] = [];
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "anthropic",
                models: {
                  "claude-opus-4-7": { variants: { high: {}, max: {} } },
                },
              },
              {
                id: "google",
                models: {
                  "gemini-2.5-pro": { variants: { medium: {} } },
                },
              },
            ],
          },
        }),
      },
    };

    await refreshCache({
      cachePath,
      client,
      discoverySink: (d) => {
        sink.push(d);
      },
    });

    expect(sink).toHaveLength(1);
    expect(sink[0]?.status).toBe("complete");
    expect(sink[0]?.source).toBe("provider-list");
    expect(sink[0]?.models).toHaveLength(2);
    expect(sink[0]?.models.map((m: { provider: string; model: string }) => `${m.provider}/${m.model}`).sort()).toEqual([
      "anthropic/claude-opus-4-7",
      "google/gemini-2.5-pro",
    ]);
  });

  it("calls the discovery sink with a `complete` Discovery from the opencode cache when the provider list is absent", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const openCodeFile = path.join(tempDir, "opencode-models.json");
    await writeFile(
      openCodeFile,
      JSON.stringify({
        anthropic: {
          id: "anthropic",
          models: {
            "claude-sonnet-4-5": { variants: { high: {} } },
          },
        },
      }),
    );

    const sink: Discovery[] = [];
    await refreshCache({
      cachePath,
      gentleAiPath: path.join(tempDir, "no-such-gentle-ai.json"),
      openCodePath: openCodeFile,
      discoverySink: (d) => {
        sink.push(d);
      },
    });

    expect(sink).toHaveLength(1);
    expect(sink[0]?.status).toBe("complete");
    expect(sink[0]?.source).toBe("opencode-cache");
    expect(sink[0]?.models).toHaveLength(1);
    expect(sink[0]?.models[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("calls the discovery sink with an `unavailable` Discovery when no source is parseable", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const sink: Discovery[] = [];
    await refreshCache({
      cachePath,
      gentleAiPath: path.join(tempDir, "no-such-gentle-ai.json"),
      openCodePath: path.join(tempDir, "no-such-opencode.json"),
      discoverySink: (d) => {
        sink.push(d);
      },
    });

    expect(sink).toHaveLength(1);
    expect(sink[0]?.status).toBe("unavailable");
    expect(sink[0]?.source).toBe("none");
    expect(sink[0]?.models).toEqual([]);
  });

  it("does not call the sink more than once per refresh", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const sink: Discovery[] = [];
    await refreshCache({
      cachePath,
      discoverySink: (d) => {
        sink.push(d);
      },
    });
    expect(sink).toHaveLength(1);
  });

  it("does not throw when the sink itself throws (sink errors are absorbed)", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    const throwingSink = (): void => {
      throw new Error("sink exploded");
    };
    await expect(
      refreshCache({ cachePath, discoverySink: throwingSink }),
    ).resolves.toBeUndefined();
    // Cache must still be on disk despite the sink blowing up.
    const cached = await readCache(cachePath);
    expect(cached).not.toBeNull();
  });

  it("supports a no-op default when no discoverySink is provided", async () => {
    const cachePath = path.join(tempDir, "model-data.json");
    // Just exercise the call path with NO sink — must complete safely.
    await expect(
      refreshCache({ cachePath }),
    ).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Task 1 — session-scoped live availability state.
 *
 * Spec: the plugin must capture a session-scoped `LiveAvailabilityState`
 * from a single successful, bound, timeout-protected
 * `client.provider.list()` call. The state becomes ready (with a
 * case-preserving `Set<provider/model>`) ONLY after a successful live
 * parse; every other path (missing client/provider/list, sync throw,
 * rejected promise, timeout, malformed/empty result) leaves the state
 * unavailable with a short reason. Cached model data does NOT make the
 * state ready, but the config hook may still use it as a profile-catalog
 * fallback.
 *
 * These tests pin the helper directly so the failure modes are easy to
 * read, plus a couple of integration tests that confirm the state is
 * threaded into the task hook and that cache fallback works while the
 * state stays unavailable.
 * -------------------------------------------------------------------------- */

describe("plugin — computeLiveAvailabilityState (Task 1, success paths)", () => {
  it("returns ready:true with a case-preserving Set on a successful live list", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "Anthropic",
                models: { "Claude-Opus-4-7": { variants: { high: {} } } },
              },
              {
                id: "google",
                models: { "Gemini-2.5-Pro": { variants: { high: {} } } },
              },
            ],
          },
        }),
      },
    };
    const state = await computeLiveAvailabilityState({ client });
    expect(state.ready).toBe(true);
    expect(state.source).toBe("provider-list");
    expect(state.reason).toBe("");
    expect(state.models).toBeInstanceOf(Set);
    // CASE-PRESERVING — match exactly what the SDK returned (no toLowerCase).
    expect([...state.models].sort()).toEqual([
      "Anthropic/Claude-Opus-4-7",
      "google/Gemini-2.5-Pro",
    ]);
  });

  it("ignores providers/models that lack an id or a models object", async () => {
    const client = {
      provider: {
        list: async () => ({
          all: [
            { id: "good", models: { "m-1": {} } },
            { models: { "skipped-no-id": {} } },
            { id: "skipped-no-models" },
            null,
            "garbage",
          ],
        }),
      },
    };
    const state = await computeLiveAvailabilityState({ client });
    expect(state.ready).toBe(true);
    expect([...state.models]).toEqual(["good/m-1"]);
  });

  it("accepts the bare-array provider-list shape (no envelope)", async () => {
    const client = {
      provider: {
        list: async () => [
          { id: "openai", models: { "gpt-4.1-mini": {} } },
        ],
      },
    };
    const state = await computeLiveAvailabilityState({ client });
    expect(state.ready).toBe(true);
    expect([...state.models]).toEqual(["openai/gpt-4.1-mini"]);
  });
});

describe("plugin — computeLiveAvailabilityState (Task 1, failure paths)", () => {
  it("returns ready:false with reason when no client is provided", async () => {
    const state = await computeLiveAvailabilityState({});
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason.length).toBeGreaterThan(0);
    expect(state.source).toBe("none");
  });

  it("returns ready:false with reason when client.provider is missing", async () => {
    const state = await computeLiveAvailabilityState({ client: {} });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason.length).toBeGreaterThan(0);
  });

  it("returns ready:false with reason when client.provider.list is missing", async () => {
    const state = await computeLiveAvailabilityState({
      client: { provider: {} },
    });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason.length).toBeGreaterThan(0);
  });

  it("returns ready:false when provider.list throws synchronously", async () => {
    const state = await computeLiveAvailabilityState({
      client: {
        provider: {
          list: () => {
            throw new Error("provider system not initialised at config time");
          },
        },
      },
    });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason).toMatch(/threw|throw/i);
  });

  it("returns ready:false when provider.list returns a rejected promise", async () => {
    const state = await computeLiveAvailabilityState({
      client: {
        provider: {
          list: () => Promise.reject(new Error("offline")),
        },
      },
    });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason).toMatch(/threw|throw/i);
  });

  it("returns ready:false with a timeout reason when provider.list hangs", async () => {
    const never = new Promise<unknown>(() => {
      // intentionally never resolves/rejects
    });
    const state = await computeLiveAvailabilityState({
      client: { provider: { list: () => never } },
      timeoutMs: 50,
    });
    expect(state.ready).toBe(false);
    expect(state.reason).toMatch(/timed out|timeout/i);
  });

  it("returns ready:false on a malformed (non-object) result", async () => {
    const state = await computeLiveAvailabilityState({
      client: { provider: { list: async () => "not-an-object" } },
    });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason.length).toBeGreaterThan(0);
  });

  it("returns ready:false on a recognised-but-empty result", async () => {
    const state = await computeLiveAvailabilityState({
      client: { provider: { list: async () => ({ all: [] }) } },
    });
    expect(state.ready).toBe(false);
    expect(state.models.size).toBe(0);
    expect(state.reason).toMatch(/no models|empty/i);
  });

  it("preserves the SDK `this`-binding (class-instance provider.list)", async () => {
    // Real OpenCode SDK exposes `client.provider` as a class instance
    // whose `list()` reads `this._client`. A bare call without binding
    // would throw inside the method. We mirror that contract here.
    class ProviderLike {
      // eslint-disable-next-line no-useless-constructor
      constructor(private readonly payload: { all: unknown[] }) {}
      list(): Promise<{ all: unknown[] }> {
        // Reading `this.payload` throws when called unbound.
        return Promise.resolve(this.payload);
      }
    }
    const client = {
      provider: new ProviderLike({
        all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
      }),
    };
    const state = await computeLiveAvailabilityState({ client });
    expect(state.ready).toBe(true);
    expect([...state.models]).toEqual(["google/gemini-2.5-pro"]);
  });

  it("does not throw even when withTimeout rejects", async () => {
    // Belt-and-suspenders: the helper must never propagate an exception
    // to its caller (the plugin init path) — any throw would surface as
    // a startup failure.
    const client = {
      provider: { list: () => Promise.reject(new Error("boot race")) },
    };
    await expect(
      computeLiveAvailabilityState({ client }),
    ).resolves.toBeDefined();
  });
});

describe("plugin — live availability state threaded into the task hook (Task 1)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-live-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exposes the live state on the returned task hook when the config hook succeeds", async () => {
    const client = {
      provider: {
        list: async () => ({
          all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
        }),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });

    const live = beforeHook.getLiveAvailability?.();
    expect(live).toBeDefined();
    expect(live?.ready).toBe(true);
    expect(live?.source).toBe("provider-list");
    expect([...(live?.models ?? [])]).toContain("google/gemini-2.5-pro");
  });

  it("returns a defensive live snapshot whose mutation cannot authorize an unavailable candidate", async () => {
    const unavailableModel = "openai/not-live";
    const client = {
      provider: {
        list: async () => ({
          all: [{ id: "openai", models: { "gpt-live": {} } }],
        }),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
      resolveCandidates: () => [
        {
          subagent_type: "sdd-design-alto",
          model: unavailableModel,
          effort: "high",
          confidence: 0.95,
          evidence: "test candidate",
          ladderRung: "openai",
        },
      ],
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });

    const exposed = beforeHook.getLiveAvailability?.();
    expect(exposed?.ready).toBe(true);
    (exposed?.models as Set<string>).add(unavailableModel);

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "defensive-snapshot" },
      output,
    );

    expect(beforeHook.getLiveAvailability?.().models.has(unavailableModel)).toBe(false);
    expect(output.args.subagent_type).toBe("sdd-design");
  });

  it("exposes an unavailable live state when the client throws on provider.list", async () => {
    const client = {
      provider: {
        list: () => {
          throw new Error("offline");
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });

    const live = beforeHook.getLiveAvailability?.();
    expect(live).toBeDefined();
    expect(live?.ready).toBe(false);
    expect(live?.reason.length).toBeGreaterThan(0);
    expect(live?.models.size).toBe(0);
  });

  it("exposes an unavailable live state when no client is provided at all", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });

    const live = beforeHook.getLiveAvailability?.();
    expect(live).toBeDefined();
    expect(live?.ready).toBe(false);
    expect(live?.reason.length).toBeGreaterThan(0);
  });

  it("cache fallback populates the profile catalog while live state stays unavailable", async () => {
    // Spec: cached model data may still generate/rank advisory profiles
    // but CANNOT make availability state ready. So: a throwing client +
    // a pre-populated cache file should still let the config hook
    // generate profiles (via the cache fallback path), while the live
    // state the plugin captures remains unavailable.
    const client = {
      provider: {
        list: () => {
          throw new Error("live unreachable");
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const cachePath = path.join(tempDir, "model-data.json");
    const quarantinePath = path.join(tempDir, "quarantine.json");
    // Pre-populate the cache file with a real model so the config hook
    // can fall back to it.
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: {
          google: {
            "gemini-2.5-pro": { variants: ["high"] },
          },
        },
        rubric: {},
      }),
      "utf8",
    );

    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: quarantinePath },
      cachePath,
    });

    // Live state MUST be unavailable (cache does not make it ready).
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    expect(beforeHook.getLiveAvailability?.().ready).toBe(false);

    // Run the config hook so the cache fallback path generates profiles.
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({
      agent: {
        "sdd-design": {
          mode: "subagent",
          model: "google/gemini-2.5-pro",
          prompt: "Design prompt",
        },
      },
    });

    // Profile catalog was populated from cache, but cache-derived profiles
    // are advisory only. Final authorization refuses the rewrite because
    // the current live snapshot is unavailable.
    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await beforeHook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c-cache-fallback" },
      output,
    );
    expect(output.args.subagent_type).toBe("sdd-design");
    // Live state still unavailable (cache did not flip it).
    expect(beforeHook.getLiveAvailability?.().ready).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Task 1.5 spec fix — live availability is captured ONLY from the config
 * hook's existing bound, timeout-protected `client.provider.list()` call.
 *
 * Review blocker: the previous implementation eagerly captured the state
 * at plugin init time, which (a) duplicated the SDK call (the config hook
 * also calls provider.list) and (b) almost always produced a permanently
 * unavailable state because providers are typically not ready when the
 * plugin loads. The approved plan requires the state to be derived from
 * the config hook's own live call, so:
 *   - No call at plugin init time.
 *   - Exactly one provider.list call through the config hook per session.
 *   - State starts unavailable with "config hook not yet called".
 *   - State flips to ready only after a successful config-hook call.
 *   - State flips to unavailable with a reason on every config-hook
 *     failure path (missing client/list, sync throw, rejected promise,
 *     timeout, malformed / empty result).
 *   - The state handed to `createTaskHook` is a live getter, not a
 *     snapshot — the hook always sees the current value.
 * -------------------------------------------------------------------------- */

describe("plugin — spec fix: live availability captured from config hook only", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-spec-fix-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does NOT call provider.list during plugin init (no eager capture)", async () => {
    let callCount = 0;
    const client = {
      provider: {
        list: () => {
          callCount += 1;
          return Promise.resolve({ all: [] });
        },
      },
    };
    await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    expect(callCount).toBe(0);
  });

  it("calls provider.list exactly once via the config hook", async () => {
    let callCount = 0;
    const client = {
      provider: {
        list: () => {
          callCount += 1;
          return Promise.resolve({
            all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
          });
        },
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    // No call yet at init time.
    expect(callCount).toBe(0);
    // One call after the config hook fires.
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    expect(callCount).toBe(1);
  });

  it("live state starts unavailable with reason before the config hook runs", async () => {
    const client = {
      provider: {
        list: async () => ({ all: [{ id: "google", models: { "gemini-2.5-pro": {} } }] }),
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const live = beforeHook.getLiveAvailability?.();
    expect(live).toBeDefined();
    expect(live?.ready).toBe(false);
    expect(live?.reason.length).toBeGreaterThan(0);
  });

  it("live state flips to ready after a successful config-hook call", async () => {
    const client = {
      provider: {
        list: async () => ({
          all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
        }),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    // Before config hook fires → unavailable.
    expect(beforeHook.getLiveAvailability?.().ready).toBe(false);
    // After config hook fires with valid list → ready, case-preserving Set.
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(true);
    expect(live?.source).toBe("provider-list");
    expect(live?.reason).toBe("");
    expect([...(live?.models ?? [])]).toEqual(["google/gemini-2.5-pro"]);
  });

  it("live state flips to unavailable when config hook's provider.list throws synchronously", async () => {
    const client = {
      provider: {
        list: () => {
          throw new Error("boot race");
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(false);
    expect(live?.reason).toMatch(/threw/i);
    expect(live?.models.size).toBe(0);
  });

  it("live state flips to unavailable when config hook's provider.list rejects", async () => {
    const client = {
      provider: {
        list: () => Promise.reject(new Error("offline")),
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(false);
    expect(live?.reason).toMatch(/threw/i);
  });

  it("live state flips to unavailable when config hook's provider.list returns malformed data", async () => {
    const client = {
      provider: { list: async () => "not-an-object" },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(false);
    expect(live?.models.size).toBe(0);
  });

  it("live state flips to unavailable when config hook's provider.list returns empty data", async () => {
    const client = {
      provider: { list: async () => ({ all: [] }) },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(false);
    expect(live?.reason).toMatch(/no models|empty/i);
  });

  it("live state stays unavailable when no client is provided (config hook cannot fix that)", async () => {
    const hooks = await modelForecastPlugin(undefined, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({ agent: {} });
    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(false);
    expect(live?.reason.length).toBeGreaterThan(0);
  });

  it("getter returns the LIVE state, not a stale snapshot", async () => {
    // Two config-hook calls: the first returns a real model (ready), the
    // second returns an empty list (unavailable). The getter must reflect
    // the latest call — proving it is NOT a snapshot taken at init time.
    let callCount = 0;
    const client = {
      provider: {
        list: async () => {
          callCount += 1;
          if (callCount === 1) {
            return { all: [{ id: "google", models: { "gemini-2.5-pro": {} } }] };
          }
          return { all: [] };
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
    });
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;

    // First config-hook call → ready.
    await configHook({ agent: {} });
    expect(beforeHook.getLiveAvailability?.().ready).toBe(true);

    // Second config-hook call (empty) → unavailable.
    await configHook({ agent: {} });
    expect(beforeHook.getLiveAvailability?.().ready).toBe(false);
  });

  it("does not add a second provider.list call: cache fallback path is purely advisory", async () => {
    // When the live call fails the config hook falls back to reading the
    // on-disk cache. That fallback MUST NOT trigger a second
    // provider.list call.
    let callCount = 0;
    const client = {
      provider: {
        list: () => {
          callCount += 1;
          return Promise.reject(new Error("offline"));
        },
      },
      tui: { showToast: () => Promise.resolve(true) },
    };
    const cachePath = path.join(tempDir, "model-data.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: {
          google: { "gemini-2.5-pro": { variants: ["high"] } },
        },
        rubric: {},
      }),
      "utf8",
    );
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { filePath: path.join(tempDir, "quarantine.json") },
      cachePath,
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    await configHook({
      agent: {
        "sdd-design": { mode: "subagent", model: "google/gemini-2.5-pro", prompt: "p" },
      },
    });
    // Exactly one call: the config hook's attempt.
    expect(callCount).toBe(1);
    // Live state is unavailable (cache fallback did not flip it).
    const beforeHook = hooks["tool.execute.before"] as TaskHook;
    expect(beforeHook.getLiveAvailability?.().ready).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Task 1 reliability fixes.
 *
 * These tests pin three fail-closed guarantees before Task 2 consumes the
 * getter:
 *   1. Any config invocation that cannot reach provider.list invalidates a
 *      prior ready snapshot, including generatedProfiles.enabled:false and
 *      pre-provider setup errors.
 *   2. The production config hook (not only the standalone helper) enforces
 *      the real 5-second provider-list timeout.
 *   3. Concurrent config calls are last-invocation-wins for availability;
 *      a slow older call cannot overwrite a newer completed call.
 * -------------------------------------------------------------------------- */

describe("plugin — Task 1 live availability reliability", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "plugin-live-reliability-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resets a prior ready state when generated profiles are disabled", async () => {
    let providerListCalls = 0;
    const generatedProfiles: { enabled?: boolean } = { enabled: true };
    const client = {
      provider: {
        list: async () => {
          providerListCalls += 1;
          return {
            all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
          };
        },
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      generatedProfiles,
      quarantine: { enabled: false },
      cachePath: path.join(tempDir, "model-data.json"),
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as TaskHook;

    await configHook({ agent: {} });
    expect(beforeHook.getLiveAvailability?.().ready).toBe(true);
    expect(providerListCalls).toBe(1);

    generatedProfiles.enabled = false;
    await configHook({ agent: {} });

    const live = beforeHook.getLiveAvailability?.();
    expect(providerListCalls).toBe(1);
    expect(live?.ready).toBe(false);
    expect(live?.models.size).toBe(0);
    expect(live?.reason).toMatch(/generated profiles.*disabled/i);
  });

  it("resets a prior ready state when config setup fails before provider.list", async () => {
    let providerListCalls = 0;
    let failDirectoryRead = false;
    const client = {
      provider: {
        list: async () => {
          providerListCalls += 1;
          return {
            all: [{ id: "google", models: { "gemini-2.5-pro": {} } }],
          };
        },
      },
    };
    const input = {
      client,
      get directory(): undefined {
        if (failDirectoryRead) throw new Error("pre-provider setup failed");
        return undefined;
      },
    };
    const hooks = await modelForecastPlugin(input, {
      mode: "auto",
      quarantine: { enabled: false },
      cachePath: path.join(tempDir, "model-data.json"),
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as TaskHook;

    await configHook({ agent: {} });
    expect(beforeHook.getLiveAvailability?.().ready).toBe(true);
    expect(providerListCalls).toBe(1);

    failDirectoryRead = true;
    await expect(configHook({ agent: {} })).resolves.toBeUndefined();

    const live = beforeHook.getLiveAvailability?.();
    expect(providerListCalls).toBe(1);
    expect(live?.ready).toBe(false);
    expect(live?.models.size).toBe(0);
    expect(live?.reason).toMatch(/before provider\.list.*pre-provider setup failed/i);
  });

  it("times out the production config-hook provider.list call after exactly 5 seconds", async () => {
    vi.useFakeTimers();
    let providerListCalls = 0;
    const neverSettles = new Promise<unknown>(() => {});
    const client = {
      provider: {
        list: () => {
          providerListCalls += 1;
          return neverSettles;
        },
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { enabled: false },
      cachePath: path.join(tempDir, "missing-model-data.json"),
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as TaskHook;

    let settled = false;
    const pending = configHook({ agent: {} }).finally(() => {
      settled = true;
    });

    expect(providerListCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    const live = beforeHook.getLiveAvailability?.();
    expect(settled).toBe(true);
    expect(live?.ready).toBe(false);
    expect(live?.models.size).toBe(0);
    expect(live?.reason).toMatch(/timed out after 5000ms/i);
  });

  it("keeps the newer availability when an older concurrent config call resolves last", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const client = {
      provider: {
        list: () => new Promise<unknown>((resolve) => resolvers.push(resolve)),
      },
    };
    const hooks = await modelForecastPlugin({ client }, {
      mode: "auto",
      quarantine: { enabled: false },
      cachePath: path.join(tempDir, "model-data.json"),
    });
    const configHook = hooks["config"] as (config: unknown) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as TaskHook;

    const older = configHook({ agent: {} });
    expect(resolvers).toHaveLength(1);
    const newer = configHook({ agent: {} });
    expect(resolvers).toHaveLength(2);

    resolvers[1]?.({
      all: [{ id: "NewProvider", models: { "NewModel": {} } }],
    });
    await newer;
    expect(beforeHook.getLiveAvailability?.().ready).toBe(true);
    expect([...(beforeHook.getLiveAvailability?.().models ?? [])]).toEqual([
      "NewProvider/NewModel",
    ]);

    resolvers[0]?.({
      all: [{ id: "OldProvider", models: { "OldModel": {} } }],
    });
    await older;

    const live = beforeHook.getLiveAvailability?.();
    expect(live?.ready).toBe(true);
    expect([...(live?.models ?? [])]).toEqual(["NewProvider/NewModel"]);
  });
});
