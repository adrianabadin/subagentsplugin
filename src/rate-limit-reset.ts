import {
  DEFAULT_RATE_LIMIT_TTL_MS,
  MAX_RATE_LIMIT_TTL_MS,
  MIN_RATE_LIMIT_TTL_MS,
} from "./recovery-policy.js";

export type RateLimitResetHint =
  | { source: "status_next"; value: unknown }
  | { source: "structured_retry_after"; value: unknown }
  | { source: "text"; value: unknown };

interface RankedTtl {
  rank: number;
  ttlMs: number;
}

function validTtl(ttlMs: number): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return Math.min(MAX_RATE_LIMIT_TTL_MS, Math.max(MIN_RATE_LIMIT_TTL_MS, Math.ceil(ttlMs)));
}

function absoluteTimestampTtl(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value >= 1_000_000_000_000) return validTtl(value - now);
  if (value >= 1_000_000_000) return validTtl(value * 1_000 - now);
  return undefined;
}

function retryAfterTtl(value: string, now: number): number | undefined {
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric)) return validTtl(numeric * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : validTtl(date - now);
}

function durationTtl(value: string): number | undefined {
  const match = /(?:retry after|try again in|resets in)\s+(\d+(?:\.\d+)?)\s+(milliseconds?|seconds?|minutes?|hours?)/i.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("millisecond")
    ? 1
    : unit.startsWith("second")
      ? 1_000
      : unit.startsWith("minute")
        ? 60_000
        : 3_600_000;
  return validTtl(amount * multiplier);
}

function textTtls(value: string, now: number): number[] {
  const ttls: number[] = [];
  const retryAfter = /retry-after\s*:\s*([^\r\n]+)/gi;
  for (const match of value.matchAll(retryAfter)) {
    const ttl = retryAfterTtl(match[1], now);
    if (ttl !== undefined) ttls.push(ttl);
  }

  const reset = /(?:x-ratelimit-reset|ratelimit-reset)\s*:\s*(\d+(?:\.\d+)?)/gi;
  for (const match of value.matchAll(reset)) {
    const ttl = absoluteTimestampTtl(Number(match[1]), now);
    if (ttl !== undefined) ttls.push(ttl);
  }

  const duration = durationTtl(value);
  if (duration !== undefined) ttls.push(duration);

  const resetAt = /resets? at\s+([^\r\n]+)/i.exec(value);
  if (resetAt !== null) {
    const date = Date.parse(resetAt[1]);
    const ttl = Number.isNaN(date) ? undefined : validTtl(date - now);
    if (ttl !== undefined) ttls.push(ttl);
  }
  return ttls;
}

function normalizeHint(hint: RateLimitResetHint, now: number): RankedTtl[] {
  if (hint.source === "status_next") {
    const ttl = absoluteTimestampTtl(hint.value, now);
    return ttl === undefined ? [] : [{ rank: 100, ttlMs: ttl }];
  }
  if (hint.source === "structured_retry_after") {
    const ttl = typeof hint.value === "number" ? validTtl(hint.value) : undefined;
    return ttl === undefined ? [] : [{ rank: 80, ttlMs: ttl }];
  }
  if (typeof hint.value !== "string") return [];
  return textTtls(hint.value, now).map((ttlMs) => ({ rank: 60, ttlMs }));
}

export function resolveRateLimitTtlMs(
  hints: readonly RateLimitResetHint[],
  now: number,
): number {
  const ranked = hints.flatMap((hint) => normalizeHint(hint, now));
  if (ranked.length === 0) return DEFAULT_RATE_LIMIT_TTL_MS;
  const highestRank = Math.max(...ranked.map((hint) => hint.rank));
  return Math.max(...ranked.filter((hint) => hint.rank === highestRank).map((hint) => hint.ttlMs));
}
