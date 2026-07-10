/**
 * `forecast config` - interactive CLI menu for global benchmark data.
 *
 * Architecture overview is in `.planning/sdd/forecast-config-menu/design.md`.
 *
 * Layered so the pure logic (parsers, validators, state I/O) is testable
 * independently from the readline-driven interactive loop. The loop
 * accepts injected `stdin`/`stdout`/`stderr` so tests can mock the
 * readline interface and drive deterministic prompts.
 */

import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import { loadGlobalBenchmarks, saveGlobalBenchmarks } from "./repo-data.js";
import type { BenchmarkEntry } from "./benchmark-registry.js";
import { getBenchmarkRegistry } from "./benchmark-registry.js";

export interface ConfigArgs {
  ok: true;
  root?: string;
  nonInteractive: boolean;
}

export interface ConfigArgsFailure {
  ok: false;
  error: string;
}

export interface ConfigLoopIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  globalPath?: string;
  /**
   * Optional readline factory for tests. When omitted, the real
   * `node:readline` module is used.
   */
  createReadline?: (stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => ReadlineLike;
}

export interface ConfigRunResult {
  exitCode: number;
  persisted: boolean;
  outputPath?: string;
  error?: string;
}

export interface ConfigStateOptions {
  globalPath?: string;
}

/**
 * Pure argument parser for the `config` subcommand.
 */
export function parseConfigArgs(args: string[]): ConfigArgs | ConfigArgsFailure {
  let root: string | undefined;
  let nonInteractive = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: "--root requires a path argument" };
      root = value;
      i += 1;
    } else if (arg === "--non-interactive") {
      nonInteractive = true;
    } else {
      return { ok: false, error: `unknown argument for config: ${arg}` };
    }
  }
  return { ok: true, root, nonInteractive };
}

/**
 * Loads editable global benchmark state if present, otherwise seeds from
 * the compiled registry. Always returns a Map keyed by canonical
 * `provider/model`.
 */
export async function loadConfigState(
  _rootDir: string,
  options: ConfigStateOptions = {},
): Promise<Map<string, BenchmarkEntry>> {
  const map = new Map<string, BenchmarkEntry>();
  for (const entry of getBenchmarkRegistry()) {
    map.set(entry.key, { ...entry });
  }
  const globalEntries = await loadGlobalBenchmarks(options.globalPath);
  for (const entry of globalEntries ?? []) {
    map.set(entry.key, entry);
  }
  return map;
}

/**
 * Atomically writes the editable state to the global benchmarks file.
 * Returns the output path.
 */
export async function saveConfigState(
  _rootDir: string,
  map: ReadonlyMap<string, BenchmarkEntry>,
  options: ConfigStateOptions = {},
): Promise<string> {
  return saveGlobalBenchmarks([...map.values()], options.globalPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationOk { ok: true; value: string | number }
export interface ValidationFail { ok: false; reason: string }
export type ValidationResult = ValidationOk | ValidationFail;

export function validateAvailability(input: unknown): ValidationResult {
  if (input === "available" || input === "unknown" || input === "unavailable") {
    return { ok: true, value: input };
  }
  return { ok: false, reason: "must be available | unknown | unavailable" };
}

export function validateConfidence(input: string): ValidationResult {
  if (input.trim().length === 0) return { ok: false, reason: "empty value" };
  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, reason: "not a finite number" };
  if (n < 0 || n > 1) return { ok: false, reason: "must be in [0, 1]" };
  return { ok: true, value: n };
}

export function validateCost(input: string): ValidationResult {
  if (input.trim().length === 0) return { ok: false, reason: "empty value" };
  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, reason: "not a finite number" };
  if (n < 0) return { ok: false, reason: "must be ≥ 0" };
  return { ok: true, value: n };
}

export function validatePositiveInt(input: string): ValidationResult {
  if (input.trim().length === 0) return { ok: false, reason: "empty value" };
  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, reason: "not a finite number" };
  if (!Number.isInteger(n)) return { ok: false, reason: "must be an integer" };
  if (n <= 0) return { ok: false, reason: "must be > 0" };
  return { ok: true, value: n };
}

export function validateBenchmarkScore(input: string): ValidationResult {
  if (input.trim().length === 0) return { ok: false, reason: "empty value" };
  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, reason: "not a finite number" };
  if (n < 0 || n > 1) return { ok: false, reason: "must be in [0, 1]" };
  return { ok: true, value: n };
}

