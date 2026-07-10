import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import { writeAuditEntry } from "../src/audit.js";
import type { QuarantineAuditEntry } from "../src/hooks.js";
import type { AuditEntry } from "../src/types.js";

function entry(): AuditEntry {
  return {
    timestamp: "2026-07-03T00:00:00.000Z",
    phase: "sdd-design",
    originalSubagentType: "sdd-design",
    mode: "auto",
    sessionID: "s1",
    decision: {
      action: "switch",
      subagent_type: "sdd-design-alto",
      model: "openai/gpt-5.5",
      effort: "high",
      reason: "test",
      confidence: 0.8,
      evidence: "test evidence",
    },
  };
}

describe("writeAuditEntry()", () => {
  it("calls the provided Engram writer and appends JSONL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audit-test-"));
    try {
      const auditPath = path.join(dir, "audit.jsonl");
      const writeEngram = vi.fn().mockResolvedValue(undefined);

      await writeAuditEntry(entry(), { auditPath, writeEngram });

      expect(writeEngram).toHaveBeenCalledOnce();
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).decision.action).toBe("switch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never throws when sinks fail", async () => {
    const writeEngram = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      writeAuditEntry(entry(), {
        auditPath: path.join("Z:\\", "not", "real", "audit.jsonl"),
        writeEngram,
      }),
    ).resolves.toBeUndefined();
  });

  it("works when no sinks are configured", async () => {
    await expect(writeAuditEntry(entry())).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * 429-fallback — discriminated-union audit entries.
 * Spec #1316 requirement 4 + design #1317 R12. `AuditEntry` becomes a
 * union of the pre-existing selection shape and the new
 * `QuarantineAuditEntry`. Both flow through `writeAuditEntry`; the
 * `kind` discriminator survives JSON round-trip.
 * -------------------------------------------------------------------------- */
describe("writeAuditEntry() — 429-fallback union", () => {
  function quarantineEntry(): QuarantineAuditEntry {
    return {
      kind: "quarantine",
      timestamp: "2026-07-04T00:00:00.000Z",
      model: "openai/gpt-4.1-mini",
      reason: "rate_limit",
      callID: "c1",
      sessionID: "s1",
      expiresAt: "2026-07-04T01:00:00.000Z",
      nextViableModel: "minimax/M3",
    };
  }

  it("accepts a QuarantineAuditEntry and persists it with kind: 'quarantine'", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audit-quarantine-"));
    try {
      const auditPath = path.join(dir, "audit.jsonl");
      // AuditEntry is a discriminated union; the quarantine variant
      // must satisfy it WITHOUT an `as unknown as` cast.
      const e: AuditEntry = quarantineEntry();
      await writeAuditEntry(e, { auditPath });
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.kind).toBe("quarantine");
      expect(parsed.model).toBe("openai/gpt-4.1-mini");
      expect(parsed.callID).toBe("c1");
      expect(parsed.nextViableModel).toBe("minimax/M3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
