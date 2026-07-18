/**
 * Design v4 — Initial candidate pipeline integration (contract C).
 *
 * Drives createTaskHook with the new async `deps.live` seam so the live
 * filter runs BEFORE scoring/ranking (reversing the old at-boundary gate).
 * Uses the REAL `select()` (no mock) so the filter's effect on the
 * winning candidate is observable end-to-end.
 */
import { describe, expect, it, vi } from "vitest";

import { createTaskHook } from "../src/hooks.js";
import type { ResolveCandidates } from "../src/hooks.js";
import {
  createGeneratedProfileResolver,
  generatedProfileAlias,
  type GeneratedProfileCatalog,
} from "../src/profiles.js";
import type {
  AuditEntry,
  LadderRung,
  SelectCandidate,
  SelectionAuditEntry,
  SelectionRefusalCause,
} from "../src/types.js";

const LADDER: LadderRung[] = ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"];

function candidate(model: string, confidence: number, rung: LadderRung = "openai"): SelectCandidate {
  return {
    subagent_type: `alias-${model}`,
    model,
    effort: "",
    confidence,
    evidence: "curated",
    ladderRung: rung,
  };
}

function resolverReturning(candidates: SelectCandidate[]): ResolveCandidates {
  return () => candidates;
}

function hookConfig() {
  return {
    mode: "auto" as const,
    confidenceThreshold: 0.6,
    ladder: LADDER,
    allowlist: ["sdd-design"],
    denylist: [],
  };
}

async function runHook(deps: Record<string, unknown>) {
  const audit = vi.fn<(entry: AuditEntry) => void>();
  const hook = createTaskHook(hookConfig(), {
    audit,
    isAliasRegistered: () => true,
    ...deps,
  } as never);
  const output = { args: { subagent_type: "sdd-design", prompt: "refactor the module" } };
  await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c-pipe" }, output);
  return { output, audit };
}

function lastAuditEntry(audit: ReturnType<typeof vi.fn>): SelectionAuditEntry | undefined {
  const entry = audit.mock.calls[audit.mock.calls.length - 1]?.[0] as AuditEntry | undefined;
  return entry !== undefined && "decision" in entry ? entry : undefined;
}

