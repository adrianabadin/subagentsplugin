#!/usr/bin/env node
/**
 * PR4 — Forecast CLI.
 *
 * Usage:
 *   forecast --phase <p> [--preset <name>] [--cache <path>]
 *            [--verbose]
 *            [--select]
 *            [--diff-lines <n>]
 *            [--file <path>]... [--symbol <name>]...
 *            [--risk-domain <domain>]
 *            [--context-breadth <narrow|moderate|wide>]
 *            [--modality <type>]...
 *   forecast refresh
 *   forecast doctor [--mode <name>]
 *   forecast update-data --from-file <path> [--root <dir>]
 *   forecast config [--root <dir>] [--non-interactive]
 *
 * Subcommands:
 *   (none)        Run a forecast for the given phase (default).
 *   refresh       Manually refresh the model-data cache from sources.
 *   doctor        Run environment diagnostics.
 *   update-data   Write repo-local benchmark overrides from a JSON file
 *                 to <root>/forecast-data/benchmarks.json.
 *   config        Open an interactive menu for editing global model
 *                 availability, benchmarks, and pricing.
 *
 * Behaviour:
 *   - On success: prints a JSON-encoded Forecast (4 fields) by default,
 *     a VerboseForecast (7 fields) when --verbose is set, OR a
 *     SelectDecision (7 fields) when --select is set; exits 0.
 *   - On invalid args: prints an error to stderr and exits 1.
 *   - `refresh` writes the merged cache to disk and exits 0 on success.
 *
 * The CLI is split into two testable pure-ish entry points:
 *   - `parseCliArgs(args: string[])` — pure, returns a typed result.
 *   - `runCli(args: string[])` — invokes `forecast()` and (when
 *     --select is set) `select()`, captures `process.stdout.write` /
 *     `process.stderr.write` to a buffer, and returns
 *     `{ exitCode, stdout, stderr }`. Side-effect-free for tests.
 *
 * PR2 — evidence-based-forecasting additions:
 *   - `--verbose` opts into the additive `VerboseForecast` shape.
 *   - The 6 context flags wire into `ForecastInput.context` (TaskContextInput).
 *   - When `verbose === false` AND no context was provided, the CLI
 *     projects the result down to the canonical 4-field Forecast shape so
 *     existing callers/skill consumers see no JSON-contract change.
 *
 * PR1 (forecast-orchestration-layer):
 *   - `--select` opts into the structured advisory SelectDecision shape
 *     (`{action, subagent_type, model, effort, reason, confidence,
 *     evidence}`). The CLI builds a single candidate from the existing
 *     forecast path, then runs `select()` to emit the decision JSON.
 *   - The two output shapes are mutually exclusive: a CLI invocation
 *     emits ONE of them, never both. With both `--select` and
 *     `--verbose`, --select wins (decision JSON).
 *
 * When run directly as a script (the default export below), `runCli` is
 * called with `process.argv.slice(2)` and the exit code is propagated.
 */

import process from "process";
import { existsSync, readFileSync } from "node:fs";
import path from "path";
import { forecast } from "./forecast.js";
import { refreshCache } from "./plugin.js";
import { select } from "./select.js";
import { loadPolicy, DEFAULT_LADDER } from "./policy.js";
import { readCache, defaultCachePath } from "./cache.js";
import {
  gentleAiVariantsCachePath,
  openCodeModelsCachePath,
  readGentleAiVariantsCache,
  readOpenCodeModelsCache,
} from "./models.js";
import { PHASE_DIFFICULTY } from "./phases.js";
import { loadEffectiveBenchmarks } from "./repo-data.js";
import type { TaskContextInput } from "./context.js";
import type {
  Effort,
  Forecast,
  ForecastInput,
  LadderRung,
  SelectCandidate,
  SelectionMode,
  TaskContext,
  VerboseForecast,
} from "./types.js";

export interface CliParseSuccess {
  ok: true;
  input: ForecastInput;
  /**
   * PR1 (forecast-orchestration-layer): true when `--select` was
   * passed. The CLI routes to the SelectDecision path; otherwise the
   * canonical Forecast path runs.
   */
  select: boolean;
}

export interface CliParseFailure {
  ok: false;
  error: string;
}

export type CliParseResult = CliParseSuccess | CliParseFailure;

/**
 * Valid values for `--context-breadth`. Pinned here so the CLI can
 * reject malformed input without forwarding unknown strings to the
 * engine (which would otherwise silently default to "moderate").
 */
const CONTEXT_BREADTH_VALUES = ["narrow", "moderate", "wide"] as const;
type ContextBreadthValue = (typeof CONTEXT_BREADTH_VALUES)[number];

/**
 * Internal accumulator for `parseCliArgs`. Mirrors `ForecastInput` plus
 * the per-flag sources of truth, so we can build `context` at the end.
 */
interface CliParseAccumulator {
  phase?: string;
  preset?: string;
  cachePath?: string;
  verbose: boolean;
  select: boolean;
  diffLines?: number;
  files: string[];
  symbols: string[];
  riskDomain?: string;
  contextBreadth?: ContextBreadthValue;
  modality: string[];
}

