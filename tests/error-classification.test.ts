/**
 * model-fallback-error-classification (SDD change) — Slice 1.
 *
 * Spec #1620 "Structured Error Classification" (error-classification ADDED
 * requirements): classifyError() must classify every failed tracked task
 * output into exactly one of rate_limit / model_not_configured /
 * provider_error / other, with a fixed first-match-wins precedence order
 * (model_not_configured > provider_error > rate_limit > other), a bounded
 * 16 KiB scan window, and a ≤200-char rawExcerpt. extractResetHintMs()
 * probes output.metadata for a real reset signal (best-effort; the
 * verified SDK reality is that these keys are never populated today).
 *
 * TDD ordering: these tests reference the production API in
 * `src/error-classification.ts`. They are expected to FAIL until that
 * module is implemented (task 2).
 */

import { describe, expect, it } from "vitest";

import { classifyError, extractResetHintMs } from "../src/error-classification.js";

describe("classifyError() — rate_limit patterns", () => {
  it("classifies a usage_limit_reached message as rate_limit", () => {
    const result = classifyError("Error: usage_limit_reached — try again later");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("rate_limit");
  });

  it("classifies an HTTP 429 message as rate_limit", () => {
    const result = classifyError("upstream returned HTTP 429 Too Many Requests");
    expect(result?.type).toBe("rate_limit");
  });

  it("classifies a 'quota' style message as rate_limit", () => {
    const result = classifyError("provider error: rate limit exceeded, quota reached");
    expect(result?.type).toBe("rate_limit");
  });
});

describe("classifyError() — model_not_configured patterns", () => {
  it.each([
    ["model_not_found: openai/gpt-99 does not exist", "model_not_found in payload"],
    ["Unknown model requested: openai/gpt-99", "Unknown model"],
    ["no such model registered for this provider", "no such model"],
    ["this model is not available on your plan", "not available on your plan"],
    ["account is not entitled to use this model", "not entitled"],
    ["provider not configured for this workspace", "provider not configured"],
    ["error: model not found in catalog", "model not found"],
    ["you have no access to model minimax/M3", "no access to model"],
  ])("classifies %j as model_not_configured (%s)", (text) => {
    const result = classifyError(text);
    expect(result?.type).toBe("model_not_configured");
  });
});

describe("classifyError() — unknown error falls back to other", () => {
  it("classifies unmatched output as other, never null/undefined", () => {
    const result = classifyError("agent finished successfully; see attached diff.");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("other");
  });

  it("classifies a generic timeout as other", () => {
    const result = classifyError("function_call failed: timeout");
    expect(result?.type).toBe("other");
  });
});

describe("classifyError() — multiple pattern match precedence", () => {
  it("prefers model_not_configured over rate_limit when both patterns match", () => {
    const text = "429 rate limit exceeded, but also: model not found for this provider";
    const result = classifyError(text);
    expect(result?.type).toBe("model_not_configured");
  });

  it("prefers model_not_configured over provider_error when both patterns match", () => {
    const text = "Unauthorized — model not found for account credentials";
    const result = classifyError(text);
    expect(result?.type).toBe("model_not_configured");
  });

  it("prefers provider_error over rate_limit when both patterns match", () => {
    const text = "429 too many requests, and also invalid_api_key supplied";
    const result = classifyError(text);
    expect(result?.type).toBe("provider_error");
  });
});

describe("classifyError() — empty / non-string input", () => {
  it("returns null for empty string (no failure to classify)", () => {
    expect(classifyError("")).toBeNull();
  });
});

describe("classifyError() — rawExcerpt", () => {
  it("caps rawExcerpt at 200 characters", () => {
    const longText = "model not found " + "x".repeat(500);
    const result = classifyError(longText);
    expect(result?.rawExcerpt.length).toBeLessThanOrEqual(200);
  });

  it("keeps rawExcerpt intact for short text", () => {
    const result = classifyError("HTTP 429");
    expect(result?.rawExcerpt).toBe("HTTP 429");
  });
});

describe("classifyError() — 16 KiB scan window boundary", () => {
  it("matches a model-not-configured pattern just inside the 16 KiB window", () => {
    const prefix = "x".repeat(16_360);
    const result = classifyError(`${prefix} model not found`);
    expect(result?.type).toBe("model_not_configured");
  });

  it("ignores a pattern that appears past the 16 KiB scan window", () => {
    const prefix = "x".repeat(16_385);
    const result = classifyError(`${prefix} model not found`);
    expect(result?.type).toBe("other");
  });
});

describe("extractResetHintMs()", () => {
  it("parses a numeric retryAfter key when present", () => {
    expect(extractResetHintMs({ retryAfter: 5000 })).toBe(5000);
  });

  it("parses a numeric retry_after key when present", () => {
    expect(extractResetHintMs({ retry_after: 3000 })).toBe(3000);
  });

  it("parses a numeric resetAt key when present", () => {
    expect(extractResetHintMs({ resetAt: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  it("returns undefined when no known key is present (documents current SDK reality)", () => {
    expect(extractResetHintMs({ title: "child session", summary: "did work" })).toBeUndefined();
  });

  it("returns undefined for null, undefined, or non-object metadata", () => {
    expect(extractResetHintMs(null)).toBeUndefined();
    expect(extractResetHintMs(undefined)).toBeUndefined();
    expect(extractResetHintMs("not an object")).toBeUndefined();
  });
});
