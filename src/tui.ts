/**
 * OpenCode TUI entry for `forecast-config`.
 *
 * This module intentionally avoids direct imports from `@opentui/*` so the
 * package can build in environments where those optional peers are absent.
 * It uses the host-provided `api.ui` surface and the current OpenCode keymap
 * layer to expose:
 *
 * - `/forecast-config`
 * - `Alt+G` / `Super+G`
 *
 * Both entry points open an integrated dialog flow inside OpenCode for
 * editing global model configuration persisted to
 * `~/.config/opencode-model-forecast/benchmarks.json`. The same flow exposes a Quarantine
 * sub-menu so the user can manually block a model or a whole provider
 * group without leaving the TUI.
 */

import type { BenchmarkEntry } from "./benchmark-registry.js";
import { getBenchmarkRegistry } from "./benchmark-registry.js";
import { createComponent } from "solid-js/web";
import {
  loadConfigState,
  saveConfigState,
  validateAvailability,
  validateBenchmarkScore,
  validateConfidence,
  validateCost,
  validateDate,
  validatePositiveInt,
} from "./cli-config.js";
import {
  defaultQuarantineFilePath,
  getSharedQuarantineStore,
} from "./quarantine.js";
import {
  loadQuarantineFile,
  runQuarantine,
} from "./cli-quarantine.js";
import { resolveQuarantineTarget } from "./model-groups.js";
import {
  buildQuarantineToast,
  formatExpiry,
  modelOptions as registryModelOptions,
  providerGroupOptions,
  quarantineMenuOptions,
  validateHours,
} from "./tui-quarantine.js";

type TuiDialogSelectOption<Value = string> = {
  title: string;
  value: Value;
  description?: string;
  category?: string;
  disabled?: boolean;
};

type TuiApi = {
  lifecycle?: {
    onDispose: (dispose: () => void) => void;
  };
  keymap?: {
    registerLayer: (layer: {
      mode?: string;
      priority?: number;
      commands: Array<{
        name: string;
        title: string;
        desc?: string;
        category?: string;
        namespace?: string;
        nargs?: string;
        slashName?: string;
        slashAliases?: string[];
        run: () => boolean | void | Promise<boolean | void>;
      }>;
      bindings?: Array<{
        key: string;
        cmd: string;
        desc?: string;
      }>;
    }) => () => void;
  };
  command?: {
    register: (cb: () => Array<{
      title: string;
      value: string;
      description?: string;
      keybind?: string;
      slash?: { name: string; aliases?: string[] };
      onSelect?: () => void | Promise<void>;
    }>) => () => void;
  };
  state: {
    path: {
      directory: string;
    };
  };
  ui: {
    DialogSelect: <Value = string>(props: {
      title: string;
      options: TuiDialogSelectOption<Value>[];
      onSelect?: (option: TuiDialogSelectOption<Value>) => void;
      placeholder?: string;
      current?: Value;
    }) => unknown;
    DialogPrompt: (props: {
      title: string;
      placeholder?: string;
      value?: string;
      onConfirm?: (value: string) => void;
      onCancel?: () => void;
    }) => unknown;
    DialogConfirm: (props: {
      title: string;
      message: string;
      onConfirm?: () => void;
      onCancel?: () => void;
    }) => unknown;
    DialogAlert: (props: {
      title: string;
      message: string;
      onConfirm?: () => void;
    }) => unknown;
    dialog: {
      replace: (render: () => unknown, onClose?: () => void) => void;
      clear: () => void;
    };
    toast: (input: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string }) => void;
  };
};

interface ForecastConfigTuiOptions {
  shortcut?: string;
  shortcuts?: string[];
}

const DEFAULT_SHORTCUTS = ["alt+g", "super+g"];

function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s*\+\s*/g, "+").replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function resolveShortcuts(options?: ForecastConfigTuiOptions): string[] {
  const explicit = Array.isArray(options?.shortcuts)
    ? options.shortcuts.map(normalizeShortcut).filter((value): value is string => Boolean(value))
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];
  const shortcut = normalizeShortcut(options?.shortcut);
  return shortcut ? [shortcut] : DEFAULT_SHORTCUTS;
}

