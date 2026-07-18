import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import {
  createInterruptionAuditSink,
  type InterruptionAuditCorrelation,
  type InterruptionAuditDependencies,
  type InterruptionAuditEvent,
  type InterruptionAuditEventName,
} from "../src/interruption-audit.js";

const NOW = "2026-07-15T12:34:56.789Z";
const PROJECT = "C:\\repo";
const NAMES: InterruptionAuditEventName[] = [
  "abort_requested", "abort_resolved", "abort_rejected", "abort_timeout",
];

function event(
  name: InterruptionAuditEventName = "abort_requested",
  overrides: Partial<InterruptionAuditCorrelation> = {},
): InterruptionAuditEvent {
  return {
    event: name,
    sessionID: "session-1",
    parentSessionID: "parent-1",
    callID: "call-1",
    attemptID: "attempt-1",
    origin: "attempt-watchdog",
    reason: "provider_response_timeout",
    ...overrides,
  };
}

function harness(overrides: Partial<InterruptionAuditDependencies> = {}) {
  const writes: Array<{ file: string; data: string }> = [];
  const stderr: string[] = [];
  const sink = createInterruptionAuditSink(PROJECT, {
    now: () => NOW,
    stderr: (line) => stderr.push(line),
    mkdir: async () => undefined,
    appendFile: async (file, data) => { writes.push({ file, data }); },
    ...overrides,
  });
  return { sink, writes, stderr };
}

