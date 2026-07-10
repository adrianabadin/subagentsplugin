/**
 * model-fallback-error-classification (SDD change) — Slice 1.
 *
 * Spec #1620 "Structured Error Classification" (error-classification ADDED
 * requirements). Pure leaf module: `classifyError(text)` classifies a
 * failed tracked task output into exactly one of `rate_limit`,
 * `model_not_configured`, `provider_error`, `other` using a FIXED
 * first-match-wins precedence order:
 *
 *     model_not_configured > provider_error > rate_limit > other
 *
 * Permanent conditions (a model that will never work) MUST NOT be masked
 * by an incidental "429"/"limit" substring inside a model-not-found
 * message, so the more specific/permanent classification always wins.
 * `other` is the guaranteed fallback — classification is NEVER null for
 * a non-empty input (design #1623 "Match precedence").
 *
 * `hooks.ts` (`detectRateLimit` / `detectProviderError` / `matchReason`)
 * becomes a thin wrapper over this module (task 3-4) so existing exports
 * and their behavior stay intact.
 *
 * `extractResetHintMs(metadata)` is a SEPARATE, best-effort probe over
 * `output.metadata` for a real reset signal. Design #1623 verified that
 * `tool.execute.after` `output.metadata` is populated by OpenCode's task
 * tool (title/summary/child-session data), NEVER by provider HTTP
 * headers — so this probe documents current SDK reality and returns
 * `undefined` today. It is additive/safe and composes with the static
 * TTL defaults in `quarantine.ts` (task 5-6).
 */

export type ErrorType = "model_not_configured" | "provider_error" | "rate_limit" | "other";

export interface ClassifiedError {
  type: ErrorType;
  code: string;
  provider?: string;
  model?: string;
  /** Bounded to <= 200 chars for audit-trail friendliness. */
  rawExcerpt: string;
  /** Best-effort reset hint, in ms. Populated by callers via `extractResetHintMs`, never by `classifyError` itself (text alone carries no reliable reset signal). */
  ttlHintMs?: number;
}

/** Bounded scan window — keeps the regexes out of pathological inputs. */
export const ERROR_SCAN_WINDOW = 16_384;

const RAW_EXCERPT_MAX = 200;

/**
 * `model_not_configured` — permanent condition: the model does not exist,
 * is not entitled, or the provider is not configured. New patterns per
 * design #1623 "File Changes" row for `src/error-classification.ts`.
 */
export const MODEL_NOT_CONFIGURED_PATTERN =
  /model_not_found|unknown model|no such model|not available on your plan|not entitled|provider not configured|model not found|no access to model/i;

/**
 * `provider_error` — auth/billing conditions. Mirrors the pre-existing
 * `PROVIDER_ERROR_PATTERN` from `hooks.ts` (moved here as the canonical
 * source; `hooks.ts` re-exports it for backward compatibility).
 */
export const PROVIDER_ERROR_PATTERN =
  /invalid_api_key|API key not found|Unauthorized|billing[-_ ]not[-_ ]active|credit[-_ ]limit|payment[-_ ]required|insufficient[-_ ]funds|auth[-_ ]failed|unauthorized[-_ ]client|authentication[-_ ]failed|invalid[-_ ]credentials/i;

/**
 * `rate_limit` — mirrors the pre-existing `RATE_LIMIT_PATTERN` from
 * `hooks.ts` (moved here as the canonical source).
 */
export const RATE_LIMIT_PATTERN =
  /usage_limit_reached|usage limit has been reached|rate[-_ ]limit(?:_exceeded)?|HTTP[-_ ]?429|AI_APICallError[\s\S]{0,200}?429|\b429\b|quota/i;

function boundedHead(text: string): string {
  return text.length > ERROR_SCAN_WINDOW ? text.slice(0, ERROR_SCAN_WINDOW) : text;
}

function excerptOf(text: string): string {
  return text.length > RAW_EXCERPT_MAX ? text.slice(0, RAW_EXCERPT_MAX) : text;
}

