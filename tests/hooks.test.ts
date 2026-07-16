import { describe, expect, it, vi } from "vitest";

import { createAfterHook, createTaskHook, detectRateLimit, parseGeneratedAlias, detectProviderError, matchProviderErrorReason } from "../src/hooks.js";
import { QuarantineStore, type QuarantineBlocklist } from "../src/quarantine.js";
import { generatedProfileAlias } from "../src/profiles.js";
import { DEFAULT_LADDER } from "../src/policy.js";
import { AttemptCoordinator } from "../src/attempt-coordinator.js";
import { Logger } from "../src/logger.js";
import type { AuditEntry, LadderRung, SelectDecision } from "../src/types.js";

function decision(overrides: Partial<SelectDecision> = {}): SelectDecision {
  return {
    action: "switch",
    subagent_type: "sdd-design-alto",
    model: "openai/gpt-5.5",
    effort: "high",
    reason: "test decision",
    confidence: 0.8,
    evidence: "test evidence",
    ...overrides,
  };
}

function readyAvailabilityFor(...models: string[]) {
  return {
    ready: true,
    models: new Set(models),
    reason: "",
    source: "provider-list" as const,
  };
}

describe("createTaskHook()", () => {
  it("rewrites task subagent_type only when mode is auto and allowlist matches", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        audit,
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design-alto");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("keeps default outside auto mode", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "advisory",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        audit,
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps default when allowlist does not match", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-verify"],
        denylist: [],
      },
      {
        select: () => decision(),
        audit,
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps default when decision is keep-default", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision({ action: "keep-default", subagent_type: "" }),
        audit,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("keeps default when recommended model is denylisted", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: ["openai/gpt-5.5"],
      },
      {
        select: () => decision(),
        audit,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("bypasses true re-entry (same callID triggers hook twice)", async () => {
    // S2 recursion-guard precision: the guard blocks TRUE re-entry (the same
    // hook callID being processed twice by the hook itself). A repeat with a
    // different callID is a legitimate second task launch and MUST be
    // processed, NOT bypassed. This test pins the same-callID arm.
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        audit,
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const first = { args: { subagent_type: "sdd-design", prompt: "work" } };
    // Same callID = same OpenCode hook invocation being re-entered.
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, first);
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, first);

    // The second invocation with the same callID MUST be bypassed: the
    // subagent_type stays "sdd-design" and no second audit entry is written.
    expect(first.args.subagent_type).toBe("sdd-design-alto");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("processes different callIDs in the same session (S2 — no over-blocking)", async () => {
    // Counterpart to the above: legitimate second task launches in the
    // same session have DIFFERENT callIDs. The recursion guard MUST allow
    // them through so cost optimisation works on every distinct call.
    // The previous per-session-recursion guard suppressed this — fixed in
    // PR3 by tracking callID instead of sessionID.
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        audit,
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const first = { args: { subagent_type: "sdd-design", prompt: "work" } };
    const second = { args: { subagent_type: "sdd-design", prompt: "again" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, first);
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c2" }, second);

    // BOTH calls processed independently — switch applies to both.
    expect(first.args.subagent_type).toBe("sdd-design-alto");
    expect(second.args.subagent_type).toBe("sdd-design-alto");
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("keeps default when select returns switch with empty subagent_type (missing alias)", async () => {
    // PR2 W1: the missing-alias arm of the refused-rewrite path was
    // un-covered. Spec #1274 "Safe task rewrite" requires that when the
    // decision is a switch but its subagent_type is empty (the alias
    // ladder is missing), the hook MUST downgrade to keep-default with a
    // reason and audit the refusal.
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () =>
          decision({
            action: "switch",
            subagent_type: "",
            model: "openai/gpt-5.5",
          }),
        audit,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    // Original subagent_type is preserved — no rewrite.
    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).toHaveBeenCalledOnce();
    const auditedEntry = audit.mock.calls[0]?.[0];
    expect(auditedEntry.decision.action).toBe("keep-default");
    expect(auditedEntry.decision.reason.toLowerCase()).toContain("alias");
  });

  it("audits phaseMatched=true when the subagent_type resolves to a known phase (incl. -alto variant)", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision({ action: "keep-default", subagent_type: "" }),
        audit,
      },
    );

    const output = { args: { subagent_type: "sdd-design-alto", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0].phaseMatched).toBe(true);
  });

  it("lets an unknown subagent_type proceed (no block) and records phaseMatched=false in the audit", async () => {
    // Spec: truly-unknown subagent types MUST NOT block the task. The
    // hook keeps the default and records a structured warning
    // (phaseMatched=false) so the user knows the pattern was unmatched.
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: [], // empty allowlist = matches everything
        denylist: [],
      },
      {
        select: () => decision({ action: "keep-default", subagent_type: "" }),
        audit,
      },
    );

    const output = { args: { subagent_type: "some-custom-agent", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    // Task proceeds untouched (not blocked, not rewritten).
    expect(output.args.subagent_type).toBe("some-custom-agent");
    expect(audit).toHaveBeenCalledOnce();
    const entry = audit.mock.calls[0]?.[0];
    expect(entry.phaseMatched).toBe(false);
    expect(entry.originalSubagentType).toBe("some-custom-agent");
  });

  it("ignores non-task tools", async () => {
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      { select: () => decision() },
    );

    const output = { args: { subagent_type: "sdd-design" } };
    await hook({ tool: { id: "read" }, sessionID: "s1", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
  });

  it("emits a stderr warning when auto-mode rewrite is refused (S1 loud advisory)", async () => {
    // Spec #1274 "Safe task rewrite" requires a loud advisory warning when
    // the auto hook refuses to rewrite. The audit trail captures intent;
    // this test pins the runtime-visible warning that surfaces in the
    // orchestrator's stderr so it cannot be silently ignored.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const hook = createTaskHook(
        {
          mode: "auto",
          confidenceThreshold: 0.6,
          ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
          allowlist: ["sdd-design"],
          denylist: ["openai/gpt-5.5"],
        },
        {
          select: () => decision(), // would switch to a denylisted model
          audit: vi.fn(),
        },
      );

      const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
      await hook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
        output,
      );

      expect(output.args.subagent_type).toBe("sdd-design"); // kept default
      // Stderr received at least one warning line mentioning the refusal.
      const stderrWrites = stderrSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("");
      expect(stderrWrites.toLowerCase()).toMatch(/warn|refus|denylist|keep.*default/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("classifies task complexity from prompt (error-fixing, simple, vague)", async () => {
    const runSelection = vi.fn().mockImplementation(() => decision());
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: runSelection,
      },
    );

    // 1. Error correction prompt -> "remediation" domain + "wide" contextBreadth
    const outputError = { args: { subagent_type: "sdd-design", prompt: "Fix vitest error: expected 1 to be 2. Let's fix this bug." } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, outputError);
    expect(runSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          contextBreadth: "wide",
          riskDomain: "remediation",
        }),
      }),
    );

    // 2. Simple prompt -> "narrow" contextBreadth
    const outputSimple = { args: { subagent_type: "sdd-design", prompt: "Write simple code. Trivial mechanical change. Pre-armado structure." } };
    await hook({ tool: { id: "task" }, sessionID: "s2", callID: "c2" }, outputSimple);
    expect(runSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          contextBreadth: "narrow",
          riskDomain: undefined,
        }),
      }),
    );

    // 3. Vague/Abstract prompt -> "wide" contextBreadth + "architecture" domain
    const outputAbstract = { args: { subagent_type: "sdd-design", prompt: "Designing a brand new architecture from scratch. This is a vague abstract task containing heavy refactoring of our entire payment flow. We need to completely rethink the domain models and rewrite the storage adapters to decouple them from the SQL database. This is a broad architectural redesign that will touch multiple modules." } };
    await hook({ tool: { id: "task" }, sessionID: "s3", callID: "c3" }, outputAbstract);
    expect(runSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          contextBreadth: "wide",
          riskDomain: "architecture",
        }),
      }),
    );
  });
});

