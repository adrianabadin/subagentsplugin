/**
 * PR3 — Data collectors: provider.list(), gentle-ai variants cache,
 * OpenCode models cache, and provider-variant merge.
 *
 * All collectors are best-effort and MUST never throw (spec S2). They
 * return empty maps when sources are absent, unreadable, or invalid.
 *
 * The provider.list() extraction heuristic is copied verbatim from
 * gentle-ai/internal/assets/opencode/plugins/model-variants.ts lines 37-39
 * and 41-50 (the per-model variant extraction):
 *
 *   const data = (result as any).data ?? result
 *   const providerList: any[] = data?.all ?? data?.providers
 *     ?? (Array.isArray(data) ? data : [])
 *   for (const prov of providerList) {
 *     for (const [modelId, model] of Object.entries(prov.models ?? {})) {
 *       const m = model as any
 *       if (m.variants && Object.keys(m.variants).length > 0) {
 *         variants[prov.id] = variants[prov.id] || {}
 *         variants[prov.id][modelId] = Object.keys(m.variants).sort()
 *       }
 *     }
 *   }
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import type { Effort } from "./types.js";
import type { Logger } from "./logger.js";
import type { Discovery, LiveModel } from "./pending-queue.js";
export type { Discovery, LiveModel } from "./pending-queue.js";

/**
 * Returns the default path to the gentle-ai model-variants cache file:
 * `~/.gentle-ai/cache/model-variants.json`.
 */
export function gentleAiVariantsCachePath(): string {
  return path.join(homedir(), ".gentle-ai", "cache", "model-variants.json");
}

/**
 * Returns the default path to the OpenCode models cache file:
 * `~/.cache/opencode/models.json`.
 */
export function openCodeModelsCachePath(): string {
  return path.join(homedir(), ".cache", "opencode", "models.json");
}

/**
 * Extracts the provider list from a `provider.list()` SDK result using
 * the EXACT heuristic from model-variants.ts:37-39. Returns an empty
 * array on null/undefined input or unrecognized shapes — never throws.
 */