/**
 * Parses CLI argument vector into a `ForecastInput` (or an error).
 *
 * Flags:
 *   --phase <p>                  (required)
 *   --preset <name>              (optional)
 *   --cache <path>               (optional)
 *   --verbose                    (optional, no value)
 *   --select                     (PR1: optional, no value)
 *   --diff-lines <n>             (optional, integer)
 *   --file <path>                (optional, repeatable)
 *   --symbol <name>              (optional, repeatable)
 *   --risk-domain <domain>       (optional)
 *   --context-breadth <b>        (optional: narrow|moderate|wide)
 *   --modality <type>            (optional, repeatable)
 *   --help, -h                   (shows usage message)
 *
 * Pure. Does not touch process I/O. Always resolves either with a typed
 * input or with an error message.
 */
export function parseCliArgs(args: string[]): CliParseResult {
  const out: CliParseAccumulator = {
    verbose: false,
    select: false,
    files: [],
    symbols: [],
    modality: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phase") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--phase requires a value (e.g. --phase sdd-design).",
        };
      }
      out.phase = value;
      i++;
    } else if (arg === "--preset") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--preset requires a value (balanced|performance|economy|diversity).",
        };
      }
      out.preset = value;
      i++;
    } else if (arg === "--cache") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--cache requires a path (e.g. --cache /tmp/model-data.json).",
        };
      }
      out.cachePath = value;
      i++;
    } else if (arg === "--verbose") {
      out.verbose = true;
    } else if (arg === "--select") {
      // PR1 (forecast-orchestration-layer): route to the
      // SelectDecision emission path. The forecast path runs internally
      // to seed a single candidate, but the JSON contract on stdout is
      // the 7-field SelectDecision shape.
      out.select = true;
    } else if (arg === "--diff-lines") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--diff-lines requires a non-negative integer (e.g. --diff-lines 150).",
        };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
        return {
          ok: false,
          error: `--diff-lines requires a non-negative integer (got '${value}').`,
        };
      }
      out.diffLines = parsed;
      i++;
    } else if (arg === "--file") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--file requires a path (e.g. --file src/forecast.ts).",
        };
      }
      out.files.push(value);
      i++;
    } else if (arg === "--symbol") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--symbol requires a name (e.g. --symbol forecast).",
        };
      }
      out.symbols.push(value);
      i++;
    } else if (arg === "--risk-domain") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--risk-domain requires a value (e.g. --risk-domain architecture).",
        };
      }
      out.riskDomain = value;
      i++;
    } else if (arg === "--context-breadth") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: `--context-breadth requires one of: ${CONTEXT_BREADTH_VALUES.join("|")}.`,
        };
      }
      if (
        !(CONTEXT_BREADTH_VALUES as readonly string[]).includes(value)
      ) {
        return {
          ok: false,
          error: `--context-breadth must be one of: ${CONTEXT_BREADTH_VALUES.join("|")} (got '${value}').`,
        };
      }
      out.contextBreadth = value as ContextBreadthValue;
      i++;
    } else if (arg === "--modality") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--modality requires a value (e.g. --modality code).",
        };
      }
      out.modality.push(value);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        error: buildUsageMessage(),
      };
    } else {
      return {
        ok: false,
        error: `Unknown argument: '${arg}'. Try --help for usage.`,
      };
    }
  }

  if (out.phase === undefined || out.phase.length === 0) {
    return {
      ok: false,
      error: "--phase is required (e.g. --phase sdd-design).",
    };
  }

  // Build the TaskContextInput. Only attach the object when at least one
  // field was supplied — keeps the ForecastInput shape clean and lets
  // the engine treat an absent context as "use defaults".
  const context = buildContext(out);

  const input: ForecastInput = {
    phase: out.phase,
  };
  if (out.preset !== undefined) input.preset = out.preset;
  if (out.cachePath !== undefined) input.cachePath = out.cachePath;
  if (out.verbose) input.verbose = true;
  if (context !== null) input.context = context;

  return { ok: true, input, select: out.select };
}

/**
 * Renders the canonical help/usage message. Single source of truth so
 * `--help`, the unknown-flag fallback, and any future docs share text.
 */
function buildUsageMessage(): string {
  return [
    "Usage:",
    "  forecast --phase <phase> [--preset <name>] [--cache <path>]",
    "           [--verbose] [--select]",
    "           [--diff-lines <n>] [--file <path>]... [--symbol <name>]...",
    "           [--risk-domain <domain>] [--context-breadth <narrow|moderate|wide>]",
    "           [--modality <type>]...",
    "",
    "  doctor [--mode <auto|advisory|off>]",
    "          Print a JSON snapshot of plugin state (mode, ladder, caches, recommendations).",
    "          By default, mode is auto-detected from the opencode.json plugin entry.",
    "",
    "  quarantine <add|list|release> <target>",
    "                     [--permanent | --ttl-hours N] [--reason \"...\"]",
    "                     [--file <path>] [--root <path>]",
    "          Manually quarantine a model or provider group. Applies on next plugin load.",
  ].join("\n");
}

