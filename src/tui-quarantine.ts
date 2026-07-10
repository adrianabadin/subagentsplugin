/**
 * Pure helpers for the TUI / agent-facing quarantine flow.
 *
 * All functions here are pure (no I/O, no global state mutation) so they
 * can be unit-tested independently from the TUI dialog glue in
 * `src/tui.ts`. The TUI calls into these to validate user input and
 * format messages; the dialog glue stays thin and untested.
 */

import { listKnownProviders } from "./model-groups.js";
import type { BenchmarkEntry } from "./benchmark-registry.js";

/** Hard upper bound for a manual TTL — 1 year in hours. */
export const MAX_TTL_HOURS = 8760;

/**
 * Validates a user-supplied hour count. Returns `{ ok: true, value }`
 * when the value is a positive finite number ≤ MAX_TTL_HOURS, otherwise
 * `{ ok: false, reason }` with a human-readable error.
 */
export function validateHours(input: string): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "hours is required" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, reason: "must be a number" };
  if (!Number.isInteger(n)) return { ok: false, reason: "must be a whole number" };
  if (n <= 0) return { ok: false, reason: "must be greater than zero" };
  if (n > MAX_TTL_HOURS) return { ok: false, reason: `must be ≤ ${MAX_TTL_HOURS} (1 year)` };
  return { ok: true, value: n };
}

/**
 * Formats an `expiresAt` ms timestamp as a short human-readable label
 * for the TUI toast / dialog confirmation. Permanent entries render as
 * `permanent`, finite entries as ISO 8601.
 */
export function formatExpiry(expiresAt: number): string {
  if (expiresAt === Infinity) return "permanent";
  return new Date(expiresAt).toISOString();
}

/**
 * Locale-independent string comparator. `localeCompare` is locale-aware
 * and treats characters like `-` as word separators in some locales,
 * which puts `zai-coding-plan/*` AFTER `zai/*` instead of before. We
 * want ASCII ordering (raw character codes) so the menu is stable
 * across machines and locales.
 */
function asciiCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Builds the provider-group options for the TUI target picker. Sorted
 * alphabetically so the menu is stable across runs.
 */
export function providerGroupOptions(): Array<{ value: string; title: string; description: string }> {
  return listKnownProviders()
    .slice()
    .sort(asciiCompare)
    .map((provider) => ({
      value: `${provider}/*`,
      title: `${provider}/*`,
      description: `All models under provider '${provider}'`,
    }));
}

/**
 * Builds the per-model options for the TUI target picker. Sorted by
 * canonical key so the menu is stable.
 */
export function modelOptions(registry: readonly BenchmarkEntry[]): Array<{ value: string; title: string; description: string }> {
  return registry
    .slice()
    .sort((a, b) => asciiCompare(a.key, b.key))
    .map((entry) => ({
      value: entry.key,
      title: entry.key,
      description: `${entry.availability} · ${entry.source}`,
    }));
}

/**
 * Renders the toast message after a successful manual quarantine
 * action. Includes how many model ids were blocked, until when, and
 * the original target string for audit visibility.
 */
export function buildQuarantineToast(opts: {
  target: string;
  expandedCount: number;
  permanent: boolean;
  expiresAt: number;
}): { variant: "success" | "warning" | "info"; message: string } {
  const until = formatExpiry(opts.expiresAt);
  return {
    variant: "success",
    message:
      `Quarantined ${opts.expandedCount} model${opts.expandedCount === 1 ? "" : "s"} ` +
      `(${opts.target}) — ${opts.permanent ? "permanent" : `until ${until}`}`,
  };
}

/**
 * Returns the menu options for the root of the quarantine sub-flow:
 * - "Add quarantine"   → opens the target picker
 * - "View / release"   → lists current entries and offers release
 */
export function quarantineMenuOptions(): Array<{ value: string; title: string; description?: string }> {
  return [
    { value: "add", title: "Add quarantine", description: "Block a model or provider group (permanent or TTL hours)" },
    { value: "view", title: "View / release", description: "List current quarantines and optionally release one" },
    { value: "back", title: "Back", description: "Return to the root menu" },
  ];
}