describe("createTaskHook() — final live authorization refusal", () => {
  const config = {
    mode: "auto" as const,
    confidenceThreshold: 0.6,
    ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"] as const,
    allowlist: ["sdd-design"],
    denylist: [],
  };

  function readyLive(...models: string[]) {
    return {
      ready: true,
      models: new Set(models),
      reason: "",
      source: "provider-list" as const,
    };
  }

  function unavailableLive(reason = "provider.list timed out") {
    return {
      ready: false,
      models: new Set<string>(),
      reason,
      source: "none" as const,
    };
  }

  function output() {
    return { args: { subagent_type: "sdd-design", prompt: "work" } };
  }

  it("rewrites and tracks only an exact live, non-quarantined switch", async () => {
    const tracking = new Map<string, unknown>();
    const audit = vi.fn();
    const warnSink = vi.fn();
    const quarantine = { isBlocked: vi.fn(() => false) };
    const hook = createTaskHook(config, {
      select: () => decision(),
      tracking: tracking as never,
      quarantine,
      getLiveAvailability: () => readyLive("openai/gpt-5.5"),
      audit,
      warnSink,
    });
    const result = output();

    await hook({ tool: "task", sessionID: "s1", callID: "eligible" }, result);

    expect(quarantine.isBlocked).toHaveBeenCalledOnce();
    expect(quarantine.isBlocked).toHaveBeenCalledWith("openai/gpt-5.5");
    expect(result.args.subagent_type).toBe("sdd-design-alto");
    expect(tracking.get("eligible")).toMatchObject({
      originalSubagentType: "sdd-design",
      targetAlias: "sdd-design-alto",
      model: "openai/gpt-5.5",
    });
    expect(warnSink).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).not.toHaveProperty("refusalCause");
  });

  it("refuses an exact quarantined switch once without tracking or another candidate", async () => {
    const tracking = new Map<string, unknown>();
    const audit = vi.fn();
    const warnSink = vi.fn();
    const select = vi.fn(() => decision());
    const hook = createTaskHook(config, {
      select,
      tracking: tracking as never,
      quarantine: { isBlocked: (model) => model === "openai/gpt-5.5" },
      getLiveAvailability: () => readyLive("openai/gpt-5.5", "openai/gpt-5.4"),
      audit,
      warnSink,
    });
    const result = output();

    await hook({ tool: "task", sessionID: "s1", callID: "quarantined" }, result);

    expect(select).toHaveBeenCalledOnce();
    expect(result.args.subagent_type).toBe("sdd-design");
    expect(tracking.size).toBe(0);
    expect(warnSink).toHaveBeenCalledOnce();
    expect(warnSink).toHaveBeenCalledWith(expect.stringMatching(/openai\/gpt-5\.5.*candidate_quarantined/));
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      refusalCause: "candidate_quarantined",
      decision: {
        action: "keep-default",
        model: "openai/gpt-5.5",
      },
    });
  });

  it("refuses a switch when the current live snapshot is unavailable", async () => {
    const tracking = new Map<string, unknown>();
    const audit = vi.fn();
    const warnSink = vi.fn();
    const hook = createTaskHook(config, {
      select: () => decision(),
      tracking: tracking as never,
      quarantine: { isBlocked: () => false },
      getLiveAvailability: () => unavailableLive(),
      audit,
      warnSink,
    });
    const result = output();

    await hook({ tool: "task", sessionID: "s1", callID: "unavailable" }, result);

    expect(result.args.subagent_type).toBe("sdd-design");
    expect(tracking.size).toBe(0);
    expect(warnSink).toHaveBeenCalledOnce();
    expect(warnSink).toHaveBeenCalledWith(expect.stringMatching(/openai\/gpt-5\.5.*live_snapshot_unavailable/));
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      refusalCause: "live_snapshot_unavailable",
      decision: { action: "keep-default" },
    });
  });

  it("refuses a switch whose exact case-preserving key is absent from the live snapshot", async () => {
    const tracking = new Map<string, unknown>();
    const audit = vi.fn();
    const warnSink = vi.fn();
    const hook = createTaskHook(config, {
      select: () => decision(),
      tracking: tracking as never,
      quarantine: { isBlocked: () => false },
      getLiveAvailability: () => readyLive("OpenAI/gpt-5.5", "openai/GPT-5.5"),
      audit,
      warnSink,
    });
    const result = output();

    await hook({ tool: "task", sessionID: "s1", callID: "not-live" }, result);

    expect(result.args.subagent_type).toBe("sdd-design");
    expect(tracking.size).toBe(0);
    expect(warnSink).toHaveBeenCalledOnce();
    expect(warnSink).toHaveBeenCalledWith(expect.stringMatching(/openai\/gpt-5\.5.*candidate_not_live/));
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      refusalCause: "candidate_not_live",
      decision: { action: "keep-default" },
    });
  });

  it("does not use provider families or aliases to block or authorize a switch", async () => {
    const tracking = new Map<string, unknown>();
    const quarantine = new QuarantineStore({ now: () => 1_700_000_000 });
    quarantine.addManual("xiaomi/mimo-v2.5-pro", "exact route only", { permanent: true });
    const isBlocked = vi.spyOn(quarantine, "isBlocked");
    const hook = createTaskHook(config, {
      select: () => decision({ model: "crof/mimo-v2.5-pro" }),
      tracking: tracking as never,
      quarantine,
      getLiveAvailability: () => readyLive("crof/mimo-v2.5-pro"),
    });
    const allowed = output();

    await hook({ tool: "task", sessionID: "s1", callID: "crof-live" }, allowed);

    expect(isBlocked).toHaveBeenCalledWith("crof/mimo-v2.5-pro");
    expect(quarantine.isBlocked("crof/mimo-v2.5-pro")).toBe(false);
    expect(allowed.args.subagent_type).toBe("sdd-design-alto");
    expect(tracking.has("crof-live")).toBe(true);

    const audit = vi.fn();
    const warnSink = vi.fn();
    const notAuthorized = createTaskHook(config, {
      select: () => decision({ model: "crof/mimo-v2.5-pro" }),
      tracking: new Map() as never,
      quarantine: { isBlocked: () => false },
      getLiveAvailability: () => readyLive("xiaomi/mimo-v2.5-pro"),
      audit,
      warnSink,
    });
    const refused = output();

    await notAuthorized({ tool: "task", sessionID: "s1", callID: "xiaomi-only" }, refused);

    expect(refused.args.subagent_type).toBe("sdd-design");
    expect(warnSink).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ refusalCause: "candidate_not_live" });
  });

  it("keeps the original type when a malicious resolver mutates its args before refusal", async () => {
    const tracking = new Map<string, unknown>();
    const audit = vi.fn();
    const hook = createTaskHook(config, {
      resolveCandidates: ({ args }) => {
        try {
          (args as Record<string, unknown>).subagent_type = "malicious-agent";
        } catch {
          // An immutable resolver snapshot may reject the mutation.
        }
        return [
          {
            subagent_type: "sdd-design-alto",
            model: "openai/not-live",
            effort: "high",
            confidence: 0.95,
            evidence: "test",
            ladderRung: "openai",
          },
        ];
      },
      tracking: tracking as never,
      quarantine: { isBlocked: () => false },
      getLiveAvailability: () => readyLive("openai/gpt-5.5"),
      audit,
      warnSink: vi.fn(),
    });
    const result = output();

    await hook({ tool: "task", sessionID: "s1", callID: "malicious-resolver" }, result);

    expect(result.args.subagent_type).toBe("sdd-design");
    expect(tracking.size).toBe(0);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      refusalCause: "candidate_not_live",
      decision: { action: "keep-default", model: "openai/not-live" },
    });
  });

  it("isolates nested task args from malicious resolver mutation before refusal", async () => {
    const audit = vi.fn();
    const hook = createTaskHook(config, {
      resolveCandidates: ({ args }) => {
        const metadata = args.metadata as {
          routing: { requestedType: string; tags: string[] };
        };
        try {
          metadata.routing.requestedType = "malicious-agent";
        } catch {
          // A deeply immutable resolver snapshot may reject the mutation.
        }
        try {
          metadata.routing.tags.push("mutated");
        } catch {
          // Arrays in a deeply immutable snapshot may reject mutation too.
        }
        return [
          {
            subagent_type: "sdd-design-alto",
            model: "openai/not-live",
            effort: "high",
            confidence: 0.95,
            evidence: "test",
            ladderRung: "openai",
          },
        ];
      },
      quarantine: { isBlocked: () => false },
      getLiveAvailability: () => readyLive("openai/gpt-5.5"),
      audit,
      warnSink: vi.fn(),
    });
    const result = {
      args: {
        subagent_type: "sdd-design",
        prompt: "work",
        metadata: {
          routing: {
            requestedType: "sdd-design",
            tags: ["original"],
          },
        },
      },
    };

    await hook({ tool: "task", sessionID: "s1", callID: "nested-resolver" }, result);

    expect(result.args.subagent_type).toBe("sdd-design");
    expect(result.args.metadata).toEqual({
      routing: {
        requestedType: "sdd-design",
        tags: ["original"],
      },
    });
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      refusalCause: "candidate_not_live",
    });
  });

  it("emits one visible verbose refusal diagnostic and persists the structured warning", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const persisted: string[] = [];
    try {
      const hook = createTaskHook(config, {
        select: () => decision(),
        quarantine: { isBlocked: () => true },
        getLiveAvailability: () => readyLive("openai/gpt-5.5"),
        logger: new Logger("task-2-test", process.cwd(), {
          verbose: true,
          writeLog: (line) => {
            persisted.push(line);
          },
        }),
      });
      const result = output();

      await hook({ tool: "task", sessionID: "s1", callID: "verbose-refusal" }, result);

      const visibleRefusals = stderrSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .filter((line) => line.includes("candidate_quarantined"));
      expect(result.args.subagent_type).toBe("sdd-design");
      expect(visibleRefusals).toHaveLength(1);
      expect(persisted.filter((line) => line.includes("candidate_quarantined"))).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it.each(["logger", "warnSink", "audit"] as const)(
    "%s sink errors keep a refused switch effective",
    async (failingSink) => {
      const tracking = new Map<string, unknown>();
      const audit = failingSink === "audit"
        ? vi.fn().mockRejectedValue(new Error("audit failed"))
        : vi.fn();
      const warnSink = failingSink === "warnSink"
        ? vi.fn(() => { throw new Error("warn failed"); })
        : vi.fn();
      const logger = {
        info: vi.fn(),
        warn: failingSink === "logger"
          ? vi.fn(() => { throw new Error("logger failed"); })
          : vi.fn(),
      };
      const hook = createTaskHook(config, {
        select: () => decision(),
        tracking: tracking as never,
        quarantine: { isBlocked: () => true },
        getLiveAvailability: () => readyLive("openai/gpt-5.5"),
        audit,
        warnSink,
        logger: logger as never,
      });
      const result = output();

      await expect(
        hook({ tool: "task", sessionID: "s1", callID: `sink-${failingSink}` }, result),
      ).resolves.toBeUndefined();
      expect(result.args.subagent_type).toBe("sdd-design");
      expect(tracking.size).toBe(0);
    },
  );
});

