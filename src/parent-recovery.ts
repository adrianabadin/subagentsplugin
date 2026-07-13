import { withDeadline } from "./async-deadline.js";
import type { AttemptCoordinator } from "./attempt-coordinator.js";
import type { OpenCodeSessionClient } from "./opencode-client.js";
import type { FallbackResult } from "./fallback.js";
import { ORIGINAL_SETTLEMENT_TIMEOUT_MS, PARENT_RECOVERY_MAX_RESULT_CHARS, RECOVERY_ENQUEUE_TIMEOUT_MS } from "./recovery-policy.js";

export interface ParentRecoveryOptions {
  coordinator: AttemptCoordinator;
  client?: OpenCodeSessionClient;
  settlementMs?: number;
  enqueueTimeoutMs?: number;
}

/** Ensures a failed task cannot leave its parent workflow blocked forever. */
export class ParentRecovery {
  readonly terminalErrors = new Map<string, string>();
  private readonly scheduled = new Set<string>();
  private readonly settlementMs: number;
  private readonly enqueueTimeoutMs: number;

  constructor(private readonly options: ParentRecoveryOptions) {
    this.settlementMs = options.settlementMs ?? ORIGINAL_SETTLEMENT_TIMEOUT_MS;
    this.enqueueTimeoutMs = options.enqueueTimeoutMs ?? RECOVERY_ENQUEUE_TIMEOUT_MS;
  }

  schedule(callID: string): void {
    if (this.scheduled.has(callID)) return;
    this.scheduled.add(callID);
    void this.run(callID);
  }

  noteAfter(callID: string): void {
    const task = this.options.coordinator.tasksByCallID.get(callID);
    if (task !== undefined) task.afterHookSeen = true;
  }

  private async run(callID: string): Promise<void> {
    await this.settle();
    if (!this.canRecover(callID)) return;
    await this.abortOriginalChild(callID);
    await this.settle();
    if (!this.canRecover(callID)) return;
    const task = this.options.coordinator.tasksByCallID.get(callID);
    if (task === undefined) return;
    if (await this.canAbortParent(task.parentSessionID, callID)) {
      await this.abort(task.parentSessionID, callID, task.originalAttemptID || task.parentSessionID, "parent_recovery");
    }
    await this.settle();
    if (!this.canRecover(callID)) return;
    await this.enqueue(callID);
  }

  private async settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.settlementMs));
  }

  private canRecover(callID: string): boolean {
    const task = this.options.coordinator.tasksByCallID.get(callID);
    return task !== undefined && !task.afterHookSeen && !task.userCancelled && !task.parentRecoveryEnqueued;
  }

  private async abortOriginalChild(callID: string): Promise<void> {
    for (const [sessionID, ownerCallID] of this.options.coordinator.callIDBySessionID) {
      if (ownerCallID !== callID) continue;
      const task = this.options.coordinator.tasksByCallID.get(callID);
      if (task !== undefined) await this.abort(sessionID, callID, task.originalAttemptID || sessionID, "second_abort");
      return;
    }
  }

  private async abort(sessionID: string, callID: string, attemptID: string, reason: string): Promise<void> {
    this.options.coordinator.registerPluginAbort({ sessionID, callID, attemptID, origin: "plugin-parent-recovery", reason });
    if (typeof this.options.client?.abort !== "function") return;
    try { await Promise.resolve(this.options.client.abort({ path: { id: sessionID } })); } catch { /* recovery continues */ }
  }

  private async canAbortParent(parentSessionID: string, callID: string): Promise<boolean> {
    const children = this.options.client?.children;
    if (typeof children !== "function") return true;
    try {
      const result = await Promise.resolve(children({ path: { id: parentSessionID } }));
      return !childrenOf(result).some((child) => {
        const info = child.info !== null && typeof child.info === "object" ? child.info as Record<string, unknown> : child;
        const id = typeof info.id === "string" ? info.id : "";
        return id.length > 0 && !this.isRelatedChild(id, callID) && isActiveChild(info);
      });
    } catch { return false; }
  }

  private isRelatedChild(sessionID: string, callID: string): boolean {
    return this.options.coordinator.callIDBySessionID.get(sessionID) === callID || this.options.coordinator.internalSessionCallIDs.get(sessionID) === callID;
  }

  private async enqueue(callID: string): Promise<void> {
    const task = this.options.coordinator.tasksByCallID.get(callID);
    if (task === undefined || task.userCancelled || task.afterHookSeen) return;
    const request = { path: { id: task.parentSessionID }, body: { parts: [{ type: "text", text: recoveryPrompt(task) }] } };
    const client = this.options.client;
    try {
      if (typeof client?.promptAsync === "function") {
        await withDeadline("parent recovery promptAsync", this.enqueueTimeoutMs, () => Promise.resolve(client.promptAsync!(request)));
      } else if (typeof client?.prompt === "function") {
        await withDeadline("parent recovery prompt", this.enqueueTimeoutMs, () => Promise.resolve(client.prompt!({ ...request, body: { ...request.body, noReply: true } })));
      } else {
        this.terminalErrors.set(callID, "OpenCode client has no prompt API for parent recovery");
        return;
      }
    } catch {
      if (task.userCancelled || task.afterHookSeen) return;
      if (typeof client?.prompt !== "function") { this.terminalErrors.set(callID, "Parent recovery prompt enqueue failed"); return; }
      try {
        await withDeadline("parent recovery prompt", this.enqueueTimeoutMs, () => Promise.resolve(client.prompt!({ ...request, body: { ...request.body, noReply: true } })));
      } catch { this.terminalErrors.set(callID, "Parent recovery prompt enqueue failed"); return; }
    }
    if (!task.userCancelled && !task.afterHookSeen) this.options.coordinator.markParentRecoveryEnqueued(callID);
  }
}

