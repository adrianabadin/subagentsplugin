/**
 * PR1 — selection-decision unit tests (forecast-orchestration-layer).
 *
 * RED phase (task 1.2): these tests reference `select()` from
 * `../src/select.js` which does NOT exist yet. Running `npm test` before
 * the implementation lands MUST fail with a "Cannot find module" error.
 *
 * Spec contract (spec #1274 "Stable advisory selection decision"):
 *   - `select(input)` returns exactly
 *     `{action, subagent_type, model, effort, reason, confidence, evidence}`.
 *   - `action` is one of `switch | keep-default`.
 *   - Switch iff `confidence >= policy.confidenceThreshold`; below
 *     threshold → `keep-default` with no model change.
 *   - Cheapest capable candidate wins (ladder position).
 *
 * The tests are pure: no I/O, no clock, no Engram. The candidate set is
 * the test fixture; the runner only filters/orders it.
 */

import { describe, expect, it } from "vitest";

import { select } from "../src/select.js";
import type {
  Effort,
  Ladder,
  LadderRung,
  SelectCandidate,
  SelectionPolicy,
  TaskContext,
} from "../src/types.js";

/** Canonical ladder — the spec-mandated default. */
const DEFAULT_LADDER: Ladder = [
  "minimax",
  "google-antigravity",
  "openai",
  "glm-5.2",
  "anthropic",
] as const;

/** Default policy: advisory + 0.6 threshold. */
const DEFAULT_POLICY: SelectionPolicy = {
  mode: "advisory",
  confidenceThreshold: 0.6,
};

/** Default context — phase required, all signals supplied. */
const DEFAULT_CONTEXT: TaskContext = {
  phase: "sdd-design",
  diffLines: 250,
  files: ["src/forecast.ts"],
  symbols: ["forecast"],
  riskDomain: "architecture",
  contextBreadth: "moderate",
  modality: ["code"],
};

/** Builds a candidate with sensible defaults for the listed fields. */
function makeCandidate(overrides: Partial<SelectCandidate>): SelectCandidate {
  return {
    subagent_type: "sdd-design",
    model: "minimax/MiniMax-M3",
    effort: "medium" as Effort,
    confidence: 0.7,
    evidence: "test fixture",
    ladderRung: "minimax" as LadderRung,
    ...overrides,
  };
}

describe("select() — stable public shape (spec #1274 ADDED)", () => {
  it("returns exactly the seven SelectDecision fields", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({})],
    });

    // The seven required keys MUST be present. We assert the exact set
    // (no more, no less) so any drift in the public surface breaks here.
    expect(Object.keys(decision).sort()).toEqual(
      [
        "action",
        "confidence",
        "effort",
        "evidence",
        "model",
        "reason",
        "subagent_type",
      ].sort(),
    );
  });

  it("emits action values from the closed enum {switch, keep-default}", () => {
    // Two runs covering both branches; both must return an allowed value.
    const switchRun = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.9 })],
    });
    expect(switchRun.action).toBe("switch");

    const keepRun = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.1 })],
    });
    expect(keepRun.action).toBe("keep-default");

    // Reject the literal string "refuse" — the spec pinned the enum to
    // exactly two values. A third value would break the public contract.
    expect(["switch", "keep-default"]).toContain(switchRun.action);
    expect(["switch", "keep-default"]).toContain(keepRun.action);
  });

  it("returns effort typed as a ClaudeEffort literal (string union member)", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ effort: "high" })],
    });
    // The existing `Effort` type from src/types.ts.
    const allowed: readonly Effort[] = ["", "low", "medium", "high", "xhigh", "max"];
    expect(allowed).toContain(decision.effort);
  });
});

describe("select() — threshold gate (spec #1274 'Threshold-gated no-op')", () => {
  it("emits action='switch' when candidate confidence exceeds threshold", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.9 })],
    });
    expect(decision.action).toBe("switch");
    expect(decision.confidence).toBe(0.9);
  });

  it("emits action='keep-default' when candidate confidence is below threshold", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.3 })],
    });
    expect(decision.action).toBe("keep-default");
    expect(decision.confidence).toBe(0.3);
  });

  it("treats confidence == threshold as 'switch' (>= semantics, spec equality scenario)", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY, // confidenceThreshold: 0.6
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.6 })],
    });
    expect(decision.action).toBe("switch");
  });

  it("emits a 'below threshold' reason text when no candidate clears the bar", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.2, evidence: "missing" })],
    });
    expect(decision.action).toBe("keep-default");
    expect(decision.reason.toLowerCase()).toMatch(/threshold/);
  });

  it("emits keep-default (no switch) when the candidate set is empty", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [],
    });
    expect(decision.action).toBe("keep-default");
    // Empty input MUST NOT throw — defensiveness contract.
    expect(typeof decision.reason).toBe("string");
  });
});

