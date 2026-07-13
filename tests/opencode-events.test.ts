/**
 * supervised-model-fallback-recovery (SDD change) — PR-05.
 *
 * Pure-module tests for `src/opencode-events.ts`: event normalization,
 * §14 association scoring, structured/textual authoritative-error
 * classification, R-02 activity classification, and the P-02 reset
 * tolerance probe. No coordinator, no client, no side effects.
 *
 * Authoritative requirements: design "diseño fallback.md" §PR-05
 * (lines 1834-1909) + §14 (lines 1004-1068), amended by:
 *   - C-02: normalize `permission.updated` (NEVER `permission.asked`).
 *   - C-03: reset signals come from `session.status.retry.next` +
 *     error text, never HTTP headers.
 *   - P-02: reset ≤ 60s is the tolerance-window trigger.
 *   - R-02: any child event counts as activity.
 */

import { describe, expect, it } from "vitest";

import {
  normalizeEvent,
  eventSessionID,
  isActivityEvent,
  classifyStructuredError,
  classifyErrorText,
  scoreAssociation,
  resolveAssociation,
  resolveKnownResetMs,
  ASSOCIATION_TIME_WINDOW_MS,
  type AssociationCandidate,
} from "../src/opencode-events.js";

// ---------------------------------------------------------------------------
// normalizeEvent — one assertion group per event type (design item 2)
// ---------------------------------------------------------------------------

describe("normalizeEvent — each mandated event type", () => {
  it("normalizes session.created with parent/title/time and defensive agent+model", () => {
    const event = normalizeEvent({
      type: "session.created",
      properties: {
        info: {
          id: "child-1",
          parentID: "parent-1",
          title: "fallback task c-42",
          time: { created: 1_700_000_000_000 },
          agent: "__mf_sdd-design__abc_ff00aa",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    });
    expect(event).toEqual({
      kind: "session.created",
      sessionID: "child-1",
      parentID: "parent-1",
      title: "fallback task c-42",
      createdAt: 1_700_000_000_000,
      agent: "__mf_sdd-design__abc_ff00aa",
      model: "openai/gpt-5.5",
    });
  });

  it("normalizes session.status retry, extracting next + message + attempt", () => {
    const event = normalizeEvent({
      type: "session.status",
      properties: {
        sessionID: "s-1",
        status: { type: "retry", attempt: 2, message: "HTTP 429 rate limit", next: 1_700_000_060_000 },
      },
    });
    expect(event).toEqual({
      kind: "session.status",
      sessionID: "s-1",
      status: "retry",
      retry: { attempt: 2, message: "HTTP 429 rate limit", next: 1_700_000_060_000 },
    });
  });

  it("normalizes session.status busy and idle without a retry payload", () => {
    expect(normalizeEvent({ type: "session.status", properties: { sessionID: "s-2", status: { type: "busy" } } })).toEqual({
      kind: "session.status",
      sessionID: "s-2",
      status: "busy",
    });
    expect(normalizeEvent({ type: "session.status", properties: { sessionID: "s-3", status: { type: "idle" } } })).toEqual({
      kind: "session.status",
      sessionID: "s-3",
      status: "idle",
    });
  });

  it("normalizes session.error, flattening a ProviderAuthError", () => {
    const event = normalizeEvent({
      type: "session.error",
      properties: {
        sessionID: "s-4",
        error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "invalid_api_key" } },
      },
    });
    expect(event).toEqual({
      kind: "session.error",
      sessionID: "s-4",
      error: { name: "ProviderAuthError", message: "invalid_api_key", providerID: "anthropic" },
    });
  });

  it("normalizes session.error, flattening an APIError with statusCode + isRetryable", () => {
    const event = normalizeEvent({
      type: "session.error",
      properties: {
        sessionID: "s-5",
        error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429, isRetryable: true } },
      },
    });
    expect(event).toEqual({
      kind: "session.error",
      sessionID: "s-5",
      error: { name: "APIError", message: "Too Many Requests", statusCode: 429, retryable: true },
    });
  });

  it("normalizes session.idle and session.deleted to just the sessionID", () => {
    expect(normalizeEvent({ type: "session.idle", properties: { sessionID: "s-6" } })).toEqual({
      kind: "session.idle",
      sessionID: "s-6",
    });
    expect(normalizeEvent({ type: "session.deleted", properties: { info: { id: "s-7" } } })).toEqual({
      kind: "session.deleted",
      sessionID: "s-7",
    });
  });

  it("normalizes message.updated with a structured assistant error", () => {
    const event = normalizeEvent({
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID: "s-8",
          error: { name: "APIError", data: { message: "usage_limit_reached", statusCode: 429, isRetryable: false } },
        },
      },
    });
    expect(event).toEqual({
      kind: "message.updated",
      sessionID: "s-8",
      role: "assistant",
      error: { name: "APIError", message: "usage_limit_reached", statusCode: 429, retryable: false },
    });
  });

  it("normalizes message.part.updated with the part type + sessionID", () => {
    const event = normalizeEvent({
      type: "message.part.updated",
      properties: { part: { type: "text", sessionID: "s-9", text: "hi" } },
    });
    expect(event).toEqual({ kind: "message.part.updated", sessionID: "s-9", partType: "text" });
  });

  it("normalizes permission.updated (C-02) with sessionID + callID", () => {
    const event = normalizeEvent({
      type: "permission.updated",
      properties: { id: "perm-1", sessionID: "s-10", callID: "tool-7", type: "bash", title: "run", messageID: "m1", metadata: {}, time: { created: 1 } },
    });
    expect(event).toEqual({ kind: "permission.updated", sessionID: "s-10", callID: "tool-7" });
  });

  it("normalizes permission.replied with the sessionID", () => {
    const event = normalizeEvent({
      type: "permission.replied",
      properties: { sessionID: "s-11", permissionID: "perm-1", response: "once" },
    });
    expect(event).toEqual({ kind: "permission.replied", sessionID: "s-11" });
  });
});

