import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

import type { AuditEntry, RecoveryAuditEntry } from "./types.js";

export interface AuditOptions {
  auditPath?: string;
  writeEngram?: (entry: AuditEntry) => Promise<void> | void;
}

export async function writeAuditEntry(
  entry: AuditEntry,
  options: AuditOptions = {},
): Promise<void> {
  try {
    await Promise.resolve(options.writeEngram?.(entry));
  } catch {
    // Audit must never break the task call.
  }

  if (options.auditPath === undefined) return;

  try {
    await mkdir(dirname(options.auditPath), { recursive: true });
    await appendFile(options.auditPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Audit must never break the task call.
  }
}

/** Suppresses duplicate terminal records while keeping all observations. */
export function createRecoveryAuditRecorder(options: AuditOptions = {}): {
  record: (entry: RecoveryAuditEntry) => Promise<void>;
} {
  const terminalCallIDs = new Set<string>();
  return {
    async record(entry): Promise<void> {
      if (entry.terminal) {
        if (terminalCallIDs.has(entry.callID)) return;
        terminalCallIDs.add(entry.callID);
      }
      await writeAuditEntry(entry, options);
    },
  };
}