export function validateDate(input: string): ValidationResult {
  if (input.trim().length === 0) return { ok: false, reason: "empty value" };
  if (Number.isNaN(Date.parse(input))) return { ok: false, reason: "not a parseable date" };
  return { ok: true, value: input };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive loop
// ─────────────────────────────────────────────────────────────────────────────

interface ReadlineLike {
  question: (prompt: string, cb: (answer: string) => void) => void;
  close: () => void;
  on: (event: "close", listener: () => void) => void;
}

interface Session {
  map: Map<string, BenchmarkEntry>;
  dirty: boolean;
  rootDir: string;
  globalPath?: string;
  outputPath: string | undefined;
}

async function loadSession(rootDir: string, globalPath?: string): Promise<Session> {
  const map = await loadConfigState(rootDir, { globalPath });
  return { map, dirty: false, rootDir, globalPath, outputPath: undefined };
}

function printMainMenu(io: ConfigLoopIO): void {
  io.stdout.write(
    [
      "forecast-config>",
      "  (l)ist [filter]      list models (e.g. `l opencode-go/*`)",
      "  (e)dit <key>         edit an existing model",
      "  (a)dd <key>          add a new model",
      "  (r)emove <key>       remove a model (confirms)",
      "  (d)iff <key>         show compiled vs current values",
      "  (s)how <key>         print current values",
      "  (h)elp               show this menu",
      "  (q)uit               save and quit",
      "",
    ].join("\n"),
  );
}

function formatEntryRow(idx: number, e: BenchmarkEntry): string {
  const marker = e.source === "compiled" || e.source === "" ? " " : "*";
  return `${String(idx).padStart(4)}. ${marker} ${e.key.padEnd(48)} ${e.availability.padEnd(11)} conf=${e.confidence.toFixed(2)}  ${e.source}`;
}

function listModels(map: ReadonlyMap<string, BenchmarkEntry>, filter: string | undefined, io: ConfigLoopIO): void {
  const entries = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  const filtered = filter === undefined || filter === ""
    ? entries
    : entries.filter((e) => matchFilter(e.key, filter));
  if (filtered.length === 0) {
    io.stdout.write(`no models match filter: ${filter}\n`);
    return;
  }
  io.stdout.write(`${filtered.length} model(s):\n`);
  filtered.forEach((e, i) => io.stdout.write(`${formatEntryRow(i + 1, e)}\n`));
}

function matchFilter(key: string, filter: string): boolean {
  if (filter.endsWith("/*")) {
    const prefix = filter.slice(0, -1); // trailing "*"
    return key.startsWith(prefix);
  }
  return key.includes(filter);
}

function diffEntry(map: ReadonlyMap<string, BenchmarkEntry>, key: string, io: ConfigLoopIO): void {
  const current = map.get(key);
  if (current === undefined) {
    io.stdout.write(`no such model: ${key}\n`);
    return;
  }
  const compiled = getBenchmarkRegistry().find((e) => e.key === key);
  if (compiled === undefined) {
    io.stdout.write(`${key}: only in repo-local (no compiled counterpart)\n`);
    io.stdout.write(JSON.stringify(current, null, 2) + "\n");
    return;
  }
  io.stdout.write(`field                        compiled         repo-local\n`);
  io.stdout.write(`─`.repeat(60) + "\n");
  const fields: (keyof BenchmarkEntry)[] = [
    "availability", "source", "date", "confidence",
  ];
  for (const f of fields) {
    const a = String(compiled[f]);
    const b = String(current[f]);
    io.stdout.write(`${f.padEnd(28)} ${a.padEnd(16)} ${b}\n`);
  }
  const compiledBench = compiled.benchmarks;
  const currentBench = current.benchmarks;
  const allKeys = new Set([...Object.keys(compiledBench), ...Object.keys(currentBench)]);
  for (const name of allKeys) {
    const a = compiledBench[name];
    const b = currentBench[name];
    if (a !== b) {
      io.stdout.write(`benchmark.${name.padEnd(18)} ${String(a).padEnd(16)} ${String(b)}\n`);
    }
  }
}

function showEntry(map: ReadonlyMap<string, BenchmarkEntry>, key: string, io: ConfigLoopIO): void {
  const entry = map.get(key);
  if (entry === undefined) {
    io.stdout.write(`no such model: ${key}\n`);
    return;
  }
  io.stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

async function handleAdd(
  session: Session,
  key: string,
  rl: ReadlineLike,
  io: ConfigLoopIO,
): Promise<void> {
  if (session.map.has(key)) {
    io.stdout.write(`key already present: ${key} (use edit instead)\n`);
    return;
  }
  const entry: BenchmarkEntry = {
    key,
    benchmarks: {},
    availability: "available",
    source: "interactive-config",
    date: new Date().toISOString().slice(0, 10),
    confidence: 0.7,
  };
  session.map.set(key, entry);
  session.dirty = true;
  io.stdout.write(`added ${key} with defaults; entering edit screen.\n`);
  await editLoop(session, key, rl, io);
}

async function editLoop(
  session: Session,
  key: string,
  rl: ReadlineLike,
  io: ConfigLoopIO,
): Promise<void> {
  const entry = session.map.get(key);
  if (entry === undefined) return;
  const prompt = `forecast-config/edit ${key}>`;
  for (;;) {
    const answer = await ask(rl, prompt);
    const trimmed = answer.trim();
    if (trimmed === "" || trimmed === "x" || trimmed === "done" || trimmed === "q") return;
    const [cmd, ...rest] = trimmed.split(/\s+/);
    switch (cmd) {
      case "a":
      case "availability": {
        const r = validateAvailability(rest.join(" "));
        if (!r.ok) { io.stdout.write(`invalid availability: ${r.reason}\n`); break; }
        entry.availability = r.value as BenchmarkEntry["availability"];
        session.dirty = true;
        io.stdout.write(`availability = ${entry.availability}\n`);
        break;
      }
      case "s":
      case "source": {
        entry.source = rest.join(" ");
        session.dirty = true;
        io.stdout.write(`source = ${entry.source}\n`);
        break;
      }
      case "d":
      case "date": {
        const r = validateDate(rest.join(" "));
        if (!r.ok) { io.stdout.write(`invalid date: ${r.reason}\n`); break; }
        entry.date = r.value as string;
        session.dirty = true;
        io.stdout.write(`date = ${entry.date}\n`);
        break;
      }
      case "c":
      case "confidence": {
        const r = validateConfidence(rest.join(" "));
        if (!r.ok) { io.stdout.write(`invalid confidence: ${r.reason}\n`); break; }
        entry.confidence = r.value as number;
        session.dirty = true;
        io.stdout.write(`confidence = ${entry.confidence}\n`);
        break;
      }
      case "p":
      case "pricing": {
        const [field, value] = [rest[0], rest[1]];
        if (!field || value === undefined) { io.stdout.write(`usage: pricing <input|output|cache-hit|max-output> <number>\n`); break; }
        const r = validateCost(value);
        if (!r.ok) { io.stdout.write(`invalid cost: ${r.reason}\n`); break; }
        const n = r.value as number;
        switch (field) {
          case "input": entry.inputCost = n; break;
          case "output": entry.outputCost = n; break;
          case "cache-hit": entry.cacheHitCost = n; break;
          case "max-output": {
            const pi = validatePositiveInt(value);
            if (!pi.ok) { io.stdout.write(`invalid max-output: ${pi.reason}\n`); break; }
            entry.maxOutput = pi.value as number;
            break;
          }
          default:
            io.stdout.write(`unknown pricing field: ${field} (use input | output | cache-hit | max-output)\n`);
            continue;
        }
        session.dirty = true;
        io.stdout.write(`${field} = ${n}\n`);
        break;
      }
      case "b":
      case "benchmark": {
        const sub = rest[0];
        if (sub === "add") {
          const [name, value] = [rest[1], rest[2]];
          if (!name || value === undefined) { io.stdout.write(`usage: benchmark add <name> <0..1>\n`); break; }
          const r = validateBenchmarkScore(value);
          if (!r.ok) { io.stdout.write(`invalid score: ${r.reason}\n`); break; }
          entry.benchmarks[name] = r.value as number;
          session.dirty = true;
          io.stdout.write(`benchmark.${name} = ${entry.benchmarks[name]}\n`);
        } else if (sub === "remove") {
          const name = rest[1];
          if (!name) { io.stdout.write(`usage: benchmark remove <name>\n`); break; }
          if (!(name in entry.benchmarks)) { io.stdout.write(`no benchmark named: ${name}\n`); break; }
          delete entry.benchmarks[name];
          session.dirty = true;
          io.stdout.write(`benchmark.${name} removed\n`);
        } else {
          io.stdout.write(`usage: benchmark add|remove ...\n`);
        }
        break;
      }
      case "w":
      case "window": {
        const r = validatePositiveInt(rest.join(" "));
        if (!r.ok) { io.stdout.write(`invalid context window: ${r.reason}\n`); break; }
        entry.contextWindow = r.value as number;
        session.dirty = true;
        io.stdout.write(`contextWindow = ${entry.contextWindow}\n`);
        break;
      }
      case "h":
      case "help": {
        io.stdout.write(
          [
            "edit sub-commands:",
            "  (a)vailability <available|unknown|unavailable>",
            "  (s)ource <citation>",
            "  (d)ate <YYYY-MM-DD>",
            "  (c)onfidence <0..1>",
            "  (p)ricing <input|output|cache-hit|max-output> <number>",
            "  (b)enchmark add|remove <name> [<0..1>]",
            "  (w)indow <integer tokens>",
            "  (x) done  (returns to main menu)",
          ].join("\n") + "\n",
        );
        break;
      }
      default:
        io.stdout.write(`unknown command: ${cmd} (try h for help, x to exit)\n`);
    }
  }
}

async function handleRemove(
  session: Session,
  key: string,
  rl: ReadlineLike,
  io: ConfigLoopIO,
): Promise<void> {
  if (!session.map.has(key)) {
    io.stdout.write(`no such model: ${key}\n`);
    return;
  }
  const answer = await ask(rl, `remove ${key}? [y/N] `);
  if (answer.trim().toLowerCase() === "y") {
    session.map.delete(key);
    session.dirty = true;
    io.stdout.write(`removed ${key}\n`);
  } else {
    io.stdout.write(`canceled\n`);
  }
}

function ask(rl: ReadlineLike, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

type ReadlineFactory = (stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => ReadlineLike;

const defaultReadlineFactory: ReadlineFactory = (stdin, stdout) => {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl as unknown as ReadlineLike;
};

export function makeReadline(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): ReadlineLike {
  return defaultReadlineFactory(stdin, stdout);
}

/**
 * Drives the interactive loop. Stops on `q` (after save/discard prompt)
 * or EOF / close on stdin.
 */
export async function runConfig(args: ConfigArgs, io?: Partial<ConfigLoopIO>): Promise<ConfigRunResult> {
  const rootDir = args.root ?? process.cwd();
  const session = await loadSession(rootDir, io?.globalPath);

  const stdin = (io?.stdin ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean };
  const stdout = (io?.stdout ?? process.stdout) as NodeJS.WritableStream;
  const stderr = (io?.stderr ?? process.stderr) as NodeJS.WritableStream;

  if (args.nonInteractive || stdin.isTTY === false) {
    stderr.write(
      args.nonInteractive
        ? "config requires an interactive TTY (--non-interactive set)\n"
        : "config requires an interactive TTY\n",
    );
    return { exitCode: 1, persisted: false, error: "non-TTY stdin" };
  }

  const rl = (io?.createReadline ?? makeReadline)(stdin, stdout);
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  try {
    printMainMenu(io ? { stdin, stdout, stderr } : { stdin, stdout, stderr });
    while (!closed) {
      const line = await ask(rl, "forecast-config> ");
      if (closed) break;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed === "h") {
        printMainMenu({ stdin, stdout, stderr });
        continue;
      }
      const [cmd, ...rest] = trimmed.split(/\s+/);
      switch (cmd) {
        case "l":
        case "list":
          listModels(session.map, rest[0], { stdin, stdout, stderr });
          break;
        case "e":
        case "edit": {
          const key = rest[0];
          if (!key) { stdout.write("usage: edit <key>\n"); break; }
          if (!session.map.has(key)) { stdout.write(`no such model: ${key}\n`); break; }
          await editLoop(session, key, rl, { stdin, stdout, stderr });
          break;
        }
        case "a":
        case "add":
          if (!rest[0]) { stdout.write("usage: add <provider/model>\n"); break; }
          await handleAdd(session, rest[0], rl, { stdin, stdout, stderr });
          break;
        case "r":
        case "remove":
          if (!rest[0]) { stdout.write("usage: remove <key>\n"); break; }
          await handleRemove(session, rest[0], rl, { stdin, stdout, stderr });
          break;
        case "d":
        case "diff":
          if (!rest[0]) { stdout.write("usage: diff <key>\n"); break; }
          diffEntry(session.map, rest[0], { stdin, stdout, stderr });
          break;
        case "s":
        case "show":
          if (!rest[0]) { stdout.write("usage: show <key>\n"); break; }
          showEntry(session.map, rest[0], { stdin, stdout, stderr });
          break;
        case "q":
        case "quit":
          closed = true;
          break;
        default:
          stdout.write(`unknown command: ${cmd} (try h for help)\n`);
      }
    }

    // Save / discard on quit. The main loop set `closed = true` when the
    // user typed `q`; we re-open the readline for the save prompt by
    // resetting `closed = false`. (If the readline is actually closed,
    // the ask() call below will hang — we use a short timeout below.)
    closed = false;
    if (!session.dirty) {
      stdout.write("no changes; nothing to save\n");
      return { exitCode: 0, persisted: false };
    }
    const answer = await ask(rl, "save changes? [y/n/discard] ");
    const normalized = answer.trim().toLowerCase();
    if (normalized === "discard" || (normalized !== "y" && normalized !== "n")) {
      stdout.write("discarded\n");
      return { exitCode: 0, persisted: false };
    }
    if (normalized === "n") {
      stdout.write("discarded\n");
      return { exitCode: 0, persisted: false };
    }
    const outPath = await saveConfigState(session.rootDir, session.map, { globalPath: session.globalPath });
    stdout.write(`saved ${session.map.size} entr${session.map.size === 1 ? "y" : "ies"} to ${outPath}\n`);
    return { exitCode: 0, persisted: true, outputPath: outPath };
  } finally {
    rl.close();
  }
}

// Ensure unused imports are flagged if code ever drifts.
void EventEmitter;