/**
 * Renders doctor-specific help. Returned by `runDoctor(["--help"])` so
 * `node dist/cli.js doctor --help` is a one-liner diagnostic.
 */
function buildDoctorUsageMessage(): string {
  return [
    "Usage: doctor [--mode <auto|advisory|off>]",
    "",
    "Print a JSON snapshot of plugin state. By default, mode is auto-detected",
    "from your opencode.json plugin entry. Use --mode to override.",
    "",
    "Flags:",
    "  --mode <auto|advisory|off>   Override the resolved mode. Bypasses auto-detect.",
    "  --help, -h                    Show this help message.",
  ].join("\n");
}

/**
 * Builds a `TaskContextInput` from the parsed accumulator. Returns
 * `null` when no context flag was supplied, so callers can omit
 * `input.context` entirely (and the engine treats that as defaults).
 */
function buildContext(acc: CliParseAccumulator): TaskContextInput | null {
  const hasAny =
    acc.diffLines !== undefined ||
    acc.files.length > 0 ||
    acc.symbols.length > 0 ||
    acc.riskDomain !== undefined ||
    acc.contextBreadth !== undefined ||
    acc.modality.length > 0;
  if (!hasAny) return null;
  const ctx: TaskContextInput = {};
  if (acc.diffLines !== undefined) ctx.diffLines = acc.diffLines;
  if (acc.files.length > 0) ctx.files = [...acc.files];
  if (acc.symbols.length > 0) ctx.symbols = [...acc.symbols];
  if (acc.riskDomain !== undefined) ctx.riskDomain = acc.riskDomain;
  if (acc.contextBreadth !== undefined) ctx.contextBreadth = acc.contextBreadth;
  if (acc.modality.length > 0) ctx.modality = [...acc.modality];
  return ctx;
}

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Projects a `Forecast | VerboseForecast` down to the canonical
 * 4-field `Forecast` shape. Used by the CLI when `--verbose` is absent
 * to preserve the documented default JSON contract.
 */
function toForecast(result: Forecast | VerboseForecast): Forecast {
  return {
    model: result.model,
    effort: result.effort as Effort,
    reasoning: result.reasoning,
    fallback: result.fallback,
  };
}

function ladderRungForModel(model: string): LadderRung {
  const normalized = model.toLowerCase();
  if (normalized.includes("minimax")) return "minimax";
  if (normalized.includes("google") || normalized.includes("gemini")) {
    return "google-antigravity";
  }
  if (normalized.includes("openai") || normalized.includes("gpt")) {
    return "openai";
  }
  if (normalized.includes("glm-5.2") || normalized.includes("glm")) {
    return "glm-5.2";
  }
  return "anthropic";
}

function taskContextFromInput(input: ForecastInput): TaskContext {
  return {
    phase: input.phase,
    diffLines: input.context?.diffLines,
    files: input.context?.files,
    symbols: input.context?.symbols,
    riskDomain: input.context?.riskDomain,
    contextBreadth: input.context?.contextBreadth,
    modality: input.context?.modality,
  };
}

function candidateFromForecast(
  input: ForecastInput,
  result: Forecast | VerboseForecast,
): SelectCandidate {
  return {
    subagent_type: input.phase,
    model: result.model,
    effort: result.effort as Effort,
    confidence: result.fallback ? 0.6 : 0.8,
    evidence: result.reasoning,
    ladderRung: ladderRungForModel(result.model),
  };
}

/**
 * Programmatic CLI runner used by both the default script invocation and
 * by tests. Captures stdout/stderr to in-memory buffers, returns the exit
 * code that should be propagated to `process.exit`.
 *
 * Override `io` to inject fake buffers in tests; defaults to the real
 * `process` streams.
 *
 * PR2 — output projection: when `parsed.input.verbose === true`, the
 * runner emits the full `VerboseForecast` JSON (7 fields); otherwise it
 * projects down to the canonical 4-field `Forecast` shape.
 */
