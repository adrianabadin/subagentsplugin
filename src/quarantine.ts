/**
 * 429-fallback (SDD change) — QuarantineStore.
 *
 * Spec #1316 requirement 2 + design #1317 §2. In-memory TTL-keyed model
 * blocklist used by the after hook to skip rungs that just hit a 429.
 *
 * Contract:
 *   - `add(model, reason)` is idempotent: re-adding the same model
 *     refreshes `expiresAt` and `reason` and keeps a SINGLE entry.
 *     Non-manual (auto rate-limit) entries are NEVER persisted.
 *   - `addManual(model, reason, opts)` is idempotent in the same way and
 *     ALWAYS sets `manual: true`. Manual entries (both permanent and
 *     finite-TTL) MAY be persisted via `saveToFile`. Manual finite-TTL
 *     entries whose `expiresAt <= now` are dropped on `loadFromFile`
 *     so a restart after expiry does not "revive" them.
 *   - `isBlocked(model)` = `now < expiresAt` (half-open; equal => false).
 *   - `snapshot()` lazily purges entries with `expiresAt <= now` so
 *     consumers see only live blocklist.
 *   - `clear()` empties the store.
 *   - `clearNonPermanent()` only removes finite-ttl entries; permanent
 *     entries (provider/billing errors, `expiresAt === Infinity`) survive.
 *   - `release(model)` removes a single model from the store. Returns
 *     `true` when an entry was removed, `false` when the model was not
 *     blocked. Used by the TUI release flow.
 *   - `saveToFile(path)` persists manual entries (permanent AND finite
 *     TTL) but skips non-manual TTL entries (rate-limit auto-quarantines
 *     must never survive restart). The on-disk shape uses `null` for
 *     `Infinity` and the `manual` flag for finite-TTL entries.
 *   - `loadFromFile(path)` restores permanent entries (null → Infinity)
 *     AND manual finite-TTL entries whose `expiresAt > now` (expired
 *     manual TTL entries are dropped — they would be inert anyway).
 *     Non-manual TTL entries in the file are silently ignored.
 *   - Clock is injectable via `options.now` (default `Date.now`).
 *   - Default TTL is 3_600_000 ms (60 min) per design #1317 §2.
 *
 * The class implements the structural `QuarantineBlocklist` interface
 * (defined here) so `src/profiles.ts` can depend on the structural
 * shape without importing this leaf module's class.
 *
 * Cross-bundle singleton pattern:
 *   tsup builds each entry (`index`, `api`, `cli`, `tui`) into a SEPARATE
 *   module bundle, so a `module-level singleton` in this file is NOT
 *   shared across bundles. The live plugin instance and the TUI live in
 *   DIFFERENT bundles. For "immediate effect" the plugin publishes its
 *   store on `globalThis` via `setSharedQuarantineStore(quarantine)`
 *   immediately after construction; the TUI reads/mutates the SAME
 *   `QuarantineStore` instance from there.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";
import {
  resolveModelGroup,
  resolveQuarantineTarget,
} from "./model-groups.js";

export interface QuarantineEntry {
  model: string;
  reason: string;
  expiresAt: number;
  /**
   * `true` for entries created by `addManual` (user-initiated, can be
   * persisted). `false`/absent for automatic rate-limit entries
   * (in-memory only — must NOT survive restart).
   */
  manual?: boolean;
}

export interface QuarantineBlocklist {
  isBlocked(model: string): boolean;
}

export interface QuarantineStoreOptions {
  /** Time-to-live in milliseconds. Defaults to 3_600_000 (60 min). */
  ttlMs?: number;
  /** Injectable clock returning the current time in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional logger for trace-level operation logging. */
  logger?: import("./logger.js").Logger;
}

const DEFAULT_TTL_MS = 3_600_000;

/**
 * On-disk shape: `expiresAt === null` means permanent (Infinity in memory).
 * Manual finite-TTL entries carry their numeric `expiresAt` and the
 * `manual: true` flag. Non-manual TTL entries are never persisted.
 */
interface SerializedEntry {
  model: string;
  reason: string;
  expiresAt: number | null;
  manual?: boolean;
}

function serializeEntry(entry: QuarantineEntry): SerializedEntry {
  const out: SerializedEntry = {
    model: entry.model,
    reason: entry.reason,
    expiresAt: entry.expiresAt === Infinity ? null : entry.expiresAt,
  };
  if (entry.manual === true) out.manual = true;
  return out;
}

/**
 * The canonical on-disk location for the quarantine persistence file.
 * Exposed so the TUI bundle, the CLI bundle, and the plugin bundle all
 * agree on the same path (they all live in different module bundles
 * after tsup, so they cannot share a module-level constant via direct
 * import — they all read it from this function instead).
 */
