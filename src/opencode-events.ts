/**
 * supervised-model-fallback-recovery (SDD change) — PR-05.
 *
 * Pure, side-effect-free event normalization + §14 session-association
 * scoring + authoritative-error classification. No coordinator, no
 * client, no timers, no I/O — every function here is deterministic and
 * safe to call from any layer (hook, tests).
 *
 * Design "diseño fallback.md" §PR-05 (lines 1834-1909) + §14
 * (lines 1004-1068), amended by:
 *   - C-02: the SDK exposes `permission.updated` / `permission.replied`;
 *     there is NO `permission.asked` event. `normalizeEvent` recognises
 *     `permission.updated` and treats `permission.asked` as unknown.
 *   - C-03: timing signals come only from `session.status.retry.next`
 *     (absolute epoch) and free-text error excerpts — never HTTP
 *     headers. `resolveKnownResetMs` reads exactly those.
 *   - C-06: `output_length` is not a failure kind; a
 *     `MessageOutputLengthError` classifies to `null`.
 *   - P-02: `resolveKnownResetMs` exposes the reset delay so the hook
 *     can apply the ≤ 60s tolerance window.
 *   - R-02: `isActivityEvent` marks every child-session activity signal
 *     (busy/retry status, message updates, permission events) so a
 *     later watchdog (PR-06) can treat any child event as activity.
 *     PR-05 only classifies; it wires no watchdog.
 *
 * Every reader is defensive: an unknown or malformed payload yields
 * `null` (unknown events are ignored, design item 3) rather than a
 * throw.
 */

import { classifyError } from "./error-classification.js";
import { resolveRateLimitTtlMs, type RateLimitResetHint } from "./rate-limit-reset.js";

// ---------------------------------------------------------------------------
// Normalized event union (design item 2 — exactly these nine types)
// ---------------------------------------------------------------------------

/** Flattened structured error read from `session.error` / `message.updated`. */
export interface StructuredEventError {
  name: string;
  message?: string;
  providerID?: string;
  statusCode?: number;
  retryable?: boolean;
}

export type NormalizedEvent =
  | {
      kind: "session.created";
      sessionID: string;
      parentID?: string;
      agent?: string;
      /** `providerID/modelID` when present on the created session (defensive; often absent). */
      model?: string;
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "session.status";
      sessionID: string;
      status: "idle" | "busy" | "retry";
      retry?: { attempt?: number; message?: string; next?: number };
    }
  | { kind: "session.error"; sessionID?: string; error?: StructuredEventError }
  | { kind: "session.idle"; sessionID: string }
  | { kind: "session.deleted"; sessionID: string }
  | { kind: "message.updated"; sessionID?: string; role?: string; error?: StructuredEventError }
  | { kind: "message.part.updated"; sessionID?: string; partType?: string }
  | { kind: "permission.updated"; sessionID: string; callID?: string }
  | { kind: "permission.replied"; sessionID: string };

/** Authoritative failure derived from a structured or textual error. */
export interface AuthoritativeFailure {
  kind: "rate_limit" | "provider_error" | "model_not_configured";
  code: string;
  message: string;
  statusCode?: number;
  providerID?: string;
  rawExcerpt?: string;
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flattenError(raw: unknown): StructuredEventError | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const name = readString(record.name);
  if (name === undefined) return undefined;
  const data = asRecord(record.data) ?? {};
  const error: StructuredEventError = { name };
  const message = readString(data.message);
  if (message !== undefined) error.message = message;
  const providerID = readString(data.providerID);
  if (providerID !== undefined) error.providerID = providerID;
  const statusCode = readNumber(data.statusCode);
  if (statusCode !== undefined) error.statusCode = statusCode;
  if (typeof data.isRetryable === "boolean") error.retryable = data.isRetryable;
  return error;
}

// ---------------------------------------------------------------------------
// normalizeEvent — ignores unknown/malformed events (design item 3)
// ---------------------------------------------------------------------------

