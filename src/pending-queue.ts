/**
 * PR1 — Pending model queue data layer.
 *
 * Spec: see the `sdd/enrich-discovered-model-evidence/{spec,design,tasks}`
 * artifacts in PMC. This module owns:
 *
 *   - The strict `PendingEntry` shape (`key`, `firstSeenAt`, `providers`).
 *     The shape is deliberately small: pending entries MUST NOT carry
 *     `benchmarks`, `confidence`, `source`, `date`, or `availability` —
 *     those fields are reserved for the curated evidence registry.
 *   - The `Discovery` and `LiveModel` types shared with `src/models.ts`.
 *   - `computePendingDelta` — derives the canonical pending snapshot
 *     (`live − verified`) with deterministic ordering (lowercased,
 *     unique keys, sorted) and timestamp retention for still-pending
 *     keys.
 *   - `validatePendingEntry` — strict-shape validator. Rejects entries
 *     with ANY extra fields so on-disk and in-memory representations
 *     stay in lockstep with the published contract.
 *   - `loadPendingQueue` / `writePendingQueue` / `clearPendingQueue` —
 *     atomic I/O for `forecast-data/pending.json`. Reads never throw;
 *     writes return a `{ ok, error? }` result so the caller decides
 *     how to react. A failed write cleans its own tmp file and
 *     preserves the existing target.
 *
 * Design: all functions in this module are either pure (no I/O) or
 * safe-by-default I/O (never throw, never partial-write, never leave
 * behind `.tmp` artefacts).
 */

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { randomBytes } from "crypto";
import path from "path";

/* -------------------------------------------------------------------------- *
 * Types
 * -------------------------------------------------------------------------- */

/**
 * Canonical key format: `${provider}/${model}` (lowercased), or for
 * models that appear under multiple distinct providers with the same
 * bare name, just `${model}` (lowercased). See `computePendingDelta`.
 */
export type PendingKey = string;

/**
 * One pending entry persisted to `forecast-data/pending.json`. Strict
 * shape — NO invented evidence fields. Verified peers are looked up via
 * the curated registry, not via the pending queue.
 */
export interface PendingEntry {
  /** Canonical model key, lowercased. */
  key: PendingKey;
  /** ISO-8601 timestamp the model was first observed in the live delta. */
  firstSeenAt: string;
  /** Sorted, unique provider ids that reported the model. */
  providers: string[];
}

/** A single live model observed in the catalog. */
export interface LiveModel {
  /** Lowercased provider id. */
  provider: string;
  /** Lowercased model id (without provider prefix). */
  model: string;
  /**
   * Whether the model exposes at least one documented variant. Optional
   * because callers (e.g. `computePendingDelta`) that operate on a
   * minimal `{ provider, model }` shape do not need to set it. The
   * discovery function in `src/models.ts` populates it whenever the
   * catalog carries a `variants` object.
   */
  hasVariants?: boolean;
}

/**
 * Live catalog discovery result. The `source` describes which input
 * drove the discovery; `status` reports whether at least one source
 * was parseable (even an empty parseable list still counts as
 * `complete`).
 */
export interface Discovery {
  status: "complete" | "unavailable";
  source: "provider-list" | "opencode-cache" | "none";
  models: LiveModel[];
}