export function defaultQuarantineFilePath(): string {
  return path.join(homedir(), ".cache", "opencode-model-forecast", "quarantine.json");
}

export class QuarantineStore implements QuarantineBlocklist {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries: Map<string, QuarantineEntry>;
  private readonly logger?: import("./logger.js").Logger;

  constructor(options: QuarantineStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.entries = new Map<string, QuarantineEntry>();
    this.logger = options.logger;
  }

  /**
   * Idempotent. Re-adding the same model refreshes `expiresAt` and
   * `reason` while keeping a single entry. This is the
   * AUTOMATIC / RATE-LIMIT path — entries are NEVER persisted across
   * restart. Use `addManual` for entries that should survive restart.
   *
   * Model-group expansion (SDD change): the model is resolved to its
   * full group of equivalent aliases before storing.  Every alias in
   * the group gets an identical entry so `isBlocked` on any group
   * member returns `true`.  The returned `QuarantineEntry` carries the
   * original (caller-supplied) model string for audit backwards-compat.
   */
  add(model: string, reason: string, ttlMs?: number): QuarantineEntry {
    const expiresAt = ttlMs === Infinity ? Infinity : this.now() + (ttlMs ?? this.ttlMs);
    const entry: QuarantineEntry = { model, reason, expiresAt };
    // Expand the model to all equivalent group aliases so the router
    // cannot evade quarantine by selecting a different alias for the
    // same underlying model group.
    const group = resolveModelGroup(model);
    for (const alias of group) {
      this.entries.set(alias, { model: alias, reason, expiresAt });
    }
    this.logger?.info("quarantine", `add model=${model} reason=${reason} ttlMs=${ttlMs ?? this.ttlMs} permanent=${expiresAt === Infinity} manual=false group=${group.length > 1 ? `expanded to ${group.length} aliases` : "singleton"}`);
    return entry;
  }

  /**
   * Manual (user-initiated) add. Sets `manual: true` so the entry is
   * eligible for persistence. Exact model ids remain singletons; only an
   * explicit `provider/*` target expands. Unlike `add()`, this method never
   * performs implicit model-family expansion.
   *
   * - `{ permanent: true }`            ⇒ `expiresAt = Infinity`
   * - `{ ttlMs: <positive number> }`   ⇒ `expiresAt = now + ttlMs`
   *
   * Exactly one of `permanent` / `ttlMs` should be supplied. When both
   * are absent the default TTL is used (treat as a TTL entry).
   */
  addManual(
    model: string,
    reason: string,
    opts: { permanent?: boolean; ttlMs?: number } = {},
  ): QuarantineEntry {
    const ttl = opts.permanent === true ? Infinity : (opts.ttlMs ?? this.ttlMs);
    const expiresAt = ttl === Infinity ? Infinity : this.now() + ttl;
    const group = resolveQuarantineTarget(model);
    const entry: QuarantineEntry = { model, reason, expiresAt, manual: true };
    for (const alias of group) {
      this.entries.set(alias, { model: alias, reason, expiresAt, manual: true });
    }
    this.logger?.info(
      "quarantine",
      `addManual model=${model} reason=${reason} ttlMs=${ttl === Infinity ? "Infinity" : ttl} permanent=${expiresAt === Infinity} manual=true group=${group.length > 1 ? `expanded to ${group.length} aliases` : "singleton"}`,
    );
    return entry;
  }

  /**
   * Half-open block: `now < expiresAt` ⇒ blocked. `now === expiresAt`
   * ⇒ NOT blocked (spec "Boundary equal" scenario).
   */
  isBlocked(model: string): boolean {
    const entry = this.entries.get(model);
    if (entry === undefined) return false;
    const blocked = this.now() < entry.expiresAt;
    if (blocked) {
      const untilStr = entry.expiresAt === Infinity ? "Infinity" : new Date(entry.expiresAt).toISOString();
      this.logger?.trace("quarantine", `isBlocked model=${model} => true (until ${untilStr})`);
    }
    return blocked;
  }

  /** Removes ALL entries (permanent and TTL-based). */
  clear(): void {
    this.logger?.info("quarantine", `clear (was ${this.entries.size} entries)`);
    this.entries.clear();
  }