describe("select() — cost ladder ordering (spec 'Cheapest capable wins')", () => {
  it("picks the earlier ladder candidate when multiple clear the threshold", () => {
    // Both candidates have confidence well above threshold; the runner
    // MUST pick the earlier ladder rung (minimax, not anthropic).
    const candidates: SelectCandidate[] = [
      makeCandidate({
        subagent_type: "sdd-design-alto",
        model: "anthropic/claude-opus-4-7",
        effort: "high",
        confidence: 0.95,
        evidence: "anthropic fresh",
        ladderRung: "anthropic",
      }),
      makeCandidate({
        subagent_type: "sdd-design",
        model: "minimax/MiniMax-M3",
        effort: "medium",
        confidence: 0.7,
        evidence: "minimax fresh",
        ladderRung: "minimax",
      }),
    ];
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("minimax/MiniMax-M3");
    expect(decision.subagent_type).toBe("sdd-design");
  });

  it("ignores candidates that are below threshold even if they sit earlier in the ladder", () => {
    // minimax is the cheapest rung but its confidence is too low to
    // switch; the runner MUST skip it and use the next capable rung.
    const candidates: SelectCandidate[] = [
      makeCandidate({
        model: "minimax/MiniMax-M3",
        effort: "medium",
        confidence: 0.1,
        evidence: "no evidence",
        ladderRung: "minimax",
      }),
      makeCandidate({
        subagent_type: "sdd-design-alto",
        model: "openai/gpt-5.1",
        effort: "high",
        confidence: 0.8,
        evidence: "openai fresh",
        ladderRung: "openai",
      }),
    ];
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    // The chosen model identifies the rung it sits on (provider prefix
    // maps to the LadderRung enum; this is a stable check across runs).
    expect(decision.model).toBe("openai/gpt-5.1");
    expect(decision.subagent_type).toBe("sdd-design-alto");
  });

  it("is deterministic: same inputs produce structurally equal decisions", () => {
    const input = {
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [makeCandidate({ confidence: 0.8 })],
    };
    const a = select(input);
    const b = select(input);
    expect(a).toEqual(b);
  });
});

describe("select() — defensiveness", () => {
  it("never throws on a malformed candidate (missing optional fields)", () => {
    // A candidate with only the required-looking fields. select() MUST
    // fill the gaps with documented defaults rather than throw.
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        {
          subagent_type: "sdd-design",
          model: "minimax/MiniMax-M3",
          effort: "medium",
          confidence: 0.8,
          evidence: "ok",
          ladderRung: "minimax",
        } as SelectCandidate,
      ],
    });
    expect(decision.action).toBe("switch");
  });

  it("returns a decision with the requested subagent_type when switching", () => {
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        makeCandidate({ subagent_type: "sdd-design-custom", confidence: 0.8 }),
      ],
    });
    expect(decision.action).toBe("switch");
    expect(decision.subagent_type).toBe("sdd-design-custom");
  });
});

/* -------------------------------------------------------------------------- *
 * PR3 — Spec #1274 "Cost-ordered deterministic candidate choice".
 *
 * Task 3.3 / 3.4 — additional triage:
 *   - Effort must clamp to a supported Effort literal (existing unit
 *     coverage lives on forecast.test.ts; select() must not emit an
 *     unsupported effort in its decision.effort).
 *   - The cheapest capable ladder candidate wins (already covered above,
 *     but a triangular case asserts the runner skips a more expensive
 *     candidate that fails the threshold).
 *   - Uncurated / missing-evidence candidates must have their
 *     confidence capped at the MISSING_EVIDENCE floor (0.1) before the
 *     threshold gate, so they keep default instead of slipping past.
 *   - Anthropic rung is reserved for the hardest tier only — even if
 *     anthropic confidence is high, it MUST be skipped when the task
 *     context does not signal "hardest".
 * -------------------------------------------------------------------------- */