/** Result of an atomic `writePendingQueue` call. The writer never throws. */
export interface PendingWriteResult {
  ok: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- *
 * Strict-shape validator
 * -------------------------------------------------------------------------- */

const PENDING_ENTRY_FIELDS = new Set<keyof PendingEntry>([
  "key",
  "firstSeenAt",
  "providers",
]);

/**
 * Returns `true` iff `value` matches the strict `PendingEntry` shape.
 * Any unknown field is rejected — pending entries are not a generic
 * record. In particular `benchmarks`, `confidence`, `source`, `date`,
 * and `availability` are reserved for the curated evidence registry
 * and MUST NOT appear on a pending entry.
 */
export function validatePendingEntry(value: unknown): value is PendingEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  // Reject any unknown field — strict shape, not open-world.
  for (const field of Object.keys(v)) {
    if (!PENDING_ENTRY_FIELDS.has(field as keyof PendingEntry)) {
      return false;
    }
  }
  if (typeof v.key !== "string" || v.key.length === 0) return false;
  if (typeof v.firstSeenAt !== "string" || v.firstSeenAt.length === 0) return false;
  if (!Array.isArray(v.providers)) return false;
  for (const provider of v.providers) {
    if (typeof provider !== "string" || provider.length === 0) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- *
 * Delta computation (pure)
 * -------------------------------------------------------------------------- */

/**
 * Derives the canonical pending snapshot. Returns the set difference
 * `live − verified` with deterministic ordering (lowercased, unique
 * keys, sorted by key), retaining the prior `firstSeenAt` for keys
 * still present in the new delta.
 *
 * Pure — no I/O, no random IDs. The caller controls the clock via the
 * `now` parameter; the default returns the current Date.
 *
 * Key derivation rules (PR1 contract):
 *   - If multiple DISTINCT providers report the same BARE model id
 *     (no `/`), the canonical key is the bare model id. Providers are
 *     deduped and sorted.
 *   - Otherwise, the canonical key is `${provider}/${model}` for
 *     bare model ids. Qualified model ids (containing `/`) use the
 *     model id itself as the key (the provider is implicit).
 */
export function computePendingDelta(
  live: readonly LiveModel[],
  verified: ReadonlySet<string>,
  prior: readonly PendingEntry[] = [],
  now: () => Date = () => new Date(),
): PendingEntry[] {
  // Group live models by lowercased model id so we can detect
  // cross-provider aliasing.
  const groups = new Map<string, LiveModel[]>();
  for (const m of live) {
    const modelKey = m.model.toLowerCase();
    if (modelKey.length === 0) continue;
    const list = groups.get(modelKey);
    if (list) {
      list.push(m);
    } else {
      groups.set(modelKey, [m]);
    }
  }

  // Index prior entries by lowercased key for timestamp retention.
  const priorByKey = new Map<string, PendingEntry>();
  for (const entry of prior) {
    priorByKey.set(entry.key.toLowerCase(), entry);
  }

  const result: PendingEntry[] = [];
  for (const [modelKey, members] of groups) {
    if (members.length === 0) continue;

    // Determine the canonical key.
    const distinctProviders = new Set(
      members.map((m) => m.provider.toLowerCase()).filter((p) => p.length > 0),
    );
    let canonicalKey: string;
    if (members.length > 0 && members[0]!.model.includes("/")) {
      // Qualified model id: the provider is implicit. Use the first
      // occurrence as the canonical form.
      canonicalKey = members[0]!.model.toLowerCase();
    } else if (distinctProviders.size > 1) {
      // Multiple distinct providers on the same bare model: collapse
      // to just the model id.
      canonicalKey = modelKey;
    } else {
      // Single provider: key is `${provider}/${model}`.
      const [provider, model] = [...distinctProviders][0]!.split("/");
      canonicalKey = `${provider ?? members[0]!.provider.toLowerCase()}/${modelKey}`;
    }
    canonicalKey = canonicalKey.toLowerCase();

    // Verified lookup uses the canonical key (with provider prefix).
    if (verified.has(canonicalKey)) continue;

    // Timestamp retention: keep the prior firstSeenAt for still-pending keys.
    const priorEntry = priorByKey.get(canonicalKey);
    const firstSeenAt = priorEntry?.firstSeenAt ?? now().toISOString();

    // Providers list: dedupe, sort.
    const providersSet = new Set<string>();
    for (const m of members) {
      const p = m.provider.toLowerCase();
      if (p.length > 0) providersSet.add(p);
    }
    const providers = [...providersSet].sort();

    result.push({ key: canonicalKey, firstSeenAt, providers });
  }

  // Deterministic order: sort by key.
  result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return result;
}

/* -------------------------------------------------------------------------- *
 * Atomic I/O
 * -------------------------------------------------------------------------- */

const PENDING_FILENAME = "pending.json";

/**
 * Reads the pending queue at `filePath`. Returns an empty array on:
 *   - missing file (ENOENT or any other read error)
 *   - empty file
 *   - invalid JSON
 *   - non-array root
 *   - any individual entry failing `validatePendingEntry`
 *
 * Never throws. A malformed or partial file is treated as empty so a
 * refresh can rebuild it deterministically on the next run.
 */
export async function loadPendingQueue(filePath: string): Promise<PendingEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  for (const entry of parsed) {
    if (!validatePendingEntry(entry)) {
      // Any malformed entry poisons the whole file — treat as empty.
      return [];
    }
  }
  // Deep-copy so the caller cannot mutate the parsed structure.
  return parsed.map((entry) => ({
    key: (entry as PendingEntry).key,
    firstSeenAt: (entry as PendingEntry).firstSeenAt,
    providers: [...(entry as PendingEntry).providers],
  }));
}

/**
 * Writes `entries` to `filePath` atomically. The data is first written
 * to a same-directory tmp file and then renamed over the target. The
 * parent directory is created if it does not exist. On failure:
 *   - the tmp file is removed best-effort
 *   - the existing target is preserved
 *   - the function returns `{ ok: false, error }` instead of throwing
 *
 * The result-returning shape lets the CLI surface the failure in stderr
 * without breaking the forecast pipeline.
 */
export async function writePendingQueue(
  filePath: string,
  entries: readonly PendingEntry[],
): Promise<PendingWriteResult> {
  const dir = path.dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }

  const tmpPath = path.join(dir, `${PENDING_FILENAME}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
    await rename(tmpPath, filePath);
    return { ok: true };
  } catch (err) {
    // Best-effort tmp cleanup so the cache directory does not leak.
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Ignore — the original error is the one to surface.
    }
    return { ok: false, error: formatError(err) };
  }
}

/**
 * Removes the on-disk pending queue. No-op when the file is absent.
 * Never throws. Used by tests and (in future PRs) by reset flows.
 */
export async function clearPendingQueue(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Best-effort: a missing file is a no-op; any other failure is
    // absorbed so a stuck `clearPendingQueue` cannot break startup.
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