export function normalizeEvent(raw: unknown): NormalizedEvent | null {
  const root = asRecord(raw);
  if (root === undefined) return null;
  const type = typeof root.type === "string" ? root.type : undefined;
  if (type === undefined) return null;
  const props = asRecord(root.properties);
  if (props === undefined) return null;

  switch (type) {
    case "session.created": {
      const info = asRecord(props.info);
      const sessionID = info !== undefined ? readString(info.id) : undefined;
      if (sessionID === undefined) return null;
      const model = info !== undefined ? asRecord(info.model) : undefined;
      const providerID = model !== undefined ? readString(model.providerID) : undefined;
      const modelID = model !== undefined ? readString(model.modelID) : undefined;
      const time = info !== undefined ? asRecord(info.time) : undefined;
      const out: Extract<NormalizedEvent, { kind: "session.created" }> = { kind: "session.created", sessionID };
      const parentID = info !== undefined ? readString(info.parentID) : undefined;
      if (parentID !== undefined) out.parentID = parentID;
      const agent = info !== undefined ? readString(info.agent) : undefined;
      if (agent !== undefined) out.agent = agent;
      if (providerID !== undefined && modelID !== undefined) out.model = `${providerID}/${modelID}`;
      const title = info !== undefined ? readString(info.title) : undefined;
      if (title !== undefined) out.title = title;
      const createdAt = time !== undefined ? readNumber(time.created) : undefined;
      if (createdAt !== undefined) out.createdAt = createdAt;
      return out;
    }
    case "session.status": {
      const sessionID = readString(props.sessionID);
      if (sessionID === undefined) return null;
      const status = asRecord(props.status);
      const statusType = status !== undefined ? readString(status.type) : undefined;
      if (statusType !== "idle" && statusType !== "busy" && statusType !== "retry") return null;
      const out: Extract<NormalizedEvent, { kind: "session.status" }> = {
        kind: "session.status",
        sessionID,
        status: statusType,
      };
      if (statusType === "retry" && status !== undefined) {
        const retry: { attempt?: number; message?: string; next?: number } = {};
        const attempt = readNumber(status.attempt);
        if (attempt !== undefined) retry.attempt = attempt;
        const message = readString(status.message);
        if (message !== undefined) retry.message = message;
        const next = readNumber(status.next);
        if (next !== undefined) retry.next = next;
        out.retry = retry;
      }
      return out;
    }
    case "session.error": {
      const out: Extract<NormalizedEvent, { kind: "session.error" }> = { kind: "session.error" };
      const sessionID = readString(props.sessionID);
      if (sessionID !== undefined) out.sessionID = sessionID;
      const error = flattenError(props.error);
      if (error !== undefined) out.error = error;
      return out;
    }
    case "session.idle": {
      const sessionID = readString(props.sessionID);
      if (sessionID === undefined) return null;
      return { kind: "session.idle", sessionID };
    }
    case "session.deleted": {
      const info = asRecord(props.info);
      const sessionID = info !== undefined ? readString(info.id) : readString(props.sessionID);
      if (sessionID === undefined) return null;
      return { kind: "session.deleted", sessionID };
    }
    case "message.updated": {
      const info = asRecord(props.info);
      const out: Extract<NormalizedEvent, { kind: "message.updated" }> = { kind: "message.updated" };
      if (info !== undefined) {
        const sessionID = readString(info.sessionID);
        if (sessionID !== undefined) out.sessionID = sessionID;
        const role = readString(info.role);
        if (role !== undefined) out.role = role;
        const error = flattenError(info.error);
        if (error !== undefined) out.error = error;
      }
      return out;
    }
    case "message.part.updated": {
      const part = asRecord(props.part);
      const out: Extract<NormalizedEvent, { kind: "message.part.updated" }> = { kind: "message.part.updated" };
      if (part !== undefined) {
        const sessionID = readString(part.sessionID);
        if (sessionID !== undefined) out.sessionID = sessionID;
        const partType = readString(part.type);
        if (partType !== undefined) out.partType = partType;
      }
      return out;
    }
    case "permission.updated": {
      const sessionID = readString(props.sessionID);
      if (sessionID === undefined) return null;
      const out: Extract<NormalizedEvent, { kind: "permission.updated" }> = { kind: "permission.updated", sessionID };
      const callID = readString(props.callID);
      if (callID !== undefined) out.callID = callID;
      return out;
    }
    case "permission.replied": {
      const sessionID = readString(props.sessionID);
      if (sessionID === undefined) return null;
      return { kind: "permission.replied", sessionID };
    }
    default:
      // Any other event type — including the non-existent
      // `permission.asked` (amendment C-02) — is ignored.
      return null;
  }
}

/** Session id an event refers to, or undefined when the event carries none. */
export function eventSessionID(event: NormalizedEvent): string | undefined {
  return "sessionID" in event ? event.sessionID : undefined;
}

// ---------------------------------------------------------------------------
// Activity classification (R-02 — any child event counts as activity)
// ---------------------------------------------------------------------------