export function extractProviderList(result: unknown): unknown[] {
  const data: unknown = (result as { data?: unknown } | null | undefined)?.data ?? result;
  if (!data || typeof data !== "object") {
    if (Array.isArray(data)) return data;
    return [];
  }
  const candidate = data as { all?: unknown; providers?: unknown };
  if (Array.isArray(candidate.all)) return candidate.all;
  if (Array.isArray(candidate.providers)) return candidate.providers;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Walks a provider list (the output of `extractProviderList`) and
 * returns a `Record<providerId, Record<modelId, string[]>>` of model
 * variant keys per provider, mirroring model-variants.ts:41-50. Variants
 * are sorted alphabetically for deterministic cache output.
 *
 * Skips providers without an `id` or without a `models` object, and
 * models whose `variants` object is empty. Does not mutate the input.
 *
 * PR2 hardening: per-model entries can be `null` or non-object in the wild
 * (SDKs occasionally drop a model between snapshots). We defensively skip
 * those entries instead of dereferencing `null.variants`. This guarantees
 * the collector chain NEVER throws, even on a malformed provider list —
 * so the scoring pipeline downstream of `forecast()` can never be blocked
 * by a bad upstream cache payload.
 */
export function extractVariantsFromProviderList(
  providerList: unknown[],
): Record<string, Record<string, string[]>> {
  const variants: Record<string, Record<string, string[]>> = {};
  for (const prov of providerList) {
    if (!prov || typeof prov !== "object") continue;
    const providerId = (prov as { id?: unknown }).id;
    if (typeof providerId !== "string") continue;
    const models = (prov as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      // Skip null / non-object per-model entries (PR2 hardening).
      if (!model || typeof model !== "object") continue;
      const m = model as { variants?: unknown };
      if (
        m.variants &&
        typeof m.variants === "object" &&
        Object.keys(m.variants).length > 0
      ) {
        variants[providerId] = variants[providerId] || {};
        variants[providerId][modelId] = Object.keys(m.variants as object).sort();
      }
    }
  }
  return variants;
}

/**
 * Reads and parses a JSON object file in a best-effort manner. Returns the
 * parsed object on success; returns `{}` on missing file, empty file,
 * invalid JSON, or non-object root (e.g. array). Never throws.
 *
 * Shared helper for both collectors to keep the best-effort contract in one
 * place.
 */
async function readJsonObjectSafe(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {};
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads the gentle-ai model-variants JSON cache from `customPath`
 * (or the default path when omitted). Returns `{}` on:
 *   - missing file (ENOENT)
 *   - empty file
 *   - invalid JSON
 *   - non-object root (e.g. array)
 *
 * Never throws.
 */
export async function readGentleAiVariantsCache(
  customPath?: string,
  logger?: Logger,
): Promise<Record<string, Record<string, string[]>>> {
  const target = customPath ?? gentleAiVariantsCachePath();
  const result = (await readJsonObjectSafe(target)) as Record<
    string,
    Record<string, string[]>
  >;
  logger?.trace("readGentleAiVariantsCache", `${Object.keys(result).length} providers from ${target}`);
  return result;
}

/**
 * Reads the OpenCode models JSON cache from `customPath` (or the default
 * path when omitted). Returns `{}` on missing/invalid input. Never throws.
 */
export async function readOpenCodeModelsCache(
  customPath?: string,
  logger?: Logger,
): Promise<Record<string, unknown>> {
  const target = customPath ?? openCodeModelsCachePath();
  const result = await readJsonObjectSafe(target);
  logger?.trace("readOpenCodeModelsCache", `${Object.keys(result).length} keys from ${target}`);
  return result;
}

/**
 * Adapts the gentle-ai variants shape (`Record<providerId, Record<modelId, string[]>>`)
 * into the `ModelDataCache.providers` shape (`Record<providerId, Record<modelId, { variants: Effort[] }>>`).
 * Pure — does not mutate the input.
 *
 * Type note: variant keys originate from the OpenCode SDK as plain strings.
 * They are widened to `Effort[]` in the cache contract so downstream consumers
 * (PR4 forecast engine) can rely on the literal-union type. The cast is
 * safe-by-contract because the SDK only returns documented ClaudeEffort keys;
 * invalid values propagate as-is and are clamped in the engine layer.
 */
export function buildProvidersCache(
  variantsByProvider: Record<string, Record<string, string[]>>,
): Record<string, Record<string, { variants: Effort[] }>> {
  const out: Record<string, Record<string, { variants: Effort[] }>> = {};
  for (const [providerId, models] of Object.entries(variantsByProvider)) {
    const adapted: Record<string, { variants: Effort[] }> = {};
    for (const [modelId, variants] of Object.entries(models)) {
      adapted[modelId] = { variants: [...variants] as Effort[] };
    }
    out[providerId] = adapted;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * PR1 — Live model discovery (pending-queue data layer)
 *
 * Builds a `Discovery` from the available sources:
 *   1. provider.list() result (preferred — live SDK data)
 *   2. OpenCode models cache file (fallback)
 *
 * A source counts as "valid" when it has a recognized shape, even if
 * it yields zero models. The result is `complete` with zero entries
 * rather than `unavailable` so callers can distinguish "catalog is
 * empty" from "we could not read the catalog".
 *
 * Discovery is non-throwing — every step is best-effort and malformed
 * inputs degrade gracefully (an unrecognizable provider-list falls
 * through to the cache; an empty cache falls through to `unavailable`).
 * -------------------------------------------------------------------------- */

function hasProviderListShape(input: unknown): boolean {
  // Mirrors the recognition logic of `extractProviderList` so the
  // empty-but-valid case (`{ all: [] }`) is treated as a parseable
  // source and emits `complete` with zero entries.
  if (Array.isArray(input)) return true;
  if (input === null || input === undefined) return false;
  if (typeof input !== "object") return false;
  const obj = input as { data?: unknown };
  const data: unknown = obj.data ?? input;
  if (data === null || typeof data !== "object") return false;
  if (Array.isArray(data)) return true;
  const c = data as { all?: unknown; providers?: unknown };
  if (Array.isArray(c.all)) return true;
  if (Array.isArray(c.providers)) return true;
  return false;
}

function collectLiveModelsFromProviderList(providerList: unknown[]): LiveModel[] {
  const out: LiveModel[] = [];
  for (const prov of providerList) {
    if (!prov || typeof prov !== "object") continue;
    const providerId = (prov as { id?: unknown }).id;
    if (typeof providerId !== "string" || providerId.length === 0) continue;
    const models = (prov as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue;
      const variants = (model as { variants?: unknown }).variants;
      const hasVariants = !!(
        variants &&
        typeof variants === "object" &&
        Object.keys(variants as object).length > 0
      );
      out.push({
        provider: providerId.toLowerCase(),
        model: modelId.toLowerCase(),
        hasVariants,
      });
    }
  }
  return out;
}

function collectLiveModelsFromOpenCodeCache(
  cache: Record<string, unknown>,
): LiveModel[] {
  const out: LiveModel[] = [];
  for (const [providerId, prov] of Object.entries(cache)) {
    if (!prov || typeof prov !== "object") continue;
    const models = (prov as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue;
      const variants = (model as { variants?: unknown }).variants;
      const hasVariants = !!(
        variants &&
        typeof variants === "object" &&
        Object.keys(variants as object).length > 0
      );
      out.push({
        provider: providerId.toLowerCase(),
        model: modelId.toLowerCase(),
        hasVariants,
      });
    }
  }
  return out;
}

function sortLiveModels(models: readonly LiveModel[]): LiveModel[] {
  // Deterministic order: sort by `provider/model`. Two models with the
  // same key (impossible from a single source) keep insertion order.
  return [...models].sort((a, b) => {
    const ak = `${a.provider}/${a.model}`;
    const bk = `${b.provider}/${b.model}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

/**
 * Derives a `Discovery` from the available sources. Provider-list is
 * preferred; the opencode cache is a fallback for offline or
 * pre-warmed reads. Both empty-but-valid sources still count as
 * `complete` (with zero models) so callers can distinguish a missing
 * catalog from an empty one.
 *
 * Never throws. The output is deterministic for a given input.
 */
export function discoverLiveModels(sources: {
  providerList?: unknown;
  openCodeCache?: Record<string, unknown>;
}): Discovery {
  // Try provider-list first.
  if (sources.providerList !== undefined && hasProviderListShape(sources.providerList)) {
    const providerList = extractProviderList(sources.providerList);
    return {
      status: "complete",
      source: "provider-list",
      models: sortLiveModels(collectLiveModelsFromProviderList(providerList)),
    };
  }
  // Fall back to opencode-cache.
  if (sources.openCodeCache && typeof sources.openCodeCache === "object") {
    const models = collectLiveModelsFromOpenCodeCache(sources.openCodeCache);
    if (models.length > 0) {
      return {
        status: "complete",
        source: "opencode-cache",
        models: sortLiveModels(models),
      };
    }
  }
  return {
    status: "unavailable",
    source: "none",
    models: [],
  };
}