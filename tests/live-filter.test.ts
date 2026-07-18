/**
 * Design v4 — Live-gate filter (contract C).
 *
 * Pure tests for the candidate-pipeline live filter. The filter runs
 * BEFORE scoring/ranking so a disconnected higher-ranked candidate
 * cannot win or block a connected lower-ranked candidate.
 */
import { describe, expect, it } from "vitest";

import { applyLiveGate } from "../src/live-filter.js";
import type { SelectCandidate } from "../src/types.js";

function candidate(model: string, confidence: number): SelectCandidate {
  return {
    subagent_type: `alias-${model}`,
    model,
    effort: "",
    confidence,
    evidence: "curated",
    ladderRung: "openai",
  };
}

describe("applyLiveGate — policy disabled / absent (C compatibility bypass)", () => {
  it("disabled policy leaves candidates untouched (legacy behavior)", () => {
    const out = applyLiveGate(
      [candidate("openai/disconnected", 0.9)],
      { status: "ready", models: ["anthropic/other"] },
      "disabled",
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.refusalCause).toBeUndefined();
  });

  it("required policy fails closed when the live resolver has no outcome", () => {
    const out = applyLiveGate(
      [candidate("openai/a", 0.9)],
      undefined,
      "required",
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.refusalCause).toBe("live_snapshot_unavailable");
  });
});

describe("applyLiveGate — required policy, unavailable live (C fail-safe)", () => {
  it("required + unavailable => empty candidates + live_snapshot_unavailable", () => {
    const out = applyLiveGate(
      [candidate("openai/a", 0.9)],
      { status: "unavailable", models: [] },
      "required",
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.refusalCause).toBe("live_snapshot_unavailable");
  });

  it.each([
    ["null outcome", null],
    ["ready without models", { status: "ready" }],
    ["non-array models", { status: "ready", models: "openai/a" }],
    ["empty ready models", { status: "ready", models: [] }],
    ["mixed ready models", { status: "ready", models: ["openai/a", 7] }],
  ])("fails closed without throwing for malformed injected live result: %s", (_label, outcome) => {
    expect(() => applyLiveGate(
      [candidate("openai/a", 0.9)],
      outcome as never,
      "required",
    )).not.toThrow();
    expect(applyLiveGate(
      [candidate("openai/a", 0.9)],
      outcome as never,
      "required",
    )).toEqual({ candidates: [], refusalCause: "live_snapshot_unavailable" });
  });
});

describe("applyLiveGate — required policy, ready live (C exact filter)", () => {
  it("removes a disconnected higher-ranked candidate so a connected lower-ranked one can win", () => {
    const out = applyLiveGate(
      [
        candidate("openai/disconnected", 0.95),
        candidate("anthropic/connected", 0.7),
      ],
      { status: "ready", models: ["anthropic/connected"] },
      "required",
    );
    expect(out.candidates).toEqual([candidate("anthropic/connected", 0.7)]);
    expect(out.refusalCause).toBeUndefined();
  });

  it("exact join supports multi-slash model ids without family rewriting", () => {
    // A multi-slash id must match EXACTLY. `anthropic/claude-opus-4-7` is NOT
    // live when only `anthropic/claude-opus-4-8` is connected — no family
    // equivalence is applied.
    const out = applyLiveGate(
      [candidate("anthropic/claude-opus-4-7", 0.9)],
      { status: "ready", models: ["anthropic/claude-opus-4-8"] },
      "required",
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.refusalCause).toBe("candidate_not_live");
  });

  it("matches a multi-slash connected id exactly", () => {
    const out = applyLiveGate(
      [candidate("opencode-go/sub/deepseek-v4-pro", 0.9)],
      { status: "ready", models: ["opencode-go/sub/deepseek-v4-pro"] },
      "required",
    );
    expect(out.candidates).toHaveLength(1);
  });

  it("keeps candidates whose exact model is connected (case-preserving exact match)", () => {
    const out = applyLiveGate(
      [candidate("OpenAI/GPT-5.5", 0.9)],
      { status: "ready", models: ["OpenAI/GPT-5.5"] },
      "required",
    );
    expect(out.candidates).toHaveLength(1);
  });

  it("all disconnected => empty candidates + candidate_not_live", () => {
    const out = applyLiveGate(
      [candidate("openai/a", 0.9), candidate("openai/b", 0.8)],
      { status: "ready", models: ["anthropic/other"] },
      "required",
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.refusalCause).toBe("candidate_not_live");
  });
});