export function isActivityEvent(event: NormalizedEvent): boolean {
  switch (event.kind) {
    case "session.status":
      // busy + retry are activity (§15.2); idle is not.
      return event.status === "busy" || event.status === "retry";
    case "message.updated":
    case "message.part.updated":
    case "permission.updated":
    case "permission.replied":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Authoritative-error classification
// ---------------------------------------------------------------------------

function failureFromClassified(text: string): AuthoritativeFailure | null {
  const classified = classifyError(text);
  if (classified === null) return null;
  if (
    classified.type === "rate_limit" ||
    classified.type === "provider_error" ||
    classified.type === "model_not_configured"
  ) {
    return {
      kind: classified.type,
      code: classified.code,
      message: text,
      rawExcerpt: classified.rawExcerpt,
    };
  }
  return null;
}

/** Classify a free-text error excerpt. Returns null when it is not an authoritative failure. */
export function classifyErrorText(text: unknown): AuthoritativeFailure | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return failureFromClassified(text);
}

/**
 * Classify a structured SDK error (design item 7: `session.error`
 * prevails over text). Returns null when the error is not an
 * authoritative model failure (aborts, output-length — C-06 —, opaque
 * 5xx errors, etc.).
 */
export function classifyStructuredError(error: StructuredEventError): AuthoritativeFailure | null {
  switch (error.name) {
    case "ProviderAuthError": {
      const failure: AuthoritativeFailure = {
        kind: "provider_error",
        code: "provider_auth_error",
        message: error.message ?? "provider authentication failed",
      };
      if (error.providerID !== undefined) failure.providerID = error.providerID;
      return failure;
    }
    case "MessageAbortedError":
    case "MessageOutputLengthError":
      // Aborts are handled by later PRs; output_length was removed (C-06).
      return null;
    case "APIError":
    case "UnknownError":
    default: {
      // Prefer a textual signal from the message; fall back to a 429
      // status code when the text is opaque.
      const byText = error.message !== undefined ? failureFromClassified(error.message) : null;
      if (byText !== null) {
        if (error.statusCode !== undefined) byText.statusCode = error.statusCode;
        if (error.providerID !== undefined) byText.providerID = error.providerID;
        return byText;
      }
      if (error.statusCode === 429) {
        const failure: AuthoritativeFailure = {
          kind: "rate_limit",
          code: "http_429",
          message: error.message ?? "HTTP 429",
          statusCode: 429,
        };
        return failure;
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// §14 association scoring (pure)
// ---------------------------------------------------------------------------

/** The window (ms) inside which a +10 temporal-proximity bonus applies (§14.3). */
export const ASSOCIATION_TIME_WINDOW_MS = 15_000;

/** A tracked task shaped for §14 scoring (supplied by the coordinator / hook). */
export interface AssociationCandidate {
  callID: string;
  parentSessionID: string;
  generatedAlias: string;
  originalModel: string;
  createdAt: number;
}

/** The signals a `session.created` (or children-augmented) event carries for scoring. */
export interface AssociationEventInfo {
  parentID?: string;
  agent?: string;
  model?: string;
  title?: string;
  createdAt?: number;
}

/** §14.3 additive score of one candidate against one created-session event. */
export function scoreAssociation(info: AssociationEventInfo, candidate: AssociationCandidate): number {
  let score = 0;
  if (info.parentID !== undefined && info.parentID === candidate.parentSessionID) score += 100;
  if (info.agent !== undefined && info.agent === candidate.generatedAlias) score += 50;
  if (info.model !== undefined && info.model === candidate.originalModel) score += 40;
  if (info.title !== undefined && candidate.callID.length > 0 && info.title.includes(candidate.callID)) score += 20;
  if (info.createdAt !== undefined && Math.abs(info.createdAt - candidate.createdAt) <= ASSOCIATION_TIME_WINDOW_MS) {
    score += 10;
  }
  return score;
}

export type AssociationResolution =
  | { kind: "associate"; callID: string }
  | { kind: "tie"; callIDs: string[] }
  | { kind: "none" };

/**
 * §14.4 resolution: the unique highest-scoring candidate is associated;
 * a shared max is a tie (no association); an empty or all-zero candidate
 * set is `none`.
 */
export function resolveAssociation(
  info: AssociationEventInfo,
  candidates: readonly AssociationCandidate[],
): AssociationResolution {
  if (candidates.length === 0) return { kind: "none" };
  const scored = candidates.map((candidate) => ({ candidate, score: scoreAssociation(info, candidate) }));
  const maxScore = Math.max(...scored.map((entry) => entry.score));
  if (maxScore <= 0) return { kind: "none" };
  const winners = scored.filter((entry) => entry.score === maxScore);
  if (winners.length === 1) return { kind: "associate", callID: winners[0]!.candidate.callID };
  return { kind: "tie", callIDs: winners.map((entry) => entry.candidate.callID) };
}

// ---------------------------------------------------------------------------
// Reset-hint probe (C-03 signals; P-02 tolerance trigger)
// ---------------------------------------------------------------------------

/**
 * Resolve the delay (ms) until the rate-limit reset from the only two
 * observable signals (C-03): `session.status.retry.next` (absolute
 * epoch) and free-text `retry-after` / `x-ratelimit-reset` excerpts.
 *
 * Returns `undefined` when NO reset hint is present — the caller must
 * distinguish "no hint" (no tolerance) from "10-minute default" and so
 * cannot use `resolveRateLimitTtlMs` (which floors to the default).
 * The P-02 tolerance window compares the returned value against 60_000.
 */
export function resolveKnownResetMs(next: unknown, text: string | undefined, now: number): number | undefined {
  const hints: RateLimitResetHint[] = [];
  if (typeof next === "number" && Number.isFinite(next)) {
    hints.push({ source: "status_next", value: next });
  }
  if (typeof text === "string" && text.length > 0) {
    hints.push({ source: "text", value: text });
  }
  if (hints.length === 0) return undefined;
  // resolveRateLimitTtlMs floors to DEFAULT when it finds no hint, so we
  // compare against a no-hint baseline to detect "no signal".
  const baseline = resolveRateLimitTtlMs([], now);
  const resolved = resolveRateLimitTtlMs(hints, now);
  return resolved === baseline ? undefined : resolved;
}