function renderSelect(api: TuiApi, props: Parameters<TuiApi["ui"]["DialogSelect"]>[0]): unknown {
  return createComponent(api.ui.DialogSelect as never, props as never);
}

function renderPrompt(api: TuiApi, props: Parameters<TuiApi["ui"]["DialogPrompt"]>[0]): unknown {
  return createComponent(api.ui.DialogPrompt as never, props as never);
}

function renderConfirm(api: TuiApi, props: Parameters<TuiApi["ui"]["DialogConfirm"]>[0]): unknown {
  return createComponent(api.ui.DialogConfirm as never, props as never);
}

function renderAlert(api: TuiApi, props: Parameters<TuiApi["ui"]["DialogAlert"]>[0]): unknown {
  return createComponent(api.ui.DialogAlert as never, props as never);
}

interface ConfigDialogSession {
  rootDir: string;
  map: Map<string, BenchmarkEntry>;
  dirty: boolean;
}

function modelOptions(session: ConfigDialogSession): TuiDialogSelectOption[] {
  const options = [...session.map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({
      title: entry.key,
      value: entry.key,
      description: `${entry.availability} · conf=${entry.confidence.toFixed(2)} · ${entry.source}`,
      category: entry.key.split("/")[0] ?? "other",
    }));
  return [
    { title: "Add model", value: "__add__", description: "Create a new model entry" },
    { title: "Quarantine", value: "__quarantine__", description: "Block a model or provider group (immediate effect)" },
    { title: "Save changes", value: "__save__", description: "Persist global benchmarks config", disabled: !session.dirty },
    ...options,
  ];
}

function showAlert(api: TuiApi, title: string, message: string, next?: () => void): void {
  api.ui.dialog.replace(
    () => renderAlert(api, {
      title,
      message,
      onConfirm: () => {
        if (next) next();
        else api.ui.dialog.clear();
      },
    }),
  );
}

function showRootMenu(api: TuiApi, session: ConfigDialogSession): void {
  api.ui.dialog.replace(() => renderSelect(api, {
    title: "Forecast Config",
    placeholder: "Choose a model or an action",
    options: modelOptions(session),
    onSelect: (option) => {
      if (option.value === "__save__") {
        void saveSession(api, session);
        return;
      }
      if (option.value === "__add__") {
        promptForNewModel(api, session);
        return;
      }
      if (option.value === "__quarantine__") {
        showQuarantineMenu(api, session);
        return;
      }
      showModelMenu(api, session, String(option.value));
    },
  }));
}

async function saveSession(api: TuiApi, session: ConfigDialogSession): Promise<void> {
  try {
    const outPath = await saveConfigState(session.rootDir, session.map);
    session.dirty = false;
    api.ui.toast({ variant: "success", message: `Saved to ${outPath}` });
    showRootMenu(api, session);
  } catch (err) {
    showAlert(api, "Save failed", err instanceof Error ? err.message : String(err), () => showRootMenu(api, session));
  }
}

function promptForNewModel(api: TuiApi, session: ConfigDialogSession): void {
  api.ui.dialog.replace(() => renderPrompt(api, {
    title: "Add model",
    placeholder: "provider/model",
    onConfirm: (value) => {
      const key = value.trim();
      if (key.length === 0) {
        showAlert(api, "Invalid key", "provider/model is required", () => promptForNewModel(api, session));
        return;
      }
      if (session.map.has(key)) {
        showAlert(api, "Duplicate key", `${key} already exists`, () => promptForNewModel(api, session));
        return;
      }
      session.map.set(key, {
        key,
        benchmarks: {},
        availability: "available",
        source: "interactive-config",
        date: new Date().toISOString().slice(0, 10),
        confidence: 0.7,
      });
      session.dirty = true;
      showModelMenu(api, session, key);
    },
    onCancel: () => showRootMenu(api, session),
  }));
}

