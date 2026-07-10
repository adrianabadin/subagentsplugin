/**
 * `forecast quarantine` — manage persistent model quarantines from the CLI.
 *
 * The CLI runs as its own process so it cannot reach the live in-process
 * `QuarantineStore` (the plugin and the CLI live in different tsup
 * bundles AND different Node processes). This subcommand therefore
 * manipulates the persistence file directly, so the change applies on
 * the next plugin load / OpenCode restart.
 *
 * Subcommands:
 *   add <target> [--permanent | --ttl-hours N] [--reason "..."]
 *       Quarantine a single model (`provider/model`) or an entire
 *       provider group (`provider/*`). The target is validated through
 *       `resolveQuarantineTarget` so an unknown provider returns
 *       exit-code 1 with a clear error.
 *
 *   list
 *       Print all current quarantines (model, reason, expiry). Expiry
 *       renders as `permanent` / `expires <iso>` / `expired` so the
 *       reader can tell the state at a glance.
 *
 *   release <target>
 *       Remove matching entries (manual + automatic) from the file.
 *       Group-expanded like `add`.
 *
 * Flags (shared by `add`):
 *   --permanent              mark the entry as permanent (Infinity)
 *   --ttl-hours N            mark the entry with a finite TTL of N hours
 *   --reason "..."           free-form reason string (default "manual-cli")
 *   --root <path>            target project root (default process.cwd())
 *   --file <path>            override the quarantine file path directly
 *
 * Persistence contract is the same as `QuarantineStore`:
 *   - Permanent entries serialize with `expiresAt: null`.
 *   - Manual finite-TTL entries serialize with their numeric
 *     `expiresAt` and `manual: true`.
 *   - Non-manual TTL entries are NEVER persisted.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

import {
  defaultQuarantineFilePath,
  type QuarantineEntry,
} from "./quarantine.js";
import { resolveQuarantineTarget } from "./model-groups.js";

export type QuarantineAction = "add" | "list" | "release";

export interface QuarantineArgs {
  ok: true;
  action: QuarantineAction;
  /** Target for `add` / `release`. Unused by `list`. */
  target?: string;
  /** True when `--permanent` was supplied. */
  permanent: boolean;
  /** Number of hours from `--ttl-hours`. */
  ttlHours?: number;
  /** Reason string from `--reason`. Defaults to `manual-cli` / `manual-tui`. */
  reason?: string;
  /** Optional override of the quarantine file path. */
  filePath?: string;
  /** Optional override of the project root (currently informational only). */
  root?: string;
}

export interface QuarantineArgsFailure {
  ok: false;
  error: string;
}

export interface QuarantineAddSuccess {
  ok: true;
  action: "add";
  expandedCount: number;
  expiresAt: number;
  expiresAtIso: string;
  permanent: boolean;
  filePath: string;
}

export interface QuarantineListSuccess {
  ok: true;
  action: "list";
  filePath: string;
  entries: QuarantineEntry[];
}

export interface QuarantineReleaseSuccess {
  ok: true;
  action: "release";
  removedCount: number;
  filePath: string;
}

export type QuarantineResult =
  | QuarantineAddSuccess
  | QuarantineListSuccess
  | QuarantineReleaseSuccess
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- *
 * Pure argument parser for `forecast quarantine <action> ...`.
 * -------------------------------------------------------------------------- */