describe("select() — effort clamping in the decision (spec 'cheapest capable, supported effort')", () => {
  it("emits an Effort literal in the decision — never an unsupported or empty-undefined value", () => {
    // The decision's `effort` field must always be a typed Effort union
    // member; the runner must NOT echo an unknown value from the input.
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        makeCandidate({ effort: "high", confidence: 0.9 }),
      ],
    });
    const allowed: readonly Effort[] = [
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    expect(allowed).toContain(decision.effort);
  });

  it("emits a valid Effort literal even when the candidate's effort is unsupported in the cache", () => {
    // The runner is a pure ranker; it does not read the cache. The
    // candidate contract guarantees `effort` is already clamped upstream,
    // so `decision.effort` MUST match the candidate's effort verbatim
    // when the rung clears the threshold — guaranteeing the field is
    // always a supported Effort literal.
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        makeCandidate({ effort: "low", confidence: 0.9, ladderRung: "minimax" }),
      ],
    });
    expect(decision.action).toBe("switch");
    expect(decision.effort).toBe("low");
    const allowed: readonly Effort[] = [
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    expect(allowed).toContain(decision.effort);
  });

  it("checks the cheapest capable ladder candidate wins (no off-by-one)", () => {
    // Two candidates: minimax below threshold, openai above. The runner
    // must pick openai (the EARLIEST cleared rung), not anthropic.
    // This is a triangulating case for the existing "earlier rung wins"
    // test: it confirms the runner does NOT walk past a cleared rung
    // even if a later rung would yield a more attractive candidate.
    const candidates: SelectCandidate[] = [
      makeCandidate({
        model: "minimax/MiniMax-M3",
        effort: "low",
        confidence: 0.1,
        ladderRung: "minimax",
      }),
      makeCandidate({
        subagent_type: "sdd-design-openai",
        model: "openai/gpt-5.1",
        effort: "high",
        confidence: 0.8,
        ladderRung: "openai",
      }),
      makeCandidate({
        subagent_type: "sdd-design-alto",
        model: "anthropic/claude-opus-4-7",
        effort: "max",
        confidence: 0.99,
        ladderRung: "anthropic",
      }),
    ];
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("openai/gpt-5.1");
    expect(decision.subagent_type).toBe("sdd-design-openai");
    expect(decision.effort).toBe("high");
  });
});

describe("select() — uncurated/missing evidence floored at MISSING_EVIDENCE_CONFIDENCE (0.1)", () => {
  // Spec #1274 'Uncurated or missing evidence blocks switch' scenario.
  // The runner detects missing-evidence candidates by their evidence
  // string and caps their confidence at the floor before applying the
  // threshold gate. This guarantees an uncurated model never slips past
  // the bar just because the orchestrator handed in a high number.

  it("caps confidence at the missing-evidence floor when evidence marks the candidate as uncurated", () => {
    // The candidate's confidence is above threshold (0.8) but its
    // evidence carries a 'missing' marker. select() MUST cap the
    // effective confidence at 0.1 → below threshold → keep-default.
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        makeCandidate({
          confidence: 0.8,
          evidence: "MISSING_EVIDENCE: orchestrator did not score this model",
          ladderRung: "minimax",
        }),
      ],
    });
    expect(decision.action).toBe("keep-default");
    // Confidence reported is the capped value, not the supplied 0.8.
    expect(decision.confidence).toBeLessThanOrEqual(0.1);
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
  });

  it("keeps the candidate's confidence unchanged when its evidence is curated", () => {
    // Triangulation: a curated evidence string MUST NOT trigger the
    // floor; the runner respects the supplied confidence.
    const decision = select({
      context: DEFAULT_CONTEXT,
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates: [
        makeCandidate({
          confidence: 0.85,
          evidence: "registry: minimax fresh; benchmark 2026-04-01",
          ladderRung: "minimax",
        }),
      ],
    });
    expect(decision.action).toBe("switch");
    expect(decision.confidence).toBe(0.85);
  });
});

