/**
 * PR1 — selection-policy loader (forecast-orchestration-layer).
 *
 * Spec contract (spec #1274 "Layered policy resolution" + "Resilient
 * policy loading"):
 *   - Merge order: project file → plugin options → user file →
 *     built-in defaults. Per key, top wins.
 *   - Built-in defaults: `mode: "advisory"`,
 *     `confidenceThreshold: 0.6`, ladder
 *     `[minimax, google-antigravity, openai, glm-5.2, anthropic]`.
 *   - Missing / malformed / empty / invalid policy files fall back
 *     per-key to the next-priority layer (or built-in) and emit a
 *     warning. Never throws.
 *
 * Policy file format (JSON):
 *   {
 *     "mode": "off" | "advisory" | "auto",
 *     "confidenceThreshold": number in [0, 1],
 *     "ladder": ["minimax" | "google-antigravity" | "openai" | "glm-5.2" | "anthropic", ...]
 *   }
 * All keys are optional; only the ones present in a layer override
 * lower-priority layers.
 *
 * Plugin options (in-memory) accept the same shape minus the JSON
 * wrapping. They are sourced from `opencode.json` `plugin: [["...",
 * { mode, confidenceThreshold, ladder }]]` in PR2.
 */

import { readFile } from "fs/promises";

import type {
  Ladder,
  LadderRung,
  SelectionMode,
  SelectionPolicy,
} from "./types.js";

/**
 * Built-in default ladder. Pinned by spec #1274 "Layered policy
 * resolution" — the 5 rungs in cheapest-to-most-restricted order.
 */
export const DEFAULT_LADDER: Ladder = [
  "minimax",
  "google-antigravity",
  "openai",
  "glm-5.2",
  "anthropic",
] as const;

/**
 * Built-in default policy. Pinned by spec #1274 — `mode: advisory`
 * preserves the MVP `{}` plugin entry; `confidenceThreshold: 0.6`
 * matches the MISSING_EVIDENCE_CONFIDENCE floor in src/evidence.ts.
 */
export const DEFAULT_POLICY: SelectionPolicy = {
  mode: "advisory",
  confidenceThreshold: 0.6,
};

/** Which layer supplied the active value for a given key. */
export type PolicySource = "built-in" | "user" | "plugin" | "project";

/** Result of a successful `loadPolicy` call. */
export interface ResolvedPolicy {
  mode: SelectionMode;
  confidenceThreshold: number;
  ladder: Ladder;
  /**
   * For each key, the layer whose value was applied. Used by PR2's
   * audit trail to surface "which config set this knob".
   */
  sources: {
    mode: PolicySource;
    confidenceThreshold: PolicySource;
    ladder: PolicySource;
  };
}

/** Optional in-memory policy inputs (sourced from opencode.json). */
export interface PluginPolicyOptions {
  mode?: SelectionMode;
  confidenceThreshold?: number;
  ladder?: readonly LadderRung[];
}

/** Public loader options. All fields optional. */
export interface LoadPolicyOptions {
  /** Project-level policy file (e.g. `.planning/.../policy.json`). */
  projectPolicyPath?: string;
  /** User-level policy file (e.g. `~/.gentle-ai/forecast-policy.json`). */
  userPolicyPath?: string;
  /** In-memory plugin options (from opencode.json plugin entry). */
  pluginOptions?: PluginPolicyOptions;
  /**
   * Optional callback for non-fatal issues (missing files, invalid
   * values, JSON parse errors). Default is silent — the spec mandates
   * non-throwing fallback. Callers that want diagnostics can supply a
   * sink.
   */
  warningSink?: (warning: string) => void;
}

/* -------------------------------------------------------------------------- *
 * Validators — pure, never throw.
 * -------------------------------------------------------------------------- */

const VALID_MODES: readonly SelectionMode[] = ["off", "advisory", "auto"];

const VALID_RUNGS: readonly LadderRung[] = [
  "minimax",
  "google-antigravity",
  "openai",
  "glm-5.2",
  "anthropic",
];

function isMode(v: unknown): v is SelectionMode {
  return typeof v === "string" && (VALID_MODES as readonly string[]).includes(v);
}

function isThreshold(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
  );
}