export async function runCli(
  args: string[],
  io?: {
    stdout?: { write: (data: string) => void };
    stderr?: { write: (data: string) => void };
  },
): Promise<RunCliResult> {
  const stdoutCapture: string[] = [];
  const stderrCapture: string[] = [];
  const stdout = io?.stdout ?? {
    write: (data: string): void => {
      stdoutCapture.push(data);
      process.stdout.write(data);
    },
  };
  const stderr = io?.stderr ?? {
    write: (data: string): void => {
      stderrCapture.push(data);
      process.stderr.write(data);
    },
  };

  const parsed = parseCliArgs(args);
  if (!parsed.ok) {
    stderr.write(`error: ${parsed.error}\n`);
    return {
      exitCode: 1,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  }

  try {
    await loadEffectiveBenchmarks({ rootDir: process.cwd() });
    const result = await forecast(parsed.input);
    if (parsed.select) {
      const policy = await loadPolicy();
      const decision = select({
        context: taskContextFromInput(parsed.input),
        policy,
        ladder: policy.ladder,
        candidates: [candidateFromForecast(parsed.input, result)],
      });
      stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
      return {
        exitCode: 0,
        stdout: stdoutCapture.join(""),
        stderr: stderrCapture.join(""),
      };
    }
    // PR2 — projection. Without --verbose the JSON contract stays at 4
    // fields (backward compat). With --verbose, the 7-field shape is
    // emitted verbatim.
    const output =
      parsed.input.verbose === true ? result : toForecast(result);
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return {
      exitCode: 0,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`error: forecast failed — ${message}\n`);
    return {
      exitCode: 1,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  }
}

/* -------------------------------------------------------------------------- *
 * `doctor` subcommand.
 *
 * Prints a static JSON snapshot of plugin state to stdout. Does NOT depend
 * on OpenCode loading the plugin — it reads the on-disk caches directly
 * using the same readers the runtime uses, and reports the resolved mode,
 * ladder, and phase rubric. Exits 0 on success, 1 on internal error
 * (e.g. fs permission denied) or invalid `--mode` argument.
 *
 * Output shape (always JSON on stdout):
 *   {
 *     ok: boolean,
 *     mode: "off" | "advisory" | "auto",
 *     modeSource: "config" | "default" | "override",
 *     modeConfigPath?: string,        // only when modeSource === "config"
 *     modePluginPath?: string,        // only when modeSource === "config"
 *     overrideValue?: string,         // only when modeSource === "override"
 *     ladder: string[],
 *     phases: string[],
 *     wouldRegisterHooks: string[],
 *     caches: {
 *       modelData: { path, exists, version?, generatedAt?, providerCount?, modelCount? },
 *       gentleAiVariants: { path, exists, providerCount?, modelCount? },
 *       openCodeModels: { path, exists, providerCount? }
 *     },
 *     recommendations: string[]
 *   }
 * -------------------------------------------------------------------------- */

/** One-hour TTL used to classify the model-data cache as fresh vs. stale. */
const DOCTOR_FRESH_TTL_MS = 60 * 60 * 1000;

/** Valid literal values accepted by the `--mode` flag. */
const VALID_DOCTOR_MODES: readonly SelectionMode[] = ["auto", "advisory", "off"];

/** Where the effective mode came from — propagated to the JSON snapshot. */
type ModeSource = "config" | "default" | "override";

/**
 * Internal result of `detectModeFromConfig()`. Distinct from the public
 * `ModeSource` because the helper can only return `config` (matched) or
 * `default` (no match) — `override` is decided at the resolution layer.
 */
interface DetectedMode {
  mode: SelectionMode;
  source: "config" | "default";
  recoveryEnabled: boolean;
  configPath?: string;
  pluginPath?: string;
}

/** Resolution result fed into the JSON snapshot. */
interface ResolvedMode {
  mode: SelectionMode;
  recoveryEnabled: boolean;
  modeSource: ModeSource;
  modeConfigPath?: string;
  modePluginPath?: string;
  overrideValue?: string;
}

/**
 * Discriminated result of parsing `--mode` out of the doctor argv. Either
 * a valid override, an explicit parse error (→ exit 1), or absent.
 */
type ModeOverride =
  | { kind: "ok"; mode: SelectionMode; value: string }
  | { kind: "error"; message: string };

/* -------------------------------------------------------------------------- *
 * `detectModeFromConfig` — private helper.
 *
 * Walks the candidate list of `opencode.json` paths (in order: the
 * `OPENCODE_CONFIG` env override, then platform-specific user/global
 * locations) and looks for the first one that:
 *   1. Exists on disk.
 *   2. Parses as JSON.
 *   3. Has a `plugin` array with an entry whose path matches
 *      `opencode-model-forecast` (substring), `/subagentsplugin/dist/`
 *      (dev build path), or `@aabadin/opencode-model-forecast` (npm).
 *   4. The matched entry's `options.mode` is one of `auto|advisory|off`.
 *
 * Returns `{ mode, source: "config", configPath, pluginPath }` on a hit;
 * otherwise `{ mode: "advisory", source: "default" }`. Read/parse failures
 * fall through to the next candidate; a parseable file with no plugin
 * match short-circuits to default (the user has an opencode.json but it
 * does not configure this plugin — silently probing the next candidate
 * would hide a deliberate configuration).
 * -------------------------------------------------------------------------- */
function detectModeFromConfig(): DetectedMode {
  const candidates: string[] = [];

  // 1. Explicit env override (highest priority).
  const envConfig = process.env.OPENCODE_CONFIG;
  if (envConfig !== undefined && envConfig.length > 0) {
    candidates.push(envConfig);
  }

  // 2-3. Platform-specific user/global config locations.
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE;
    if (userProfile !== undefined && userProfile.length > 0) {
      candidates.push(
        path.join(userProfile, ".config", "opencode", "opencode.json"),
      );
    }
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.length > 0) {
      candidates.push(path.join(appData, "opencode", "opencode.json"));
    }
  } else {
    const home = process.env.HOME;
    if (home !== undefined && home.length > 0) {
      candidates.push(
        path.join(home, ".config", "opencode", "opencode.json"),
      );
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg.length > 0) {
      candidates.push(path.join(xdg, "opencode", "opencode.json"));
    }
  }

  const matchesPlugin = (entryPath: string): boolean =>
    entryPath.includes("opencode-model-forecast") ||
    entryPath.includes("/subagentsplugin/dist/") ||
    entryPath.includes("@aabadin/opencode-model-forecast");

  for (const candidate of candidates) {
    let raw: string;
    try {
      if (!existsSync(candidate)) continue;
      raw = readFileSync(candidate, "utf-8");
    } catch {
      // Permission denied / IO error — fall through to next candidate.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON — fall through to next candidate.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const pluginRaw = (parsed as { plugin?: unknown }).plugin;
    if (!Array.isArray(pluginRaw)) continue;

    for (const entry of pluginRaw) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const entryPath = entry[0];
      if (typeof entryPath !== "string") continue;
      if (!matchesPlugin(entryPath)) continue;

      // Plugin matched — check options.mode.
      const options = entry[1];
      if (
        options !== null &&
        typeof options === "object" &&
        "mode" in options
      ) {
        const modeValue = (options as { mode: unknown }).mode;
        if (
          modeValue === "auto" ||
          modeValue === "advisory" ||
          modeValue === "off"
        ) {
          const recovery = (options as { recovery?: unknown }).recovery;
          const recoveryEnabled = recovery === null || typeof recovery !== "object"
            ? true
            : (recovery as { enabled?: unknown }).enabled !== false;
          return {
            mode: modeValue,
            source: "config",
            recoveryEnabled,
            configPath: candidate,
            pluginPath: entryPath,
          };
        }
      }
      // Plugin entry matched but the mode is missing/invalid — short-circuit
      // to default. The user has the plugin wired up but the options bag
      // is malformed; probing further candidates would be misleading.
      return { mode: "advisory", source: "default", recoveryEnabled: true };
    }

    // File parsed cleanly but no model-forecast plugin entry was found.
    // Short-circuit to default — same rationale as above.
    return { mode: "advisory", source: "default", recoveryEnabled: true };
  }

  return { mode: "advisory", source: "default", recoveryEnabled: true };
}