function childrenOf(result: unknown): Array<Record<string, unknown>> {
  const candidate = Array.isArray(result) ? result : result !== null && typeof result === "object" && Array.isArray((result as { data?: unknown }).data) ? (result as { data: unknown[] }).data : [];
  return candidate.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

function isActiveChild(child: Record<string, unknown>): boolean {
  const status = child.status;
  const raw = typeof status === "string" ? status : typeof (status as { type?: unknown } | undefined)?.type === "string" ? (status as { type: string }).type : "active";
  return !["idle", "completed", "closed", "deleted"].includes(raw.toLowerCase());
}

function recoveryPrompt(task: { recoveryToken: string; callID: string; originalModel: string; fallbackResult?: FallbackResult }): string {
  const fallback = task.fallbackResult;
  const result = truncateResult(fallback?.status === "success" || fallback?.status === "exhausted" ? fallback.output : "[model-forecast] FALLBACK EXHAUSTED: no fallback result was available.");
  const status = fallback?.status === "success" ? "success" : "exhausted";
  const model = fallback?.status === "success" ? fallback.model : "none";
  return `[MODEL_FORECAST_RECOVERY]\nrecovery_id: ${task.recoveryToken}\ncall_id: ${task.callID}\nfailed_model: ${task.originalModel}\nfallback_status: ${status}\nfallback_model: ${model}\n\nThe previous subagent execution stalled and was terminated by model-forecast.\n\nDo NOT re-run the same subtask.\n\nTreat the content delimited by MODEL_FORECAST_RESULT as the definitive result\nof the failed task and continue from the next step of your workflow.\n\n<MODEL_FORECAST_RESULT>\n${result}\n</MODEL_FORECAST_RESULT>`;
}

function truncateResult(value: string): string {
  if (value.length <= PARENT_RECOVERY_MAX_RESULT_CHARS) return value;
  let omitted = value.length - PARENT_RECOVERY_MAX_RESULT_CHARS;
  let marker = truncationMarker(omitted);
  let kept = value.slice(0, PARENT_RECOVERY_MAX_RESULT_CHARS - marker.length - 1);
  omitted = value.length - kept.length;
  marker = truncationMarker(omitted);
  kept = value.slice(0, PARENT_RECOVERY_MAX_RESULT_CHARS - marker.length - 1);
  return `${kept}\n${marker}`;
}

function truncationMarker(omitted: number): string {
  return `[truncated by model-forecast: ${omitted} chars omitted]`;
}
