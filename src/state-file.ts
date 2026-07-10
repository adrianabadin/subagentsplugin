/**
 * Forecast state file — atomic writer + reader used to bridge state from
 * the server plugin module to the (separate-process) tui plugin module.
 *
 * Per the Opus-validated design (`sdd/forecast-ux-maintenance/design.md`),
 * server and tui modules cannot share memory — they are mutually
 * exclusive plugin shapes in the OpenCode SDK. The contract is a single
 * JSON file under `~/.cache/opencode-model-forecast/state.json` that the
 * server writes atomically after each relevant hook, and the tui module
 * reads reactively.
 *
 * This file is purely the I/O layer. The TUI module is responsible for
 * re-reading the file when it changes; the server does NOT poll the file
 * (only writes).
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { randomBytes } from "crypto";

export interface ForecastState {
  selectedModel: string | null;
  selectedEffort: string;
  selectedConfidence: number;
  fallbackModel: string | null;
  fallbackConfidence: number;
  preset: string;
  mode: "auto" | "advisory" | "off";
  quarantineCount: number;
  quarantined: string[];
  cacheAge: string | null;
  lastUpdate: string;
}

export const STATE_FILENAME = "state.json";
export const STATE_DIR_NAME = ".cache/opencode-model-forecast";

export function defaultStatePath(): string {
  return path.join(homedir(), STATE_DIR_NAME, STATE_FILENAME);
}

/**
 * Validates a parsed JSON value against the `ForecastState` shape. Returns
 * `null` when the payload is structurally valid, or a reason string when it
 * is not (so callers can log why a write/read failed).
 */
function validateState(value: unknown): { ok: true; state: ForecastState } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "root is not an object" };
  }
  const v = value as Record<string, unknown>;
  const stringOrNull = (x: unknown): boolean =>
    x === null || typeof x === "string";
  if (!stringOrNull(v.selectedModel)) return { ok: false, reason: "selectedModel invalid" };
  if (typeof v.selectedEffort !== "string") return { ok: false, reason: "selectedEffort invalid" };
  if (typeof v.selectedConfidence !== "number" || !Number.isFinite(v.selectedConfidence)) {
    return { ok: false, reason: "selectedConfidence invalid" };
  }
  if (!stringOrNull(v.fallbackModel)) return { ok: false, reason: "fallbackModel invalid" };
  if (typeof v.fallbackConfidence !== "number" || !Number.isFinite(v.fallbackConfidence)) {
    return { ok: false, reason: "fallbackConfidence invalid" };
  }
  if (typeof v.preset !== "string") return { ok: false, reason: "preset invalid" };
  if (v.mode !== "auto" && v.mode !== "advisory" && v.mode !== "off") {
    return { ok: false, reason: "mode invalid" };
  }
  if (typeof v.quarantineCount !== "number" || !Number.isFinite(v.quarantineCount)) {
    return { ok: false, reason: "quarantineCount invalid" };
  }
  if (!Array.isArray(v.quarantined) || v.quarantined.some((x) => typeof x !== "string")) {
    return { ok: false, reason: "quarantined invalid" };
  }
  if (!stringOrNull(v.cacheAge)) return { ok: false, reason: "cacheAge invalid" };
  if (typeof v.lastUpdate !== "string") return { ok: false, reason: "lastUpdate invalid" };
  return { ok: true, state: value as ForecastState };
}

/**
 * Per-statePath write serialization so concurrent writers cannot collide on
 * the same tmp file or the target rename. Entries are evicted when the
 * chain settles so the map never grows unbounded.
 */
const writeLocks = new Map<string, Promise<void>>();

/**
 * Atomically writes `state` to `statePath`. Validates the payload up
 * front so a buggy writer cannot poison the on-disk state. Creates
 * parent directory if missing. Writes go via tmp + rename so concurrent
 * readers never see a partial JSON document. Concurrent writers to the
 * SAME `statePath` are serialized internally so the target rename cannot
 * collide.
 *
 * Throws when `state` is invalid OR on filesystem errors; callers wrap
 * and log.
 */
export async function writeStateFile(statePath: string, state: ForecastState): Promise<void> {
  const validated = validateState(state);
  if (!validated.ok) {
    throw new Error(`writeStateFile rejected invalid state: ${validated.reason}`);
  }
  const previous = writeLocks.get(statePath) ?? Promise.resolve();
  const next = previous.then(() => doWrite(statePath, validated.state));
  writeLocks.set(
    statePath,
    next
      .catch(() => undefined)
      .finally(() => {
        if (writeLocks.get(statePath) === next.catch(() => undefined)) {
          writeLocks.delete(statePath);
        }
      }),
  );
  return next;
}

async function doWrite(statePath: string, state: ForecastState): Promise<void> {
  const dir = path.dirname(statePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${statePath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state), "utf8");
  await rename(tmpPath, statePath);
}

/**
 * Reads `statePath`. Returns `null` when the file is missing, empty,
 * malformed, or does not match the ForecastState shape. Never throws.
 */
export async function readStateFile(statePath: string): Promise<ForecastState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = validateState(parsed);
  return result.ok ? result.state : null;
}