function showModelMenu(api: TuiApi, session: ConfigDialogSession, key: string): void {
  const entry = session.map.get(key);
  if (!entry) {
    showAlert(api, "Missing model", key, () => showRootMenu(api, session));
    return;
  }
  const options: TuiDialogSelectOption[] = [
    { title: `Availability: ${entry.availability}`, value: "availability" },
    { title: `Source: ${entry.source}`, value: "source" },
    { title: `Date: ${entry.date}`, value: "date" },
    { title: `Confidence: ${entry.confidence}`, value: "confidence" },
    { title: `Pricing`, value: "pricing", description: `input=${entry.inputCost ?? "-"} output=${entry.outputCost ?? "-"}` },
    { title: `Context window: ${entry.contextWindow ?? "-"}`, value: "contextWindow" },
    { title: `Max output: ${entry.maxOutput ?? "-"}`, value: "maxOutput" },
    { title: `Add or edit benchmark`, value: "benchmark" },
    { title: "Remove model", value: "remove", description: "Delete this global config entry" },
    { title: "Back", value: "back" },
  ];

  api.ui.dialog.replace(() => renderSelect(api, {
    title: `Edit ${key}`,
    options,
    onSelect: (option) => {
      switch (String(option.value)) {
        case "availability":
          promptAvailability(api, session, key);
          return;
        case "source":
          promptTextField(api, session, key, "Source", entry.source, (value) => {
            entry.source = value;
          });
          return;
        case "date":
          promptValidated(api, session, key, "Date", entry.date, validateDate, (value) => {
            entry.date = value as string;
          });
          return;
        case "confidence":
          promptValidated(api, session, key, "Confidence", String(entry.confidence), validateConfidence, (value) => {
            entry.confidence = value as number;
          });
          return;
        case "pricing":
          promptPricingField(api, session, key);
          return;
        case "contextWindow":
          promptValidated(api, session, key, "Context window", String(entry.contextWindow ?? ""), validatePositiveInt, (value) => {
            entry.contextWindow = value as number;
          });
          return;
        case "maxOutput":
          promptValidated(api, session, key, "Max output", String(entry.maxOutput ?? ""), validatePositiveInt, (value) => {
            entry.maxOutput = value as number;
          });
          return;
        case "benchmark":
          promptBenchmark(api, session, key);
          return;
        case "remove":
          confirmRemove(api, session, key);
          return;
        default:
          showRootMenu(api, session);
      }
    },
  }));
}

function promptAvailability(api: TuiApi, session: ConfigDialogSession, key: string): void {
  api.ui.dialog.replace(() => renderSelect(api, {
    title: `Availability for ${key}`,
    options: [
      { title: "available", value: "available" },
      { title: "unknown", value: "unknown" },
      { title: "unavailable", value: "unavailable" },
    ],
    onSelect: (option) => {
      const result = validateAvailability(option.value);
      if (!result.ok) {
        showAlert(api, "Invalid availability", result.reason, () => promptAvailability(api, session, key));
        return;
      }
      const entry = session.map.get(key);
      if (!entry) return;
      entry.availability = result.value as BenchmarkEntry["availability"];
      session.dirty = true;
      showModelMenu(api, session, key);
    },
  }));
}

function promptTextField(
  api: TuiApi,
  session: ConfigDialogSession,
  key: string,
  title: string,
  value: string,
  apply: (value: string) => void,
): void {
  api.ui.dialog.replace(() => renderPrompt(api, {
    title,
    value,
    onConfirm: (next) => {
      apply(next);
      session.dirty = true;
      showModelMenu(api, session, key);
    },
    onCancel: () => showModelMenu(api, session, key),
  }));
}

function promptValidated(
  api: TuiApi,
  session: ConfigDialogSession,
  key: string,
  title: string,
  value: string,
  validate: (value: string) => { ok: true; value: string | number } | { ok: false; reason: string },
  apply: (value: string | number) => void,
): void {
  api.ui.dialog.replace(() => renderPrompt(api, {
    title,
    value,
    onConfirm: (next) => {
      const result = validate(next);
      if (!result.ok) {
        showAlert(api, `Invalid ${title.toLowerCase()}`, result.reason, () => promptValidated(api, session, key, title, value, validate, apply));
        return;
      }
      apply(result.value);
      session.dirty = true;
      showModelMenu(api, session, key);
    },
    onCancel: () => showModelMenu(api, session, key),
  }));
}

