import {
  ATTEMPT_HARD_TIMEOUT_MS,
  CHILD_BIND_TIMEOUT_MS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_MS,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./recovery-policy.js";

export type WatchdogTimeoutKind = "child_bind" | "first_activity" | "inactivity" | "tool" | "hard";

export interface AttemptWatchdogTimeout {
  attemptID: string;
  kind: WatchdogTimeoutKind;
  generation: number;
}

export interface AttemptWatchdogTimeouts {
  childBindMs?: number;
  firstActivityMs?: number;
  inactivityMs?: number;
  toolMs?: number;
  hardMs?: number;
}

export interface AttemptWatchdogOptions {
  timeouts?: AttemptWatchdogTimeouts;
  onTimeout: (timeout: AttemptWatchdogTimeout) => void | Promise<void>;
}

interface Entry {
  generation: number;
  bound: boolean;
  activity: boolean;
  permissionPending: boolean;
  tools: number;
  timers: Partial<Record<WatchdogTimeoutKind, ReturnType<typeof setTimeout>>>;
}

export class AttemptWatchdog {
  private readonly entries = new Map<string, Entry>();
  private readonly timeouts: Required<AttemptWatchdogTimeouts>;

  constructor(private readonly options: AttemptWatchdogOptions) {
    const configured = options.timeouts ?? {};
    this.timeouts = {
      childBindMs: configured.childBindMs ?? CHILD_BIND_TIMEOUT_MS,
      firstActivityMs: configured.firstActivityMs ?? FIRST_ACTIVITY_TIMEOUT_MS,
      inactivityMs: configured.inactivityMs ?? INACTIVITY_TIMEOUT_MS,
      toolMs: configured.toolMs ?? TOOL_EXECUTION_TIMEOUT_MS,
      hardMs: configured.hardMs ?? ATTEMPT_HARD_TIMEOUT_MS,
    };
  }

  watch(attemptID: string, options: { waitingForBind?: boolean } = {}): void {
    this.stop(attemptID);
    const entry: Entry = { generation: (this.entries.get(attemptID)?.generation ?? 0) + 1, bound: false, activity: false, permissionPending: false, tools: 0, timers: {} };
    this.entries.set(attemptID, entry);
    if (options.waitingForBind) this.arm(attemptID, entry, "child_bind", this.timeouts.childBindMs);
    this.arm(attemptID, entry, "hard", this.timeouts.hardMs);
  }

  bind(attemptID: string): void {
    const entry = this.entry(attemptID);
    entry.bound = true;
    this.clear(entry, "child_bind");
    if (!entry.activity) this.arm(attemptID, entry, "first_activity", this.timeouts.firstActivityMs);
  }

  activity(attemptID: string): void {
    const entry = this.entry(attemptID);
    entry.activity = true;
    this.clear(entry, "first_activity");
    this.resetInactivity(attemptID, entry);
  }

  permissionPending(attemptID: string, pending: boolean): void {
    const entry = this.entry(attemptID);
    entry.permissionPending = pending;
    if (pending) this.clear(entry, "inactivity");
    else if (entry.activity) this.resetInactivity(attemptID, entry);
  }

  toolStart(attemptID: string): void {
    const entry = this.entry(attemptID);
    entry.tools += 1;
    this.clear(entry, "inactivity");
    this.arm(attemptID, entry, "tool", this.timeouts.toolMs);
  }

  toolEnd(attemptID: string): void {
    const entry = this.entry(attemptID);
    entry.tools = Math.max(0, entry.tools - 1);
    if (entry.tools === 0) {
      this.clear(entry, "tool");
      this.resetInactivity(attemptID, entry);
    }
  }

  stop(attemptID: string): void {
    const entry = this.entries.get(attemptID);
    if (entry === undefined) return;
    for (const timer of Object.values(entry.timers)) if (timer !== undefined) clearTimeout(timer);
    this.entries.delete(attemptID);
  }

  dispose(): void {
    for (const attemptID of this.entries.keys()) this.stop(attemptID);
  }

  private entry(attemptID: string): Entry {
    const entry = this.entries.get(attemptID);
    if (entry === undefined) throw new Error(`[model-forecast] watchdog is not watching '${attemptID}'`);
    return entry;
  }

  private resetInactivity(attemptID: string, entry: Entry): void {
    if (!entry.activity || entry.permissionPending || entry.tools > 0) return;
    this.arm(attemptID, entry, "inactivity", this.timeouts.inactivityMs);
  }

  private arm(attemptID: string, entry: Entry, kind: WatchdogTimeoutKind, ms: number): void {
    this.clear(entry, kind);
    const generation = entry.generation;
    const timer = setTimeout(() => {
      if (this.entries.get(attemptID) !== entry || entry.generation !== generation) return;
      void this.options.onTimeout({ attemptID, kind, generation });
    }, ms);
    timer.unref?.();
    entry.timers[kind] = timer;
  }

  private clear(entry: Entry, kind: WatchdogTimeoutKind): void {
    const timer = entry.timers[kind];
    if (timer !== undefined) clearTimeout(timer);
    delete entry.timers[kind];
  }
}
