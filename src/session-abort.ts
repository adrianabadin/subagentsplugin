import { withDeadline, DeadlineError } from "./async-deadline.js";
import type { AttemptCoordinator } from "./attempt-coordinator.js";
import type { Logger } from "./logger.js";
import type { OpenCodeSessionClient } from "./opencode-client.js";
import type { AbortOrigin } from "./recovery-types.js";
import { PARENT_ABORT_SETTLEMENT_TIMEOUT_MS, SESSION_ABORT_TIMEOUT_MS } from "./recovery-policy.js";

export type AbortStatus = "fulfilled" | "rejected" | "timed_out" | "skipped";

export interface SafeAbortSessionInput {
  client: OpenCodeSessionClient | undefined;
  coordinator: AttemptCoordinator;
  sessionID: string;
  callID: string;
  attemptID: string;
  origin: AbortOrigin;
  reason: string;
  timeoutMs?: number;
  now?: () => number;
  logger?: Logger;
}

export interface SafeAbortSessionResult {
  requested: boolean;
  status: AbortStatus;
  attempt: number;
}

const requestedAtBySession = new Map<string, number[]>();

export async function safeAbortSession(input: SafeAbortSessionInput): Promise<SafeAbortSessionResult> {
  const now = input.now ?? Date.now;
  const requests = requestedAtBySession.get(input.sessionID) ?? [];
  const canRetry = requests.length === 1 && now() - requests[0]! >= PARENT_ABORT_SETTLEMENT_TIMEOUT_MS;
  if (requests.length >= 2 || (requests.length === 1 && !canRetry)) {
    return { requested: false, status: "skipped", attempt: requests.length };
  }

  const requestedAt = now();
  requests.push(requestedAt);
  requestedAtBySession.set(input.sessionID, requests);
  input.coordinator.registerPluginAbort({
    sessionID: input.sessionID,
    callID: input.callID,
    attemptID: input.attemptID,
    origin: input.origin,
    reason: input.reason,
    requestedAt,
  });

  if (typeof input.client?.abort !== "function") {
    return { requested: true, status: "rejected", attempt: requests.length };
  }

  try {
    await withDeadline("session.abort", input.timeoutMs ?? SESSION_ABORT_TIMEOUT_MS, () =>
      Promise.resolve(input.client!.abort!({ path: { id: input.sessionID } })),
    );
    return { requested: true, status: "fulfilled", attempt: requests.length };
  } catch (error) {
    const status: AbortStatus = error instanceof DeadlineError ? "timed_out" : "rejected";
    try {
      input.logger?.warn("session-abort", `abort ${status} for ${input.sessionID}: ${input.reason}`);
    } catch {
      // Abort failures are non-fatal; recovery proceeds independently.
    }
    return { requested: true, status, attempt: requests.length };
  }
}
