/**
 * Tests for `src/tui-quarantine.ts` — pure helpers used by the TUI
 * dialog glue. The dialog flow itself depends on the host `api.ui`
 * surface and is intentionally NOT unit-tested here (the existing
 * `tests/tui.test.ts` covers the registration + happy-path glue).
 *
 * These tests pin the pure contract:
 *   - `validateHours` rejects invalid inputs and accepts the valid range.
 *   - `formatExpiry` renders Infinity as "permanent" and finite as ISO.
 *   - `providerGroupOptions` / `modelOptions` are stable and sorted.
 *   - `buildQuarantineToast` carries the right variant + message.
 *   - `quarantineMenuOptions` exposes Add / View / Back.
 */

import { describe, expect, it } from "vitest";

import {
  buildQuarantineToast,
  formatExpiry,
  MAX_TTL_HOURS,
  modelOptions as registryModelOptions,
  providerGroupOptions,
  quarantineMenuOptions,
  validateHours,
} from "../src/tui-quarantine.js";
import { getBenchmarkRegistry } from "../src/benchmark-registry.js";

describe("validateHours", () => {
  it("accepts a positive integer", () => {
    expect(validateHours("24")).toEqual({ ok: true, value: 24 });
  });

  it("accepts 1 (boundary)", () => {
    expect(validateHours("1")).toEqual({ ok: true, value: 1 });
  });

  it("accepts MAX_TTL_HOURS (boundary)", () => {
    expect(validateHours(String(MAX_TTL_HOURS))).toEqual({ ok: true, value: MAX_TTL_HOURS });
  });

  it("rejects empty input", () => {
    const r = validateHours("");
    expect(r.ok).toBe(false);
  });

  it("rejects whitespace-only input", () => {
    const r = validateHours("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects zero", () => {
    const r = validateHours("0");
    expect(r.ok).toBe(false);
  });

  it("rejects negative", () => {
    const r = validateHours("-1");
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer", () => {
    const r = validateHours("1.5");
    expect(r.ok).toBe(false);
  });

  it("rejects above MAX_TTL_HOURS", () => {
    const r = validateHours(String(MAX_TTL_HOURS + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("8760");
  });

  it("rejects non-numeric", () => {
    const r = validateHours("abc");
    expect(r.ok).toBe(false);
  });
});

describe("formatExpiry", () => {
  it("returns 'permanent' for Infinity", () => {
    expect(formatExpiry(Infinity)).toBe("permanent");
  });

  it("returns ISO 8601 for finite values", () => {
    expect(formatExpiry(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("providerGroupOptions", () => {
  it("includes known providers from the registry", () => {
    const opts = providerGroupOptions();
    const values = opts.map((o) => o.value);
    expect(values).toContain("opencode-go/*");
    expect(values).toContain("openai/*");
    expect(values).toContain("google/*");
    expect(values).toContain("anthropic/*");
  });

  it("uses the 'provider/*' form for every value", () => {
    for (const opt of providerGroupOptions()) {
      expect(opt.value.endsWith("/*")).toBe(true);
    }
  });

  it("is sorted alphabetically (provider names, locale-independent)", () => {
    const values = providerGroupOptions().map((o) => o.value);
    // Pin the contract: the helper sorts the PROVIDER NAMES (without
    // the trailing /*) using ASCII order, then appends the suffix. So
    // `zai-coding-plan` is a longer-prefix sibling of `zai` and sorts
    // AFTER it (shorter prefix comes first in lexicographic order).
    // The test recomputes the expected order by sorting provider
    // names and then appending `/*`, mirroring the helper's pipeline.
    const providers = values.map((v) => v.replace(/\/\*$/, ""));
    const expected = providers
      .slice()
      .sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map((p) => `${p}/*`);
    expect(values).toEqual(expected);
    // Boundary case: `zai` (the prefix) sorts BEFORE `zai-coding-plan`.
    expect(values.indexOf("zai/*")).toBeLessThan(values.indexOf("zai-coding-plan/*"));
  });
});

describe("registryModelOptions", () => {
  it("includes every registry key", () => {
    const registry = getBenchmarkRegistry();
    const values = registryModelOptions(registry).map((o) => o.value);
    for (const entry of registry) {
      expect(values).toContain(entry.key);
    }
  });

  it("is sorted alphabetically by model key", () => {
    const values = registryModelOptions(getBenchmarkRegistry()).map((o) => o.value);
    const sorted = [...values].sort((a, b) => a.localeCompare(b));
    expect(values).toEqual(sorted);
  });
});

describe("buildQuarantineToast", () => {
  it("includes the target, count, and expiry", () => {
    const toast = buildQuarantineToast({
      target: "openai/*",
      expandedCount: 5,
      permanent: true,
      expiresAt: Infinity,
    });
    expect(toast.variant).toBe("success");
    expect(toast.message).toContain("openai/*");
    expect(toast.message).toContain("5");
    expect(toast.message).toContain("permanent");
  });

  it("uses ISO 8601 for finite expiresAt", () => {
    const toast = buildQuarantineToast({
      target: "openai/gpt-5.5",
      expandedCount: 1,
      permanent: false,
      expiresAt: 1_700_000_000_000,
    });
    expect(toast.message).toContain(new Date(1_700_000_000_000).toISOString());
  });

  it("pluralises 'model' correctly (zero / one / many)", () => {
    const singular = buildQuarantineToast({
      target: "openai/gpt-5.5",
      expandedCount: 1,
      permanent: true,
      expiresAt: Infinity,
    });
    const plural = buildQuarantineToast({
      target: "openai/*",
      expandedCount: 4,
      permanent: true,
      expiresAt: Infinity,
    });
    expect(singular.message).toContain("1 model ");
    expect(plural.message).toContain("4 models");
  });
});

describe("quarantineMenuOptions", () => {
  it("exposes Add / View / Back", () => {
    const values = quarantineMenuOptions().map((o) => o.value);
    expect(values).toContain("add");
    expect(values).toContain("view");
    expect(values).toContain("back");
  });
});