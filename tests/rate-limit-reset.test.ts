import { describe, expect, it } from "vitest";
import { resolveRateLimitTtlMs } from "../src/rate-limit-reset.js";

const NOW = Date.UTC(2026, 0, 1);

describe("resolveRateLimitTtlMs", () => {
  it("parses Retry-After numeric seconds and HTTP dates", () => {
    expect(resolveRateLimitTtlMs([{ source: "text", value: "retry-after: 12" }], NOW)).toBe(12_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: `retry-after: ${new Date(NOW + 25_000).toUTCString()}` }], NOW)).toBe(25_000);
  });

  it("parses reset epochs and status retry timestamps", () => {
    expect(resolveRateLimitTtlMs([{ source: "text", value: `x-ratelimit-reset: ${NOW + 17_000}` }], NOW)).toBe(17_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: `ratelimit-reset: ${(NOW + 19_000) / 1_000}` }], NOW)).toBe(19_000);
    expect(resolveRateLimitTtlMs([{ source: "status_next", value: NOW + 21_000 }], NOW)).toBe(21_000);
  });

  it("parses explicit textual durations only", () => {
    expect(resolveRateLimitTtlMs([{ source: "text", value: "try again in 3 seconds" }], NOW)).toBe(3_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: "resets in 2 minutes" }], NOW)).toBe(120_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: "retry after 2 hours" }], NOW)).toBe(7_200_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: "rate limit soon" }], NOW)).toBe(600_000);
  });

  it("rejects zero, negative, expired, and ambiguous reset values", () => {
    expect(resolveRateLimitTtlMs([{ source: "text", value: "retry-after: 0" }], NOW)).toBe(600_000);
    expect(resolveRateLimitTtlMs([{ source: "text", value: "retry after -1 seconds" }], NOW)).toBe(600_000);
    expect(resolveRateLimitTtlMs([{ source: "status_next", value: NOW - 1 }], NOW)).toBe(600_000);
  });

  it("uses the highest confidence source and largest same-rank value", () => {
    expect(resolveRateLimitTtlMs([
      { source: "text", value: "retry after 10 minutes" },
      { source: "structured_retry_after", value: 30_000 },
      { source: "status_next", value: NOW + 20_000 },
    ], NOW)).toBe(20_000);
    expect(resolveRateLimitTtlMs([
      { source: "text", value: "retry after 10 seconds\nretry-after: 20" },
    ], NOW)).toBe(20_000);
  });
});