/* -------------------------------------------------------------------------- *
 * 429-fallback (SDD change) — Rate-limit detection on task output.
 * Spec #1316 requirement 1 "429 Detection on Task Output". The function
 * matches any of: usage_limit_reached, usage limit has been reached,
 * rate[_ ]limit(_exceeded)?, HTTP[_ ]?429, AI_APICallError.*429, \b429\b.
 * Bounded scan over output.slice(0, 16384) per design #1317 §2.
 * -------------------------------------------------------------------------- */
describe("detectRateLimit()", () => {
  it("detects usage_limit_reached", () => {
    expect(detectRateLimit("Error: usage_limit_reached — try again later")).toBe(true);
  });

  it("detects 'usage limit has been reached'", () => {
    expect(detectRateLimit("AI_APICallError: usage limit has been reached for minimax/M3")).toBe(true);
  });

  it("detects rate_limit and rate-limit and rate limit exceeded variants", () => {
    expect(detectRateLimit("provider error: rate_limit_exceeded")).toBe(true);
    expect(detectRateLimit("provider error: rate-limit hit")).toBe(true);
    expect(detectRateLimit("provider error: rate limit exceeded")).toBe(true);
  });

  it("detects HTTP 429 and HTTP_429 variants", () => {
    expect(detectRateLimit("upstream returned HTTP 429 Too Many Requests")).toBe(true);
    expect(detectRateLimit("upstream returned HTTP_429 Too Many Requests")).toBe(true);
  });

  it("detects AI_APICallError with 429", () => {
    expect(detectRateLimit("AI_APICallError: provider returned 429; bailing out")).toBe(true);
  });

  it("detects a bare 429 token", () => {
    expect(detectRateLimit("request failed: 429 (rate limited)")).toBe(true);
  });

  it("does NOT match benign output (no 429, no rate-limit phrase)", () => {
    expect(detectRateLimit("function_call failed: timeout")).toBe(false);
    expect(detectRateLimit("agent finished successfully; see attached diff.")).toBe(false);
    expect(detectRateLimit("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(detectRateLimit("USAGE_LIMIT_REACHED")).toBe(true);
    expect(detectRateLimit("HTTP 429")).toBe(true);
  });

  it("ignores the 429 pattern when it appears past the 16 KiB scan window", () => {
    // Build a payload where the only 429 mention is past 16384 chars.
    const prefix = "x".repeat(16_385);
    expect(detectRateLimit(`${prefix} 429`)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — parseGeneratedAlias validation guard.
 * Spec #1316 requirement 1: rewritten alias must start with `__mf_`
 * (which is also a runtime invariant we re-check defensively). The regex
 * `/^__mf_([a-z0-9-]+)__([a-z0-9-]+)_([a-z0-9]{1,6})$/` per design #1317.
 * -------------------------------------------------------------------------- */
describe("parseGeneratedAlias()", () => {
  it("parses an alias produced by generatedProfileAlias()", () => {
    const alias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const parsed = parseGeneratedAlias(alias);
    expect(parsed).not.toBeNull();
    expect(parsed?.base).toBe("sdd-design");
    expect(parsed?.modelSlug).toBe("openai-gpt-4-1-mini");
    expect(parsed?.hash).toMatch(/^[a-z0-9]{1,6}$/);
  });

  it("returns null for non-__mf_ aliases", () => {
    expect(parseGeneratedAlias("sdd-design-alto")).toBeNull();
    expect(parseGeneratedAlias("gentle-orchestrator")).toBeNull();
    expect(parseGeneratedAlias("")).toBeNull();
  });

  it("returns null for malformed __mf_ aliases (missing parts)", () => {
    expect(parseGeneratedAlias("__mf_only-one-part")).toBeNull();
    expect(parseGeneratedAlias("__mf_a__b")).toBeNull(); // missing hash
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — createAfterHook.
 * Spec #1316 requirements 1, 4, 6. The after hook fires on
 * `tool.execute.after`, only for the `task` tool, only when a tracked
 * callID exists, only when the rewritten alias parses as a generated
 * profile (`__mf_…`), only when the output matches a rate-limit pattern.
 * On match: quarantine.add(model) + audit "quarantine" entry + stderr
 * warning with nextViableModel. Sink failures are absorbed by safeAudit.
 * -------------------------------------------------------------------------- */
describe("createAfterHook()", () => {
  function buildTrackingWith(
    callID: string,
    targetAlias: string,
    model: string,
    original: string,
  ): AttemptCoordinator {
    const coordinator = new AttemptCoordinator();
    coordinator.registerTask({
      callID,
      parentSessionID: "parent",
      originalSubagentType: original,
      generatedAlias: targetAlias,
      originalModel: model,
      prompt: "",
    });
    return coordinator;
  }

  function makeCatalog(byBase: Record<string, Array<{ modelId: string }>>): {
    byBase: Record<string, Array<{ modelId: string; ladderRung: LadderRung }>>;
  } {
    return {
      byBase: Object.fromEntries(
        Object.entries(byBase).map(([k, v]) => [
          k,
          v.map((entry) => ({ ...entry, ladderRung: "openai" as LadderRung })),
        ]),
      ),
    };
  }

  it("quarantines the tracked model on a 429 output and writes one audit entry", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "upstream returned HTTP 429 Too Many Requests" },
    );

    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
    expect(audit).toHaveBeenCalledOnce();
    const entry = audit.mock.calls[0]?.[0] as AuditEntry;
    expect(entry).toBeDefined();
  });

  it("emits an audit entry with all six quarantine fields + ISO expiresAt + nextViableModel", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "anthropic/claude-opus-4-8");
    const tracking = buildTrackingWith("c1", targetAlias, "anthropic/claude-opus-4-8", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "anthropic/claude-opus-4-8" },
        { modelId: "minimax/M3" },
      ],
    });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "AI_APICallError: usage limit has been reached" },
    );

    expect(audit).toHaveBeenCalledOnce();
    const entry = audit.mock.calls[0]?.[0] as AuditEntry;
    const record = entry as unknown as Record<string, unknown>;
    expect(record["kind"]).toBe("quarantine");
    expect(record["model"]).toBe("anthropic/claude-opus-4-8");
    expect(record["callID"]).toBe("c1");
    expect(record["sessionID"]).toBe("sess-1");
    expect(typeof record["expiresAt"]).toBe("string");
    expect(() => new Date(String(record["expiresAt"]))).not.toThrow();
    // nextViableModel: the OTHER live candidate in ladder order. catalog
    // has anthropic (blocked) + minimax → minimax is the next viable.
    expect(record["nextViableModel"]).toBe("minimax/M3");
    expect(typeof record["reason"]).toBe("string");
  });

  it("emits one stderr line containing both the quarantined model and the next viable one", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "anthropic/claude-opus-4-8");
    const tracking = buildTrackingWith("c1", targetAlias, "anthropic/claude-opus-4-8", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "anthropic/claude-opus-4-8" },
        { modelId: "minimax/M3" },
      ],
    });

    const stderrLines: string[] = [];
    const warnSink = (msg: string): void => {
      stderrLines.push(msg);
    };

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      warnSink,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "HTTP 429" },
    );

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("anthropic/claude-opus-4-8");
    expect(stderrLines[0]).toContain("minimax/M3");
  });

  it("emits stderr 'none' when no other candidate is viable", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-5.5");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-5.5", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    // All candidates blocked at the time of next-viable lookup? Here
    // we only have the one candidate in the catalog, so next viable is
    // null.
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-5.5" }],
    });

    const stderrLines: string[] = [];
    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      warnSink: (m) => stderrLines.push(m),
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "rate_limit_exceeded" },
    );

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("none");
  });

  it("uses the 10-minute default TTL for google rate-limit quarantine", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "google/gemini-3.5-flash");
    const tracking = buildTrackingWith("c1", targetAlias, "google/gemini-3.5-flash", "sdd-design");
    const nowMs = 1_700_000_000;
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => nowMs });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "google/gemini-3.5-flash" }, { modelId: "minimax/M3" }],
    });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "rate_limit_exceeded" },
    );

    // Model-group expansion: quarantining one Gemini Flash model quarantines
    // all gemini flash aliases. Snapshot returns all expanded entries.
    const snap = quarantine.snapshot();
    const models = snap.map((e) => e.model).sort();
    // Original model must be present
    expect(models).toContain("google/gemini-3.5-flash");
    // All entries share the same TTL
    for (const entry of snap) {
      expect(entry.expiresAt).toBe(nowMs + 10 * 60 * 1000);
    }
  });

  it("safeAudit absorbs audit-sink throws", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });
    const audit = vi.fn(() => {
      throw new Error("audit sink boom");
    });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    // The hook MUST resolve without rethrowing.
    await expect(
      hook(
        { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
        { output: "HTTP 429" },
      ),
    ).resolves.toBeUndefined();

    // Quarantine still applied even though audit threw.
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
  });

  it("skips non-task tools (tool id !== 'task')", async () => {
    const tracking = buildTrackingWith("c1", "__mf_x__y_z", "model", "orig");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    const catalog = makeCatalog({ "x": [{ modelId: "model" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "read" }, sessionID: "s1", callID: "c1" },
      { output: "HTTP 429" },
    );

    expect(audit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("model")).toBe(false);
  });

  it("skips unknown callIDs (no entry in tracking map)", async () => {
    const tracking = new AttemptCoordinator();
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    const catalog = makeCatalog({ "x": [{ modelId: "model" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "unknown" },
      { output: "HTTP 429" },
    );

    expect(audit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("model")).toBe(false);
  });

  it("skips non-__mf_ target aliases (validation guard)", async () => {
    const tracking = buildTrackingWith("c1", "sdd-design-alto", "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "HTTP 429" },
    );

    expect(audit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(false);
  });

  it("skips outputs that do NOT match a rate-limit pattern", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "function_call failed: timeout" },
    );

    expect(audit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(false);
  });

  it("consumes the tracking entry (delete-on-consume) so a second after-hook with the same callID is a no-op", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "HTTP 429" },
    );
    expect(audit).toHaveBeenCalledTimes(1);

    // Second invocation: tracking entry is gone, so we skip silently.
    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "HTTP 429" },
    );
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("coerces non-string output to '' and skips", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    // Pass an object output (not a string) — the hook must NOT crash.
    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: { some: "object" } },
    );
    expect(audit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(false);
  });

  it("uses the QuarantineBlocklist structural interface (custom stub works)", async () => {
    // Demonstrate the structural-interface decision from design #1317:
    // profiles.ts depends on { isBlocked } only — a custom stub fits
    // without subclassing QuarantineStore.
    const stub: QuarantineBlocklist = { isBlocked: () => false };
    expect(stub.isBlocked("anything")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — createTaskHook tracking-map wiring.
 * Spec #1316 requirement 1. The before hook writes
 * `tracking.set(callID, {originalSubagentType, targetAlias, model})`
 * when the decision is a "switch" with a non-empty subagent_type and
 * model. keep-default decisions do NOT populate the map. Eviction is
 * FIFO-bounded (1000 entries) to prevent unbounded memory in long
 * sessions (R13).
 * -------------------------------------------------------------------------- */
describe("createTaskHook() — 429-fallback tracking map", () => {
  function decision(overrides: Partial<SelectDecision> = {}): SelectDecision {
    return {
      action: "switch",
      subagent_type: "__mf_sdd-design__openai-gpt-4-1-mini_a1b2c3",
      model: "openai/gpt-4.1-mini",
      effort: "high",
      reason: "test decision",
      confidence: 0.8,
      evidence: "test evidence",
      ...overrides,
    };
  }

  const getLiveAvailability = () => ({
    ready: true,
    models: new Set(["openai/gpt-4.1-mini"]),
    reason: "",
    source: "provider-list" as const,
  });

  it("populates tracking.set(callID, …) on a switch decision", async () => {
    const tracking = new Map<string, unknown>();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        tracking: tracking as never,
        getLiveAvailability,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    const entry = tracking.get("c1") as
      | { originalSubagentType: string; targetAlias: string; model: string }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry?.originalSubagentType).toBe("sdd-design");
    expect(entry?.targetAlias).toBe("__mf_sdd-design__openai-gpt-4-1-mini_a1b2c3");
    expect(entry?.model).toBe("openai/gpt-4.1-mini");
  });

  it("does NOT populate tracking when the decision is keep-default", async () => {
    const tracking = new Map<string, unknown>();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision({ action: "keep-default", subagent_type: "" }),
        tracking: tracking as never,
        getLiveAvailability,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(tracking.has("c1")).toBe(false);
  });

  it("does NOT populate tracking when a switch is downgraded to keep-default (denylist)", async () => {
    const tracking = new Map<string, unknown>();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: ["openai/gpt-4.1-mini"],
      },
      {
        select: () => decision(),
        tracking: tracking as never,
        getLiveAvailability,
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "s1", callID: "c1" }, output);

    expect(tracking.has("c1")).toBe(false);
  });

  it("FIFO-evicts the oldest entry when the map exceeds 1000 entries (R13)", async () => {
    const tracking = new Map<string, unknown>();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: ["minimax", "google-antigravity", "openai", "glm-5.2", "anthropic"],
        allowlist: ["sdd-design"],
        denylist: [],
      },
      {
        select: () => decision(),
        tracking: tracking as never,
        getLiveAvailability,
      },
    );

    // Write 1001 entries with unique callIDs. The first one (c0) must
    // be evicted.
    for (let i = 0; i < 1001; i += 1) {
      const output = { args: { subagent_type: "sdd-design", prompt: `work-${i}` } };
      await hook(
        { tool: { id: "task" }, sessionID: "s1", callID: `c${i}` },
        output,
      );
    }
    expect(tracking.size).toBeLessThanOrEqual(1000);
    expect(tracking.has("c0")).toBe(false);
    // The last-written entry must still be present.
    expect(tracking.has("c1000")).toBe(true);
  });
});

