import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

import type { AuditEntry } from "./types.js";

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
