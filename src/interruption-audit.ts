import { appendFile, mkdir } from "fs/promises";
import path from "path";

export type InterruptionAuditEventName =
  | "abort_requested"
  | "abort_resolved"
  | "abort_rejected"
  | "abort_timeout";

export interface InterruptionAuditCorrelation {
  sessionID: string;
  parentSessionID?: string;
  callID?: string;
  attemptID?: string;
  origin: string;
  reason: string;
  error?: string;
}

export type InterruptionAuditEvent =
  | (InterruptionAuditCorrelation & { event: "abort_requested" })
  | (InterruptionAuditCorrelation & { event: "abort_resolved" })
  | (InterruptionAuditCorrelation & { event: "abort_rejected" })
  | (InterruptionAuditCorrelation & { event: "abort_timeout" });

export type InterruptionAuditSink = (
  event: InterruptionAuditEvent,
) => Promise<void>;

export interface InterruptionAuditDependencies {
  mkdir: (
    directory: string,
    options: { recursive: true },
  ) => Promise<unknown> | unknown;
  appendFile: (
    file: string,
    data: string,
    encoding: "utf8",
  ) => Promise<unknown> | unknown;
  stderr: (line: string) => unknown;
  now: () => string;
}

interface PersistedInterruptionAuditEvent extends InterruptionAuditCorrelation {
  timestamp: string;
  event: InterruptionAuditEventName;
}

const EVENT_NAMES = new Set<InterruptionAuditEventName>([
  "abort_requested",
  "abort_resolved",
  "abort_rejected",
  "abort_timeout",
]);
const ALLOWED_REASON_CODES = new Set([
  "provider_response_timeout", "first_activity_timeout", "inactivity_timeout",
  "tool_execution_timeout", "hard_timeout", "session_create_timeout",
  "fallback_prompt_rejected", "fallback_prompt_timeout",
  "user_cancelled", "parent_recovery", "second_abort",
]);
const ALLOWED_ERROR_CODES = new Set([
  "abort_rejected_bad_request", "abort_rejected_not_found",
  "abort_rejected_cancelled", "abort_rejected_timeout",
  "abort_rejected_transport", "abort_rejected_unknown",
  "deadline_exceeded",
]);

const defaultDependencies: InterruptionAuditDependencies = {
  mkdir,
  appendFile,
  stderr: (line) => {
    process.stderr.write(line);
  },
  now: () => new Date().toISOString(),
};

function safeDiagnosticCode(value: string, allowlist: ReadonlySet<string>): string {
  return allowlist.has(value) ? value : "redacted";
}

function persistedEvent(
  input: InterruptionAuditEvent,
  timestamp: string,
): PersistedInterruptionAuditEvent | undefined {
  const {
    event, sessionID, parentSessionID, callID, attemptID, origin, reason, error,
  } = input;
  if (
    !EVENT_NAMES.has(event) ||
    typeof sessionID !== "string" ||
    typeof origin !== "string" ||
    typeof reason !== "string"
  ) {
    return undefined;
  }

  return {
    timestamp,
    event,
    sessionID,
    ...(typeof parentSessionID === "string"
      ? { parentSessionID }
      : {}),
    ...(typeof callID === "string" ? { callID } : {}),
    ...(typeof attemptID === "string"
      ? { attemptID }
      : {}),
    origin,
    reason: safeDiagnosticCode(reason, ALLOWED_REASON_CODES),
    ...(typeof error === "string"
      ? { error: safeDiagnosticCode(error, ALLOWED_ERROR_CODES) }
      : {}),
  };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * Serializes records within the returned sink instance only. It does not
 * provide cross-instance or cross-process append atomicity.
 */
export function createInterruptionAuditSink(
  projectDir: string,
  dependencies: Partial<InterruptionAuditDependencies> = {},
): InterruptionAuditSink {
  const deps = { ...defaultDependencies, ...dependencies };
  const auditPath = path.join(
    projectDir,
    ".opencode",
    "logs",
    "subagent-interruptions.jsonl",
  );
  let queue = Promise.resolve();
  let writeDisabled = false;

  const processRecord = async (input: InterruptionAuditEvent): Promise<void> => {
    try {
      const record = persistedEvent(input, deps.now());
      if (record === undefined) return;

      try {
        await Promise.resolve(
          deps.stderr(
            `[model-forecast] ${record.event} session=${oneLine(record.sessionID)} reason=${oneLine(record.reason)}\n`,
          ),
        );
      } catch {
        // Interruption diagnostics must never break abort handling.
      }

      if (writeDisabled) return;
      try {
        await Promise.resolve(
          deps.mkdir(path.dirname(auditPath), { recursive: true }),
        );
      } catch {
        return;
      }
      try {
        await Promise.resolve(
          deps.appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8"),
        );
      } catch {
        // A rejected append may have left a partial tail; never append over it.
        writeDisabled = true;
      }
    } catch {
      // Malformed input and dependency failures must never break abort handling.
    }
  };

  return (input): Promise<void> => {
    queue = queue.then(() => processRecord(input)).catch(() => undefined);
    return queue;
  };
}
