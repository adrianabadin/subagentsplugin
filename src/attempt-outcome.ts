/**
 * supervised-model-fallback-recovery (SDD change) — PR-03.
 *
 * Pure leaf module implementing design §8 ("Clasificación de
 * resultados") with amendments C-06 and P-01 baked in:
 *
 *   - §8.2 `classifyOutputText(value, now)`: not-string / empty /
 *     whitespace → `empty_output`. Non-empty text whose `classifyError`
 *     returns `model_not_configured` / `provider_error` / `rate_limit`
 *     is treated as an AUTHORITATIVE failure ONLY when the trimmed
 *     text length is ≤ `MAX_TEXT_AUTHORITATIVE_LENGTH` (600 chars —
 *     amendment P-01: protects legitimate work whose output happens to
 *     mention rate-limit language). Otherwise the result is `success`.
 *
 *   - §8.3 `classifySdkResult(value)`: extracts text from one of
 *     `result.parts` / `result.data.parts` / `result.error` /
 *     `result.data.error` / `result.info.error` /
 *     `result.data.info.error`. Yields `empty_output` when no usable
 *     text exists and `malformed_response` ONLY when the structure is
 *     unrecognised (amendment C-06: `malformed_response` is structural-
 *     only and §8.2 never emits it).
 *
 * No I/O, no time, no randomness. Both functions are deterministic and
 * safe to call from any layer (engine, hooks, tests).
 */

import { classifyError } from "./error-classification.js";
import type { AttemptFailureKind } from "./recovery-types.js";

/**
 * Maximum trimmed-text length (in characters) at which a textual
 * match against `model_not_configured` / `provider_error` /
 * `rate_limit` is considered authoritative. Above this threshold the
 * match is treated as incidental — legitimate work may legitimately
 * mention rate-limit language and we must not punish the model group
 * for it. (Amendment P-01.)
 */
export const MAX_TEXT_AUTHORITATIVE_LENGTH = 600;

/**
 * The discriminated outcome of classifying a fallback attempt's
 * produced text. The engine branches on `kind`:
 *
 *   - `success`: the attempt produced a usable text answer.
 *   - `failure`: the attempt produced a recognized failure mode
 *     (`reason` carries the structural kind so the engine can decide
 *     quarantine vs. transient).
 *
 * `malformed_response` only ever appears on the structural path
 * (`classifySdkResult`); `classifyOutputText` never produces it
 * (amendment C-06).
 */
export type AttemptOutcome =
  | { kind: "success"; text: string }
  | { kind: "failure"; reason: AttemptFailureKind; code: string; rawExcerpt?: string };

const EMPTY_OUTCOME: AttemptOutcome = {
  kind: "failure",
  reason: "empty_output",
  code: "empty_output",
};

function isAuthoritativeFailure(reason: string): reason is "rate_limit" | "provider_error" | "model_not_configured" {
  return (
    reason === "rate_limit" ||
    reason === "provider_error" ||
    reason === "model_not_configured"
  );
}

/**
 * §8.2 — textual classifier. Applies P-01 (length-600 corroboration)
 * before claiming an authoritative failure from textual error
 * patterns.
 */
export function classifyOutputText(value: unknown, _now: number): AttemptOutcome {
  if (typeof value !== "string") return EMPTY_OUTCOME;
  const trimmed = value.trim();
  if (trimmed.length === 0) return EMPTY_OUTCOME;

  const classified = classifyError(trimmed);
  if (classified === null) return { kind: "success", text: trimmed };

  if (isAuthoritativeFailure(classified.type)) {
    if (trimmed.length <= MAX_TEXT_AUTHORITATIVE_LENGTH) {
      return {
        kind: "failure",
        reason: classified.type,
        code: classified.code,
        rawExcerpt: classified.rawExcerpt,
      };
    }
  }

  return { kind: "success", text: trimmed };
}

interface SdkPartsResult {
  kind: "ok";
  parts: ReadonlyArray<unknown>;
}
interface SdkErrorResult {
  kind: "error";
  text: string;
}
type SdkExtract = SdkPartsResult | SdkErrorResult | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function readPartsArray(record: Record<string, unknown>): ReadonlyArray<unknown> | undefined {
  const parts = record.parts;
  if (Array.isArray(parts)) return parts;
  const data = asRecord(record.data);
  if (data !== undefined) {
    const dataParts = data.parts;
    if (Array.isArray(dataParts)) return dataParts;
  }
  return undefined;
}

function readErrorString(record: Record<string, unknown>): string | undefined {
  const candidates: ReadonlyArray<unknown> = [
    record.error,
    asRecord(record.data)?.error,
    asRecord(record.info)?.error,
    asRecord(asRecord(record.data)?.info)?.error,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function extractFromSdk(value: unknown): SdkExtract {
  const root = asRecord(value);
  if (root === undefined) return undefined;

  const parts = readPartsArray(root);
  if (parts !== undefined) return { kind: "ok", parts };

  const errorText = readErrorString(root);
  if (errorText !== undefined) return { kind: "error", text: errorText };

  return undefined;
}

function joinTextFromParts(parts: ReadonlyArray<unknown>): string {
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * §8.3 — structural classifier. Inspects the SDK response shape and
 * yields a textual `AttemptOutcome` via `classifyOutputText`. Emits
 * `malformed_response` ONLY when the shape is unrecognised
 * (amendment C-06).
 */
export function classifySdkResult(value: unknown): AttemptOutcome {
  const extracted = extractFromSdk(value);
  if (extracted === undefined) {
    return { kind: "failure", reason: "malformed_response", code: "malformed_response" };
  }

  if (extracted.kind === "ok") {
    if (extracted.parts.length === 0) return EMPTY_OUTCOME;
    const text = joinTextFromParts(extracted.parts);
    if (text.length === 0) return EMPTY_OUTCOME;
    return classifyOutputText(text, 0);
  }

  // extracted.kind === "error"
  const trimmedError = extracted.text.trim();
  if (trimmedError.length === 0) return EMPTY_OUTCOME;
  return classifyOutputText(trimmedError, 0);
}