function promptPricingField(api: TuiApi, session: ConfigDialogSession, key: string): void {
  api.ui.dialog.replace(() => renderSelect(api, {
    title: `Pricing for ${key}`,
    options: [
      { title: "Input cost", value: "inputCost" },
      { title: "Output cost", value: "outputCost" },
      { title: "Cache-hit cost", value: "cacheHitCost" },
      { title: "Back", value: "back" },
    ],
    onSelect: (option) => {
      if (option.value === "back") {
        showModelMenu(api, session, key);
        return;
      }
      const entry = session.map.get(key);
      if (!entry) return;
      const field = String(option.value) as "inputCost" | "outputCost" | "cacheHitCost";
      promptValidated(api, session, key, field, String(entry[field] ?? ""), validateCost, (value) => {
        entry[field] = value as number;
      });
    },
  }));
}

function promptBenchmark(api: TuiApi, session: ConfigDialogSession, key: string): void {
  api.ui.dialog.replace(() => renderPrompt(api, {
    title: `Benchmark name for ${key}`,
    placeholder: "e.g. mmlu, swe-bench",
    onConfirm: (benchmarkName) => {
      const entry = session.map.get(key);
      if (!entry) return;
      const trimmed = benchmarkName.trim();
      if (trimmed.length === 0) {
        showAlert(api, "Invalid benchmark name", "Name is required", () => promptBenchmark(api, session, key));
        return;
      }
      api.ui.dialog.replace(() => renderPrompt(api, {
        title: `Benchmark score for ${trimmed}`,
        placeholder: "0..1",
        value: entry.benchmarks[trimmed] === undefined ? "" : String(entry.benchmarks[trimmed]),
        onConfirm: (scoreValue) => {
          const result = validateBenchmarkScore(scoreValue);
          if (!result.ok) {
            showAlert(api, "Invalid benchmark score", result.reason, () => promptBenchmark(api, session, key));
            return;
          }
          entry.benchmarks[trimmed] = result.value as number;
          session.dirty = true;
          showModelMenu(api, session, key);
        },
        onCancel: () => showModelMenu(api, session, key),
      }));
    },
    onCancel: () => showModelMenu(api, session, key),
  }));
}

function confirmRemove(api: TuiApi, session: ConfigDialogSession, key: string): void {
  api.ui.dialog.replace(() => renderConfirm(api, {
    title: `Remove ${key}?`,
    message: "This removes the entry from the global benchmarks config.",
    onConfirm: () => {
      session.map.delete(key);
      session.dirty = true;
      showRootMenu(api, session);
    },
    onCancel: () => showModelMenu(api, session, key),
  }));
}

/* ---------------------------------------------------------------------- *
 * Quarantine flow — manual block of a single model or a whole provider
 * group. Mutations apply IMMEDIATELY to the running plugin (via the
 * shared cross-bundle accessor) AND persist to
 * `~/.cache/opencode-model-forecast/quarantine.json` so they survive
 * restart.
 * ---------------------------------------------------------------------- */

function showQuarantineMenu(api: TuiApi, session: ConfigDialogSession): void {
  api.ui.dialog.replace(() => renderSelect(api, {
    title: "Quarantine",
    placeholder: "Add or view quarantines",
    options: quarantineMenuOptions(),
    onSelect: (option) => {
      const value = String(option.value);
      if (value === "back") {
        showRootMenu(api, session);
        return;
      }
      if (value === "add") {
        promptQuarantineTarget(api, session);
        return;
      }
      if (value === "view") {
        showQuarantineList(api, session);
        return;
      }
    },
  }));
}

function promptQuarantineTarget(api: TuiApi, session: ConfigDialogSession): void {
  const groupOpts = providerGroupOptions();
  const singleOpts = registryModelOptions(getBenchmarkRegistry());
  const options: TuiDialogSelectOption[] = [
    ...groupOpts,
    ...singleOpts,
    { title: "Back", value: "__back__" },
  ];
  api.ui.dialog.replace(() => renderSelect(api, {
    title: "Quarantine target",
    placeholder: "Pick a provider group or a single model",
    options,
    onSelect: (option) => {
      const value = String(option.value);
      if (value === "__back__") {
        showQuarantineMenu(api, session);
        return;
      }
      promptQuarantineDuration(api, session, value);
    },
  }));
}