describe("detectProviderError()", () => {
  it("detects various provider, credential, and billing errors", () => {
    expect(detectProviderError("Error: invalid_api_key — check credentials")).toBe(true);
    expect(detectProviderError("API key not found in environment")).toBe(true);
    expect(detectProviderError("401 Unauthorized")).toBe(true);
    expect(detectProviderError("billing-not-active on account")).toBe(true);
    expect(detectProviderError("credit_limit reached")).toBe(true);
    expect(detectProviderError("payment required to proceed")).toBe(true);
    expect(detectProviderError("insufficient funds in wallet")).toBe(true);
    expect(detectProviderError("auth failed")).toBe(true);
    expect(detectProviderError("unauthorized client")).toBe(true);
    expect(detectProviderError("authentication failed")).toBe(true);
    expect(detectProviderError("invalid credentials")).toBe(true);
  });

  it("does NOT match benign or rate-limit output", () => {
    expect(detectProviderError("usage_limit_reached")).toBe(false);
    expect(detectProviderError("HTTP 429")).toBe(false);
    expect(detectProviderError("success")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(detectProviderError("CREDIT LIMIT REACHED")).toBe(true);
  });

  it("ignores errors past the scan window", () => {
    const prefix = "x".repeat(16_385);
    expect(detectProviderError(`${prefix} invalid_api_key`)).toBe(false);
  });
});

describe("createAfterHook() — provider and billing errors (permanent quarantine)", () => {
  function buildTrackingWith(
    callID: string,
    targetAlias: string,
    model: string,
    original: string,
  ): AttemptCoordinator {
    const coordinator = new AttemptCoordinator();
    coordinator.registerTask({ callID, parentSessionID: "parent", originalSubagentType: original, generatedAlias: targetAlias, originalModel: model, prompt: "" });
    return coordinator;
  }

  function makeCatalog(byBase: Record<string, Array<{ modelId: string }>>): {
    byBase: Record<string, Array<{ modelId: string; ladderRung: LadderRung }>>;
  } {
    return {
      byBase: Object.fromEntries(
        Object.entries(byBase).map(([k, v]) => [
          k,
          v.map((entry) => ({ ...entry, ladderRung: "openai" as LadderRung })),
        ]),
      ),
    };
  }

  it("quarantines permanently (expiresAt = Infinity) on a billing error", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }],
    });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "sess-1", callID: "c1" },
      { output: "insufficient_funds in user balance" },
    );

    // Verify it is blocked and expiresAt is Infinity
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
    expect(audit).toHaveBeenCalledOnce();
    const entry = audit.mock.calls[0]?.[0] as AuditEntry;
    const record = entry as unknown as Record<string, unknown>;
    expect(record["expiresAt"]).toBe("Infinity");
    expect(record["reason"]).toBe("insufficient_funds");

    const snap = quarantine.snapshot();
    expect(snap.length).toBeGreaterThan(1);
    expect(snap.every((entry) => entry.expiresAt === Infinity)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * model-fallback-error-classification (SDD change) — Slice 1, task 3-4.
 * design #1623: `detectRateLimit` / `detectProviderError` /
 * `matchProviderErrorReason` become thin wrappers/re-exports over the new
 * `src/error-classification.ts` pure module. This block pins:
 *   1. Existing exported signatures/behavior are unchanged for every case
 *      the original hand-written patterns already covered (no regression).
 *   2. The wrappers now also recognize the classifier's newly-added
 *      patterns (e.g. `quota` for rate_limit) — proof they truly delegate
 *      to `classifyError` rather than keeping a stale local copy.
 * -------------------------------------------------------------------------- */
describe("hooks.ts detectors delegate to error-classification.ts", () => {
  it("detectRateLimit still recognizes every pre-existing rate-limit case (no regression)", () => {
    expect(detectRateLimit("Error: usage_limit_reached — try again later")).toBe(true);
    expect(detectRateLimit("AI_APICallError: usage limit has been reached for minimax/M3")).toBe(true);
    expect(detectRateLimit("provider error: rate_limit_exceeded")).toBe(true);
    expect(detectRateLimit("upstream returned HTTP 429 Too Many Requests")).toBe(true);
    expect(detectRateLimit("request failed: 429 (rate limited)")).toBe(true);
    expect(detectRateLimit("agent finished successfully; see attached diff.")).toBe(false);
    expect(detectRateLimit("")).toBe(false);
  });

  it("detectProviderError still recognizes every pre-existing provider-error case (no regression)", () => {
    expect(detectProviderError("Error: invalid_api_key — check credentials")).toBe(true);
    expect(detectProviderError("401 Unauthorized")).toBe(true);
    expect(detectProviderError("usage_limit_reached")).toBe(false);
    expect(detectProviderError("success")).toBe(false);
  });

  it("matchProviderErrorReason still maps every pre-existing reason code (no regression)", () => {
    expect(matchProviderErrorReason("invalid_api_key supplied")).toBe("invalid_api_key");
    expect(matchProviderErrorReason("billing-not-active on account")).toBe("billing_not_active");
    expect(matchProviderErrorReason("some unmapped provider failure")).toBe("provider_error");
  });

  it("detectRateLimit now also recognizes the classifier's new 'quota' pattern (proves delegation, not a stale copy)", () => {
    // hooks.ts's own hand-written RATE_LIMIT_PATTERN never included
    // "quota" — this only passes once detectRateLimit truly delegates to
    // src/error-classification.ts's classifyError().
    expect(detectRateLimit("quota exceeded for this account")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * model-fallback-error-classification (SDD change) — Slice 1, task 7-8.
 * Spec #1620 "Structured Error Classification" scenarios "Untracked callID
 * ignored" / "Non-task tools ignored" (already covered by the pre-existing
 * "skips non-task tools" / "skips unknown callIDs" tests above — those
 * guards run BEFORE any classification call). This block pins the NEW
 * behavior: the after hook now classifies via `classifyError` (not just
 * detectRateLimit/detectProviderError) and threads the resulting
 * `errorType` into `quarantine.add(model, reason, ttlMs, errorType)`.
 * -------------------------------------------------------------------------- */
describe("createAfterHook() — error classification wiring (errorType)", () => {
  function buildTrackingWith(
    callID: string,
    targetAlias: string,
    model: string,
    original: string,
  ): AttemptCoordinator {
    const coordinator = new AttemptCoordinator();
    coordinator.registerTask({ callID, parentSessionID: "parent", originalSubagentType: original, generatedAlias: targetAlias, originalModel: model, prompt: "" });
    return coordinator;
  }

  function makeCatalog(byBase: Record<string, Array<{ modelId: string }>>): {
    byBase: Record<string, Array<{ modelId: string; ladderRung: LadderRung }>>;
  } {
    return {
      byBase: Object.fromEntries(
        Object.entries(byBase).map(([k, v]) => [
          k,
          v.map((entry) => ({ ...entry, ladderRung: "openai" as LadderRung })),
        ]),
      ),
    };
  }

  it("a model_not_configured output quarantines PERMANENTLY with errorType='model_not_configured'", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-99");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-99", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-99" }, { modelId: "minimax/M3" }] });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "error: model not found in catalog for provider openai" },
    );

    expect(quarantine.isBlocked("openai/gpt-99")).toBe(true);
    const snap = quarantine.snapshot();
    const entry = snap.find((e) => e.model === "openai/gpt-99");
    expect(entry?.expiresAt).toBe(Infinity);
    expect(entry?.errorType).toBe("model_not_configured");
  });

  it("a rate_limit output quarantines with errorType='rate_limit'", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "upstream returned HTTP 429 Too Many Requests" },
    );

    const snap = quarantine.snapshot();
    const entry = snap.find((e) => e.model === "openai/gpt-4.1-mini");
    expect(entry?.errorType).toBe("rate_limit");
  });

  it("a provider_error output quarantines PERMANENTLY with errorType='provider_error'", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "invalid_api_key supplied" },
    );

    const snap = quarantine.snapshot();
    const entry = snap.find((e) => e.model === "openai/gpt-4.1-mini");
    expect(entry?.expiresAt).toBe(Infinity);
    expect(entry?.errorType).toBe("provider_error");
  });

  it("a rate_limit output with a parseable output.metadata reset signal uses that TTL, not the static default", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const nowMs = 1_700_000_000;
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => nowMs });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "HTTP 429", metadata: { retryAfter: 42_000 } },
    );

    const snap = quarantine.snapshot();
    const entry = snap.find((e) => e.model === "openai/gpt-4.1-mini");
    expect(entry?.expiresAt).toBe(nowMs + 42_000);
  });

  it("an 'other' (unclassifiable) output does NOT quarantine and does NOT audit", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "task" }, sessionID: "s1", callID: "c1" },
      { output: "agent finished successfully; see attached diff." },
    );

    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("classification, quarantine, and audit are ALL skipped for an untracked callID (no error)", async () => {
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: new AttemptCoordinator(),
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await expect(
      hook(
        { tool: { id: "task" }, sessionID: "s1", callID: "unknown-call" },
        { output: "model not found for provider" },
      ),
    ).resolves.not.toThrow();

    expect(quarantine.snapshot()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("classification, quarantine, and audit are ALL skipped for a non-task tool", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });
    const audit = vi.fn();

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      audit,
    });

    await hook(
      { tool: { id: "read" }, sessionID: "s1", callID: "c1" },
      { output: "model not found for provider" },
    );

    expect(quarantine.snapshot()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    // Tracking entry must still be present — the hook returned before
    // even reaching the tracked-callID lookup, so nothing was consumed.
    expect(tracking.tasksByCallID.has("c1")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * model-fallback-error-classification (SDD change) — Slice 3, task 23.
 * Spec #1620 "Recursive Retry With Bounded Attempts". Design #1623
 * "Re-entrancy guard" + "Fallback mechanism".
 * -------------------------------------------------------------------------- */

describe("createTaskHook() — fallback-session re-entrancy guard (before-hook)", () => {
  it("early-returns when input.sessionID is owned by the coordinator", async () => {
    const coordinator = new AttemptCoordinator();
    coordinator.markInternalSession("fallback-child-session");
    const audit = vi.fn();
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: DEFAULT_LADDER,
        allowlist: [],
        denylist: [],
      },
      {
        audit,
        coordinator,
        select: () => decision(),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "fallback-child-session", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design");
    expect(audit).not.toHaveBeenCalled();
  });

  it("proceeds normally when input.sessionID is not coordinator-owned", async () => {
    const coordinator = new AttemptCoordinator();
    coordinator.markInternalSession("some-other-session");
    const hook = createTaskHook(
      {
        mode: "auto",
        confidenceThreshold: 0.6,
        ladder: DEFAULT_LADDER,
        allowlist: [],
        denylist: [],
      },
      {
        coordinator,
        select: () => decision(),
        getLiveAvailability: () => readyAvailabilityFor("openai/gpt-5.5"),
      },
    );

    const output = { args: { subagent_type: "sdd-design", prompt: "work" } };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(output.args.subagent_type).toBe("sdd-design-alto");
  });
});

describe("createAfterHook() — fallback engine integration (Slice 3, task 23-24)", () => {
  function buildTrackingWith(
    callID: string,
    targetAlias: string,
    model: string,
    original: string,
    prompt = "do the thing",
  ): AttemptCoordinator {
    const coordinator = new AttemptCoordinator();
    coordinator.registerTask({ callID, parentSessionID: "parent", originalSubagentType: original, generatedAlias: targetAlias, originalModel: model, prompt });
    return coordinator;
  }

  function makeCatalog(byBase: Record<string, Array<{ modelId: string }>>): {
    byBase: Record<string, Array<{ modelId: string; ladderRung: LadderRung }>>;
  } {
    return {
      byBase: Object.fromEntries(
        Object.entries(byBase).map(([k, v]) => [
          k,
          v.map((entry) => ({ ...entry, ladderRung: "openai" as LadderRung })),
        ]),
      ),
    };
  }

  it("on a classified failure with fallback enabled + client present, invokes the engine and overwrites output on success", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const client = {
      session: {
        create: vi.fn(async () => ({ id: "child-1" })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "fallback success output" }] })),
      },
    };

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: true },
    });

    const output: { output?: unknown; metadata?: unknown } = { output: "upstream returned HTTP 429 Too Many Requests" };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(output.output).toBe("fallback success output");
    expect((output.metadata as { mfFallback?: { attempts: number; model: string } })?.mfFallback).toEqual({
      attempts: 2,
      model: "minimax/M3",
    });
    // The failing model must be quarantined (existing attempt-1 path).
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
  });

  it("surfaces explicit child cancellation without retrying, aborting, or marking fallback exhausted", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google/gemini-x" },
      ],
    });
    const cancellation = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const abort = vi.fn();
    const interruptionAudit = vi.fn();
    const client = {
      session: {
        create: vi.fn(async () => ({ id: "child-1" })),
        prompt: vi.fn(async () => Promise.reject(cancellation)),
        abort,
      },
    };
    const hook = createAfterHook({
      quarantine,
      tracking: tracking as never,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: true, interruptionAudit },
    });
    const output: { output?: unknown; metadata?: unknown } = {
      output: "upstream returned HTTP 429 Too Many Requests",
    };

    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(output.output).toBe(
      "[model-forecast] FALLBACK CANCELLED: child prompt cancelled for sdd-design.",
    );
    expect(output.metadata).toMatchObject({
      mfFallback: { cancelled: true },
    });
    expect(output.metadata).not.toMatchObject({
      mfFallback: { exhausted: true },
    });
    expect(client.session.create).toHaveBeenCalledOnce();
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(interruptionAudit).not.toHaveBeenCalled();
    expect(quarantine.isBlocked("minimax/M3")).toBe(false);
  });

  it("on exhaustion, overwrites output.output with the terminal error and sets metadata.mfFallback.exhausted", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({
      "sdd-design": [
        { modelId: "openai/gpt-4.1-mini" },
        { modelId: "minimax/M3" },
        { modelId: "google-antigravity/gemini-x" },
      ],
    });

    const client = {
      session: {
        create: vi.fn(async () => ({ id: `child-${Math.random()}` })),
        prompt: vi.fn(async () => ({ parts: [{ type: "text", text: "HTTP 429 too many requests" }] })),
      },
    };

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: true },
    });

    const output: { output?: unknown; metadata?: unknown } = { output: "upstream returned HTTP 429 Too Many Requests" };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(String(output.output)).toContain("[model-forecast] FALLBACK EXHAUSTED: 3 attempts failed for sdd-design");
    expect((output.metadata as { mfFallback?: { exhausted: boolean; attempts: unknown[] } })?.mfFallback?.exhausted).toBe(true);
    expect((output.metadata as { mfFallback?: { exhausted: boolean; attempts: unknown[] } })?.mfFallback?.attempts).toHaveLength(3);
  });

  it("options.fallback.enabled=false restores audit-only behavior (no engine dispatch, output untouched)", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "minimax/M3" }] });

    const create = vi.fn();
    const prompt = vi.fn();
    const client = { session: { create, prompt } };

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: false },
    });

    const output: { output?: unknown; metadata?: unknown } = { output: "upstream returned HTTP 429 Too Many Requests" };
    await hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output);

    expect(create).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(output.output).toBe("upstream returned HTTP 429 Too Many Requests");
    expect(quarantine.isBlocked("openai/gpt-4.1-mini")).toBe(true);
  });

  it("without a fallback dep at all, behaves exactly like the pre-Slice-3 hook (no crash, no dispatch)", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });

    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
    });

    const output: { output?: unknown; metadata?: unknown } = { output: "upstream returned HTTP 429 Too Many Requests" };
    await expect(
      hook({ tool: { id: "task" }, sessionID: "parent-session", callID: "c1" }, output),
    ).resolves.not.toThrow();
    expect(output.output).toBe("upstream returned HTTP 429 Too Many Requests");
  });

  it("uses the coordinator to early-return when input.sessionID is fallback-owned", async () => {
    const targetAlias = generatedProfileAlias("sdd-design", "openai/gpt-4.1-mini");
    const tracking = buildTrackingWith("c1", targetAlias, "openai/gpt-4.1-mini", "sdd-design");
    const quarantine = new QuarantineStore({ ttlMs: 3_600_000, now: () => 1_700_000_000 });
    const catalog = makeCatalog({ "sdd-design": [{ modelId: "openai/gpt-4.1-mini" }] });

    const client = { session: { create: vi.fn(), prompt: vi.fn() } };
    const hook = createAfterHook({
      quarantine,
      coordinator: tracking,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: true },
    });

    const coordinator = new AttemptCoordinator();
    coordinator.markInternalSession("fallback-child");

    const coordinatedHook = createAfterHook({
      quarantine,
      catalog: catalog as never,
      ladder: DEFAULT_LADDER,
      fallback: { client, enabled: true },
      coordinator,
    });

    const output: { output?: unknown } = { output: "HTTP 429" };
    await coordinatedHook({ tool: { id: "task" }, sessionID: "fallback-child", callID: "c1" }, output);

    // Early-return: tracking entry must NOT have been consumed and
    // nothing quarantined.
    expect(tracking.tasksByCallID.has("c1")).toBe(true);
    expect(quarantine.snapshot()).toEqual([]);
  });
});
