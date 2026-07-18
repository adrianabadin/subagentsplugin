/**
 * Design v4 — Permission propagation (contract A6).
 *
 * OpenCode task permissions use ordered wildcard matching; the LAST
 * matching rule wins. Generated aliases get an EXACT `__mf_` allow only
 * when the base agent is effectively allowed, and stale exact `__mf_`
 * entries are removed. The orchestrator is NEVER inferred from map
 * presence.
 */
import { describe, expect, it } from "vitest";

import {
  effectiveTaskAllowed,
  generatedProfileAlias,
  generateProfilesForConfig,
  propagateAliasPermissions,
  wildcardMatch,
} from "../src/profiles.js";

describe("wildcardMatch", () => {
  it("matches exact", () => {
    expect(wildcardMatch("sdd-design", "sdd-design")).toBe(true);
    expect(wildcardMatch("sdd-design", "sdd-spec")).toBe(false);
  });
  it("matches a single trailing * wildcard", () => {
    expect(wildcardMatch("sdd-*", "sdd-design")).toBe(true);
    expect(wildcardMatch("sdd-*", "jd-judge-a")).toBe(false);
  });
  it("matches a bare * wildcard", () => {
    expect(wildcardMatch("*", "anything")).toBe(true);
  });
});

describe("generateProfilesForConfig — generated namespace cleanup", () => {
  it("removes stale exact generated permissions even when no base profile remains", () => {
    const staleAlias = generatedProfileAlias("sdd-design", "openai/removed");
    const config = {
      agent: {
        orchestrator: {
          permission: { task: { [staleAlias]: "allow", "jd-*": "allow" } },
        },
      },
    };
    generateProfilesForConfig(config, []);
    expect(config.agent.orchestrator.permission.task).toEqual({ "jd-*": "allow" });
  });

  it("preserves user-created __mf_ agents and permissions that are not canonical managed aliases", () => {
    const config = {
      agent: {
        orchestrator: { permission: { task: { __mf_custom: "deny" } } },
        __mf_custom: { description: "user-created agent" },
      },
    };
    generateProfilesForConfig(config, []);
    expect(config.agent.__mf_custom).toBeDefined();
    expect(config.agent.orchestrator.permission.task.__mf_custom).toBe("deny");
  });

  it("removes canonical legacy primary and fallback aliases without description ownership", () => {
    const primary = generatedProfileAlias("sdd-design", "openai/removed");
    const fallback = `${primary}-fallback`;
    const config: { agent: Record<string, Record<string, unknown>> } = {
      agent: {
        [primary]: { description: "changed by a user" },
        [fallback]: { description: "also changed" },
        orchestrator: { permission: { task: { [primary]: "allow", [fallback]: "allow" } } },
      },
    };
    generateProfilesForConfig(config, []);
    expect(config.agent[primary]).toBeUndefined();
    expect(config.agent[fallback]).toBeUndefined();
    expect(config.agent.orchestrator?.permission).toEqual({ task: {} });
  });
});

describe("effectiveTaskAllowed — ordered wildcard last-match-wins", () => {
  it("allow overrides an earlier deny when the later wildcard also matches", () => {
    expect(effectiveTaskAllowed({ "*": "deny", "sdd-*": "allow" }, "sdd-design")).toBe(true);
  });
  it("deny overrides an earlier allow (last match wins)", () => {
    expect(effectiveTaskAllowed({ "sdd-*": "allow", "sdd-design": "deny" }, "sdd-design")).toBe(false);
  });
  it("ask overrides an earlier allow and is not unconditional access", () => {
    expect(effectiveTaskAllowed({ "sdd-*": "allow", "sdd-design": "ask" }, "sdd-design")).toBe(false);
  });
  it("a malformed final match does not retain an earlier unconditional allow", () => {
    expect(effectiveTaskAllowed({ "sdd-*": "allow", "sdd-design": "unexpected" }, "sdd-design")).toBe(false);
  });
  it("top-level 'ask' is not unconditional access", () => {
    expect(effectiveTaskAllowed("ask", "sdd-design")).toBe(false);
  });
  it("no matching rule => not allowed", () => {
    expect(effectiveTaskAllowed({ "jd-*": "allow" }, "sdd-design")).toBe(false);
  });
  it("top-level 'allow' string allows everything", () => {
    expect(effectiveTaskAllowed("allow", "sdd-design")).toBe(true);
  });
});

describe("propagateAliasPermissions — exact alias allow + stale cleanup", () => {
  type Agent = { permission?: { task?: Record<string, unknown> | string } };

  it("adds exact alias allow only when the base is effectively allowed", () => {
    const holder: Agent = { permission: { task: { "sdd-*": "allow" } } };
    propagateAliasPermissions(
      { holder },
      "sdd-design",
      ["__mf_newalias"],
      [],
    );
    expect(holder.permission?.task).toMatchObject({ __mf_newalias: "allow" });
  });

  it("does NOT add alias allow when the base is effectively denied", () => {
    const holder: Agent = { permission: { task: { "sdd-design": "deny" } } };
    propagateAliasPermissions(
      { holder },
      "sdd-design",
      ["__mf_newalias"],
      [],
    );
    expect((holder.permission?.task as Record<string, unknown>)?.__mf_newalias).toBeUndefined();
  });

  it("does NOT add alias allow when the base is effectively ask", () => {
    const holder: Agent = { permission: { task: { "sdd-*": "allow", "sdd-design": "ask" } } };
    propagateAliasPermissions({ holder }, "sdd-design", ["__mf_newalias"], []);
    expect((holder.permission?.task as Record<string, unknown>)?.__mf_newalias).toBeUndefined();
  });

  it.each(["deny", "ask"])("does not overwrite an existing exact alias %s with allow", (decision) => {
    const holder: Agent = {
      permission: { task: { "sdd-design": "allow", __mf_newalias: decision } },
    };
    propagateAliasPermissions({ holder }, "sdd-design", ["__mf_newalias"], []);
    expect((holder.permission?.task as Record<string, unknown>).__mf_newalias).toBe(decision);
  });

  it("removes stale exact __mf_ entries that are no longer registered", () => {
    const holder: Agent = {
      permission: { task: { __mf_oldalias: "allow", "sdd-design": "allow" } },
    };
    propagateAliasPermissions(
      { holder },
      "sdd-design",
      ["__mf_newalias"],
      ["__mf_oldalias"],
    );
    const task = holder.permission?.task as Record<string, unknown>;
    expect(task.__mf_oldalias).toBeUndefined();
    expect(task.__mf_newalias).toBe("allow");
  });

  it("never infers the orchestrator from map presence (no alias added when base absent from task map and no wildcard allows)", () => {
    // The holder's task map does not mention the base nor any matching
    // wildcard; presence of OTHER entries must not grant the alias.
    const holder: Agent = { permission: { task: { "jd-judge-a": "allow" } } };
    propagateAliasPermissions(
      { holder },
      "sdd-design",
      ["__mf_newalias"],
      [],
    );
    expect((holder.permission?.task as Record<string, unknown>)?.__mf_newalias).toBeUndefined();
  });
});