  /**
   * Removes only NON-permanent entries (finite `expiresAt`). Permanent
   * entries (provider/billing errors) survive so they persist across
   * plugin restarts when combined with file persistence.
   */
  clearNonPermanent(): void {
    let removed = 0;
    for (const [model, entry] of this.entries) {
      if (Number.isFinite(entry.expiresAt)) {
        this.entries.delete(model);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger?.info("quarantine", `clearNonPermanent removed ${removed} TTL entries (${this.entries.size} permanent entries remain)`);
    }
  }

  /**
   * Removes a single model from the store. Returns `true` if an entry
   * existed and was removed, `false` otherwise. Group-expands the
   * target so `release("opencode-go/*")` clears every alias at once.
   * Used by the TUI release flow + the CLI `release` subcommand.
   */
  release(model: string): boolean {
    const group = resolveQuarantineTarget(model);
    let removed = 0;
    for (const alias of group) {
      if (this.entries.delete(alias)) removed += 1;
    }
    this.logger?.info(
      "quarantine",
      `release model=${model} removed=${removed} requested=${group.length}`,
    );
    return removed > 0;
  }

  /**
   * Reconcile persisted quarantines from disk into the live store while
   * preserving finite, non-manual rate-limit entries that only live in memory.
   * This is used by the backend plugin watcher: TUI/CLI/agent write the file,
   * the backend reloads it, and releases remove persisted entries from memory.
   */
  syncPersistentEntries(entries: readonly QuarantineEntry[]): { added: number; removed: number } {
    let removed = 0;
    for (const [model, entry] of this.entries) {
      if (entry.manual === true || entry.expiresAt === Infinity) {
        this.entries.delete(model);
        removed += 1;
      }
    }

    let added = 0;
    for (const entry of entries) {
      if (entry.expiresAt <= this.now()) continue;
      this.entries.set(entry.model, { ...entry });
      added += 1;
    }

    this.logger?.info(
      "quarantine",
      `syncPersistentEntries removed=${removed} added=${added}`,
    );
    return { added, removed };
  }

  /**
   * Lazy purge: drops entries with `expiresAt <= now` and returns the
   * remaining live entries. Mutates the underlying map so subsequent
   * `isBlocked` checks are also faster.
   *
   * Permanent entries (`expiresAt === Infinity`) are never purged
   * (`Infinity <= nowMs` is always false).
   */
  snapshot(): QuarantineEntry[] {
    const nowMs = this.now();
    const live: QuarantineEntry[] = [];
    for (const [model, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(model);
        continue;
      }
      live.push({ ...entry });
    }
    return live;
  }

  /* ---------------------------------------------------------------------- *
   * Persistence — manual quarantines survive CLI/plugin restart.
   *
   * Contract:
   *   - saveToFile: writes BOTH permanent entries (`expiresAt === Infinity`)
   *     AND manual finite-TTL entries (entries with `manual: true`). The
   *     `manual` flag is preserved on disk so the loader can distinguish
   *     them from rate-limit TTL entries (which are in-memory only).
   *     Non-manual TTL entries are SKIPPED so a restart does not revive
   *     a 429 fallback. An empty manual+permanent set writes `[]` to
   *     clear any stale entries from a previous version.
   *   - loadFromFile: restores entries with `expiresAt: null` (permanent,
   *     become Infinity) AND entries with `expiresAt: number` +
   *     `manual: true` (manual finite-TTL, dropped when `expiresAt <= now`).
   *     Non-manual TTL entries (e.g. legacy rate-limit leftovers) are
   *     silently ignored — rate-limit quarantines live in memory only
   *     and must never be revived across CLI/plugin restart.
   * ---------------------------------------------------------------------- */

  /**
   * Persists permanent entries + manual finite-TTL entries to disk.
   * Non-manual TTL entries are skipped — they belong in memory only
   * and must not be revived across CLI/plugin restart.
   *
   * Creates parent directories. Never throws — logs and continues.
   */
  async saveToFile(filePath: string): Promise<void> {
    try {
      const serialized: SerializedEntry[] = [];
      for (const entry of this.entries.values()) {
        const isPermanent = entry.expiresAt === Infinity;
        const isManualTtl = entry.manual === true && Number.isFinite(entry.expiresAt);
        if (!isPermanent && !isManualTtl) continue;
        serialized.push(serializeEntry(entry));
      }

      const dir = path.dirname(filePath);
      try { await mkdir(dir, { recursive: true }); } catch { /* ok */ }

      await writeFile(filePath, JSON.stringify(serialized, null, 2), "utf8");
      this.logger?.info(
        "quarantine",
        `saveToFile wrote ${serialized.length} entries (permanent + manual TTL): ${filePath}`,
      );
    } catch (err) {
      this.logger?.warn("quarantine", `saveToFile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Restores permanent entries + manual finite-TTL entries from disk.
   * Non-manual TTL entries are silently skipped — they must never
   * survive restart. Manual TTL entries whose `expiresAt <= now` are
   * dropped (they have expired while offline).
   *
   * Missing file, empty file, or invalid JSON → no-op (never throws).
   *
   * Existing in-memory entries are NOT cleared — call `clear()` first
   * if you want a fresh load. Entries from the file are upserted into
   * the existing map (idempotent: re-adding the same model refreshes).
   */
  async loadFromFile(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // Missing file is not an error.
      return;
    }
    if (raw.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;

    let loaded = 0;
    let skipped = 0;
    let droppedExpired = 0;
    const nowMs = this.now();
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.model !== "string" || entry.model.length === 0) continue;
      if (typeof entry.reason !== "string") continue;

      const expiresAtRaw = entry.expiresAt;
      const isManual = entry.manual === true;

      if (expiresAtRaw === null) {
        // null → permanent (Infinity) — restore.
        // Use explicit-target semantics: an individual `provider/model`
        // stays a singleton (no implicit family expansion) while an
        // explicit `provider/*` group expands to all provider members.
        // Permanent entries are inherently manual (the auto rate-limit
        // path always uses finite TTL), so we mark them `manual: true`
        // for round-trip identity preservation.
        const group = resolveQuarantineTarget(entry.model);
        for (const alias of group) {
          this.entries.set(alias, {
            model: alias,
            reason: entry.reason,
            expiresAt: Infinity,
            manual: true,
          });
        }
        loaded += 1;
        continue;
      }

      // TTL entry on disk — only restore if `manual: true` is set.
      // Rate-limit (non-manual) TTL entries are silently skipped.
      if (typeof expiresAtRaw !== "number" || !Number.isFinite(expiresAtRaw)) {
        skipped += 1;
        continue;
      }

      if (!isManual) {
        skipped += 1;
        continue;
      }

      if (expiresAtRaw <= nowMs) {
        // Manual TTL entry that expired while offline — drop, do not revive.
        droppedExpired += 1;
        continue;
      }

      // Explicit-target semantics: individual ids stay singletons; only
      // an explicit `provider/*` group expands.
      const group = resolveQuarantineTarget(entry.model);
      for (const alias of group) {
        this.entries.set(alias, {
          model: alias,
          reason: entry.reason,
          expiresAt: expiresAtRaw,
          manual: true,
        });
      }
      loaded += 1;
    }
    if (loaded > 0 || skipped > 0 || droppedExpired > 0) {
      this.logger?.info(
        "quarantine",
        `loadFromFile loaded=${loaded} skipped=${skipped} droppedExpired=${droppedExpired}: ${filePath}`,
      );
    }
  }
}

/* ---------------------------------------------------------------------- *
 * Cross-bundle shared-store accessor (globalThis-backed).
 *
 * tsup bundles `dist/index.js` (plugin) and `dist/tui.js` (TUI) as
 * SEPARATE modules with NO code-sharing. A module-level singleton in
 * this file would NOT be visible to both bundles. Instead, the plugin
 * publishes its live `QuarantineStore` on `globalThis` at startup, and
 * the TUI / CLI read it back from the same slot. This is the only way
 * to achieve "TUI mutation is immediately observed by the running
 * plugin" without IPC.
 *
 * The key is a registry-stable symbol so consumers cannot collide with
 * unrelated `globalThis` keys.
 * ---------------------------------------------------------------------- */

const SHARED_KEY = Symbol.for("model-forecast.quarantine");

interface SharedGlobalThis {
  [SHARED_KEY]?: QuarantineStore;
}

/**
 * Publish the live `QuarantineStore` on `globalThis`. Called by the
 * plugin immediately after construction so the TUI / CLI (which live
 * in separate tsup bundles) can reach the same instance.
 */
export function setSharedQuarantineStore(store: QuarantineStore): void {
  const g = globalThis as unknown as SharedGlobalThis;
  g[SHARED_KEY] = store;
}

/**
 * Read the live `QuarantineStore` previously published by
 * `setSharedQuarantineStore`. Returns `null` when the plugin has not
 * registered a store yet (e.g. the TUI is invoked before the plugin
 * finishes startup).
 */
export function getSharedQuarantineStore(): QuarantineStore | null {
  const g = globalThis as unknown as SharedGlobalThis;
  return g[SHARED_KEY] ?? null;
}

/**
 * Clear the published shared store. Intended for tests that need to
 * guarantee isolation; production code should never call this.
 */
export function clearSharedQuarantineStore(): void {
  const g = globalThis as unknown as SharedGlobalThis;
  delete g[SHARED_KEY];
}
