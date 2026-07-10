/**
 * PR3 unit tests — data collectors (provider.list, gentle-ai variants,
 * OpenCode models cache) and provider-variant merge.
 *
 * RED phase: these tests reference src/models.ts which does NOT exist yet.
 * Running `npm test` before the implementation lands should fail with a
 * module resolution / compile error.
 *
 * Spec acceptance: all collectors are best-effort and MUST never throw
 * (S2). They produce empty maps when sources are absent or malformed.
 *
 * Heuristic from gentle-ai/internal/assets/opencode/plugins/model-variants.ts
 * lines 37-39:
 *   const data = (result as any).data ?? result
 *   const providerList: any[] = data?.all ?? data?.providers ?? (Array.isArray(data) ? data : [])
 *
 * Per-model variant extraction mirrors model-variants.ts lines 41-50.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  buildProvidersCache,
  discoverLiveModels,
  extractProviderList,
  extractVariantsFromProviderList,
  gentleAiVariantsCachePath,
  openCodeModelsCachePath,
  readGentleAiVariantsCache,
  readOpenCodeModelsCache,
} from "../src/models.js";

describe("models — extractProviderList heuristic (model-variants.ts:37-39)", () => {
  it("prefers data.all when result.data is { all: [...] }", () => {
    const result = { data: { all: [{ id: "p1" }, { id: "p2" }] } };
    const list = extractProviderList(result);
    expect(list).toHaveLength(2);
    expect((list[0] as { id: string }).id).toBe("p1");
    expect((list[1] as { id: string }).id).toBe("p2");
  });

  it("falls back to data.providers when data.all is missing", () => {
    const result = { data: { providers: [{ id: "p3" }] } };
    const list = extractProviderList(result);
    expect(list).toHaveLength(1);
    expect((list[0] as { id: string }).id).toBe("p3");
  });

  it("uses data as array when data.all and data.providers are absent and data is array", () => {
    const result = { data: [{ id: "p4" }] };
    const list = extractProviderList(result);
    expect(list).toHaveLength(1);
    expect((list[0] as { id: string }).id).toBe("p4");
  });

  it("uses the result itself when there is no data envelope and result is array", () => {
    const result = [{ id: "p5" }];
    const list = extractProviderList(result);
    expect(list).toHaveLength(1);
    expect((list[0] as { id: string }).id).toBe("p5");
  });

  it("uses result.providers when result is object without data and has providers array", () => {
    const result = { providers: [{ id: "p6" }] };
    const list = extractProviderList(result);
    expect(list).toHaveLength(1);
    expect((list[0] as { id: string }).id).toBe("p6");
  });

  it("uses result.all when result is object without data and has all array", () => {
    const result = { all: [{ id: "p7" }, { id: "p8" }] };
    const list = extractProviderList(result);
    expect(list).toHaveLength(2);
  });

  it("returns empty array when result is null", () => {
    expect(extractProviderList(null)).toEqual([]);
  });

  it("returns empty array when result is undefined", () => {
    expect(extractProviderList(undefined)).toEqual([]);
  });

  it("returns empty array when no recognizable shape is found", () => {
    expect(extractProviderList({})).toEqual([]);
    expect(extractProviderList({ data: {} })).toEqual([]);
    expect(extractProviderList({ data: { unrelated: "field" } })).toEqual([]);
  });
});

describe("models — extractVariantsFromProviderList (model-variants.ts:41-50)", () => {
  it("extracts per-model variant keys per provider and sorts them", () => {
    const providers = [
      {
        id: "anthropic",
        models: {
          "claude-opus-4-7": { variants: { low: {}, high: {} } },
          "claude-haiku-4-5": { variants: {} }, // empty → skip
          "claude-sonnet-4-5": { variants: { max: {} } },
        },
      },
      {
        id: "openai",
        models: {
          "gpt-5": { variants: { low: {}, medium: {} } },
        },
      },
    ];

    const result = extractVariantsFromProviderList(providers);

    expect(result.anthropic["claude-opus-4-7"]).toEqual(["high", "low"]); // sorted
    expect(result.anthropic["claude-sonnet-4-5"]).toEqual(["max"]);
    expect(result.openai["gpt-5"]).toEqual(["low", "medium"]);
    // No entry for haiku (empty variants)
    expect(result.anthropic["claude-haiku-4-5"]).toBeUndefined();
  });

  it("returns empty object for empty input", () => {
    expect(extractVariantsFromProviderList([])).toEqual({});
  });

  it("skips providers with no id", () => {
    const result = extractVariantsFromProviderList([
      { models: { x: { variants: { low: {} } } } },
    ]);
    expect(result).toEqual({});
  });

  it("skips providers with no models", () => {
    const result = extractVariantsFromProviderList([
      { id: "anthropic" },
      { id: "openai", models: null },
    ]);
    expect(result).toEqual({});
  });

  it("does not mutate the input array or its models", () => {
    const original = [
      {
        id: "anthropic",
        models: { "claude-opus-4-7": { variants: { low: {}, high: {} } } },
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    extractVariantsFromProviderList(original);
    expect(original).toEqual(snapshot);
  });
});

describe("models — readGentleAiVariantsCache (best-effort, never throws)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "models-gentle-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty object when file is missing", async () => {
    const result = await readGentleAiVariantsCache(path.join(tempDir, "missing.json"));
    expect(result).toEqual({});
  });

  it("returns empty object when file contains invalid JSON", async () => {
    const p = path.join(tempDir, "broken.json");
    await writeFile(p, "{not json");
    const result = await readGentleAiVariantsCache(p);
    expect(result).toEqual({});
  });

  it("returns empty object when file is empty", async () => {
    const p = path.join(tempDir, "empty.json");
    await writeFile(p, "");
    const result = await readGentleAiVariantsCache(p);
    expect(result).toEqual({});
  });

  it("reads valid variants JSON (provider → model → string[])", async () => {
    const p = path.join(tempDir, "valid.json");
    const data = {
      anthropic: { "claude-opus-4-7": ["low", "high"] },
      openai: { "gpt-5": ["medium"] },
    };
    await writeFile(p, JSON.stringify(data));
    const result = await readGentleAiVariantsCache(p);
    expect(result).toEqual(data);
  });

  it("returns empty object when the JSON root is an array, not an object", async () => {
    const p = path.join(tempDir, "array.json");
    await writeFile(p, JSON.stringify([1, 2, 3]));
    const result = await readGentleAiVariantsCache(p);
    expect(result).toEqual({});
  });
});

describe("models — readOpenCodeModelsCache (best-effort, never throws)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "models-opencode-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty object when file is missing", async () => {
    const result = await readOpenCodeModelsCache(path.join(tempDir, "missing.json"));
    expect(result).toEqual({});
  });

  it("returns empty object when file contains invalid JSON", async () => {
    const p = path.join(tempDir, "broken.json");
    await writeFile(p, "garbage");
    const result = await readOpenCodeModelsCache(p);
    expect(result).toEqual({});
  });

  it("reads valid models JSON (provider → provider-object map)", async () => {
    const p = path.join(tempDir, "valid.json");
    const data = {
      anthropic: { id: "anthropic", name: "Anthropic", models: {} },
      openai: { id: "openai", name: "OpenAI", models: {} },
    };
    await writeFile(p, JSON.stringify(data));
    const result = await readOpenCodeModelsCache(p);
    expect(result).toEqual(data);
  });

  it("returns empty object when the JSON root is an array, not an object", async () => {
    const p = path.join(tempDir, "array.json");
    await writeFile(p, JSON.stringify([1, 2, 3]));
    const result = await readOpenCodeModelsCache(p);
    expect(result).toEqual({});
  });
});

describe("models — buildProvidersCache (shape adapter)", () => {
  it("converts string[] variants to { variants: string[] } per model", () => {
    const variants = {
      anthropic: { "claude-opus-4-7": ["low", "high"] },
    };
    const result = buildProvidersCache(variants);
    expect(result.anthropic["claude-opus-4-7"].variants).toEqual(["low", "high"]);
  });

  it("returns empty object for empty input", () => {
    expect(buildProvidersCache({})).toEqual({});
  });

  it("preserves multiple providers and models", () => {
    const variants = {
      anthropic: {
        "claude-opus-4-7": ["max"],
        "claude-haiku-4-5": [],
      },
      openai: { "gpt-5": ["low"] },
    };
    const result = buildProvidersCache(variants);
    expect(Object.keys(result)).toEqual(["anthropic", "openai"]);
    expect(result.anthropic["claude-opus-4-7"].variants).toEqual(["max"]);
    expect(result.anthropic["claude-haiku-4-5"].variants).toEqual([]);
    expect(result.openai["gpt-5"].variants).toEqual(["low"]);
  });
});

describe("models — default cache-path helpers", () => {
  it("gentleAiVariantsCachePath returns ~/.gentle-ai/cache/model-variants.json", () => {
    const p = gentleAiVariantsCachePath();
    expect(p).toContain(".gentle-ai");
    expect(p).toContain("model-variants.json");
  });

  it("openCodeModelsCachePath returns ~/.cache/opencode/models.json", () => {
    const p = openCodeModelsCachePath();
    expect(p).toContain(".cache");
    expect(p).toContain("opencode");
    expect(p).toContain("models.json");
  });
});

describe("models — PR2 evidence-based-forecasting: ID preservation + non-throwing chain", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "models-pr2-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // The PR2 scoring pipeline feeds the registry with `provider/model` ids.
  // The cache collectors MUST preserve those ids verbatim so that
  // `lookupEvidence("anthropic/claude-opus-4-7")` (the canonical registry
  // key) matches the ids that flowed through the collectors.
  it("extractVariantsFromProviderList → buildProvidersCache preserves `anthropic/claude-opus-4-7` ids", () => {
    const providerList = [
      {
        id: "anthropic",
        models: {
          "claude-opus-4-7": { variants: { "": {}, high: {}, max: {} } },
          "claude-sonnet-4-5": { variants: { "": {}, medium: {} } },
        },
      },
      {
        id: "google",
        models: {
          "gemini-2.5-pro": { variants: { "": {}, low: {} } },
        },
      },
    ];
    const variants = extractVariantsFromProviderList(providerList);
    const providers = buildProvidersCache(variants);
    // Every id is preserved exactly as `provider/model`.
    expect(Object.keys(providers)).toEqual(["anthropic", "google"]);
    expect(Object.keys(providers["anthropic"])).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-5",
    ]);
    expect(Object.keys(providers["google"])).toEqual(["gemini-2.5-pro"]);
  });

  it("non-throwing chain: malformed provider list returns empty providers, never throws", () => {
    // Each of these is a different malformed input the SDK could plausibly
    // produce. None of them should cause extractVariantsFromProviderList or
    // buildProvidersCache to throw.
    const malformed: unknown[][] = [
      [], // empty
      [null], // null entry
      [undefined], // undefined entry
      [{}], // object with no id
      [{ id: "anthropic" }], // object with no models
      [{ id: "anthropic", models: null }], // null models
      [{ id: "anthropic", models: { "m1": { variants: {} } } }], // empty variants
      [{ id: 123, models: {} }], // non-string id
      [{ id: "anthropic", models: { "m1": null } }], // null model
    ];
    for (const input of malformed) {
      expect(() => extractVariantsFromProviderList(input)).not.toThrow();
      const variants = extractVariantsFromProviderList(input);
      expect(() => buildProvidersCache(variants)).not.toThrow();
      const providers = buildProvidersCache(variants);
      expect(typeof providers).toBe("object");
    }
  });

  it("readGentleAiVariantsCache never throws even when the JSON file is missing or invalid", async () => {
    // Missing path
    const missing = path.join(tempDir, "definitely-missing.json");
    await expect(readGentleAiVariantsCache(missing)).resolves.toEqual({});

    // Empty file
    const empty = path.join(tempDir, "empty.json");
    await writeFile(empty, "");
    await expect(readGentleAiVariantsCache(empty)).resolves.toEqual({});

    // Invalid JSON
    const invalid = path.join(tempDir, "invalid.json");
    await writeFile(invalid, "{not json");
    await expect(readGentleAiVariantsCache(invalid)).resolves.toEqual({});

    // JSON array root (not an object)
    const arrayRoot = path.join(tempDir, "array.json");
    await writeFile(arrayRoot, "[1,2,3]");
    await expect(readGentleAiVariantsCache(arrayRoot)).resolves.toEqual({});
  });

  it("end-to-end: ids produced by the collector match the evidence-registry lookup key format", () => {
    // The evidence registry keys look like `anthropic/claude-opus-4-7`.
    // The collectors must produce the SAME id format so the scoring
    // pipeline can pass them straight to `lookupEvidence()`.
    const providerList = [
      {
        id: "anthropic",
        models: { "claude-opus-4-7": { variants: { "": {} } } },
      },
    ];
    const variants = extractVariantsFromProviderList(providerList);
    const providers = buildProvidersCache(variants);
    // Construct the `provider/model` id from the collector output.
    const canonicalId = `${Object.keys(providers)[0]}/${Object.keys(
      providers[Object.keys(providers)[0]!]!,
    )[0]}`;
    expect(canonicalId).toBe("anthropic/claude-opus-4-7");
  });
});

/* -------------------------------------------------------------------------- *
 * PR1 — discoverLiveModels (pending-queue data layer)
 *
 * RED phase: the source symbol `discoverLiveModels` does not exist yet
 * on src/models.ts. Running `npm test tests/models.test.ts` before the
 * implementation lands MUST fail with a module-resolution / compile
 * error from the import above. Once the function lands, these tests
 * pin its behavior so PR2+ can rely on it.
 *
 * Spec contract:
 *   - `discoverLiveModels` derives a `Discovery` from the available
 *     sources (provider-list first, opencode-cache second).
 *   - `complete` means at least one source was parseable; even an
 *     empty parseable list still counts as `complete`.
 *   - `unavailable` means no source was parseable (null, undefined,
 *     wrong shape).
 *   - ALL live models are extracted, including those with no variants.
 * -------------------------------------------------------------------------- */