describe("createInterruptionAuditSink()", () => {
  it("appends every lifecycle shape as JSONL at the exact repository path", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "interruption-audit-"));
    const auditPath = path.join(
      projectDir, ".opencode", "logs", "subagent-interruptions.jsonl",
    );
    try {
      const sink = createInterruptionAuditSink(projectDir, {
        now: () => NOW,
        stderr: () => undefined,
      });
      for (const name of NAMES) {
        await sink(event(name, name === "abort_rejected" ? { error: "abort_rejected_unknown" } : {}));
      }

      const contents = await readFile(auditPath, "utf8");
      expect(contents.endsWith("\n")).toBe(true);
      const records = contents.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(records.map((record) => record.event)).toEqual(NAMES);
      expect(records[0]).toEqual({
        timestamp: NOW,
        ...event(),
      });
      expect(records[2].error).toBe("abort_rejected_unknown");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("attempts stderr before filesystem I/O", async () => {
    const order: string[] = [];
    const sink = createInterruptionAuditSink(PROJECT, {
      now: () => NOW,
      stderr: (line) => {
        order.push("stderr");
        expect(line).toBe(
          "[model-forecast] abort_requested session=session-1 reason=provider_response_timeout\n",
        );
      },
      mkdir: async () => { order.push("mkdir"); },
      appendFile: async () => { order.push("append"); },
    });

    await sink(event());
    expect(order).toEqual(["stderr", "mkdir", "append"]);
  });

  it("serializes concurrent records in invocation order per sink instance", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const appendFile = vi.fn(async (_file: string, data: string) => {
      const name = JSON.parse(data).event as string;
      order.push(`start:${name}`);
      if (name === "abort_requested") await gate;
      order.push(`end:${name}`);
    });
    const { sink } = harness({ appendFile });

    const requested = sink(event());
    const resolved = sink(event("abort_resolved"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeRelease = appendFile.mock.calls.length;
    release();
    await Promise.all([requested, resolved]);

    expect(callsBeforeRelease).toBe(1);
    expect(order).toEqual([
      "start:abort_requested", "end:abort_requested",
      "start:abort_resolved", "end:abort_resolved",
    ]);
  });

  it("never rejects malformed input or failing dependencies", async () => {
    const hostile = new Proxy({} as InterruptionAuditEvent, {
      get: () => { throw new Error("hostile input"); },
    });
    const failures: Array<[InterruptionAuditEvent, Partial<InterruptionAuditDependencies>]> = [
      [null as unknown as InterruptionAuditEvent, {}],
      [hostile, {}],
      [event(), { now: () => { throw new Error("clock failed"); } }],
      [event(), { stderr: () => { throw new Error("stderr failed"); } }],
      [event(), { mkdir: () => Promise.reject(new Error("mkdir failed")) }],
      [event(), { appendFile: () => Promise.reject(new Error("append failed")) }],
    ];
    for (const [input, dependencies] of failures) {
      await expect(harness(dependencies).sink(input)).resolves.toBeUndefined();
    }

    const asyncStderr = harness({
      stderr: () => Promise.reject(new Error("async stderr failed")),
    });
    await expect(asyncStderr.sink(event())).resolves.toBeUndefined();
    expect(asyncStderr.writes).toHaveLength(1);
  });

  it("redacts unsafe diagnostics and excludes unknown or refusal payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { sink, writes, stderr } = harness();
    const unsafeInput: unknown = {
      ...event("abort_rejected"),
      reason: "provider_timeout\nprompt api_key=SECRET",
      error: "Bearer sk-SECRET model output",
      prompt: "SECRET PROMPT",
      modelOutput: "SECRET OUTPUT",
      payload: circular,
    };
    await sink(unsafeInput as InterruptionAuditEvent);
    await sink(event("abort_timeout", {
      reason: "r".repeat(65), error: "e".repeat(65),
    }));

    const records = writes.map(({ data }) => JSON.parse(data));
    expect(records.map(({ reason, error }) => ({ reason, error }))).toEqual([
      { reason: "redacted", error: "redacted" },
      { reason: "redacted", error: "redacted" },
    ]);
    expect(`${stderr.join("")}${writes.map(({ data }) => data).join("")}`).not.toContain("SECRET");
    expect(Object.keys(records[0]).sort()).toEqual([
      "attemptID", "callID", "error", "event", "origin", "parentSessionID",
      "reason", "sessionID", "timestamp",
    ]);

    await sink({ ...event(), event: "candidate_not_live" } as unknown as InterruptionAuditEvent);
    expect(writes).toHaveLength(2);
    expect(stderr).toHaveLength(2);
  });

  it("redacts unrecognized markerless credentials before stderr and disk", async () => {
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const { sink, writes, stderr } = harness();
    await sink(event("abort_rejected", { reason: credential, error: credential }));

    expect(JSON.parse(writes[0]!.data)).toMatchObject({
      reason: "redacted", error: "redacted",
    });
    expect(`${stderr.join("")}${writes[0]!.data}`).not.toContain(credential);
  });

  it("preserves the planned abort wrapper's known diagnostic codes", async () => {
    const reasons = [
      "provider_response_timeout", "first_activity_timeout", "inactivity_timeout",
      "tool_execution_timeout", "hard_timeout", "session_create_timeout",
      "fallback_prompt_rejected", "fallback_prompt_timeout",
      "user_cancelled", "parent_recovery", "second_abort",
    ];
    const errors = [
      "abort_rejected_bad_request", "abort_rejected_not_found",
      "abort_rejected_cancelled", "abort_rejected_timeout",
      "abort_rejected_transport", "abort_rejected_unknown",
      "deadline_exceeded",
    ];
    const { sink, writes } = harness();
    for (const reason of reasons) await sink(event("abort_requested", { reason }));
    for (const error of errors) await sink(event("abort_rejected", { error }));

    const records = writes.map(({ data }) => JSON.parse(data));
    expect(records.slice(0, reasons.length).map(({ reason }) => reason)).toEqual(reasons);
    expect(records.slice(reasons.length).map(({ error }) => error)).toEqual(errors);
  });

  it("disables later writes after append rejection may leave a partial tail", async () => {
    const appendFile = vi.fn()
      .mockRejectedValueOnce(new Error("possible partial write"))
      .mockResolvedValue(undefined);
    const stderr = vi.fn();
    const { sink } = harness({ appendFile, stderr });

    await expect(sink(event())).resolves.toBeUndefined();
    await expect(sink(event("abort_resolved"))).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledTimes(2);
    expect(appendFile).toHaveBeenCalledOnce();
  });
});