export interface RunDoctorOptions {
  /** Override the model-data cache path. Defaults to `defaultCachePath()`. */
  cachePath?: string;
  /** Override the gentle-ai variants cache path. */
  gentleAiPath?: string;
  /** Override the OpenCode models cache path. */
  openCodePath?: string;
  /** Override the resolved mode reported in the snapshot. Defaults to "advisory". */
  mode?: SelectionMode;
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Recovery kill-switch value, supplied by config detection or tests. */
  recoveryEnabled?: boolean;
  /** Runtime client capabilities when doctor is called from an embedded host. */
  recoveryClient?: Partial<Record<"create" | "prompt" | "abort" | "promptAsync" | "children", boolean>>;
}

interface CacheSummary {
  path: string;
  exists: boolean;
  version?: number;
  generatedAt?: string;
  providerCount?: number;
  modelCount?: number;
}

function summarizeGentleAi(
  path: string,
  data: Record<string, Record<string, string[]>>,
): CacheSummary {
  const providerIds = Object.keys(data);
  const modelCount = providerIds.reduce(
    (sum, pid) => sum + Object.keys(data[pid] ?? {}).length,
    0,
  );
  return {
    path,
    exists: providerIds.length > 0,
    providerCount: providerIds.length,
    modelCount,
  };
}

function summarizeOpenCodeModels(
  path: string,
  data: Record<string, unknown>,
): CacheSummary {
  const providerIds = Object.keys(data);
  return {
    path,
    exists: providerIds.length > 0,
    providerCount: providerIds.length,
  };
}

function wouldRegisterHooksForMode(mode: SelectionMode): string[] {
  if (mode === "auto") {
    return ["config", "tool.execute.before", "tool.execute.after"];
  }
  return [];
}