export function parseQuarantineArgs(args: string[]): QuarantineArgs | QuarantineArgsFailure {
  if (args.length === 0) {
    return { ok: false, error: "quarantine requires an action: add | list | release" };
  }
  const action = args[0];
  if (action !== "add" && action !== "list" && action !== "release") {
    return {
      ok: false,
      error: `unknown quarantine action: ${action ?? "<empty>"} (expected add | list | release)`,
    };
  }
  let target: string | undefined;
  let permanent = false;
  let ttlHours: number | undefined;
  let reason: string | undefined;
  let filePath: string | undefined;
  let root: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--permanent") {
      permanent = true;
    } else if (arg === "--ttl-hours") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--ttl-hours requires a positive number of hours" };
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: `--ttl-hours must be a positive number (got '${value}')` };
      }
      ttlHours = parsed;
      i += 1;
    } else if (arg === "--reason") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--reason requires a value" };
      reason = value;
      i += 1;
    } else if (arg === "--file") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--file requires a path" };
      filePath = value;
      i += 1;
    } else if (arg === "--root") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--root requires a path" };
      root = value;
      i += 1;
    } else if (typeof arg === "string" && arg.startsWith("--")) {
      return { ok: false, error: `unknown quarantine flag: ${arg}` };
    } else {
      if (target !== undefined) {
        return { ok: false, error: `unexpected extra positional argument: ${arg}` };
      }
      target = arg;
    }
  }

  if (action === "add" || action === "release") {
    if (target === undefined || target.length === 0) {
      return { ok: false, error: `${action} requires a target (provider/model or provider/*)` };
    }
  }

  if (action === "add") {
    if (permanent && ttlHours !== undefined) {
      return { ok: false, error: "--permanent and --ttl-hours are mutually exclusive" };
    }
  } else {
    if (permanent || ttlHours !== undefined) {
      return { ok: false, error: `--permanent / --ttl-hours only apply to 'add'` };
    }
  }

  const out: QuarantineArgs = { ok: true, action, permanent };
  if (target !== undefined) out.target = target;
  if (ttlHours !== undefined) out.ttlHours = ttlHours;
  if (reason !== undefined) out.reason = reason;
  if (filePath !== undefined) out.filePath = filePath;
  if (root !== undefined) out.root = root;
  return out;
}

/* -------------------------------------------------------------------------- *
 * File I/O — read / merge / write the persistence file.
 * -------------------------------------------------------------------------- */

function resolvePath(args: QuarantineArgs): string {
  return args.filePath ?? defaultQuarantineFilePath();
}

/**
 * Parse the on-disk JSON shape into `QuarantineEntry[]`. Missing file,
 * empty file, malformed JSON, or wrong shape → `[]`. Non-manual TTL
 * entries are dropped (they must never survive a CLI run).
 *
 * Exported for testing — the runnable surface uses `runQuarantine`.
 */
export function parseQuarantineFile(raw: string, nowMs: number): QuarantineEntry[] {
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: QuarantineEntry[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.model !== "string" || entry.model.length === 0) continue;
    if (typeof entry.reason !== "string") continue;
    const expiresAtRaw = entry.expiresAt;
    const isManual = entry.manual === true;
    if (expiresAtRaw === null) {
      out.push({ model: entry.model, reason: entry.reason, expiresAt: Infinity });
      continue;
    }
    if (typeof expiresAtRaw !== "number" || !Number.isFinite(expiresAtRaw)) continue;
    if (!isManual) continue; // never persist non-manual TTL entries
    if (expiresAtRaw <= nowMs) continue; // drop already-expired manual TTL entries
    out.push({
      model: entry.model,
      reason: entry.reason,
      expiresAt: expiresAtRaw,
      manual: true,
    });
  }
  return out;
}

/** Async load of the quarantine file with the same parsing rules. */
export async function loadQuarantineFile(filePath: string, nowMs: number = Date.now()): Promise<QuarantineEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parseQuarantineFile(raw, nowMs);
}

/**
 * Atomically write the quarantine file. `entries` should already be
 * the merged set the caller wants persisted. Returns the output path.
 */
export async function writeQuarantineFile(filePath: string, entries: readonly QuarantineEntry[]): Promise<string> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = JSON.stringify(
    entries.map((entry) => {
      const base: { model: string; reason: string; expiresAt: number | null; manual?: boolean } = {
        model: entry.model,
        reason: entry.reason,
        expiresAt: entry.expiresAt === Infinity ? null : entry.expiresAt,
      };
      if (entry.manual === true) base.manual = true;
      return base;
    }),
    null,
    2,
  );
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
  return filePath;
}

/* -------------------------------------------------------------------------- *
 * Pure merge helpers (testable).
 * -------------------------------------------------------------------------- */

const MAX_TTL_HOURS = 8760; // 1 year

/**
 * Compute the `expiresAt` value (ms since epoch) for an `add` call.
 * Returns `{ permanent: true }` when the result is Infinity.
 */
