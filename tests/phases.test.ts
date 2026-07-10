/**
 * PR2 unit tests — phase → difficulty tier mapping.
 *
 * RED phase: these tests reference src/phases.ts which does NOT exist yet.
 * Running `npm test` before the implementation lands should fail with a
 * module resolution / compile error.
 */

import { describe, expect, it } from "vitest";
import {
  LOWEST_TIER,
  PHASE_DIFFICULTY,
  normalizePhase,
  resolvePhase,
} from "../src/phases.js";

describe("phases — known phases map to a documented tier", () => {
  it("maps architecture phases to 'high'", () => {
    expect(PHASE_DIFFICULTY["orchestrator"]).toBe("high");
    expect(PHASE_DIFFICULTY["sdd-propose"]).toBe("high");
    expect(PHASE_DIFFICULTY["sdd-design"]).toBe("high");
  });

  it("maps standard implementation phases to 'medium'", () => {
    expect(PHASE_DIFFICULTY["sdd-explore"]).toBe("medium");
    expect(PHASE_DIFFICULTY["sdd-spec"]).toBe("medium");
    expect(PHASE_DIFFICULTY["sdd-tasks"]).toBe("medium");
    expect(PHASE_DIFFICULTY["sdd-apply"]).toBe("medium");
    expect(PHASE_DIFFICULTY["sdd-verify"]).toBe("medium");
    expect(PHASE_DIFFICULTY["jd-judge-a"]).toBe("medium");
    expect(PHASE_DIFFICULTY["jd-judge-b"]).toBe("medium");
    expect(PHASE_DIFFICULTY["jd-fix-agent"]).toBe("medium");
  });

  it("maps mechanical phases to 'low'", () => {
    expect(PHASE_DIFFICULTY["sdd-archive"]).toBe("low");
    expect(PHASE_DIFFICULTY["sdd-onboard"]).toBe("low");
  });
});

describe("phases — resolvePhase known input", () => {
  it("returns the configured tier with no warning for a known phase", () => {
    const result = resolvePhase("sdd-design");
    expect(result.tier).toBe("high");
    expect(result.warning).toBeNull();
  });

  it("returns 'low' for sdd-archive with no warning", () => {
    const result = resolvePhase("sdd-archive");
    expect(result.tier).toBe("low");
    expect(result.warning).toBeNull();
  });
});

describe("phases — resolvePhase unknown input", () => {
  it("defaults to the lowest tier when the phase is unknown", () => {
    const result = resolvePhase("totally-not-a-phase");
    expect(result.tier).toBe(LOWEST_TIER);
    expect(result.tier).toBe("low");
  });

  it("returns a non-empty warning string naming the unknown phase", () => {
    const result = resolvePhase("mystery-phase");
    expect(result.warning).not.toBeNull();
    expect(typeof result.warning).toBe("string");
    expect(result.warning).toContain("mystery-phase");
  });

  it("warns even for the empty string", () => {
    const result = resolvePhase("");
    expect(result.tier).toBe(LOWEST_TIER);
    expect(result.warning).not.toBeNull();
  });
});

describe("phases — normalizePhase (subagent_type → canonical phase)", () => {
  it("returns an exact known phase verbatim, matched", () => {
    expect(normalizePhase("sdd-design")).toEqual({ phase: "sdd-design", matched: true });
    expect(normalizePhase("sdd-propose")).toEqual({ phase: "sdd-propose", matched: true });
    expect(normalizePhase("orchestrator")).toEqual({ phase: "orchestrator", matched: true });
    expect(normalizePhase("jd-judge-a")).toEqual({ phase: "jd-judge-a", matched: true });
  });

  it("strips the '-alto' escalation suffix down to the base phase", () => {
    expect(normalizePhase("sdd-propose-alto")).toEqual({ phase: "sdd-propose", matched: true });
    expect(normalizePhase("sdd-design-alto")).toEqual({ phase: "sdd-design", matched: true });
    expect(normalizePhase("sdd-apply-alto")).toEqual({ phase: "sdd-apply", matched: true });
  });

  it("strips the '-fallback' escalation suffix down to the base phase", () => {
    expect(normalizePhase("sdd-spec-fallback")).toEqual({ phase: "sdd-spec", matched: true });
    expect(normalizePhase("sdd-tasks-fallback")).toEqual({ phase: "sdd-tasks", matched: true });
    expect(normalizePhase("sdd-verify-fallback")).toEqual({ phase: "sdd-verify", matched: true });
  });

  it("extracts the base phase from any arbitrary trailing qualifier", () => {
    expect(normalizePhase("sdd-design-experimental-v2")).toEqual({
      phase: "sdd-design",
      matched: true,
    });
  });

  it("returns the raw name unmatched for names with no known phase token", () => {
    expect(normalizePhase("sdd-init")).toEqual({ phase: "sdd-init", matched: false });
    expect(normalizePhase("sdd-continue")).toEqual({ phase: "sdd-continue", matched: false });
    expect(normalizePhase("custom-agent")).toEqual({ phase: "custom-agent", matched: false });
    expect(normalizePhase("gentle-orchestrator")).toEqual({
      phase: "gentle-orchestrator",
      matched: false,
    });
  });

  it("returns an empty phase unmatched for the empty string", () => {
    expect(normalizePhase("")).toEqual({ phase: "", matched: false });
  });
});