function buildRecommendations(
  mode: SelectionMode,
  modeSource: ModeSource,
  modelData: CacheSummary,
  modelDataFresh: boolean | null,
  gentleAi: CacheSummary,
  openCode: CacheSummary,
): string[] {
  const out: string[] = [];

  // Mode line(s) — append the source annotation (override / default) so
  // the user can see WHY their doctor report says what it says.
  const modeLines: string[] = [];
  if (mode === "auto") {
    modeLines.push(
      "auto mode active — hooks registered: config, tool.execute.before, tool.execute.after",
    );
    modeLines.push(
      "task tool calls will be rewritten to use the generated profile catalog",
    );
  } else if (mode === "off") {
    modeLines.push("off mode — plugin entry returns {}");
  } else {
    modeLines.push(
      "advisory mode — no hooks registered (set mode=auto in opencode.json to enable)",
    );
  }
  const annotation =
    modeSource === "override"
      ? " (override via --mode)"
      : modeSource === "default"
        ? " (default — opencode.json plugin entry not detected)"
        : "";
  for (const line of modeLines) {
    out.push(`${line}${annotation}`);
  }

  if (!modelData.exists) {
    out.push("model data cache file missing — run a session to populate");
  } else if (modelDataFresh === true) {
    out.push("model data cache exists and is fresh (< 1h old)");
  } else if (modelDataFresh === false) {
    out.push("model data cache exists but is stale (> 1h old) — refresh on next session start");
  }
  if (!gentleAi.exists) {
    out.push(
      `gentle-ai variants cache not found at ${gentleAi.path} — falling back to OpenCode models cache`,
    );
  }
  if (!openCode.exists) {
    out.push(
      `OpenCode models cache not found at ${openCode.path} — provider metadata will be limited`,
    );
  }
  return out;
}

function recoveryCapabilities(
  enabled: boolean,
  client: RunDoctorOptions["recoveryClient"],
): Record<string, boolean> {
  return {
    eventHook: enabled,
    create: client?.create === true,
    prompt: client?.prompt === true,
    abort: client?.abort === true,
    promptAsync: client?.promptAsync === true,
    children: client?.children === true,
    watchdog: enabled,
    parentRecovery: enabled,
  };
}

/**
 * Parses `--mode <value>` (and `--mode=<value>`) out of the argv slice.
 * Returns:
 *   - `{ kind: "ok", mode, value }` when a valid value is found
 *   - `{ kind: "error", message }` when the flag is present but malformed
 *   - `null` when the flag is absent
 *
 * Pure — does not touch process I/O. Caller decides exit semantics.
 */
function parseModeOverride(args: string[]): ModeOverride | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === undefined) {
        return {
          kind: "error",
          message: "--mode requires a value (auto|advisory|off).",
        };
      }
      if (
        value === "auto" ||
        value === "advisory" ||
        value === "off"
      ) {
        return { kind: "ok", mode: value, value };
      }
      return {
        kind: "error",
        message: `--mode must be one of: auto|advisory|off (got '${value}').`,
      };
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (
        value === "auto" ||
        value === "advisory" ||
        value === "off"
      ) {
        return { kind: "ok", mode: value, value };
      }
      return {
        kind: "error",
        message: `--mode must be one of: auto|advisory|off (got '${value}').`,
      };
    }
  }
  return null;
}

/**
 * Resolves the effective mode from the caller's argv + options, in the
 * order specified by the spec:
 *   1. `--mode <value>` flag → source "override"
 *   2. `options.mode` programmatic override → source "override"
 *   3. Auto-detect from `opencode.json` → source "config"
 *   4. Default "advisory" → source "default"
 *
 * Returns `{ kind: "resolved", ... }` on success or
 * `{ kind: "error", message }` when the flag was malformed (caller
 * surfaces the error and exits 1).
 */
function resolveMode(
  args: string[],
  options: RunDoctorOptions,
): { kind: "resolved"; resolved: ResolvedMode } | { kind: "error"; message: string } {
  // 1. --mode flag wins.
  const flag = parseModeOverride(args);
  if (flag !== null) {
    if (flag.kind === "error") {
      return { kind: "error", message: flag.message };
    }
    return {
      kind: "resolved",
      resolved: {
        mode: flag.mode,
        recoveryEnabled: options.recoveryEnabled ?? true,
        modeSource: "override",
        overrideValue: flag.value,
      },
    };
  }

  // 2. Programmatic options.mode (test-friendly override).
  if (options.mode !== undefined) {
    return {
      kind: "resolved",
      resolved: {
        mode: options.mode,
        recoveryEnabled: options.recoveryEnabled ?? true,
        modeSource: "override",
        overrideValue: `(programmatic: ${options.mode})`,
      },
    };
  }

  // 3. Auto-detect from opencode.json.
  const detected = detectModeFromConfig();
  if (detected.source === "config") {
    return {
      kind: "resolved",
      resolved: {
        mode: detected.mode,
        recoveryEnabled: options.recoveryEnabled ?? detected.recoveryEnabled,
        modeSource: "config",
        modeConfigPath: detected.configPath,
        modePluginPath: detected.pluginPath,
      },
    };
  }

  // 4. Default.
  return {
    kind: "resolved",
    resolved: { mode: "advisory", recoveryEnabled: options.recoveryEnabled ?? true, modeSource: "default" },
  };
}