export function resolveAddExpiresAt(nowMs: number, opts: { permanent: boolean; ttlHours?: number }): { expiresAt: number; permanent: boolean } {
  if (opts.permanent) return { expiresAt: Infinity, permanent: true };
  const hours = opts.ttlHours ?? 24;
  if (hours <= 0) return { expiresAt: nowMs, permanent: false }; // immediate expiry
  if (hours > MAX_TTL_HOURS) {
    // Cap silently — caller already validated the input.
    return { expiresAt: nowMs + MAX_TTL_HOURS * 3_600_000, permanent: false };
  }
  return { expiresAt: nowMs + hours * 3_600_000, permanent: false };
}

/**
 * Merge new `add` entries into an existing list. Existing entries for
 * the SAME model id are REPLACED (idempotent re-add semantics). The
 * expanded set is returned as a stable, sorted array (model id asc).
 */
export function mergeAddEntries(
  existing: readonly QuarantineEntry[],
  toAdd: readonly QuarantineEntry[],
): QuarantineEntry[] {
  const map = new Map<string, QuarantineEntry>();
  for (const entry of existing) map.set(entry.model, { ...entry });
  for (const entry of toAdd) map.set(entry.model, { ...entry });
  return [...map.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Remove every entry whose `model` is in the supplied target list.
 * Returns the kept entries + the count that were removed.
 */
export function applyRelease(
  existing: readonly QuarantineEntry[],
  targets: readonly string[],
): { kept: QuarantineEntry[]; removedCount: number } {
  const blocked = new Set(targets);
  const kept: QuarantineEntry[] = [];
  let removedCount = 0;
  for (const entry of existing) {
    if (blocked.has(entry.model)) {
      removedCount += 1;
      continue;
    }
    kept.push(entry);
  }
  return { kept, removedCount };
}

/* -------------------------------------------------------------------------- *
 * Runner — handles all three actions with file I/O.
 * -------------------------------------------------------------------------- */

export async function runQuarantine(
  args: QuarantineArgs,
  now: () => number = Date.now,
): Promise<QuarantineResult> {
  const filePath = resolvePath(args);
  const nowMs = now();

  if (args.action === "add") {
    const target = args.target ?? "";
    const expanded = resolveQuarantineTarget(target);
    if (expanded.length === 0) {
      return {
        ok: false,
        error: `unknown target '${target}' (no registry keys match provider '*' or model id)`,
      };
    }
    const { expiresAt, permanent } = resolveAddExpiresAt(nowMs, {
      permanent: args.permanent,
      ...(args.ttlHours !== undefined ? { ttlHours: args.ttlHours } : {}),
    });
    const reason = args.reason ?? "manual-cli";
    const newEntries: QuarantineEntry[] = expanded.map((model) => ({
      model,
      reason,
      expiresAt,
      ...(permanent ? {} : { manual: true }),
    }));

    const existing = await loadQuarantineFile(filePath, nowMs);
    const merged = mergeAddEntries(existing, newEntries);
    await writeQuarantineFile(filePath, merged);

    return {
      ok: true,
      action: "add",
      expandedCount: expanded.length,
      expiresAt,
      expiresAtIso: permanent ? "permanent" : new Date(expiresAt).toISOString(),
      permanent,
      filePath,
    };
  }

  if (args.action === "release") {
    const target = args.target ?? "";
    const expanded = resolveQuarantineTarget(target);
    if (expanded.length === 0) {
      return {
        ok: false,
        error: `unknown target '${target}' (no registry keys match provider '*' or model id)`,
      };
    }
    const existing = await loadQuarantineFile(filePath, nowMs);
    const { kept, removedCount } = applyRelease(existing, expanded);
    await writeQuarantineFile(filePath, kept);
    return {
      ok: true,
      action: "release",
      removedCount,
      filePath,
    };
  }

  // list
  const existing = await loadQuarantineFile(filePath, nowMs);
  return { ok: true, action: "list", filePath, entries: existing };
}

/* -------------------------------------------------------------------------- *
 * Pure formatter for `list`. Exposed for tests + stable human output.
 * -------------------------------------------------------------------------- */
export function formatQuarantineEntry(entry: QuarantineEntry, nowMs: number): string {
  const until =
    entry.expiresAt === Infinity
      ? "permanent"
      : entry.expiresAt <= nowMs
        ? "expired"
        : `expires ${new Date(entry.expiresAt).toISOString()}`;
  return `${entry.model}\t${entry.reason}\t${until}`;
}