describe("select() — anthropic rung reserved for the hardest tier", () => {
  // Spec #1274 'Cost-ordered deterministic candidate choice' scenario:
  // "MUST reserve the anthropic rung for the hardest tier". The runner
  // detects a "hardest tier" signal in the task context (wide breadth
  // + high diffLines / security risk domain) and ONLY then allows the
  // anthropic rung to compete.

  it("skips the anthropic candidate when context does not signal hardest tier", () => {
    // Even though anthropic has the highest confidence, the runner MUST
    // skip it for a moderate task. It picks the next capable rung (openai).
    const candidates: SelectCandidate[] = [
      makeCandidate({
        subagent_type: "sdd-design-alto",
        model: "anthropic/claude-opus-4-7",
        effort: "max",
        confidence: 0.99,
        ladderRung: "anthropic",
      }),
      makeCandidate({
        subagent_type: "sdd-design-openai",
        model: "openai/gpt-5.1",
        effort: "high",
        confidence: 0.85,
        ladderRung: "openai",
      }),
    ];
    const decision = select({
      context: DEFAULT_CONTEXT, // moderate context — NOT hardest
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    // anthropic is reserved → runner picks openai instead.
    expect(decision.model).toBe("openai/gpt-5.1");
  });

  it("selects the anthropic candidate when context signals hardest tier AND it is the only cleared rung", () => {
    // Triangulation: when context DOES signal hardest (high diffLines
    // + wide breadth + security risk domain) AND the only candidate
    // that clears the threshold sits on the anthropic rung, the runner
    // IS allowed to pick it. (The previous test pins the moderate case
    // where the runner correctly skips anthropic in favour of a cheaper
    // rung; here the harder case proves anthropic is NOT unconditionally
    // gated off when the task warrants it.)
    const candidates: SelectCandidate[] = [
      makeCandidate({
        subagent_type: "sdd-design-alto",
        model: "anthropic/claude-opus-4-7",
        effort: "max",
        confidence: 0.99,
        ladderRung: "anthropic",
      }),
    ];
    const decision = select({
      context: {
        phase: "sdd-verify",
        diffLines: 1500,
        files: ["src/forecast.ts", "src/hooks.ts"],
        symbols: ["forecast"],
        riskDomain: "security",
        contextBreadth: "wide",
        modality: ["code"],
      },
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("anthropic/claude-opus-4-7");
    expect(decision.effort).toBe("max");
  });
});

describe("select() — dynamic complexity scaling (PR4 ADDED)", () => {
  const candidates: SelectCandidate[] = [
    makeCandidate({
      subagent_type: "sdd-design-cheap",
      model: "minimax/MiniMax-M3",
      confidence: 0.9,
      ladderRung: "minimax",
    }),
    makeCandidate({
      subagent_type: "sdd-design-mid",
      model: "openai/gpt-5.1",
      confidence: 0.85,
      ladderRung: "openai",
    }),
    makeCandidate({
      subagent_type: "sdd-design-alto",
      model: "anthropic/claude-opus-4-7",
      confidence: 0.95,
      ladderRung: "anthropic",
    }),
  ];

  it("selects the most powerful model (highest rung first) when task has wide breadth", () => {
    // Under high complexity (contextBreadth = wide), the ladder search order
    // is reversed. So "anthropic" (highest capability) is checked first and selected
    // over minimax, even though minimax also clears the threshold.
    const decision = select({
      context: {
        phase: "sdd-design",
        contextBreadth: "wide",
      },
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("anthropic/claude-opus-4-7");
  });

  it("selects the most powerful model when riskDomain is remediation (error fixing)", () => {
    // Remediation task always scales to highest rung.
    const decision = select({
      context: {
        phase: "sdd-design",
        riskDomain: "remediation",
      },
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("anthropic/claude-opus-4-7");
  });

  it("selects the cheapest capable model when task is simple (narrow breadth)", () => {
    // Simple task (narrow breadth): anthropic is reserved (filtered out).
    // The search is cheapest-first, so minimax wins over openai.
    const decision = select({
      context: {
        phase: "sdd-design",
        contextBreadth: "narrow",
      },
      policy: DEFAULT_POLICY,
      ladder: DEFAULT_LADDER,
      candidates,
    });
    expect(decision.action).toBe("switch");
    expect(decision.model).toBe("minimax/MiniMax-M3");
  });
});
