/**
 * Design v4 — Config transaction (contract A1).
 *
 * The config hook NEVER calls provider.list. Generated aliases, the
 * catalog, and permission propagation are built from the on-disk cache
 * (plus static benchmark evidence) BEFORE the hook resolves.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { modelForecastPlugin } from "../src/plugin.js";
import { GENERATED_PROFILE_PREFIX, generatedProfileAlias } from "../src/profiles.js";

async function primeCache(cachePath: string): Promise<void> {
  const cache = {
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: {
      anthropic: {
        "claude-opus-4-7": { variants: [] },
      },
      minimax: {
        "MiniMax-M3": { variants: [] },
      },
    },
    rubric: { "sdd-design": "high" },
  };
  await writeFile(cachePath, JSON.stringify(cache), "utf8");
}

describe("Design v4 config transaction (A1) — provider.list never called", () => {
  it("config hook builds aliases/catalog from disk cache without calling provider.list", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "mf-config-v4-"));
    const cachePath = path.join(tempDir, "model-data.json");
    const quarantinePath = path.join(tempDir, "quarantine.json");
    try {
      await primeCache(cachePath);

      const listSpy = vi.fn(async () => ({
        data: { all: [], connected: ["anthropic"] },
      }));
      const client = { provider: { list: listSpy } };

      const hooks = await modelForecastPlugin({ client }, {
        mode: "auto",
        quarantine: { filePath: quarantinePath },
        cachePath,
      });

      const configArg: { agent: Record<string, unknown> } = {
        agent: {
          "sdd-design": {
            mode: "subagent",
            model: "anthropic/claude-opus-4-7",
            prompt: "Design prompt",
          },
        },
      };
      const configHook = hooks["config"] as (c: typeof configArg) => Promise<void>;
      await configHook(configArg);

      // A1: provider.list was NEVER invoked from the config hook.
      expect(listSpy).not.toHaveBeenCalled();

      // A1/A3: aliases + catalog were published before resolution. The
      // generated __mf_ alias for sdd-design on the cache-backed model
      // must now exist on the config's agent map.
      const expectedAlias = generatedProfileAlias("sdd-design", "anthropic/claude-opus-4-7");
      expect(configArg.agent[expectedAlias]).toBeTruthy();
      expect(expectedAlias.startsWith(GENERATED_PROFILE_PREFIX)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Design v4 post-bootstrap resolver wiring", () => {
  it("shares one live request across concurrent task hooks and filters injected candidates", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "mf-live-v4-"));
    const cachePath = path.join(tempDir, "model-data.json");
    try {
      await primeCache(cachePath);
      let release!: (value: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      const listSpy = vi.fn((_options?: { signal?: AbortSignal }) => response);
      const connected = "anthropic/claude-opus-4-7";
      const hooks = await modelForecastPlugin({ client: { provider: { list: listSpy } } }, {
        mode: "auto",
        quarantine: { filePath: path.join(tempDir, "quarantine.json") },
        cachePath,
        resolveCandidates: () => [
          {
            subagent_type: generatedProfileAlias("sdd-design", "minimax/MiniMax-M3"),
            model: "minimax/MiniMax-M3",
            effort: "medium",
            confidence: 0.95,
            evidence: "curated",
            ladderRung: "minimax",
          },
          {
            subagent_type: generatedProfileAlias("sdd-design", connected),
            model: connected,
            effort: "high",
            confidence: 0.8,
            evidence: "curated",
            ladderRung: "anthropic",
          },
        ],
      });
      const config = {
        agent: {
          "sdd-design": { mode: "subagent", model: connected, prompt: "p" },
        },
      };
      await (hooks.config as (value: typeof config) => Promise<void>)(config);
      expect(listSpy).not.toHaveBeenCalled();

      const before = hooks["tool.execute.before"] as (
        input: { tool: { id: string }; sessionID: string; callID: string },
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const first = { args: { subagent_type: "sdd-design", prompt: "fix architecture regression" } };
      const second = { args: { subagent_type: "sdd-design", prompt: "fix architecture regression" } };
      const pending = [
        before({ tool: { id: "task" }, sessionID: "s", callID: "c1" }, first),
        before({ tool: { id: "task" }, sessionID: "s", callID: "c2" }, second),
      ];
      await Promise.resolve();
      await Promise.resolve();
      expect(listSpy).toHaveBeenCalledOnce();
      expect(listSpy.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
      release({
        connected: ["anthropic"],
        all: [{ id: "anthropic", models: { "claude-opus-4-7": {} } }],
      });
      await Promise.all(pending);

      const expectedAlias = generatedProfileAlias("sdd-design", connected);
      expect(first.args.subagent_type).toBe(expectedAlias);
      expect(second.args.subagent_type).toBe(expectedAlias);
      expect(config.agent[expectedAlias as keyof typeof config.agent]).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the original when an injected candidate claims an unregistered alias", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "mf-alias-v4-"));
    const cachePath = path.join(tempDir, "model-data.json");
    try {
      await primeCache(cachePath);
      const hooks = await modelForecastPlugin({
        client: {
          provider: {
            list: async () => ({
              connected: ["anthropic"],
              all: [{ id: "anthropic", models: { "claude-opus-4-7": {} } }],
            }),
          },
        },
      }, {
        mode: "auto",
        quarantine: { filePath: path.join(tempDir, "quarantine.json") },
        cachePath,
        resolveCandidates: () => [{
          subagent_type: "__mf_arbitrary_injected",
          model: "anthropic/claude-opus-4-7",
          effort: "high",
          confidence: 0.99,
          evidence: "injected",
          ladderRung: "anthropic",
        }],
      });
      const config = { agent: { "sdd-design": { mode: "subagent", prompt: "p" } } };
      await (hooks.config as (value: typeof config) => Promise<void>)(config);
      const before = hooks["tool.execute.before"] as (
        input: { tool: { id: string }; sessionID: string; callID: string },
        output: { args: Record<string, unknown> },
      ) => Promise<void>;
      const output = { args: { subagent_type: "sdd-design", prompt: "design" } };
      await before({ tool: { id: "task" }, sessionID: "s", callID: "unregistered" }, output);
      expect(output.args.subagent_type).toBe("sdd-design");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
