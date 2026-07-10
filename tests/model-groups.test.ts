/**
 * Tests for `src/model-groups.ts` — provider-prefix group expansion.
 *
 * The contract under test (this PR adds two new behaviours):
 *   - `resolveProviderGroup(provider)` returns all registry keys whose
 *     provider (substring before the first `/`) equals the requested
 *     provider. Case-insensitive. Unknown provider → `[]`.
 *   - `resolveQuarantineTarget(target)` accepts either `provider/*`
 *     (an explicit group that expands to all provider members) or
 *     `provider/model` (an individual id that ALWAYS resolves to the
 *     singleton `[id]`, including Gemini Flash — no implicit family
 *     expansion). Empty → `[]`. Whitespace is trimmed.
 *   - `listKnownProviders()` returns the distinct set of provider
 *     prefixes known to the registry, in registry order.
 *   - The existing `resolveModelGroup` contract (Gemini Flash expansion,
 *     singleton for everything else) stays unchanged.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { setRepoLocal } from "../src/benchmark-registry.js";
import {
  listKnownProviders,
  providerOf,
  resolveModelGroup,
  resolveProviderGroup,
  resolveQuarantineTarget,
} from "../src/model-groups.js";

beforeEach(() => {
  setRepoLocal(null);
});

afterEach(() => {
  setRepoLocal(null);
});

describe("providerOf", () => {
  it("returns the substring before the first slash", () => {
    expect(providerOf("openai/gpt-5.5")).toBe("openai");
    expect(providerOf("opencode-go/deepseek-v4-pro")).toBe("opencode-go");
    expect(providerOf("google/gemini-3.5-flash")).toBe("google");
  });

  it("returns lowercase form", () => {
    expect(providerOf("OpenAI/gpt-5.5")).toBe("openai");
  });

  it("returns empty string when no slash or starts with slash", () => {
    expect(providerOf("noslash")).toBe("");
    expect(providerOf("/model")).toBe("");
  });
});

describe("resolveProviderGroup", () => {
  it("returns all opencode-go registry keys for 'opencode-go'", () => {
    const group = resolveProviderGroup("opencode-go");
    expect(group.length).toBeGreaterThan(0);
    for (const key of group) {
      expect(key.startsWith("opencode-go/")).toBe(true);
    }
    expect(group).toContain("opencode-go/deepseek-v4-pro");
    expect(group).toContain("opencode-go/glm-5.2");
  });

  it("returns all openai registry keys for 'openai'", () => {
    const group = resolveProviderGroup("openai");
    expect(group.length).toBeGreaterThan(0);
    for (const key of group) {
      expect(key.startsWith("openai/")).toBe(true);
    }
    expect(group).toContain("openai/gpt-5.5");
    expect(group).toContain("openai/o4-mini");
  });

  it("returns all google registry keys for 'google'", () => {
    const group = resolveProviderGroup("google");
    expect(group.length).toBeGreaterThan(0);
    for (const key of group) {
      expect(key.startsWith("google/")).toBe(true);
    }
    expect(group).toContain("google/gemini-3.5-flash");
    expect(group).toContain("google/antigravity-gemini-3-flash");
  });

  it("match is case-insensitive", () => {
    const lower = resolveProviderGroup("openai");
    const upper = resolveProviderGroup("OpenAI");
    const mixed = resolveProviderGroup("oPeNaI");
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBe(mixed.length);
  });

  it("returns empty array for unknown provider", () => {
    expect(resolveProviderGroup("nonexistent-provider")).toEqual([]);
  });

  it("returns empty array for empty provider", () => {
    expect(resolveProviderGroup("")).toEqual([]);
  });

  it("does NOT cross provider boundaries", () => {
    // Critical regression: opencode-go/deepseek-v4-pro must NOT appear in
    // the deepseek/* group — separate providers, separate groups.
    const opencodeGoGroup = resolveProviderGroup("opencode-go");
    const deepseekGroup = resolveProviderGroup("deepseek");
    expect(opencodeGoGroup).not.toContain("deepseek/deepseek-v4-pro");
    expect(deepseekGroup).not.toContain("opencode-go/deepseek-v4-pro");
  });
});

describe("resolveQuarantineTarget — provider/* form", () => {
  it("returns every opencode-go model for 'opencode-go/*'", () => {
    const result = resolveQuarantineTarget("opencode-go/*");
    expect(result.length).toBeGreaterThan(0);
    for (const key of result) {
      expect(key.startsWith("opencode-go/")).toBe(true);
    }
  });

  it("returns every openai model for 'openai/*'", () => {
    const result = resolveQuarantineTarget("openai/*");
    expect(result.length).toBeGreaterThan(0);
    for (const key of result) {
      expect(key.startsWith("openai/")).toBe(true);
    }
  });

  it("trims whitespace around the target", () => {
    const trimmed = resolveQuarantineTarget("  openai/*  ");
    const exact = resolveQuarantineTarget("openai/*");
    expect(trimmed).toEqual(exact);
  });

  it("returns empty array for unknown provider prefix", () => {
    expect(resolveQuarantineTarget("nonexistent-provider/*")).toEqual([]);
  });

  it("returns empty array for empty target", () => {
    expect(resolveQuarantineTarget("")).toEqual([]);
    expect(resolveQuarantineTarget("   ")).toEqual([]);
  });
});

describe("resolveQuarantineTarget — provider/model form", () => {
  it("returns singleton for a non-group model id", () => {
    const result = resolveQuarantineTarget("anthropic/claude-opus-4-8");
    expect(result).toEqual(["anthropic/claude-opus-4-8"]);
  });

  it("returns a singleton for a Google non-Flash model id", () => {
    const result = resolveQuarantineTarget("google/gemini-3.1-pro");
    expect(result).toEqual(["google/gemini-3.1-pro"]);
  });

  it("returns a singleton for an individual Gemini Flash alias (no implicit family expansion)", () => {
    const result = resolveQuarantineTarget("google/gemini-3.5-flash");
    expect(result).toEqual(["google/gemini-3.5-flash"]);
  });

  it("returns a singleton for an individual antigravity alias too", () => {
    const result = resolveQuarantineTarget("google/antigravity-gemini-3-flash");
    expect(result).toEqual(["google/antigravity-gemini-3-flash"]);
  });
});

describe("resolveModelGroup — regression (existing behaviour preserved)", () => {
  it("returns singleton for non-Gemini-Flash models", () => {
    expect(resolveModelGroup("anthropic/claude-opus-4-8")).toEqual(["anthropic/claude-opus-4-8"]);
    expect(resolveModelGroup("openai/gpt-5.5")).toEqual(["openai/gpt-5.5"]);
    expect(resolveModelGroup("deepseek/deepseek-v4-pro")).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("expands Gemini Flash group", () => {
    const group = resolveModelGroup("google/gemini-3.5-flash");
    expect(group.length).toBeGreaterThan(1);
    expect(group).toContain("google/gemini-3.5-flash");
  });

  it("opencode-go/* group does NOT include deepseek/*", () => {
    expect(resolveModelGroup("opencode-go/deepseek-v4-pro")).toEqual(["opencode-go/deepseek-v4-pro"]);
  });
});

describe("listKnownProviders", () => {
  it("includes the major providers from the compiled registry", () => {
    const providers = listKnownProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers).toContain("google");
    expect(providers).toContain("deepseek");
    expect(providers).toContain("opencode-go");
  });

  it("returns each provider only once", () => {
    const providers = listKnownProviders();
    const set = new Set(providers);
    expect(set.size).toBe(providers.length);
  });
});

describe("repo-local override is respected by resolveProviderGroup", () => {
  it("includes a repo-local entry under its provider prefix", () => {
    setRepoLocal([
      {
        key: "openai/gpt-99-test",
        benchmarks: { mmlu: 0.9 },
        availability: "available",
        source: "repo-local",
        date: "2026-07-08",
        confidence: 0.9,
      },
    ]);
    const group = resolveProviderGroup("openai");
    expect(group).toContain("openai/gpt-99-test");
  });
});