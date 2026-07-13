/**
 * OpenCode plugin entry.
 *
 * NOTE (loader compatibility): This module holds the plugin implementation
 * and its programmatic surface (`modelForecastPlugin`, `refreshCache`, and
 * the associated option types). The package-root entry (`src/index.ts`)
 * re-exports ONLY the default plugin function so OpenCode's plugin loader —
 * which iterates every runtime export of the package root and requires each
 * to be a Plugin function — accepts the package. The public/programmatic API
 * barrel lives in `src/api.ts` (package export `./api`).
 *
 * Mode behaviour:
 *   - "advisory" / "off" (default) — returns `{}` (no hooks registered).
 *   - "auto" — registers `config`, `tool.execute.before`, and
 *     (when quarantine is enabled) `tool.execute.after` hooks.
 *
 * `refreshCache()` is exported as a standalone function for the CLI,
 * programmatic callers, and unit tests. It is NOT called at plugin init
 * (the config hook drives profile generation from the live provider list
 * or the on-disk cache directly).
 *
 * Cache format follows `ModelDataCache` from src/types.ts. Never throws —
 * best-effort by design.
 */

import {
  readCache,
  writeCache,
  defaultCachePath,
} from "./cache.js";
import { existsSync, readFileSync, watch } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";
import {
  readGentleAiVariantsCache,
  readOpenCodeModelsCache,
  buildProvidersCache,
  discoverLiveModels,
  extractProviderList,
  extractVariantsFromProviderList,
} from "./models.js";
import type { Discovery } from "./models.js";
import {
  connectedModelsFromCache,
  connectedModelsFromProviderList,
  createGeneratedProfileResolver,
  generateProfilesForConfig,
  type GeneratedProfileCatalog,
} from "./profiles.js";
import { PHASE_DIFFICULTY, normalizePhase } from "./phases.js";
import { createAfterHook, createTaskHook, toolID, type TaskHook } from "./hooks.js";
import { createFallbackEngine } from "./fallback.js";
import { classifyError } from "./error-classification.js";
import { createEventHook } from "./opencode-event-hook.js";
import { QuarantineStore, setSharedQuarantineStore } from "./quarantine.js";
import { loadQuarantineFile } from "./cli-quarantine.js";
import { loadEffectiveBenchmarks } from "./repo-data.js";
import { DEFAULT_LADDER } from "./policy.js";
import { AttemptCoordinator } from "./attempt-coordinator.js";
import { AttemptWatchdog, type AttemptWatchdogTimeouts } from "./attempt-watchdog.js";
import { safeAbortSession } from "./session-abort.js";
import { ParentRecovery } from "./parent-recovery.js";
import { createRecoveryAuditRecorder } from "./audit.js";
import { defaultStatePath, writeStateFile, type RecoveryStateEntry } from "./state-file.js";
import type { AuditEntry, HooksConfig, ModelDataCache, RecoveryAuditEntry, SelectionMode } from "./types.js";
import type { ResolveCandidates } from "./hooks.js";
import type { AttemptFailure } from "./recovery-types.js";

/**
 * Module-level dedupe state. Tracks the in-flight refresh keyed by
 * (effective cache path × client presence). Multiple concurrent
 * `refreshCache` calls that target the same destination share the
 * same Promise instead of racing on the file.
 */
let inflightRefresh: { key: string; promise: Promise<void> } | null = null;

/**
 * Optional plugin input argument. OpenCode plugins receive an `input`
 * object with `client`, `directory`, etc. We accept it but only use the
 * directory for cache-path discovery in future expansions. The MVP uses
 * the default cache path so the CLI, which lives in a separate process,
 * can find the same cache without IPC.
 *
 * The shape is intentionally loose (`unknown`) to avoid leaking the
 * `@opencode-ai/plugin` type into the runtime contract before the
 * plugin is registered against OpenCode itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type PluginInput = Record<string, unknown>;

import type { OpenCodeSessionClient } from "./opencode-client.js";

/**
 * Optional OpenCode-style client. When supplied, `refreshCache` calls
 * `client.provider.list()` synchronously or asynchronously and merges
 * the result into the cache as the **primary** data source (the gentle-ai
 * variants cache and OpenCode models cache act as fallbacks). Either
 * throw path (sync or async) is absorbed — the cache is still written
 * with the static phase rubric.
 *
 * This shape mirrors the OpenCode SDK at runtime; we do not import the
 * SDK type to keep the plugin entry free of plugin-SDK types.
 */
export interface PluginClient {
  provider?: {
    list?: () => Promise<unknown> | unknown;
  };
  /**
   * OpenCode TUI surface. When present, `tui.showToast` renders an
   * on-screen notification. Optional and best-effort — never required.
   */
  tui?: {
    showToast?: (options: {
      body: {
        title?: string;
        message: string;
        variant: ToastVariant;
        duration?: number;
      };
    }) => Promise<unknown> | unknown;
  };
  /**
   * model-fallback-error-classification (SDD change) — Slice 3, task 22.
   * Design #1623 "Client wiring": loose structural surface for the
   * recursive fallback engine (`src/fallback.ts`). Mirrors
   * `client.session.create({body:{parentID?,title?}})` (sdk.gen.d.ts:114)
   * and `client.session.prompt({path:{id}, body:{model:{providerID,
   * modelID}, agent, parts}})` (sdk.gen.d.ts:174). Deliberately loose/
   * optional — no SDK type import — so a client missing either method
   * degrades the fallback engine to a graceful no-op instead of a crash.
   */
  session?: OpenCodeSessionClient;
}

/** Toast severity as accepted by OpenCode's `tui.showToast`. */
export type ToastVariant = "info" | "success" | "warning" | "error";