function isLadder(v: unknown): v is LadderRung[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  for (const r of v) {
    if (typeof r !== "string") return false;
    if (!(VALID_RUNGS as readonly string[]).includes(r)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- *
 * File reader — best-effort, never throws, always warns on failure.
 * -------------------------------------------------------------------------- */

interface RawPolicy {
  mode?: unknown;
  confidenceThreshold?: unknown;
  ladder?: unknown;
}

async function readPolicyFile(
  filePath: string,
  label: string,
  warn: (msg: string) => void,
): Promise<RawPolicy | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    warn(
      `${label} policy file not found at '${filePath}'; using built-in defaults.`,
    );
    return null;
  }
  if (raw.trim().length === 0) {
    warn(
      `${label} policy file at '${filePath}' is empty; using built-in defaults.`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(
      `${label} policy file at '${filePath}' is malformed JSON; using built-in defaults.`,
    );
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(
      `${label} policy file at '${filePath}' is not a JSON object; using built-in defaults.`,
    );
    return null;
  }
  return parsed as RawPolicy;
}

/* -------------------------------------------------------------------------- *
 * Per-key merge.
 *
 * Algorithm: apply the lowest-priority layer first, then walk up. The
 * highest-priority layer with a VALID value wins. Invalid values
 * fall through to the next layer AND emit a warning.
 * -------------------------------------------------------------------------- */

function applyMode(
  base: { value: SelectionMode; src: PolicySource },
  raw: RawPolicy | null,
  source: PolicySource,
  warn: (msg: string) => void,
): { value: SelectionMode; src: PolicySource } {
  if (raw === null || !("mode" in raw)) return base;
  if (isMode(raw.mode)) {
    return { value: raw.mode, src: source };
  }
  warn(`${source} policy has invalid 'mode' value; using lower-priority default.`);
  return base;
}

function applyThreshold(
  base: { value: number; src: PolicySource },
  raw: RawPolicy | null,
  source: PolicySource,
  warn: (msg: string) => void,
): { value: number; src: PolicySource } {
  if (raw === null || !("confidenceThreshold" in raw)) return base;
  if (isThreshold(raw.confidenceThreshold)) {
    return { value: raw.confidenceThreshold, src: source };
  }
  warn(
    `${source} policy has invalid 'confidenceThreshold' value; using lower-priority default.`,
  );
  return base;
}

function applyLadder(
  base: { value: Ladder; src: PolicySource },
  raw: RawPolicy | null,
  source: PolicySource,
  warn: (msg: string) => void,
): { value: Ladder; src: PolicySource } {
  if (raw === null || !("ladder" in raw)) return base;
  if (isLadder(raw.ladder)) {
    return { value: raw.ladder as Ladder, src: source };
  }
  warn(`${source} policy has invalid 'ladder' value; using lower-priority default.`);
  return base;
}

function applyLadderInMemory(
  base: { value: Ladder; src: PolicySource },
  ladder: readonly LadderRung[] | undefined,
  warn: (msg: string) => void,
): { value: Ladder; src: PolicySource } {
  if (ladder === undefined) return base;
  if (isLadder(ladder)) {
    return { value: [...ladder] as Ladder, src: "plugin" };
  }
  warn(`plugin options have invalid 'ladder' value; using lower-priority default.`);
  return base;
}

/* -------------------------------------------------------------------------- *
 * Public entry point.
 * -------------------------------------------------------------------------- */

export async function loadPolicy(
  options: LoadPolicyOptions = {},
): Promise<ResolvedPolicy> {
  const warn = (msg: string): void => {
    if (options.warningSink) options.warningSink(msg);
  };

  // Read on-disk layers (best-effort; warn on failure, never throw).
  const projectRaw =
    options.projectPolicyPath !== undefined
      ? await readPolicyFile(options.projectPolicyPath, "project", warn)
      : null;
  const userRaw =
    options.userPolicyPath !== undefined
      ? await readPolicyFile(options.userPolicyPath, "user", warn)
      : null;

  // Per-key merge. The merge order: project > plugin > user > built-in.
  // The algorithm applies the LOWEST-priority layer first and walks up
  // — so the final value comes from the highest-priority layer that
  // has a VALID value. Each key is applied independently.
  //
  // Apply order: user → plugin → project. Project is the final write
  // so it wins over plugin and user.
  let modeRes: { value: SelectionMode; src: PolicySource } = {
    value: DEFAULT_POLICY.mode,
    src: "built-in",
  };
  modeRes = applyMode(modeRes, userRaw, "user", warn);
  if (options.pluginOptions?.mode !== undefined) {
    if (isMode(options.pluginOptions.mode)) {
      modeRes = { value: options.pluginOptions.mode, src: "plugin" };
    } else {
      warn(
        `plugin options have invalid 'mode' value; using lower-priority default.`,
      );
    }
  }
  modeRes = applyMode(modeRes, projectRaw, "project", warn);

  let thresholdRes: { value: number; src: PolicySource } = {
    value: DEFAULT_POLICY.confidenceThreshold,
    src: "built-in",
  };
  thresholdRes = applyThreshold(thresholdRes, userRaw, "user", warn);
  if (options.pluginOptions?.confidenceThreshold !== undefined) {
    if (isThreshold(options.pluginOptions.confidenceThreshold)) {
      thresholdRes = {
        value: options.pluginOptions.confidenceThreshold,
        src: "plugin",
      };
    } else {
      warn(
        `plugin options have invalid 'confidenceThreshold' value; using lower-priority default.`,
      );
    }
  }
  thresholdRes = applyThreshold(thresholdRes, projectRaw, "project", warn);

  let ladderRes: { value: Ladder; src: PolicySource } = {
    value: DEFAULT_LADDER,
    src: "built-in",
  };
  ladderRes = applyLadder(ladderRes, userRaw, "user", warn);
  ladderRes = applyLadderInMemory(ladderRes, options.pluginOptions?.ladder, warn);
  ladderRes = applyLadder(ladderRes, projectRaw, "project", warn);

  return {
    mode: modeRes.value,
    confidenceThreshold: thresholdRes.value,
    ladder: ladderRes.value,
    sources: {
      mode: modeRes.src,
      confidenceThreshold: thresholdRes.src,
      ladder: ladderRes.src,
    },
  };
}
