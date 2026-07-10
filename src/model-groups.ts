/**
 * Model-group quarantine support — resolves a model identifier to all its
 * equivalent aliases so quarantining one member blocks the entire group.
 *
 * Design:
 *   - The Gemini Flash family under `google` (all `gemini-*-flash` +
 *     `antigravity-gemini-*-flash` routing variants) forms a single group
 *     that is expanded ONLY by the automatic rate-limit path
 *     (`resolveModelGroup` / `QuarantineStore.add`) so a 429 on one alias
 *     blocks the whole family.
 *   - A provider-prefix target like `opencode-go/*` or `openai/*` resolves
 *     to ALL registry keys under that provider prefix.
 *   - A manual quarantine target (`resolveQuarantineTarget`) treats EVERY
 *     individual `provider/model` id as the singleton `[modelId]` — no
 *     implicit family expansion, Gemini Flash included. Only explicit
 *     `provider/*` groups expand.
 *   - `deepseek/*` and `opencode-go/*` are different providers → separate groups.
 *
 * Contract:
 *   - `resolveModelGroup(modelId)` returns a non-empty array of equivalent model
 *     identifiers (at minimum, includes `modelId` itself).
 *   - `resolveProviderGroup(provider)` returns all registry keys whose
 *     provider (text before the first `/`) matches `provider`. The lookup
 *     is case-insensitive. An unknown provider returns an empty array.
 *   - `resolveQuarantineTarget(target)` accepts either `provider/*` (an
 *     explicit group that expands to all provider members) OR
 *     `provider/model` (an individual id that resolves to the singleton
 *     `[id]` — no implicit family expansion). Returns the list of ids to block.
 *   - Return values are derived from the benchmark registry — the registry
 *     is the authoritative source of which models exist.
 *   - Empty registry → every model is a singleton.
 */

import { getBenchmarkRegistry } from "./benchmark-registry.js";

/**
 * Heuristic: does `modelId` look like a Gemini Flash model under the `google`
 * provider?  The canonical benchmark key form is `google/<modelName>` where
 * `<modelName>` matches `gemini-*-flash` or `antigravity-gemini-*-flash`.
 */
function looksLikeGeminiFlash(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  const slash = lower.indexOf("/");
  if (slash <= 0) return false;
  const provider = lower.slice(0, slash);
  if (provider !== "google") return false;
  // Match: gemini-<version>-flash, optionally with antigravity- prefix
  return /gemini.*flash/i.test(lower);
}

/**
 * Extract the provider segment from a `provider/model` id. The provider
 * is the substring before the FIRST `/` (lowercased). Returns `""` if
 * the id has no slash or starts with one.
 */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return "";
  return modelId.slice(0, slash).toLowerCase();
}

/**
 * Resolve a model identifier to all equivalent model IDs (the model group).
 *
 * For Gemini Flash models under Google: returns ALL known Google Gemini Flash
 * model keys from the benchmark registry (canonical + routing variants).
 *
 * For all other models: returns a singleton `[modelId]`.
 */
export function resolveModelGroup(modelId: string): string[] {
  if (!looksLikeGeminiFlash(modelId)) return [modelId];

  const registry = getBenchmarkRegistry();
  const group: string[] = [];
  for (const entry of registry) {
    if (looksLikeGeminiFlash(entry.key)) {
      group.push(entry.key);
    }
  }

  // Always include the original modelId even if it wasn't in the registry
  // (covers dynamic provider.list data that may not have a benchmark entry).
  if (!group.includes(modelId)) {
    group.push(modelId);
  }

  return group.length > 0 ? group : [modelId];
}

/**
 * Resolve a provider prefix (the substring before `/`) to ALL registry keys
 * under that provider. Used by the quarantine flow to block an entire
 * provider at once via `provider/*` targets.
 *
 * The lookup is case-insensitive. When the registry is empty, returns `[]`.
 * An unknown provider (one with zero matching keys) returns `[]`.
 *
 * Examples (assuming the benchmark registry has the canonical entries):
 *   resolveProviderGroup("opencode-go") → all `opencode-go/*` keys
 *   resolveProviderGroup("openai")       → all `openai/*` keys
 *   resolveProviderGroup("google")      → all `google/*` keys
 *   resolveProviderGroup("unknown")     → []
 */
export function resolveProviderGroup(provider: string): string[] {
  const want = provider.toLowerCase();
  if (want.length === 0) return [];
  const registry = getBenchmarkRegistry();
  const out: string[] = [];
  for (const entry of registry) {
    if (providerOf(entry.key) === want) out.push(entry.key);
  }
  return out;
}

/**
 * Normalise a quarantine target string into its provider segment so
 * `resolveQuarantineTarget` can detect the `provider/*` form.
 *
 * Returns the trimmed, lowercased target so callers can branch on it
 * without re-implementing trim/lowercase logic.
 */
export function normalizeTarget(target: string): string {
  return target.trim();
}

/**
 * Resolve a user-supplied quarantine target to the FULL list of model ids
 * that should be blocked.
 *
 * Accepted forms:
 *   - `provider/*` (e.g. `opencode-go/*`, `openai/*`) → all registry keys
 *     whose provider equals the prefix. Empty when the provider is unknown.
 *   - `provider/model` (e.g. `openai/gpt-5.5`, `google/gemini-3.5-flash`)
 *     → the singleton `[provider/model]`. An individual id ALWAYS resolves
 *     to exactly that alias — no implicit model-family expansion (Gemini
 *     Flash included). Family expansion for the automatic rate-limit path
 *     lives in `QuarantineStore.add` via `resolveModelGroup`, not here.
 *   - Whitespace around the target is trimmed; empty input → `[]`.
 *
 * Order: an explicit `provider/*` group returns registry keys in registry
 * order; an individual id returns exactly `[id]`.
 */
export function resolveQuarantineTarget(target: string): string[] {
  const trimmed = normalizeTarget(target);
  if (trimmed.length === 0) return [];

  if (trimmed.endsWith("/*")) {
    const provider = trimmed.slice(0, -2).trim();
    if (provider.length === 0) return [];
    const group = resolveProviderGroup(provider);
    // Always include the literal `provider/*` so a hand-edited registry
    // still produces a sensible round-trip; but never include any other
    // id we cannot prove exists.
    if (group.length === 0) return [];
    return group;
  }

  // Individual id — resolve to exactly this alias. No implicit family
  // expansion: an explicit group must be requested via `provider/*`.
  return [trimmed];
}

/**
 * List of distinct providers known to the benchmark registry. Useful for
 * building TUI menus that ask the user "which provider group do you want
 * to quarantine?" without hardcoding the list.
 *
 * Order: registry order with first-occurrence dedupe (case-insensitive).
 */
export function listKnownProviders(): string[] {
  const registry = getBenchmarkRegistry();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of registry) {
    const provider = providerOf(entry.key);
    if (provider.length === 0) continue;
    if (seen.has(provider)) continue;
    seen.add(provider);
    out.push(provider);
  }
  return out;
}