// ---------------------------------------------------------------------------
// Unknown / unsupported events → ignored (design item 3 + amendment C-02)
// ---------------------------------------------------------------------------

describe("normalizeEvent — ignores unknown events", () => {
  it("returns null for an unknown event type", () => {
    expect(normalizeEvent({ type: "file.edited", properties: { file: "x" } })).toBeNull();
    expect(normalizeEvent({ type: "server.connected", properties: {} })).toBeNull();
  });

  it("returns null for `permission.asked` (C-02: that event does not exist in the SDK)", () => {
    expect(normalizeEvent({ type: "permission.asked", properties: { sessionID: "s" } })).toBeNull();
  });

  it("returns null for malformed / non-object input without throwing", () => {
    expect(normalizeEvent(undefined)).toBeNull();
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent("session.status")).toBeNull();
    expect(normalizeEvent({ type: 42 })).toBeNull();
    expect(normalizeEvent({ type: "session.status" })).toBeNull(); // no properties
  });
});

// ---------------------------------------------------------------------------
// eventSessionID
// ---------------------------------------------------------------------------

describe("eventSessionID", () => {
  it("returns the child session id for a session.created event", () => {
    const event = normalizeEvent({ type: "session.created", properties: { info: { id: "child-9", parentID: "p" } } })!;
    expect(eventSessionID(event)).toBe("child-9");
  });

  it("returns undefined for a session.error without a sessionID", () => {
    const event = normalizeEvent({ type: "session.error", properties: { error: { name: "UnknownError", data: { message: "x" } } } })!;
    expect(eventSessionID(event)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isActivityEvent (R-02: any child event counts as activity)
// ---------------------------------------------------------------------------

describe("isActivityEvent — R-02 activity classification", () => {
  it("counts busy status, retry status, message.updated, message.part.updated and permission events as activity", () => {
    const busy = normalizeEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } })!;
    const retry = normalizeEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "retry", attempt: 1, message: "m", next: 0 } } })!;
    const msg = normalizeEvent({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "s" } } })!;
    const part = normalizeEvent({ type: "message.part.updated", properties: { part: { type: "reasoning", sessionID: "s" } } })!;
    const perm = normalizeEvent({ type: "permission.updated", properties: { id: "p", sessionID: "s", type: "t", title: "x", messageID: "m", metadata: {}, time: { created: 0 } } })!;
    const replied = normalizeEvent({ type: "permission.replied", properties: { sessionID: "s", permissionID: "p", response: "once" } })!;
    for (const e of [busy, retry, msg, part, perm, replied]) {
      expect(isActivityEvent(e)).toBe(true);
    }
  });

  it("does NOT count session.created, session.idle, session.deleted or session.error as activity", () => {
    const created = normalizeEvent({ type: "session.created", properties: { info: { id: "c", parentID: "p" } } })!;
    const idle = normalizeEvent({ type: "session.idle", properties: { sessionID: "s" } })!;
    const deleted = normalizeEvent({ type: "session.deleted", properties: { info: { id: "s" } } })!;
    const error = normalizeEvent({ type: "session.error", properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "x" } } } })!;
    for (const e of [created, idle, deleted, error]) {
      expect(isActivityEvent(e)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyStructuredError (session.error must prevail over text — item 7)
// ---------------------------------------------------------------------------

describe("classifyStructuredError", () => {
  it("classifies a ProviderAuthError as an authoritative provider_error", () => {
    const failure = classifyStructuredError({ name: "ProviderAuthError", message: "invalid_api_key", providerID: "anthropic" });
    expect(failure).not.toBeNull();
    expect(failure!.kind).toBe("provider_error");
    expect(failure!.providerID).toBe("anthropic");
  });

  it("classifies an APIError with statusCode 429 as rate_limit even when the message is opaque", () => {
    const failure = classifyStructuredError({ name: "APIError", message: "upstream unavailable", statusCode: 429, retryable: true });
    expect(failure).not.toBeNull();
    expect(failure!.kind).toBe("rate_limit");
    expect(failure!.statusCode).toBe(429);
  });

  it("classifies an UnknownError by its message text (model_not_configured wins over rate limit)", () => {
    const failure = classifyStructuredError({ name: "UnknownError", message: "model_not_found: gpt-9" });
    expect(failure!.kind).toBe("model_not_configured");
  });

  it("returns null for a MessageAbortedError (abort is not a model failure)", () => {
    expect(classifyStructuredError({ name: "MessageAbortedError", message: "aborted" })).toBeNull();
  });

  it("returns null for a MessageOutputLengthError (C-06: output_length kind removed)", () => {
    expect(classifyStructuredError({ name: "MessageOutputLengthError" })).toBeNull();
  });

  it("returns null for an opaque error with no recognizable signal", () => {
    expect(classifyStructuredError({ name: "APIError", message: "internal server error", statusCode: 500, retryable: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyErrorText
// ---------------------------------------------------------------------------

describe("classifyErrorText", () => {
  it("returns a rate_limit failure for 429 text", () => {
    const failure = classifyErrorText("Request failed: HTTP 429 Too Many Requests");
    expect(failure!.kind).toBe("rate_limit");
  });

  it("returns null for non-error text", () => {
    expect(classifyErrorText("the design document is finished")).toBeNull();
    expect(classifyErrorText("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scoreAssociation (§14.3 weights)
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<AssociationCandidate> = {}): AssociationCandidate {
  return {
    callID: "c-1",
    parentSessionID: "parent-1",
    generatedAlias: "__mf_sdd-design__abc_ff00aa",
    originalModel: "openai/gpt-5.5",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("scoreAssociation — §14.3 weights", () => {
  it("sums all five signals for an exact match (100+50+40+20+10 = 220)", () => {
    const score = scoreAssociation(
      {
        parentID: "parent-1",
        agent: "__mf_sdd-design__abc_ff00aa",
        model: "openai/gpt-5.5",
        title: "work for c-1",
        createdAt: 1_700_000_005_000, // +5s, within 15s window
      },
      candidate(),
    );
    expect(score).toBe(220);
  });

  it("scores 0 when the parent does not match and nothing else does", () => {
    const score = scoreAssociation({ parentID: "other-parent", createdAt: 1_700_000_000_000 }, candidate());
    // parent mismatch (0) + time within window (+10)
    expect(score).toBe(10);
  });

  it("drops the alias points when the agent differs", () => {
    const score = scoreAssociation(
      { parentID: "parent-1", agent: "__mf_other__x_y", model: "openai/gpt-5.5" },
      candidate(),
    );
    // parent (100) + model (40); no agent, no title, no time
    expect(score).toBe(140);
  });

  it("drops the model points when the model differs", () => {
    const score = scoreAssociation(
      { parentID: "parent-1", agent: "__mf_sdd-design__abc_ff00aa", model: "google/gemini-2.5-pro" },
      candidate(),
    );
    // parent (100) + alias (50)
    expect(score).toBe(150);
  });

  it("drops the time points when the delta exceeds the 15s window", () => {
    const score = scoreAssociation(
      { parentID: "parent-1", createdAt: 1_700_000_000_000 + ASSOCIATION_TIME_WINDOW_MS + 1 },
      candidate(),
    );
    expect(score).toBe(100);
  });

  it("adds the title points only when the title contains the callID", () => {
    expect(scoreAssociation({ parentID: "parent-1", title: "task c-1 running" }, candidate())).toBe(120);
    expect(scoreAssociation({ parentID: "parent-1", title: "unrelated task" }, candidate())).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// resolveAssociation (§14.4 resolution)
// ---------------------------------------------------------------------------

describe("resolveAssociation — §14.4 resolution", () => {
  it("associates the single highest-scoring candidate", () => {
    const info = { parentID: "parent-1", model: "openai/gpt-5.5" };
    const res = resolveAssociation(info, [
      candidate({ callID: "c-1", originalModel: "openai/gpt-5.5" }),
      candidate({ callID: "c-2", originalModel: "google/gemini-2.5-pro" }),
    ]);
    expect(res).toEqual({ kind: "associate", callID: "c-1" });
  });

  it("reports a tie (no association) when two candidates share the max score", () => {
    const info = { parentID: "parent-1" };
    const res = resolveAssociation(info, [
      candidate({ callID: "c-1" }),
      candidate({ callID: "c-2" }),
    ]);
    expect(res.kind).toBe("tie");
    if (res.kind === "tie") expect(res.callIDs.sort()).toEqual(["c-1", "c-2"]);
  });

  it("reports none when the candidate list is empty", () => {
    expect(resolveAssociation({ parentID: "parent-1" }, [])).toEqual({ kind: "none" });
  });

  it("reports none when every candidate scores zero", () => {
    const res = resolveAssociation({ parentID: "no-match" }, [candidate({ callID: "c-1", createdAt: 0 })]);
    expect(res).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// resolveKnownResetMs (P-02 tolerance probe / C-03 signals)
// ---------------------------------------------------------------------------

describe("resolveKnownResetMs — C-03 signals, P-02 tolerance trigger", () => {
  const now = 1_700_000_000_000;

  it("returns the ms until reset from a valid status.retry.next epoch (<= 60s)", () => {
    const reset = resolveKnownResetMs(now + 30_000, undefined, now);
    expect(reset).toBe(30_000);
  });

  it("returns the ms until reset parsed from retry-after text when next is absent", () => {
    const reset = resolveKnownResetMs(undefined, "retry-after: 45", now);
    expect(reset).toBe(45_000);
  });

  it("returns undefined when there is no reset hint at all", () => {
    expect(resolveKnownResetMs(undefined, "rate limited, please slow down", now)).toBeUndefined();
    expect(resolveKnownResetMs(undefined, undefined, now)).toBeUndefined();
  });

  it("returns a value > 60s for a far-future reset (caller decides tolerance)", () => {
    const reset = resolveKnownResetMs(now + 120_000, undefined, now);
    expect(reset).toBe(120_000);
  });
});