describe("createTaskHook() — Design v4 live pipeline (C)", () => {
  it("runs the real generated-profile forecast after live filtering so a connected lower scorer wins", async () => {
    const disconnected = "anthropic/claude-opus-4-7";
    const connected = "openai/gpt-4.1-mini";
    const catalog: GeneratedProfileCatalog = {
      byBase: {
        "sdd-design": [
          {
            baseAgent: "sdd-design",
            alias: generatedProfileAlias("sdd-design", disconnected),
            provider: "anthropic",
            model: "claude-opus-4-7",
            modelId: disconnected,
            ladderRung: "anthropic",
          },
          {
            baseAgent: "sdd-design",
            alias: generatedProfileAlias("sdd-design", connected),
            provider: "openai",
            model: "gpt-4.1-mini",
            modelId: connected,
            ladderRung: "openai",
          },
        ],
      },
    };
    const resolver = createGeneratedProfileResolver(catalog, {
      now: new Date("2026-07-17T00:00:00.000Z"),
    });
    const unfiltered = resolver({
      originalSubagentType: "sdd-design",
      ladder: LADDER,
      context: { phase: "sdd-design", contextBreadth: "wide", riskDomain: "architecture" },
      policy: { mode: "auto", confidenceThreshold: 0.6 },
      args: { subagent_type: "sdd-design" },
    });
    expect(unfiltered.find((candidate) => candidate.model === disconnected)!.confidence)
      .toBeGreaterThan(unfiltered.find((candidate) => candidate.model === connected)!.confidence);

    const { output } = await runHook({
      resolveCandidates: resolver,
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: [connected] }),
      },
    });
    expect(output.args.subagent_type).toBe(generatedProfileAlias("sdd-design", connected));
  });

  it("#2 cold-cache pipeline picks connected lower-ranked over disconnected higher-ranked", async () => {
    const { output } = await runHook({
      resolveCandidates: resolverReturning([
        candidate("openai/disconnected", 0.95),
        candidate("anthropic/connected", 0.7),
      ]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["anthropic/connected"] }),
      },
    });
    // The disconnected higher-scored candidate was filtered out BEFORE
    // select(); the connected lower-scored candidate wins the rewrite.
    expect(output.args.subagent_type).toBe("alias-anthropic/connected");
  });

  it("#4 injected resolver output is live-filtered before selection", async () => {
    const { output } = await runHook({
      resolveCandidates: resolverReturning([
        candidate("openai/a", 0.9),
        candidate("openai/b", 0.85),
        candidate("anthropic/only-connected", 0.7),
      ]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["anthropic/only-connected"] }),
      },
    });
    expect(output.args.subagent_type).toBe("alias-anthropic/only-connected");
  });

  it("#14 required + unavailable resolver => keep-default with live_snapshot_unavailable", async () => {
    const { output, audit } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/a", 0.9)]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "unavailable", models: [] }),
      },
    });
    expect(output.args.subagent_type).toBe("sdd-design");
    const entry = lastAuditEntry(audit);
    expect(entry?.refusalCause).toBe<"live_snapshot_unavailable">("live_snapshot_unavailable");
  });

  it("required policy keeps default when the resolver rejects", async () => {
    const { output, audit } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/a", 0.9)]),
      live: {
        policy: "required",
        resolve: async () => {
          throw new Error("provider unavailable");
        },
      },
    });
    expect(output.args.subagent_type).toBe("sdd-design");
    expect(lastAuditEntry(audit)?.refusalCause).toBe("live_snapshot_unavailable");
  });

  it("#14 disabled policy => legacy behavior (no live filter; switch proceeds)", async () => {
    const { output } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/anything", 0.9)]),
      live: {
        policy: "disabled",
        // Even though "openai/anything" is not in the connected set, the
        // disabled policy MUST skip the live filter entirely.
        resolve: async () => ({ status: "ready", models: ["anthropic/other"] }),
      },
    });
    expect(output.args.subagent_type).toBe("alias-openai/anything");
  });

  it("#C all candidates disconnected => keep-default with candidate_not_live", async () => {
    const { output, audit } = await runHook({
      resolveCandidates: resolverReturning([
        candidate("openai/a", 0.9),
        candidate("openai/b", 0.8),
      ]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["anthropic/x"] }),
      },
    });
    expect(output.args.subagent_type).toBe("sdd-design");
    const entry = lastAuditEntry(audit);
    expect(entry?.refusalCause).toBe<"candidate_not_live">("candidate_not_live");
  });

  it("filters quarantined candidates before selection so the next ranked candidate can win", async () => {
    const { output } = await runHook({
      resolveCandidates: resolverReturning([
        candidate("openai/quarantined", 0.95),
        candidate("openai/eligible", 0.8),
      ]),
      quarantine: {
        isBlocked: (model: string) => model === "openai/quarantined",
      },
      live: {
        policy: "required",
        resolve: async () => ({
          status: "ready",
          models: ["openai/quarantined", "openai/eligible"],
        }),
      },
    });
    expect(output.args.subagent_type).toBe("alias-openai/eligible");
  });

  it("preserves confidence threshold and effort/variant on a live candidate", async () => {
    const highEffort = { ...candidate("openai/live", 0.9), effort: "high" as const };
    const accepted = await runHook({
      resolveCandidates: resolverReturning([highEffort]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["openai/live"] }),
      },
    });
    expect(accepted.output.args.subagent_type).toBe("alias-openai/live");
    expect(lastAuditEntry(accepted.audit)?.decision.effort).toBe("high");

    const belowThreshold = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/live", 0.59)]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["openai/live"] }),
      },
    });
    expect(belowThreshold.output.args.subagent_type).toBe("sdd-design");
    expect(lastAuditEntry(belowThreshold.audit)?.decision.action).toBe("keep-default");
  });

  it("keeps the default when the selected alias is not registered", async () => {
    const { output } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/live", 0.9)]),
      isAliasRegistered: () => false,
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["openai/live"] }),
      },
    });
    expect(output.args.subagent_type).toBe("sdd-design");
  });

  it("fails closed when an injected ready result has malformed models", async () => {
    const { output, audit } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/live", 0.9)]),
      live: {
        policy: "required",
        resolve: async () => ({ status: "ready", models: ["openai/live", 7] } as never),
      },
    });
    expect(output.args.subagent_type).toBe("sdd-design");
    expect(lastAuditEntry(audit)?.refusalCause).toBe("live_snapshot_unavailable");
  });

  it("existing quarantine boundary behavior is preserved when no live seam is wired", async () => {
    // Legacy path: deps.live absent => the boundary getLiveAvailability
    // gate still applies (fail-closed on the selected candidate).
    const { output } = await runHook({
      resolveCandidates: resolverReturning([candidate("openai/a", 0.9)]),
      getLiveAvailability: () => ({
        ready: false,
        models: new Set<string>(),
        reason: "unavailable",
        source: "none" as const,
      }),
    });
    expect(output.args.subagent_type).toBe("sdd-design");
  });
});
