/**
 * supervised-model-fallback-recovery (SDD change) — PR-03.
 *
 * Tests for the pure outcome-classification leaf module implementing
 * design §8 ("Clasificación de resultados") + amendments C-06 and P-01:
 *
 *   - §8.2 textual classifier (`classifyOutputText`): not-string /
 *     empty / whitespace → empty_output; non-empty text whose
 *     `classifyError` returns model_not_configured / provider_error /
 *     rate_limit → authoritative failure ONLY when the trimmed text is
 *     ≤ 600 chars (amendment P-01: protects against false positives on
 *     long outputs that LEGITIMATELY mention rate-limit language while
 *     doing real work). Otherwise → success.
 *   - §8.3 structural classifier (`classifySdkResult`): extracts text
 *     from one of `result.parts` / `result.data.parts` / `result.error`
 *     / `result.data.error` / `result.info.error` / `result.data.info.error`,
 *     yielding `empty_output` when no usable text exists and
 *     `malformed_response` ONLY when the structure is unrecognised
 *     (amendment C-06: `malformed_response` is structural-only — §8.2
 *     never emits it).
 *
 * The classifier is a pure leaf: no I/O, no time, no randomness.
 */
import { describe, expect, it } from "vitest";
import { classifyOutputText, classifySdkResult } from "../src/attempt-outcome.js";

const NOW = 1_700_000_000_000;

