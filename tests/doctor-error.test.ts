/**
 * Internal-error path for the `doctor` subcommand.
 *
 * Lives in a separate file because the `vi.mock` of `src/cache.js` is
 * hoisted to module load and would make `readCache` throw across
 * EVERY test in `tests/doctor.test.ts`, breaking the happy-path
 * assertions. By isolating the error test here we keep both files
 * deterministic and independent.
 *
 * What we exercise:
 *   - When `readCache` (or any other internal step) throws an
 *     unexpected error, `runDoctor` must catch it, write a single
 *     `error: doctor failed — <message>` line to stderr, return
 *     `exitCode: 1`, and NOT write a JSON snapshot to stdout.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the cache reader so the doctor path triggers a synchronous
// error. We replace the `readCache` export with a function that
// always throws an EACCES-shaped error. All other exports of
// `src/cache.js` are kept via `importActual` so the test file
// remains internally consistent.
vi.mock("../src/cache.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/cache.js")>("../src/cache.js");
  return {
    ...actual,
    readCache: async (): Promise<null> => {
      throw new Error("EACCES: permission denied (test mock)");
    },
  };
});

import { runDoctor } from "../src/cli.js";

describe("runDoctor() — internal-error path", () => {
  it("returns exit code 1 and writes an error to stderr when readCache throws", async () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdout = { write: (data: string): void => { stdoutWrites.push(data); } };
    const stderr = { write: (data: string): void => { stderrWrites.push(data); } };

    const result = await runDoctor(
      [],
      { mode: "advisory" },
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("").toLowerCase()).toContain("error");
    expect(stderrWrites.join("").toLowerCase()).toContain("eacces");
    // No JSON snapshot is emitted on the failure path.
    expect(stdoutWrites.join("")).toBe("");
  });
});