/**
 * Programmatic doctor runner used by both the script invocation and tests.
 * Returns the same `RunCliResult` shape as `runCli` so tests can capture
 * stdout/stderr uniformly.
 *
 * Accepts the raw argv slice (everything after `doctor` in
 * `node dist/cli.js doctor ...`) as its first parameter so the runner
 * can honour `--mode` / `--help` flags. Options (cache paths, programmatic
 * mode override, injectable clock) are the second parameter. `io` is the
 * third — the same `stdout`/`stderr` write-injection shape `runCli` uses.
 *
 * Resolution order for the effective mode:
 *   1. `--mode <value>` flag in `args`        → source "override"
 *   2. `options.mode` (programmatic)           → source "override"
 *   3. `opencode.json` plugin entry (auto)     → source "config"
 *   4. Default "advisory"                      → source "default"
 *
 * Catches internal errors (e.g. fs permission denied) and returns exit
 * code 1 with the error message on stderr — the script entry point
 * propagates this to the OS.
 */
export async function runDoctor(
  args: string[],
  options: RunDoctorOptions = {},
  io?: {
    stdout?: { write: (data: string) => void };
    stderr?: { write: (data: string) => void };
  },
): Promise<RunCliResult> {
  const stdoutCapture: string[] = [];
  const stderrCapture: string[] = [];
  const stdout = io?.stdout ?? {
    write: (data: string): void => {
      stdoutCapture.push(data);
      process.stdout.write(data);
    },
  };
  const stderr = io?.stderr ?? {
    write: (data: string): void => {
      stderrCapture.push(data);
      process.stderr.write(data);
    },
  };

  // --help / -h — short-circuit before any I/O so the user always gets
  // the usage message even if the opencode.json scan would be slow.
  if (args.includes("--help") || args.includes("-h")) {
    stderr.write(`${buildDoctorUsageMessage()}\n`);
    return {
      exitCode: 1,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  }

  const resolved = resolveMode(args, options);
  if (resolved.kind === "error") {
    stderr.write(`error: ${resolved.message}\n`);
    return {
      exitCode: 1,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  }
  const mode: SelectionMode = resolved.resolved.mode;
  const modeSource: ModeSource = resolved.resolved.modeSource;

  try {
    const modelDataPath = options.cachePath ?? defaultCachePath();
    const gentleAiPath = options.gentleAiPath ?? gentleAiVariantsCachePath();
    const openCodePath = options.openCodePath ?? openCodeModelsCachePath();
    const now = options.now ?? ((): Date => new Date());

    const [modelDataRaw, gentleAiRaw, openCodeRaw] = await Promise.all([
      readCache(modelDataPath),
      readGentleAiVariantsCache(gentleAiPath),
      readOpenCodeModelsCache(openCodePath),
    ]);

    let modelData: CacheSummary;
    let modelDataFresh: boolean | null;
    if (modelDataRaw === null) {
      modelData = { path: modelDataPath, exists: false };
      modelDataFresh = null;
    } else {
      const providerIds = Object.keys(modelDataRaw.providers ?? {});
      const modelCount = providerIds.reduce(
        (sum, pid) => sum + Object.keys(modelDataRaw.providers[pid] ?? {}).length,
        0,
      );
      const generatedMs = new Date(modelDataRaw.generatedAt).getTime();
      modelDataFresh =
        Number.isFinite(generatedMs) && now().getTime() - generatedMs < DOCTOR_FRESH_TTL_MS;
      modelData = {
        path: modelDataPath,
        exists: true,
        version: modelDataRaw.version,
        generatedAt: modelDataRaw.generatedAt,
        providerCount: providerIds.length,
        modelCount,
      };
    }

    const gentleAi = summarizeGentleAi(gentleAiPath, gentleAiRaw);
    const openCode = summarizeOpenCodeModels(openCodePath, openCodeRaw);

    const recommendations = buildRecommendations(
      mode,
      modeSource,
      modelData,
      modelDataFresh,
      gentleAi,
      openCode,
    );

    // Build the JSON snapshot. The `modeSource` / `modeConfigPath` /
    // `modePluginPath` / `overrideValue` fields are additive — they
    // surface the resolution provenance for downstream tooling without
    // breaking existing readers that only look at `mode`.
    const snapshot: Record<string, unknown> = {
      ok: true,
      mode,
      modeSource,
      ladder: [...DEFAULT_LADDER],
      phases: Object.keys(PHASE_DIFFICULTY),
      wouldRegisterHooks: wouldRegisterHooksForMode(mode),
      caches: {
        modelData,
        gentleAiVariants: gentleAi,
        openCodeModels: openCode,
      },
      recommendations,
      recovery: {
        enabled: resolved.resolved.recoveryEnabled,
        capabilities: recoveryCapabilities(resolved.resolved.recoveryEnabled, options.recoveryClient),
      },
    };
    if (resolved.resolved.modeConfigPath !== undefined) {
      snapshot.modeConfigPath = resolved.resolved.modeConfigPath;
    }
    if (resolved.resolved.modePluginPath !== undefined) {
      snapshot.modePluginPath = resolved.resolved.modePluginPath;
    }
    if (resolved.resolved.overrideValue !== undefined) {
      snapshot.overrideValue = resolved.resolved.overrideValue;
    }

    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return {
      exitCode: 0,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`error: doctor failed — ${message}\n`);
    return {
      exitCode: 1,
      stdout: stdoutCapture.join(""),
      stderr: stderrCapture.join(""),
    };
  }
}

/**
 * Default export: the CLI entry point invoked when this file is run as a
 * script. Calls `runCli(process.argv.slice(2))` and propagates the exit
 * code to the parent process.
 *
 * Accepts both invocations:
 *   - `node dist/cli.js forecast --phase sdd-design` (explicit subcommand)
 *   - `node dist/cli.js --phase sdd-design`           (script name only)
 *   - `node dist/cli.js doctor`                       (doctor subcommand)
 *   - `node dist/cli.js refresh`                      (manual cache refresh)
 *   - `node dist/cli.js config --root <dir>`         (interactive config menu)
 *
 * The `forecast` prefix is optional and only stripped when present.
 * `doctor`, `refresh`, `update-data`, and `config` are static subcommands — they do not parse
 * forecast flags.
 */
export default async function main(args?: string[]): Promise<void> {
  const argv = args ?? process.argv.slice(2);
  if (argv.length > 0 && argv[0] === "doctor") {
    // Forward the rest of the argv slice so `runDoctor` can honour
    // `--mode`, `--help`, and any future doctor-only flags. The
    // `doctor` subcommand never overlaps with the `forecast` flags.
    const result = await runDoctor(argv.slice(1));
    process.exit(result.exitCode);
    return;
  }
  if (argv.length > 0 && argv[0] === "refresh") {
    // Manual cache refresh — reads connected providers (when the client
    // is available in OpenCode) and writes the merged cache to disk.
    // Outside OpenCode (CLI-only) the client is absent so it falls back
    // to the on-disk file caches (gentle-ai variants + OpenCode models).
    // The exit code is 0 on success, 1 on total failure.
    try {
      await refreshCache();
      process.stderr.write("model-forecast: cache refreshed\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `model-forecast: cache refresh failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }
  if (argv.length > 0 && argv[0] === "update-data") {
    const { parseUpdateDataArgs, runUpdateData } = await import("./cli-update-data.js");
    const parsed = parseUpdateDataArgs(argv.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`model-forecast: ${parsed.error}\n`);
      process.exit(1);
      return;
    }
    const result = await runUpdateData(parsed);
    if (!result.ok) {
      process.stderr.write(`model-forecast: ${result.error}\n`);
      process.exit(1);
      return;
    }
    process.stderr.write(
      `model-forecast: wrote ${result.entriesWritten} entr${result.entriesWritten === 1 ? "y" : "ies"} to ${result.outputPath}\n`,
    );
    process.exit(0);
    return;
  }
  if (argv.length > 0 && argv[0] === "quarantine") {
    const { parseQuarantineArgs, runQuarantine, formatQuarantineEntry } = await import(
      "./cli-quarantine.js"
    );
    const parsed = parseQuarantineArgs(argv.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`model-forecast: ${parsed.error}\n`);
      process.exit(1);
      return;
    }
    const result = await runQuarantine(parsed);
    if (!result.ok) {
      process.stderr.write(`model-forecast: ${result.error}\n`);
      process.exit(1);
      return;
    }
    if (result.action === "add") {
      process.stderr.write(
        `model-forecast: quarantined ${result.expandedCount} model(s) (${result.expiresAtIso}); wrote ${result.filePath}\n`,
      );
    } else if (result.action === "release") {
      process.stderr.write(
        `model-forecast: released ${result.removedCount} entr${result.removedCount === 1 ? "y" : "ies"} from ${result.filePath}\n`,
      );
    } else {
      if (result.entries.length === 0) {
        process.stderr.write(`model-forecast: no quarantines at ${result.filePath}\n`);
      } else {
        const lines = result.entries.map((entry) => formatQuarantineEntry(entry, Date.now()));
        process.stdout.write(`${lines.join("\n")}\n`);
      }
    }
    process.exit(0);
    return;
  }
  if (argv.length > 0 && argv[0] === "config") {
    const { parseConfigArgs, runConfig } = await import("./cli-config.js");
    const parsed = parseConfigArgs(argv.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`model-forecast: ${parsed.error}\n`);
      process.exit(1);
      return;
    }
    const result = await runConfig(parsed, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (result.error) {
      process.stderr.write(`model-forecast: ${result.error}\n`);
    }
    process.exit(result.exitCode);
    return;
  }
  // Strip the explicit `forecast` subcommand if present (lets us act as
  // `node dist/cli.js forecast --phase X` while still working as
  // `node dist/cli.js --phase X`).
  if (argv.length > 0 && argv[0] === "forecast") {
    const result = await runCli(argv.slice(1));
    process.exit(result.exitCode);
    return;
  }
  const result = await runCli(argv);
  process.exit(result.exitCode);
}

// Run only when the module is the script entry point (not when imported).
// CommonJS-style guard via `import.meta.url` keeps ESM clean.
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  // crude guard: this file's path appears as argv[1] or argv[2] depending
  // on how it was invoked.
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("cli") ||
    process.argv[2]?.endsWith("cli.js") === true);

if (isMainModule) {
  void main();
}