function promptQuarantineDuration(
  api: TuiApi,
  session: ConfigDialogSession,
  target: string,
): void {
  api.ui.dialog.replace(() => renderSelect(api, {
    title: `Quarantine ${target}`,
    options: [
      { title: "Permanent", value: "permanent", description: "Block until manually released" },
      { title: "TTL (hours)", value: "ttl", description: "Block for a custom number of hours" },
      { title: "Back", value: "__back__" },
    ],
    onSelect: (option) => {
      const value = String(option.value);
      if (value === "__back__") {
        promptQuarantineTarget(api, session);
        return;
      }
      if (value === "permanent") {
        applyQuarantine(api, session, target, { permanent: true });
        return;
      }
      promptQuarantineHours(api, session, target);
    },
  }));
}

function promptQuarantineHours(
  api: TuiApi,
  session: ConfigDialogSession,
  target: string,
): void {
  api.ui.dialog.replace(() => renderPrompt(api, {
    title: `Quarantine ${target}`,
    placeholder: "Number of hours (1 - 8760)",
    onConfirm: (value) => {
      const result = validateHours(value);
      if (!result.ok) {
        showAlert(api, "Invalid hours", result.reason, () =>
          promptQuarantineHours(api, session, target),
        );
        return;
      }
      applyQuarantine(api, session, target, { permanent: false, ttlHours: result.value as number });
    },
    onCancel: () => promptQuarantineDuration(api, session, target),
  }));
}

async function applyQuarantine(
  api: TuiApi,
  session: ConfigDialogSession,
  target: string,
  opts: { permanent: boolean; ttlHours?: number },
): Promise<void> {
  const expanded = resolveQuarantineTarget(target);
  if (expanded.length === 0) {
    showAlert(api, "Unknown target", `${target} did not match any model or provider group`, () =>
      promptQuarantineTarget(api, session),
    );
    return;
  }
  const store = getSharedQuarantineStore();
  const reason = "manual-tui";
  const nowMs = Date.now();
  const ttlMs = opts.permanent ? Infinity : (opts.ttlHours ?? 24) * 3_600_000;
  try {
    if (store !== null) {
      store.addManual(target, reason, opts.permanent
        ? { permanent: true }
        : { ttlMs });
      await store.saveToFile(defaultQuarantineFilePath());
    } else {
      const result = await runQuarantine({
        ok: true,
        action: "add",
        target,
        permanent: opts.permanent,
        ...(opts.ttlHours !== undefined ? { ttlHours: opts.ttlHours } : {}),
        reason,
      });
      if (!result.ok) throw new Error(result.error);
    }
  } catch (err) {
    showAlert(api, "Save failed", err instanceof Error ? err.message : String(err), () =>
      showRootMenu(api, session),
    );
    return;
  }

  const expiresAt = opts.permanent ? Infinity : nowMs + ttlMs;
  const toast = buildQuarantineToast({
    target,
    expandedCount: expanded.length,
    permanent: opts.permanent,
    expiresAt,
  });
  api.ui.toast(toast);
  showAlert(
    api,
    "Quarantined",
    `${toast.message}\nFile: ${defaultQuarantineFilePath()}\nExpires: ${formatExpiry(expiresAt)}\nBackend reload: automatic when plugin is in auto mode`,
    () => showQuarantineMenu(api, session),
  );
}

function showQuarantineList(api: TuiApi, session: ConfigDialogSession): void {
  const store = getSharedQuarantineStore();
  if (store === null) {
    void loadQuarantineFile(defaultQuarantineFilePath(), Date.now()).then((entries) => {
      showQuarantineEntries(api, session, entries);
    });
    return;
  }
  showQuarantineEntries(api, session, store.snapshot());
}