describe("classifyOutputText (§8.2 + P-01)", () => {
  it("non-string input → empty_output", () => {
    const result = classifyOutputText(undefined, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("null input → empty_output", () => {
    const result = classifyOutputText(null, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("number input → empty_output", () => {
    const result = classifyOutputText(42, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("empty string → empty_output", () => {
    const result = classifyOutputText("", NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("whitespace-only string → empty_output", () => {
    const result = classifyOutputText("   \n\t  ", NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("valid text with no error patterns → success", () => {
    const result = classifyOutputText("task completed successfully", NOW);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.text).toBe("task completed successfully");
  });

  it("textual rate_limit error in SHORT output (≤ 600 chars) → authoritative rate_limit failure", () => {
    // design §9.7 canonical short error: "HTTP 429 too many requests"
    const short = "HTTP 429 too many requests";
    expect(short.length).toBeLessThanOrEqual(600);
    const result = classifyOutputText(short, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("rate_limit");
      expect(result.code).toBe("HTTP 429");
    }
  });

  it("textual provider_error in SHORT output (≤ 600 chars) → authoritative provider_error failure", () => {
    const short = "Error: invalid_api_key: API key not valid";
    expect(short.length).toBeLessThanOrEqual(600);
    const result = classifyOutputText(short, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("provider_error");
      expect(result.code).toBe("invalid_api_key");
    }
  });

  it("textual model_not_configured in SHORT output (≤ 600 chars) → authoritative model_not_configured failure", () => {
    const short = "model_not_found: unknown model gpt-99";
    expect(short.length).toBeLessThanOrEqual(600);
    const result = classifyOutputText(short, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("model_not_configured");
      expect(result.code).toBe("model_not_found");
    }
  });

  it("P-01: LONG output that mentions rate-limit language is NOT classified as a failure (protects legitimate work)", () => {
    // A legitimate subagent reports its findings about rate-limit handling
    // during testing. The text is intentionally long (> 600 chars) so P-01
    // demands we treat it as success — its length is the corroborating
    // signal that this is REAL output, not an error dump.
    const seed = "During testing, the provider returned rate limit errors while exercising the retry path. ";
    const long = seed.repeat(Math.ceil(620 / seed.length));
    expect(long.length).toBeGreaterThan(600);
    const result = classifyOutputText(long, NOW);
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      // The classifier trims trailing whitespace — assert trimmed equality.
      expect(result.text.length).toBeGreaterThan(600);
      expect(result.text.trimEnd().length).toBeGreaterThan(600);
      expect(result.text.includes("rate limit errors")).toBe(true);
    }
  });

  it("P-01: LONG output that mentions provider_error language is NOT classified as a failure", () => {
    const seed = "We diagnosed an auth_failed response from the upstream provider and rotated credentials cleanly. ";
    const long = seed.repeat(Math.ceil(620 / seed.length));
    expect(long.length).toBeGreaterThan(600);
    const result = classifyOutputText(long, NOW);
    expect(result.kind).toBe("success");
  });

  it("P-01: exactly at the 600-char threshold STILL triggers authoritative failure", () => {
    const filler = "x";
    const short = "HTTP 429 too many requests " + filler.repeat(600 - "HTTP 429 too many requests ".length);
    expect(short.length).toBe(600);
    const result = classifyOutputText(short, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("rate_limit");
  });

  it("P-01: at 601 chars the failure is downgraded to success", () => {
    const filler = "x";
    const tooLong = "HTTP 429 too many requests " + filler.repeat(600 - "HTTP 429 too many requests ".length + 1);
    expect(tooLong.length).toBe(601);
    const result = classifyOutputText(tooLong, NOW);
    expect(result.kind).toBe("success");
  });

  it("trim is applied before length check", () => {
    const padded = "   HTTP 429 too many requests   ";
    expect(padded.trim().length).toBeLessThanOrEqual(600);
    const result = classifyOutputText(padded, NOW);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("rate_limit");
  });

  it("§8.2 + C-06: classifyOutputText NEVER emits malformed_response (structural-only failure kind)", () => {
    // malformed_response is reserved for §8.3 structural classification.
    // Confirm it cannot leak from the textual path even with strange input.
    const inputs = ["", "   ", "ok", "HTTP 429", "x".repeat(2000), null, undefined, 0, {}];
    for (const input of inputs) {
      const result = classifyOutputText(input, NOW);
      if (result.kind === "failure") {
        expect(result.reason).not.toBe("malformed_response");
      }
    }
  });
});

describe("classifySdkResult (§8.3 + C-06)", () => {
  it("non-object input → malformed_response", () => {
    const result = classifySdkResult(null);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("malformed_response");
  });

  it("object with no recognised shape → malformed_response", () => {
    const result = classifySdkResult({ totally: "unrelated", shape: 123 });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("malformed_response");
  });

  it("object with valid parts → success", () => {
    const result = classifySdkResult({
      parts: [{ type: "text", text: "task completed" }],
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.text).toBe("task completed");
  });

  it("object with nested data.parts → success", () => {
    const result = classifySdkResult({
      data: { parts: [{ type: "text", text: "task completed" }] },
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.text).toBe("task completed");
  });

  it("object with empty parts array → empty_output", () => {
    const result = classifySdkResult({ parts: [] });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("object with parts of only non-text type → empty_output", () => {
    const result = classifySdkResult({
      parts: [{ type: "tool_use", id: "x" }, { type: "image", src: "..." }],
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("object with parts containing only whitespace text → empty_output", () => {
    const result = classifySdkResult({
      parts: [{ type: "text", text: "   \n  " }],
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("object with top-level error string → routes through classifyOutputText", () => {
    const result = classifySdkResult({ error: "HTTP 429 too many requests" });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("rate_limit");
  });

  it("object with nested data.error string → routes through classifyOutputText", () => {
    const result = classifySdkResult({ data: { error: "invalid_api_key: bad key" } });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("provider_error");
  });

  it("object with info.error string → routes through classifyOutputText", () => {
    const result = classifySdkResult({ info: { error: "model_not_found: gpt-99" } });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("model_not_configured");
  });

  it("object with data.info.error string → routes through classifyOutputText", () => {
    const result = classifySdkResult({ data: { info: { error: "HTTP 429" } } });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("rate_limit");
  });

  it("error string that is empty after trim → empty_output", () => {
    const result = classifySdkResult({ error: "   " });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("empty_output");
  });

  it("error string is non-empty but unclassified → success", () => {
    const result = classifySdkResult({ error: "ok, done" });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.text).toBe("ok, done");
  });

  it("multi-part text is joined and trimmed before classification", () => {
    const result = classifySdkResult({
      parts: [
        { type: "text", text: "  hello " },
        { type: "tool_use", id: "x" },
        { type: "text", text: " world  " },
      ],
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.text).toBe("hello  world");
  });

  it("malformed parts (non-array) with no error → malformed_response", () => {
    const result = classifySdkResult({ parts: "not-an-array" });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("malformed_response");
  });

  it("P-01 also applies on structural extraction: LONG text from parts is success even when containing rate_limit language", () => {
    const long = "We hit a rate limit during iteration 3, retried, and recovered. ".repeat(20);
    expect(long.length).toBeGreaterThan(600);
    const result = classifySdkResult({ parts: [{ type: "text", text: long }] });
    expect(result.kind).toBe("success");
  });
});