/** Emits each recovery milestone once per task, even when hooks race. */
export function createRecoveryToastEmitter(client: PluginClient | undefined): (
  callID: string,
  event: string,
  message: string,
  variant: ToastVariant,
) => void {
  const emitted = new Set<string>();
  return (callID, event, message, variant): void => {
    const key = `${callID}:${event}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    showToastSafely(client, message, variant);
  };
}

type RecoveryObserver = {
  observe: (entry: RecoveryAuditEntry) => void;
  publish: (coordinator: AttemptCoordinator) => void;
};

function createRecoveryObserver(options: ModelForecastPluginOptions | undefined): RecoveryObserver {
  const recorder = createRecoveryAuditRecorder({
    auditPath: options?.recovery?.auditPath,
    writeEngram: options?.recovery?.writeEngram,
  });
  const statePath = options?.recovery?.statePath ?? defaultStatePath();
  let lastRecovery: RecoveryStateEntry | null = null;
  return {
    observe(entry): void {
      if (entry.terminal) {
        lastRecovery = {
          callID: entry.callID,
          originalModel: entry.originalModel,
          fallbackModel: entry.fallbackModel ?? null,
          state: entry.state ?? entry.event,
          ...(entry.result !== undefined ? { result: entry.result } : {}),
          ...(entry.message !== undefined ? { failure: entry.message } : {}),
        };
      }
      void recorder.record(entry);
    },
    publish(coordinator): void {
      const activeRecoveries: RecoveryStateEntry[] = [];
      for (const task of coordinator.tasksByCallID.values()) {
        if (task.state !== "failure-claimed" && task.state !== "fallback-running" && task.state !== "awaiting-original-settlement") continue;
        activeRecoveries.push({
          callID: task.callID,
          originalModel: task.originalModel,
          fallbackModel: task.fallbackResult?.status === "success" ? task.fallbackResult.model : null,
          state: task.state,
          ...(task.failure !== undefined ? { failure: task.failure.code } : {}),
        });
      }
      void writeStateFile(statePath, {
        selectedModel: null, selectedEffort: "", selectedConfidence: 0,
        fallbackModel: null, fallbackConfidence: 0, preset: "", mode: "auto",
        quarantineCount: 0, quarantined: [], cacheAge: null,
        lastUpdate: new Date().toISOString(),
        activeRecoveryCount: activeRecoveries.length,
        activeRecoveries,
        lastRecovery,
      }).catch(() => {});
    },
  };
}

function instrumentRecoveryCoordinator(
  coordinator: AttemptCoordinator,
  observer: RecoveryObserver,
  toast: ReturnType<typeof createRecoveryToastEmitter>,
): void {
  const emit = (entry: RecoveryAuditEntry, message?: string, variant?: ToastVariant): void => {
    observer.observe(entry);
    observer.publish(coordinator);
    if (message !== undefined && variant !== undefined) toast(entry.callID, entry.event, message, variant);
  };
  const claimFailure = coordinator.claimFailure.bind(coordinator);
  coordinator.claimFailure = (input) => {
    const result = claimFailure(input);
    const task = coordinator.tasksByCallID.get(input.callID);
    if (result.claimed && task !== undefined) emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: task.callID, event: "failure_detected", originalModel: task.originalModel, terminal: false, state: task.state, message: input.failure.code });
    return result;
  };
  const registerAbort = coordinator.registerPluginAbort.bind(coordinator);
  coordinator.registerPluginAbort = (input) => {
    const record = registerAbort(input);
    const task = coordinator.tasksByCallID.get(input.callID);
    if (task !== undefined) emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: task.callID, event: "abort_requested", originalModel: task.originalModel, terminal: false, state: task.state, message: input.reason });
    return record;
  };
  const setFallbackPromise = coordinator.setFallbackPromise.bind(coordinator);
  coordinator.setFallbackPromise = (input) => {
    const promise = setFallbackPromise(input);
    const task = coordinator.tasksByCallID.get(input.callID);
    if (task !== undefined) emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: task.callID, event: "fallback_started", originalModel: task.originalModel, terminal: false, state: task.state }, "model-forecast: fallback started", "info");
    return promise;
  };
  const recordFallbackResult = coordinator.recordFallbackResult.bind(coordinator);
  coordinator.recordFallbackResult = (input) => {
    const task = recordFallbackResult(input);
    if (task.fallbackResult !== input.result) return task;
    const event = input.result.status === "success" ? "fallback_succeeded" : input.result.status === "exhausted" ? "fallback_exhausted" : "cancelled";
    const result = input.result.status === "success" ? "success" : input.result.status === "exhausted" ? "exhausted" : "cancelled";
    emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: input.callID, event, originalModel: task.originalModel, fallbackModel: input.result.status === "success" ? input.result.model : null, terminal: true, state: task.state, result, message: task.failure?.code }, `model-forecast: ${event.replaceAll("_", " ")}`, input.result.status === "success" ? "success" : "warning");
    return task;
  };
  const cancelTask = coordinator.cancelTask.bind(coordinator);
  coordinator.cancelTask = (input) => {
    const task = cancelTask(input);
    if (task !== undefined && task.state === "cancelled") emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: task.callID, event: "cancelled", originalModel: task.originalModel, terminal: true, state: task.state, result: "cancelled" });
    return task;
  };
  const cancelParent = coordinator.cancelParent.bind(coordinator);
  coordinator.cancelParent = (input) => {
    const tasks = cancelParent(input);
    for (const task of tasks) {
      emit({ kind: "recovery", timestamp: new Date().toISOString(), callID: task.callID, event: "cancelled", originalModel: task.originalModel, terminal: true, state: task.state, result: "cancelled" });
    }
    return tasks;
  };
  const markParentRecoveryEnqueued = coordinator.markParentRecoveryEnqueued.bind(coordinator);
  coordinator.markParentRecoveryEnqueued = (callID, now) => {
    const marked = markParentRecoveryEnqueued(callID, now);
    const task = coordinator.tasksByCallID.get(callID);
    if (marked && task !== undefined) emit({ kind: "recovery", timestamp: new Date().toISOString(), callID, event: "parent_recovery", originalModel: task.originalModel, terminal: false, state: task.state }, "model-forecast: parent recovery enqueued", "info");
    return marked;
  };
}

import { Logger, extractProjectInfo, logLegacy } from "./logger.js";

/**
 * Best-effort transition log. Writes ONE prefixed line per call to both
 * stderr and the plugin log file (legacy path — no project context).
 *
 * Exported for direct unit-testability; NOT re-exported by `src/api.ts`
 * so the public API surface is unchanged. Production callers inside
 * the plugin should use `Logger` instance methods instead.
 */
export function logTransition(message: string): void {
  logLegacy(message);
}

/**
 * Safe, non-throwing TUI toast. Renders an on-screen notification via
 * `client.tui.showToast` when the surface is available. Every failure
 * path — a missing client, a missing TUI, a synchronous throw, or a
 * rejected async call — is swallowed so a toast can NEVER break plugin
 * startup or a hook. Returns nothing; visibility is best-effort.
 */
function showToastSafely(
  client: PluginClient | undefined,
  message: string,
  variant: ToastVariant = "info",
): void {
  try {
    const showToast = client?.tui?.showToast;
    if (typeof showToast !== "function") return;
    const result = showToast({ body: { message, variant } });
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // Absorb async rejections; the toast is fire-and-forget.
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // Best-effort: a toast must never surface an error to the caller.
  }
}

/** Options accepted by `refreshCache` for testability. */
export interface RefreshCacheOptions {
  /** Override the destination cache path. Defaults to `defaultCachePath()`. */
  cachePath?: string;
  /** Override the gentle-ai variants cache path. */
  gentleAiPath?: string;
  /** Override the OpenCode models cache path. */
  openCodePath?: string;
  /**
   * Optional OpenCode client. When supplied, `client.provider.list()` is
   * called and merged as the primary data source. Sync and async throws
   * are absorbed (best-effort).
   */
  client?: PluginClient;
  /** Optional logger for per-step tracing. */
  logger?: Logger;
  /**
   * PR1 — pending-queue data layer. Optional callback invoked once per
   * refresh with a `Discovery` describing the live catalog. The default
   * is a no-op so the public signature is additive. Sink errors are
   * absorbed and never propagate to the refresh.
   */
  discoverySink?: (discovery: Discovery) => void;
}

export interface ModelForecastPluginOptions {
  mode?: SelectionMode;
  verbose?: boolean;
  confidenceThreshold?: number;
  allowlist?: string[];
  denylist?: string[];
  resolveCandidates?: ResolveCandidates;
  generatedProfiles?: {
    enabled?: boolean;
    phasePrefixes?: string[];
  };
  /**
   * 429-fallback — rate-limit quarantine layer. When omitted, the
   * after hook is registered with default settings (`enabled: true`,
   * `ttlMs: 3_600_000`). Setting `{ enabled: false }` disables the
   * after hook and resolver filter (restores pre-change behaviour).
   */
  quarantine?: {
    enabled?: boolean;
    ttlMs?: number;
    /**
     * Override the quarantine persistence file path. Defaults to
     * `~/.cache/opencode-model-forecast/quarantine.json`. Inject a
     * custom path (e.g. temp dir) in tests to avoid contaminating
     * the real global quarantine file.
     */
    filePath?: string;
  };
  /**
   * model-fallback-error-classification (SDD change) — Slice 3, task 22.
   * Recursive fallback layer (design #1623 "Fallback mechanism"). Gated
   * by `enabled !== false` AND the client actually exposing
   * `session.create`/`session.prompt` — the default is ON when a usable
   * client is present, and disabling it restores pre-Slice-3 audit-only
   * behavior (rollback plan, design #1623 "Migration / Rollout").
   */
  fallback?: {
    enabled?: boolean;
  };
  /**
   * supervised-model-fallback-recovery (SDD change) — PR-01.
   * Config block for active supervision, watchdog timers, and parent recovery prompts.
   */
  recovery?: {
    enabled?: boolean;
    timeouts?: {
      TOOL_EXECUTION_TIMEOUT_MS?: number;
      ATTEMPT_HARD_TIMEOUT_MS?: number;
      INACTIVITY_TIMEOUT_MS?: number;
      FIRST_ACTIVITY_TIMEOUT_MS?: number;
    };
    auditPath?: string;
    statePath?: string;
    writeEngram?: (entry: AuditEntry) => Promise<void> | void;
  };
  /**
   * Override the model-data cache path for the config hook fallback
   * read. Defaults to `~/.cache/opencode-model-forecast/model-data.json`.
   * Inject a custom path (e.g. temp dir) in tests to avoid reading the
   * real global cache file.
   */
  cachePath?: string;
  benchmarks?: {
    rootDir?: string;
    globalPath?: string;
  };
}

function pluginHooksConfig(options?: ModelForecastPluginOptions): HooksConfig {
  return {
    mode: options?.mode ?? readModeFromOpenCodeConfig() ?? "advisory",
    confidenceThreshold: options?.confidenceThreshold ?? 0.6,
    ladder: DEFAULT_LADDER,
    allowlist: options?.allowlist ?? [],
    denylist: options?.denylist ?? [],
  };
}

function isSelectionMode(value: unknown): value is SelectionMode {
  return value === "auto" || value === "advisory" || value === "off";
}

function readModeFromOpenCodeConfig(): SelectionMode | undefined {
  // Unit tests must stay hermetic; never let the developer's real
  // ~/.config/opencode/opencode.json change default plugin behavior.
  if (process.env.VITEST !== undefined || process.env.NODE_ENV === "test") return undefined;

  const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
  let parsed: unknown;
  try {
    if (!existsSync(configPath)) return undefined;
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const plugins = (parsed as { plugin?: unknown }).plugin;
  if (!Array.isArray(plugins)) return undefined;

  for (const entry of plugins) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [spec, options] = entry as [unknown, unknown];
    if (typeof spec !== "string") continue;
    const normalized = spec.replace(/\\/g, "/");
    const isThisPlugin = normalized.includes("subagentsplugin/dist/index.js") ||
      normalized.includes("@aabadin/opencode-model-forecast");
    if (!isThisPlugin) continue;
    if (options === null || typeof options !== "object") continue;
    const mode = (options as { mode?: unknown }).mode;
    return isSelectionMode(mode) ? mode : undefined;
  }

  return undefined;
}

function watchQuarantineFile(
  filePath: string,
  quarantine: QuarantineStore,
  logger: Logger,
): void {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath).toLowerCase();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async () => {
    try {
      const entries = await loadQuarantineFile(filePath, Date.now());
      const { added, removed } = quarantine.syncPersistentEntries(entries);
      logger.info("quarantine", `watched reload file=${filePath} added=${added} removed=${removed}`);
    } catch (err) {
      logger.warn("quarantine", `watched reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void mkdir(dir, { recursive: true }).then(() => {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, changed) => {
        if (changed !== null && changed !== undefined && String(changed).toLowerCase() !== fileName) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 150);
      });
      watcher.unref?.();
      logger.info("quarantine", `watching quarantine file: ${filePath}`);
    } catch (err) {
      logger.warn("quarantine", `watch setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }).catch((err: unknown) => {
    logger.warn("quarantine", `watch mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Races a promise against a timer so that a hung async operation (e.g. an
 * OpenCode provider call when another plugin has failed) cannot block startup.
 * The timer is always cleared when the promise settles.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return Promise.race([
    promise.then(
      (value) => {
        clear();
        return value;
      },
      (err) => {
        clear();
        throw err;
      },
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

/**
 * Reads variant sources, merges with the static rubric, writes the result
 * cache atomically. Returns a Promise that resolves when the cache file
 * is on disk; never rejects — best-effort by design (plugin init must
 * not fail the session).
 *
 * Pure I/O: writes to disk. Read failures (missing/invalid sources)
 * produce an empty providers map; the rubric is always present from
 * `PHASE_DIFFICULTY`.
 */
export async function refreshCache(
  options: RefreshCacheOptions = {},
): Promise<void> {
  // De-duplicate concurrent refreshes that target the SAME effective cache
  // path. The plugin init path calls `void refreshCache()` synchronously,
  // so a single OpenCode session that pulls the plugin twice (or a CLI
  // invocation that runs while init is still pending) must NOT race on
  // the same cache file. We dedupe on the effective path so:
  //   - two default-path calls share the in-flight refresh
  //   - a custom-path call gets its own refresh
  //   - two custom-path calls sharing the same target ALSO share the
  //     refresh (so a CLI invocation racing the plugin init does not
  //     collide on the same file).
  const effectiveCachePath = options.cachePath ?? defaultCachePath();
  const inflightKey = `${effectiveCachePath}|${options.client === undefined ? "no-client" : "client"}`;
  if (inflightRefresh !== null && (inflightRefresh as { key?: string }).key === inflightKey) {
    options.logger?.trace("refreshCache", `deduped (in-flight): ${effectiveCachePath}`);
    return (inflightRefresh as { promise: Promise<void> }).promise;
  }

  const logger = options.logger;

  const work = (async (): Promise<void> => {
    try {
      logger?.info("refreshCache", `starting: ${effectiveCachePath}`);
      const gentleAiVariants = await readGentleAiVariantsCache(options.gentleAiPath, logger);
      const openCodeModels = await readOpenCodeModelsCache(options.openCodePath, logger);

      // Optionally call client.provider.list() as the primary live source.
      // Spec: "cache refresh MUST NOT fail when sources are absent" — any
      // throw here is absorbed and the cache is still written with whatever
      // the file-based sources + static rubric provide.
      let liveVariants: Record<string, Record<string, string[]>> = {};
      // PR1 — keep a reference to the raw provider.list() result so the
      // discovery sink can emit a `Discovery` (PR2 consumes the snapshot
      // to compute the canonical pending delta). When the SDK throws or
      // is absent, we feed an explicit `undefined` so the sink sees an
      // `unavailable` discovery from the opencode cache fallback.
      let providerListResult: unknown = undefined;
      // this-binding: the SDK's `provider.list` is a class method that
      // reads `this._client`; call it bound to the provider instance so an
      // unbound `this` does not throw. See the config hook for detail.
      const provider = options.client?.provider;
      const listFn = provider?.list;
      if (typeof listFn === "function") {
        try {
          providerListResult = await Promise.resolve(listFn.call(provider));
          liveVariants = extractVariantsFromProviderList(extractProviderList(providerListResult));
        } catch {
          // Best-effort: SDK may not be available in test/CLI paths.
          liveVariants = {};
          providerListResult = undefined;
        }
      }

      // PR1 — emit a `Discovery` to the optional sink. The sink is a
      // no-op by default; errors thrown by the sink are absorbed so a
      // misbehaving consumer cannot break the cache write path.
      if (typeof options.discoverySink === "function") {
        const discovery = discoverLiveModels({
          ...(providerListResult !== undefined ? { providerList: providerListResult } : {}),
          ...(openCodeModels && typeof openCodeModels === "object"
            ? { openCodeCache: openCodeModels }
            : {}),
        });
        try {
          options.discoverySink(discovery);
        } catch (sinkErr) {
          const sinkMsg = sinkErr instanceof Error ? sinkErr.message : String(sinkErr);
          logger?.warn("refreshCache", `discoverySink threw (absorbed): ${sinkMsg}`);
        }
      }

      // Live client data takes precedence over the gentle-ai file cache
      // (design: "input.client.provider.list() (primary) + gentle-ai
      // variants file"). When the live source is empty we fall back to
      // the gentle-ai cache file (or the OpenCode models cache below).
      const merged: Record<string, Record<string, string[]>> =
        Object.keys(liveVariants).length > 0 ? liveVariants : gentleAiVariants;

      // Sort variant keys for deterministic cache output (matches PR3's
      // extractVariantsFromProviderList behaviour; the gentle-ai cache file
      // is not guaranteed to already be sorted).
      for (const models of Object.values(merged)) {
        for (const modelId of Object.keys(models)) {
          models[modelId] = [...models[modelId]].sort();
        }
      }

      const providers = buildProvidersCache(merged) as Record<
      string,
      Record<string, { variants: string[] }>
    >;

      // If we still have no providers, attempt a last-ditch extraction from
      // openCodeModels by scanning provider objects with a `models` map.
      if (Object.keys(providers).length === 0 && openCodeModels && typeof openCodeModels === "object") {
        for (const [providerId, prov] of Object.entries(openCodeModels)) {
          if (!prov || typeof prov !== "object") continue;
          const models = (prov as { models?: unknown }).models;
          if (!models || typeof models !== "object") continue;
          const providerEntry: Record<string, { variants: string[] }> = {};
          for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
            if (!model || typeof model !== "object") continue;
            const variants = (model as { variants?: unknown }).variants;
            if (variants && typeof variants === "object" && Object.keys(variants as object).length > 0) {
              providerEntry[modelId] = {
                variants: Object.keys(variants as object).sort(),
              };
            }
          }
          if (Object.keys(providerEntry).length > 0) {
            (providers as Record<string, Record<string, { variants: string[] }>>)[providerId] = providerEntry;
          }
        }
      }

      const cache: ModelDataCache = {
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: providers as unknown as ModelDataCache["providers"],
        rubric: { ...PHASE_DIFFICULTY },
      };

      await writeCache(effectiveCachePath, cache, logger);
    } catch (err) {
      // Best-effort. Plugin init must never throw; log to stderr instead
      // and resolve.
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error("refreshCache", `failed: ${msg}`);
      process.stderr.write(
        `model-forecast: cache refresh failed: ${msg}\n`,
      );
    }
  })();

  // Cache the in-flight refresh under (path × client-presence) so any
  // concurrent caller awaiting the same target shares the same Promise.
  inflightRefresh = { key: inflightKey, promise: work };
  work.finally(() => {
    if (inflightRefresh !== null && inflightRefresh.promise === work) {
      inflightRefresh = null;
    }
  });

  return work;
}

/**
 * Wraps a `TaskHook` with a stderr trace line that fires BEFORE the
 * inner hook runs. Used to log every intercepted `task` call so the
 * user can confirm the rewrite path is active. The wrapper preserves
 * the `TaskHook` signature exactly — it does not transform input or
 * output, only emits a trace line and awaits the inner hook. Stderr
 * write failures are absorbed by `logTransition`.
 *
 * `tool.execute.before` fires for EVERY tool (read, grep, bash, …), not
 * just `task`. The trace is therefore gated to the `task` tool so it no
 * longer emits a misleading `subagent_type=<unknown>` line for every
 * non-task tool call. For task calls it reports both the raw
 * subagent_type and the normalized canonical phase so escalation
 * variants (`sdd-propose-alto`) are visibly resolved.
 *
 * We wrap (rather than modify `createTaskHook`) so the hook surface
 * stays stable and the existing tests in tests/plugin.test.ts which
 * directly call `hooks["tool.execute.before"]` continue to pass.
 */
function wrapTaskHookForTrace(inner: TaskHook, logger?: Logger): TaskHook {
  return async (input, output) => {
    if (toolID(input?.tool) === "task") {
      const raw =
        typeof output?.args?.subagent_type === "string"
          ? output.args.subagent_type
          : "";
      const { phase, matched } = normalizePhase(raw);
      const subagentType = raw.length > 0 ? raw : "<unknown>";
      const callID = input?.callID ?? "<none>";
      if (logger) {
        logger.info(
          "task.before",
          `subagent_type=${subagentType} phase=${phase || "<unmatched>"} matched=${matched} callID=${callID}`,
        );
      } else {
        logTransition(
          `task.before subagent_type=${subagentType} phase=${phase || "<unmatched>"} matched=${matched} callID=${callID}`,
        );
      }
    }
    await inner(input, output);
  };
}

/**
 * Plugin entry. Returns an empty hooks record (NO `chat.params`, NO
 * `tool.execute.before`) per spec and kicks off a fire-and-forget cache
 * refresh via `void`.
 *
 * Safe to call with or without an input argument. When OpenCode passes an
 * `input.client` (the live SDK client), its `provider.list()` is forwarded
 * to `refreshCache` as the primary data source so the runtime cache picks
 * up the live provider/model catalog instead of relying solely on the
 * gentle-ai / OpenCode file caches.
 */
export default async function modelForecastPlugin(
  input?: PluginInput,
  options?: ModelForecastPluginOptions,
): Promise<Record<string, unknown>> {
  // Extract the optional client without leaking OpenCode types into the
  // runtime contract. We only ever reach into `input.client`; other keys
  // are ignored.
  let client: PluginClient | undefined;
  if (input !== null && typeof input === "object") {
    const maybe = (input as { client?: unknown }).client;
    if (
      maybe !== null &&
      typeof maybe === "object" &&
      (typeof (maybe as { provider?: unknown }).provider === "object" ||
        typeof (maybe as { tui?: unknown }).tui === "object")
    ) {
      client = maybe as PluginClient;
    }
  }

  const { name: projectName, dir: projectDir } = extractProjectInfo(input as Record<string, unknown> | undefined);
  const logger = new Logger(projectName, projectDir, { verbose: options?.verbose === true });

  const hookConfig = pluginHooksConfig(options);
  // Visibility — one stderr line per plugin load so the user can
  // confirm the plugin was registered and with which mode/client.
  logger.info(
    "modelForecastPlugin",
    `init mode=${hookConfig.mode} client=${client !== undefined ? "present" : "absent"} dir=${projectDir}`,
  );
  if (hookConfig.mode !== "auto") return {};

  // Visibility: announce that the plugin is live in auto mode. Fired once
  // at registration so the user can see the plugin actually took effect.
  logger.info("modelForecastPlugin", "registering hooks (auto mode)");
  showToastSafely(client, "model-forecast: active in auto mode", "info");

  const profileCatalog: GeneratedProfileCatalog = { byBase: {} };

  // 429-fallback — quarantine layer. The store is created per plugin
  // instance so multiple instances stay isolated. `enabled: true` is
  // the default per design #1317 §2.
  const quarantineEnabled = options?.quarantine?.enabled !== false;
  const quarantine = new QuarantineStore({ ttlMs: options?.quarantine?.ttlMs, logger });

  // supervised-model-fallback-recovery (SDD change) — PR-04b.
  // Coordinator (built in PR-04a) replaces the legacy
  // `Map<string, TrackedCall>` AND the `fallbackSessionIDs` re-entrancy
  // guard. One coordinator per plugin instance so multiple instances
  // stay isolated. Production wiring always passes the coordinator to
  // both hooks AND the fallback engine — `plugin.ts` no longer reads
  // `innerAfterHook?.fallbackSessionIDs`.
  const recoveryObserver = createRecoveryObserver(options);
  let coordinatorForAudit: AttemptCoordinator | undefined;
  const recoveryLogger = {
    trace: logger.trace.bind(logger),
    info: logger.info.bind(logger),
    warn(scope: string, message: string): void {
      logger.warn(scope, message);
      if (!message.startsWith("invalid_transition:")) return;
      const callID = /callID=([^\)\s]+)/.exec(message)?.[1] ?? "unknown";
      recoveryObserver.observe({
        kind: "recovery",
        timestamp: new Date().toISOString(),
        callID,
        event: "invalid_transition",
        originalModel: coordinatorForAudit?.tasksByCallID.get(callID)?.originalModel ?? "",
        terminal: false,
        message,
      });
      if (coordinatorForAudit !== undefined) recoveryObserver.publish(coordinatorForAudit);
    },
    error: logger.error.bind(logger),
  } as Logger;
  const coordinator = new AttemptCoordinator({ logger: recoveryLogger });
  coordinatorForAudit = coordinator;
  instrumentRecoveryCoordinator(
    coordinator,
    recoveryObserver,
    createRecoveryToastEmitter(client),
  );
  const parentRecovery = new ParentRecovery({ coordinator, client: client?.session });
  let watchdog: AttemptWatchdog | undefined;
  const recoveryEnabled = options?.recovery?.enabled !== false;

  function recoveryTimeouts(): AttemptWatchdogTimeouts {
    const configured = options?.recovery?.timeouts;
    type RecoveryTimeoutKey = "FIRST_ACTIVITY_TIMEOUT_MS" | "INACTIVITY_TIMEOUT_MS" | "TOOL_EXECUTION_TIMEOUT_MS" | "ATTEMPT_HARD_TIMEOUT_MS";
    const read = (key: RecoveryTimeoutKey): number | undefined => {
      const value = configured?.[key];
      if (value === undefined) return undefined;
      if (Number.isFinite(value) && value > 0) return value;
      logger.warn("recovery", `invalid ${key} override; using recovery-policy default`);
      return undefined;
    };
    return {
      firstActivityMs: read("FIRST_ACTIVITY_TIMEOUT_MS"),
      inactivityMs: read("INACTIVITY_TIMEOUT_MS"),
      toolMs: read("TOOL_EXECUTION_TIMEOUT_MS"),
      hardMs: read("ATTEMPT_HARD_TIMEOUT_MS"),
    };
  }

  // Cross-bundle publishing: tsup builds the plugin (`dist/index.js`)
  // and the TUI (`dist/tui.js`) as SEPARATE bundles, so the TUI cannot
  // reach this QuarantineStore via a normal ESM import. Publish the
  // live instance on `globalThis` so the TUI can mutate it for
  // immediate in-session effect (and persist via saveToFile).
  setSharedQuarantineStore(quarantine);

  // Permanent quarantine persistence — survives CLI/plugin restart.
  // Stored alongside the model-data cache but in a separate file so
  // provider discovery cache and quarantine state do not conflict.
  // The path can be overridden via options.quarantine.filePath for
  // tests and isolated runs; default is the global cache location.
  const quarantineFilePath = options?.quarantine?.filePath ?? path.join(
    homedir(), ".cache", "opencode-model-forecast", "quarantine.json",
  );

  // Load permanent quarantines from previous sessions.
  // AWAITED so hooks never race with file load: the config hook and
  // tool hooks run AFTER OpenCode receives the hooks object.  Since
  // `modelForecastPlugin` is an async function, OpenCode awaits its
  // result before invoking any registered hooks — guaranteeing the
  // quarantine store is populated before isBlocked() is consulted.
  if (quarantineEnabled) {
    try {
      await quarantine.loadFromFile(quarantineFilePath);
      const permCount = quarantine.snapshot().length;
      if (permCount > 0) {
        logger.info("quarantine", `loaded ${permCount} permanent quarantines from previous session`);
        showToastSafely(client, `model-forecast: ${permCount} model(s) still quarantined from previous session`, "warning");
      }
    } catch {
      // Never block plugin startup on quarantine I/O failures.
    }
  }

  if (quarantineEnabled) {
    watchQuarantineFile(quarantineFilePath, quarantine, logger);
  }

  const generatedProfileResolver = createGeneratedProfileResolver(
    profileCatalog,
    { ...(quarantineEnabled ? { quarantine } : {}), logger },
  );

  // model-fallback-error-classification (SDD change) — Slice 3, task 22.
  // Design #1623 "Fallback mechanism" + "Re-entrancy guard".
  //
  // PR-04b: the `coordinator` is the canonical registry. Both the
  // before and after hooks read the re-entrancy guard from
  // `coordinator.isInternalSession(sessionID)` and the per-callID
  // task state from `coordinator.tasksByCallID` — the legacy
  // `Map<string, TrackedCall>` and `fallbackSessionIDs` fields are no
  // longer part of the production wiring. Gated by `enabled !== false`
  // AND the client actually exposing usable `session.create`/
  // `session.prompt` methods; the default is ON only when both hold
  // (rollback plan: `fallback: {enabled: false}` — or an absent/
  // partial client — restores pre-Slice-3 audit-only behavior).
  const fallbackClientUsable =
    client !== undefined &&
    typeof client.session?.create === "function" &&
    typeof client.session?.prompt === "function";
  const fallbackEnabled = fallbackClientUsable && options?.fallback?.enabled !== false;
  let innerAfterHook: ReturnType<typeof createAfterHook> | undefined;
  if (quarantineEnabled) {
    innerAfterHook = createAfterHook({
      quarantine,
      coordinator,
      parentRecovery,
      catalog: profileCatalog,
      ladder: DEFAULT_LADDER,
      logger,
      ...(client !== undefined
        ? { fallback: { client, enabled: fallbackEnabled } }
        : {}),
      // Visibility: mirror the loud-advisory stderr line AND surface it
      // on-screen. The after hook emits this ONCE per quarantine event
      // (delete-on-consume per callID), so it is not per-call spam.
      warnSink: (message: string) => {
        try {
          process.stderr.write(`${message}\n`);
        } catch {
          // Never let the loud-advisory warning block the hook.
        }
        showToastSafely(client, message, "warning");
      },
    });
  }

  const hooks: Record<string, unknown> = {
    config: async (config: { agent?: Record<string, Record<string, unknown> | undefined> }) => {
      if (options?.generatedProfiles?.enabled === false) return;
      // OpenCode AWAITS the config hook; any rejection here surfaces as a
      // structured `Cause { failures: [...] }` and aborts startup. Wrap the
      // ENTIRE body so profile generation is strictly best-effort and can
      // never break config resolution.
      try {
        const hasInputDirectory =
          input !== null &&
          typeof input === "object" &&
          typeof (input as { directory?: unknown }).directory === "string";
        const hasBenchmarkOptions =
          options?.benchmarks?.rootDir !== undefined ||
          options?.benchmarks?.globalPath !== undefined;
        const shouldLoadBenchmarks =
          process.env.VITEST === undefined ||
          hasInputDirectory ||
          hasBenchmarkOptions;
        if (shouldLoadBenchmarks) {
          await loadEffectiveBenchmarks({
            rootDir: options?.benchmarks?.rootDir ?? projectDir,
            globalPath: options?.benchmarks?.globalPath,
          });
        }
        let connectedModels = [] as ReturnType<typeof connectedModelsFromProviderList>;
        // Diagnostic: capture WHY zero profiles were produced so the user
        // can `grep model-forecast` and see the exact reason on screen.
        let reason = "";
        // NOTE (this-binding): the OpenCode SDK exposes `client.provider`
        // as a class instance (`class Provider extends _HeyApiClient`)
        // whose `list()` reads `this._client`. Extracting the method into
        // a bare reference and calling it (`listFn()`) loses the `this`
        // binding and throws `Cannot read properties of undefined` INSIDE
        // the SDK. We therefore invoke it bound to the provider instance.
        const provider = client?.provider;
        const listFn = provider?.list;
        if (typeof listFn !== "function") {
          reason = client === undefined ? "no client at config time" : "provider.list unavailable";
        } else {
          try {
            const listResult = await withTimeout(
              Promise.resolve(listFn.call(provider)),
              5000,
              "provider.list",
            );
            connectedModels = connectedModelsFromProviderList(extractProviderList(listResult));
            if (connectedModels.length === 0) reason = "provider.list returned no models";
          } catch (err) {
            reason = `provider.list threw: ${err instanceof Error ? err.message : String(err)}`;
            connectedModels = [];
          }
        }
        // Fallback: when the live provider list is empty/unavailable at config
        // time (OpenCode starts providers after the config hook fires), read
        // the on-disk cache that refreshCache already wrote at plugin init.
        // This guarantees the config hook always has a model catalog to work
        // with, regardless of provider-list timing.
        if (connectedModels.length === 0) {
          try {
            const effectiveFallbackCachePath = options?.cachePath ?? defaultCachePath();
            const cached = await withTimeout(readCache(effectiveFallbackCachePath, logger), 3000, "readCache");
            if (cached !== null && cached.providers) {
              const fromCache = connectedModelsFromCache(cached.providers);
              if (fromCache.length > 0) {
                connectedModels = fromCache;
                reason = `fallback: ${fromCache.length} model(s) from disk cache`;
              } else {
                reason = "disk cache had no models";
              }
            } else {
              reason = "no disk cache yet";
            }
          } catch {
            reason = "disk cache read failed";
          }
        }
        const generated = generateProfilesForConfig(config, connectedModels, {
          phasePrefixes: options?.generatedProfiles?.phasePrefixes,
          maxProfilesPerBase: 3,
        });
        profileCatalog.byBase = generated.byBase;

        // Visibility: report how many generated profiles were created and
        // across how many base agents. This is the key on-screen feedback —
        // it confirms the config hook ran and produced routing profiles.
        const baseAgentCount = Object.keys(generated.byBase).length;
        const profileCount = Object.values(generated.byBase).reduce(
          (sum, profiles) => sum + profiles.length,
          0,
        );
        if (profileCount === 0 && reason === "" && baseAgentCount === 0) {
          reason = "no base phase agents in config";
        }
        // Visibility — stderr trace of the config-hook transition. Pairs
        // with the on-screen toast so a user can `grep model-forecast` in
        // the session log and see the same numbers (and the reason when 0).
        logger.info(
          "config",
          `hook fired, generated profiles=${profileCount} across ${baseAgentCount} base agents${reason ? ` (${reason})` : ""}`,
        );
        if (profileCount > 0) {
          showToastSafely(
            client,
            `model-forecast: generated ${profileCount} profile(s) across ${baseAgentCount} base agent(s)`,
            "success",
          );
        } else {
          showToastSafely(
            client,
            `model-forecast: generated 0 profiles — ${reason || "no candidates"}`,
            "warning",
          );
        }
      } catch (err) {
        // Absorb any unexpected failure (e.g. a non-mutable config object)
        // so the config hook resolves and OpenCode does not report a
        // startup `Cause` failure. Best-effort, logged to stderr only.
        logger.error(
          "config",
          `hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    "tool.execute.before": wrapTaskHookForTrace(
      createTaskHook(hookConfig, {
        resolveCandidates: options?.resolveCandidates ?? generatedProfileResolver,
        logger,
        ...(quarantineEnabled && recoveryEnabled ? { coordinator } : {}),
        onTaskRegistered: (callID) => watchdog?.watch(callID, { waitingForBind: true }),
      }),
      logger,
    ),
  };
  if (quarantineEnabled && innerAfterHook !== undefined) {
    const afterHook = innerAfterHook;
    // Wrap the after hook to persist permanent quarantines after every
    // quarantine event. saveToFile is idempotent and cheap — it only
    // writes entries with expiresAt === Infinity.
    hooks["tool.execute.after"] = async (
      input: Parameters<typeof afterHook>[0],
      output: Parameters<typeof afterHook>[1],
    ): Promise<void> => {
      const countBefore = quarantine.snapshot().length;
      await afterHook(input, output);
      const countAfter = quarantine.snapshot().length;
      // Only save if the quarantine count changed (a new entry was added).
      if (countAfter > countBefore) {
        await quarantine.saveToFile(quarantineFilePath);
      }
    };
  }

  // supervised-model-fallback-recovery (SDD change) — PR-05.
  // Register the OpenCode `event` hook for early failure detection.
  // Gated by `recovery.enabled !== false` (amendment P-06); default ON.
  // The event hook normalizes session/message/permission events (C-02),
  // associates child sessions to tracked tasks (§14), and — on an
  // authoritative 429 / provider / model failure — creates the
  // `fallbackPromise` BEFORE `tool.execute.after` fires (§PR-05 merge
  // gate). It NEVER aborts a session and starts NO watchdog (design
  // items 10 + 11). It uses a dedicated bounded fallback engine that
  // shares the coordinator + quarantine + catalog so internal-session
  // bookkeeping stays consistent with the after hook.
  if (recoveryEnabled) {
    const eventFallbackEngine =
      fallbackEnabled && client !== undefined
        ? createFallbackEngine({
            client: { session: client.session },
            quarantine,
            catalog: profileCatalog,
            ladder: DEFAULT_LADDER,
            classify: classifyError,
            maxAttempts: 3,
            logger,
            coordinator,
          })
        : undefined;

    const activeWatchdog = watchdog = new AttemptWatchdog({
      timeouts: recoveryTimeouts(),
      onTimeout: async ({ attemptID, kind }) => {
        const task = coordinator.taskForSession(attemptID);
        if (task === undefined) return;
        const timeoutKind: AttemptFailure["kind"] = kind === "first_activity" ? "first_activity_timeout"
          : kind === "inactivity" ? "inactivity_timeout"
            : kind === "tool" ? "tool_execution_timeout"
              : kind === "hard" ? "hard_timeout" : "session_create_timeout";
        const failure = {
          kind: timeoutKind,
          source: "watchdog" as const,
          code: timeoutKind,
          message: `watchdog timeout: ${kind}`,
          retryable: true,
          authoritative: true,
          detectedAt: Date.now(),
        };
        const claim = coordinator.claimFailure({
          callID: task.callID,
          attemptID: task.originalAttemptID,
          failure,
          source: "watchdog",
        });
        // Recovery and abort intentionally start independently: a hung
        // abort must never become the sole condition for fallback progress.
        const fallbackPromise = claim.claimed && eventFallbackEngine !== undefined
          ? eventFallbackEngine.run({
              sessionID: task.parentSessionID,
              taskCallID: task.callID,
              originalSubagentType: task.originalSubagentType,
              prompt: task.prompt,
              failedModel: task.originalModel,
              failureReason: timeoutKind,
            })
          : undefined;
        if (fallbackPromise !== undefined) {
          coordinator.setFallbackPromise({ callID: task.callID, promise: fallbackPromise });
          void fallbackPromise.then((result) => coordinator.recordFallbackResult({ callID: task.callID, result }), () => {});
        }
        await safeAbortSession({
          client: client?.session,
          coordinator,
          sessionID: attemptID,
          callID: task.callID,
          attemptID: task.originalAttemptID || attemptID,
          origin: "plugin-watchdog",
          reason: timeoutKind,
          logger,
        });
      },
    });

    const eventHook = createEventHook({
      coordinator,
      parentRecovery,
      ...(client !== undefined ? { client: { session: client.session } } : {}),
      logger,
      watchdog: activeWatchdog,
      ...(eventFallbackEngine !== undefined
        ? {
            startFallback: (task, failure) =>
              eventFallbackEngine.run({
                sessionID: task.parentSessionID,
                taskCallID: task.callID,
                originalSubagentType: task.originalSubagentType,
                prompt: task.prompt,
                failedModel: task.originalModel,
                failureReason: failure.code,
              }),
          }
        : {}),
    });

    // Register safely — the event hook is best-effort internally, but a
    // second guard here guarantees a thrown/rejected handler can never
    // surface to OpenCode's event dispatcher.
    hooks["event"] = async (input: { event?: unknown }): Promise<void> => {
      try {
        await eventHook(input);
      } catch (err) {
        logger.warn(
          "event",
          `event hook registration guard absorbed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
  }

  return hooks;
}

// Named export mirrors the default so tests and the tsup build agree on
// the entry point shape.
export { modelForecastPlugin };