function showQuarantineEntries(
  api: TuiApi,
  session: ConfigDialogSession,
  entries: Array<{ model: string; reason: string; expiresAt: number; errorType?: string }>,
): void {
  if (entries.length === 0) {
    showAlert(api, "No quarantines", "The quarantine store is empty.", () =>
      showQuarantineMenu(api, session),
    );
    return;
  }
  const options: TuiDialogSelectOption[] = entries
    .slice()
    .sort((a, b) => a.model.localeCompare(b.model))
    .map((entry) => ({
      title: entry.model,
      value: entry.model,
      // model-fallback-error-classification (SDD change) — Slice 1, task
      // 10. Display-only: appended only when present so legacy entries
      // (no `errorType`) render exactly as before.
      description:
        entry.errorType !== undefined
          ? `${entry.reason} · ${entry.errorType} · ${formatExpiry(entry.expiresAt)}`
          : `${entry.reason} · ${formatExpiry(entry.expiresAt)}`,
    }));
  options.push({ title: "Back", value: "__back__" });
  api.ui.dialog.replace(() => renderSelect(api, {
    title: "Quarantined models — pick one to release",
    options,
    onSelect: (option) => {
      const value = String(option.value);
      if (value === "__back__") {
        showQuarantineMenu(api, session);
        return;
      }
      confirmRelease(api, session, value);
    },
  }));
}

function confirmRelease(api: TuiApi, session: ConfigDialogSession, target: string): void {
  api.ui.dialog.replace(() => renderConfirm(api, {
    title: `Release ${target}?`,
    message: "Removes the model from the quarantine store and persists the change.",
    onConfirm: async () => {
      const store = getSharedQuarantineStore();
      try {
        if (store !== null) {
        store.release(target);
          await store.saveToFile(defaultQuarantineFilePath());
        } else {
          const result = await runQuarantine({
            ok: true,
            action: "release",
            target,
            permanent: false,
          });
          if (!result.ok) throw new Error(result.error);
        }
      } catch (err) {
        api.ui.toast({
          variant: "warning",
          message: `Release failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      api.ui.toast({ variant: "success", message: `Released ${target}` });
      showQuarantineList(api, session);
    },
    onCancel: () => showQuarantineList(api, session),
  }));
}

async function openForecastConfig(api: TuiApi): Promise<void> {
  const session: ConfigDialogSession = {
    rootDir: api.state.path.directory,
    map: await loadConfigState(api.state.path.directory),
    dirty: false,
  };
  showRootMenu(api, session);
}

async function openForecastConfigSafely(api: TuiApi): Promise<boolean> {
  try {
    await openForecastConfig(api);
  } catch (err) {
    api.ui.toast({
      variant: "error",
      title: "Forecast Config failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

export async function tui(api: TuiApi, options?: ForecastConfigTuiOptions): Promise<void> {
  let registered = false;
  const shortcuts = resolveShortcuts(options);

  if (api.keymap && typeof api.keymap.registerLayer === "function") {
    const dispose = api.keymap.registerLayer({
      mode: "base",
      priority: 100,
      commands: [
        {
          name: ":forecast-config",
          title: "Forecast Config",
          desc: "Edit model forecast configuration",
          category: "Plugin",
          namespace: "palette",
          nargs: "0",
          slashName: "forecast-config",
          slashAliases: ["mf-config"],
          run: async () => {
            return openForecastConfigSafely(api);
          },
        },
      ],
      bindings: shortcuts.map((key) => ({ key, cmd: ":forecast-config", desc: "Open Forecast Config" })),
    });
    api.lifecycle?.onDispose(dispose);
    registered = true;
  }

  if (api.command && typeof api.command.register === "function") {
    const dispose = api.command.register(() => [
      {
        title: "Forecast Config",
        value: "forecast-config",
        description: "Edit model availability, benchmarks, and pricing",
        keybind: shortcuts.join(", "),
        slash: { name: "forecast-config", aliases: ["mf-config"] },
        onSelect: async () => {
          await openForecastConfigSafely(api);
        },
      },
    ]);
    api.lifecycle?.onDispose(dispose);
    registered = true;
  }

  if (registered) return;

  // Graceful degrade: command APIs absent in this runtime.
  api.ui.toast({
    variant: "warning",
    message: "forecast-config command unavailable in this OpenCode runtime",
  });
}

export default { id: "aabadin.model-forecast.tui", tui };
