/**
 * supervised-model-fallback-recovery (SDD change) — PR-03.
 *
 * Engine-level coverage for design §21 PR-03 provider-diversity
 * prerequisites:
 *   - two distinct providers are used when available
 *   - a third distinct provider is selected when available
 *   - absence of an alternative provider terminates the loop without
 *     reusing the failed-model's provider (INV-003 + amendment P-03)
 *
 * Amendment P-03: provider diversity is a PREFERENCE, not an
 * invariant. A user with only one configured provider is still served
 * — the loop continues with the cheapest candidate from that same
 * provider so long as no candidate from that provider has returned
 * `provider_error` in this run.
 */
import { describe, expect, it, vi } from "vitest";
import { createFallbackEngine, type FallbackCatalogSlice, type FallbackClient } from "../src/fallback.js";
import { QuarantineStore } from "../src/quarantine.js";
import { classifyError } from "../src/error-classification.js";
import { DEFAULT_LADDER } from "../src/policy.js";

function makeCatalog(
  byBase: Record<string, Array<{ modelId: string }>>,
): FallbackCatalogSlice {
  return {
    byBase: Object.fromEntries(
      Object.entries(byBase).map(([k, v]) => [
        k,
        v.map((entry) => ({ ...entry, ladderRung: "openai" as const })),
      ]),
    ),
  };
}

describe("createFallbackEngine() — provider diversity preference (P-03)", () => {
  it("two distinct providers: the first fallback uses a DIFFERENT provider from the failed model", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
      ],
    });

    const attempted: string[] = [];
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: `s-${attempted.length}` })),
        prompt: vi.fn(async (opts: { body: { model?: { providerID: string; modelID: string } } }) => {
          attempted.push(`${opts.body.model?.providerID}/${opts.body.model?.modelID}`);
          return { parts: [{ type: "text", text: "task completed" }] };
        }),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("success");
    // Only one fallback attempt was needed (minimax/M3) — a different provider than openai.
    expect(attempted).toEqual(["minimax/M3"]);
  });

  it("third distinct provider: when first two providers both fail, the third fallback comes from yet another provider", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
      ],
    });

    const attempted: string[] = [];
    let callCount = 0;
    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: `s-${callCount}` })),
        prompt: vi.fn(async (opts: { body: { model?: { providerID: string; modelID: string } } }) => {
          attempted.push(`${opts.body.model?.providerID}/${opts.body.model?.modelID}`);
          callCount += 1;
          return { parts: [{ type: "text", text: "HTTP 429 too many requests" }] };
        }),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    // Engine prefers different providers: openai (failed upstream) →
    // minimax (attempt 2) → google-antigravity (attempt 3). All three
    // attempts use distinct providers.
    expect(attempted).toEqual(["minimax/M3", "google-antigravity/gemini-x"]);
    if (result.status === "exhausted") {
      expect(result.attempts.map((a) => a.provider)).toEqual([
        "openai",
        "minimax",
        "google-antigravity",
      ]);
    }
  });

  it("absence of alternative provider: when only same-provider candidates remain, the loop continues but NEVER succeeds by reusing a provider_error'd model", async () => {
    // P-03 rule 3: reuse a previously-attempted provider only when
    // (a) no other-provider candidate exists AND (b) the prior
    // attempt of that provider did not return provider_error.
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },     // failed upstream (rate_limit)
        { modelId: "openai/gpt-5.5" },           // same provider, different model
        { modelId: "openai/o1-preview" },        // same provider, third model
      ],
    });

    const client: FallbackClient = {
      session: {
        create: vi.fn(async () => ({ id: "s-only-openai" })),
        prompt: vi.fn(async () => ({
          parts: [{ type: "text", text: "HTTP 429 too many requests" }],
        })),
      },
    };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      // All three attempts share the openai provider (no alternative exists).
      expect(result.attempts.map((a) => a.provider)).toEqual(["openai", "openai", "openai"]);
      // All three OpenAI models are exhausted, but the loop DID continue
      // because no prior provider_error came from this provider.
      expect(result.attempts.length).toBe(3);
    }
  });

  it("absence of any alternative provider: SINGLE-provider catalog stops at 1 attempt (no candidate exists)", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }],
    });

    quarantine.add("openai/gpt-4.1-mini", "rate_limit", 3_600_000, "rate_limit");

    const create = vi.fn();
    const prompt = vi.fn();
    const client: FallbackClient = { session: { create, prompt } };

    const engine = createFallbackEngine({
      client,
      quarantine,
      catalog,
      ladder: DEFAULT_LADDER,
      classify: classifyError,
      maxAttempts: 3,
    });

    const result = await engine.run({
      sessionID: "parent-session",
      originalSubagentType: "sdd-design",
      prompt: "do the thing",
      failedModel: "openai/gpt-4.1-mini",
      failureReason: "rate_limit",
    });

    expect(result.status).toBe("exhausted");
    expect(create).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    if (result.status === "exhausted") {
      // Only the original (failed) attempt is recorded.
      expect(result.attempts.length).toBe(1);
    }
  });
});