describe("models — discoverLiveModels (PR1 pending-queue data layer)", () => {
  it("emits `complete` with `source: provider-list` when provider-list is valid", () => {
    const discovery = discoverLiveModels({
      providerList: {
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
      },
    });
    expect(discovery.status).toBe("complete");
    expect(discovery.source).toBe("provider-list");
    expect(discovery.models).toHaveLength(2);
    // Lowercased, sorted by `provider/model` for determinism.
    expect(discovery.models.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "anthropic/claude-opus-4-7",
      "google/gemini-2.5-pro",
    ]);
  });

  it("emits `complete` with `source: opencode-cache` when only the opencode cache is valid", () => {
    const discovery = discoverLiveModels({
      openCodeCache: {
        anthropic: {
          id: "anthropic",
          models: {
            "claude-sonnet-4-5": { variants: { high: {} } },
          },
        },
      },
    });
    expect(discovery.status).toBe("complete");
    expect(discovery.source).toBe("opencode-cache");
    expect(discovery.models).toHaveLength(1);
    expect(discovery.models[0]?.provider).toBe("anthropic");
    expect(discovery.models[0]?.model).toBe("claude-sonnet-4-5");
  });

  it("prefers the provider-list over the opencode cache when both are valid", () => {
    const discovery = discoverLiveModels({
      providerList: {
        all: [
          { id: "anthropic", models: { "claude-opus-4-7": { variants: { high: {} } } } },
        ],
      },
      openCodeCache: {
        google: { id: "google", models: { "gemini-2.5-pro": { variants: {} } } },
      },
    });
    expect(discovery.source).toBe("provider-list");
    expect(discovery.models).toHaveLength(1);
    expect(discovery.models[0]?.provider).toBe("anthropic");
  });

  it("emits `complete` with zero models when a valid provider-list has zero entries", () => {
    const discovery = discoverLiveModels({
      providerList: { all: [] },
    });
    expect(discovery.status).toBe("complete");
    expect(discovery.source).toBe("provider-list");
    expect(discovery.models).toEqual([]);
  });

  it("emits `unavailable` with `source: none` when no source is provided", () => {
    const discovery = discoverLiveModels({});
    expect(discovery.status).toBe("unavailable");
    expect(discovery.source).toBe("none");
    expect(discovery.models).toEqual([]);
  });

  it("emits `unavailable` when both sources are null/undefined/empty", () => {
    expect(discoverLiveModels({ providerList: null, openCodeCache: undefined }).status).toBe(
      "unavailable",
    );
    expect(discoverLiveModels({ openCodeCache: {} }).status).toBe("unavailable");
  });

  it("emits `unavailable` when the provider-list is unrecognizable and the cache is empty", () => {
    const discovery = discoverLiveModels({
      providerList: "garbage",
      openCodeCache: {},
    });
    expect(discovery.status).toBe("unavailable");
    expect(discovery.source).toBe("none");
    expect(discovery.models).toEqual([]);
  });

  it("falls back to opencode-cache when the provider-list is malformed", () => {
    const discovery = discoverLiveModels({
      providerList: { data: { unrelated: [] } }, // recognized shape but no providers
      openCodeCache: {
        anthropic: {
          id: "anthropic",
          models: { "claude-sonnet-4-5": { variants: {} } },
        },
      },
    });
    expect(discovery.status).toBe("complete");
    expect(discovery.source).toBe("opencode-cache");
    expect(discovery.models).toHaveLength(1);
  });

  it("extracts every model INCLUDING those with no variants (no-variant spec requirement)", () => {
    const discovery = discoverLiveModels({
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-opus-4-7": { variants: { high: {}, max: {} } },
              "claude-haiku-4-5": { variants: {} }, // empty variants object
              "claude-sonnet-4-5": { /* no variants key at all */ },
            },
          },
        ],
      },
    });
    expect(discovery.status).toBe("complete");
    // ALL three models surface — including the no-variant one.
    expect(discovery.models).toHaveLength(3);
    const byKey = new Map(
      discovery.models.map((m) => [`${m.provider}/${m.model}`, m]),
    );
    expect(byKey.get("anthropic/claude-opus-4-7")?.hasVariants).toBe(true);
    expect(byKey.get("anthropic/claude-haiku-4-5")?.hasVariants).toBe(false);
    expect(byKey.get("anthropic/claude-sonnet-4-5")?.hasVariants).toBe(false);
  });

  it("lowercases every provider and model id in the emitted LiveModel list", () => {
    const discovery = discoverLiveModels({
      providerList: {
        all: [
          {
            id: "Anthropic",
            models: { "Claude-Opus-4-7": { variants: { High: {} } } },
          },
        ],
      },
    });
    expect(discovery.models[0]?.provider).toBe("anthropic");
    expect(discovery.models[0]?.model).toBe("claude-opus-4-7");
  });

  it("returns models sorted by `provider/model` for deterministic output", () => {
    const discovery = discoverLiveModels({
      providerList: {
        all: [
          {
            id: "openai",
            models: { "zeta": { variants: { low: {} } } },
          },
          {
            id: "anthropic",
            models: { "alpha": { variants: { high: {} } } },
          },
          {
            id: "google",
            models: { "mike": { variants: {} } },
          },
        ],
      },
    });
    expect(discovery.models.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "anthropic/alpha",
      "google/mike",
      "openai/zeta",
    ]);
  });

  it("skips per-model entries that are null or non-object without throwing", () => {
    const discovery = discoverLiveModels({
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-opus-4-7": { variants: { high: {} } },
              "claude-null": null,
              "claude-undef": undefined,
              "claude-bad": "not-an-object",
            },
          },
        ],
      },
    });
    expect(discovery.status).toBe("complete");
    expect(discovery.models.map((m) => m.model)).toEqual(["claude-opus-4-7"]);
  });
});