function modelNotConfiguredCode(text: string): string {
  if (/model_not_found/i.test(text)) return "model_not_found";
  if (/unknown model/i.test(text)) return "unknown_model";
  if (/no such model/i.test(text)) return "no_such_model";
  if (/not available on your plan/i.test(text)) return "not_available_on_plan";
  if (/not entitled/i.test(text)) return "not_entitled";
  if (/provider not configured/i.test(text)) return "provider_not_configured";
  if (/model not found/i.test(text)) return "model_not_found";
  if (/no access to model/i.test(text)) return "no_access_to_model";
  return "model_not_configured";
}

/**
 * Exported so `hooks.ts` can re-export it verbatim as
 * `matchProviderErrorReason` without duplicating the pattern list.
 */
export function providerErrorCode(text: string): string {
  if (/invalid_api_key/i.test(text)) return "invalid_api_key";
  if (/API key not found/i.test(text)) return "API key not found";
  if (/Unauthorized/i.test(text)) return "Unauthorized";
  if (/billing[-_ ]not[-_ ]active/i.test(text)) return "billing_not_active";
  if (/credit[-_ ]limit/i.test(text)) return "credit_limit";
  if (/payment[-_ ]required/i.test(text)) return "payment_required";
  if (/insufficient[-_ ]funds/i.test(text)) return "insufficient_funds";
  if (/auth[-_ ]failed/i.test(text)) return "auth_failed";
  if (/unauthorized[-_ ]client/i.test(text)) return "unauthorized_client";
  if (/authentication[-_ ]failed/i.test(text)) return "authentication_failed";
  if (/invalid[-_ ]credentials/i.test(text)) return "invalid_credentials";
  return "provider_error";
}

/**
 * Exported so `hooks.ts` can re-export it verbatim as `matchReason`.
 */
export function rateLimitCode(text: string): string {
  if (/usage_limit_reached/i.test(text)) return "usage_limit_reached";
  if (/usage limit has been reached/i.test(text)) return "usage limit has been reached";
  if (/rate[-_ ]limit/i.test(text)) return "rate_limit";
  if (/HTTP[-_ ]?429/i.test(text)) return "HTTP 429";
  if (/AI_APICallError[\s\S]{0,200}?429/i.test(text)) return "AI_APICallError 429";
  if (/quota/i.test(text)) return "quota";
  return "429";
}

/**
 * Classify a failed tracked task output. Returns `null` only when there
 * is nothing to classify (empty / non-string input — mirrors the
 * existing `detectRateLimit` convention). For any non-empty input the
 * result is NEVER null: unmatched text falls back to `{type: "other"}`.
 *
 * Precedence is FIXED and deterministic, first-match-wins:
 *   model_not_configured > provider_error > rate_limit > other
 */
export function classifyError(text: string): ClassifiedError | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const head = boundedHead(text);

  if (MODEL_NOT_CONFIGURED_PATTERN.test(head)) {
    return { type: "model_not_configured", code: modelNotConfiguredCode(head), rawExcerpt: excerptOf(head) };
  }
  if (PROVIDER_ERROR_PATTERN.test(head)) {
    return { type: "provider_error", code: providerErrorCode(head), rawExcerpt: excerptOf(head) };
  }
  if (RATE_LIMIT_PATTERN.test(head)) {
    return { type: "rate_limit", code: rateLimitCode(head), rawExcerpt: excerptOf(head) };
  }
  return { type: "other", code: "unknown", rawExcerpt: excerptOf(head) };
}

/**
 * Best-effort probe over `output.metadata` for a real reset signal.
 * Checks `retryAfter`, `retry_after`, `resetAt` (first numeric match
 * wins). Returns `undefined` when `metadata` is not an object or none
 * of the keys carry a finite positive number.
 *
 * Design #1623 verified this is dead code in practice today (OpenCode's
 * task tool never populates provider HTTP headers into
 * `output.metadata`) — the probe exists so a future SDK change that DOES
 * populate one of these keys is picked up automatically, without a
 * classifier change.
 */
export function extractResetHintMs(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  for (const key of ["retryAfter", "retry_after", "resetAt"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}
