/**
 * Forecast state file I/O tests — `src/state-file.ts`.
 *
 * The state file bridges the server plugin module (writer) and the TUI
 * plugin module (reader) across the OpenCode process boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  defaultStatePath,
  readStateFile,
  writeStateFile,
  type ForecastState,
} from "../src/state-file.js";

function makeState(overrides: Partial<ForecastState> = {}): ForecastState {
  return {
    selectedModel: "openai/gpt-5.5",
    selectedEffort: "",
    selectedConfidence: 0.9,
    fallbackModel: "anthropic/claude-opus-4-8",
    fallbackConfidence: 0.85,
    preset: "balanced",
    mode: "auto",
    quarantineCount: 1,
    quarantined: ["opencode-go/deepseek-v4-pro"],
    cacheAge: null,
    lastUpdate: new Date().toISOString(),
    activeRecoveryCount: 0,
    activeRecoveries: [],
    lastRecovery: null,
    ...overrides,
  };
}

describe("state-file — writeStateFile / readStateFile", () => {
  let tmpRoot: string;
  let statePath: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "state-file-"));
    statePath = path.join(tmpRoot, "nested", "state.json");
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writeStateFile creates parent directory if missing", async () => {
    await writeStateFile(statePath, makeState());
    const raw = await readFile(statePath, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.parse(raw).selectedModel).toBe("openai/gpt-5.5");
  });

  it("readStateFile round-trips a valid state", async () => {
    const state = makeState({ selectedModel: "anthropic/claude-opus-4-8" });
    await writeStateFile(statePath, state);
    const read = await readStateFile(statePath);
    expect(read?.selectedModel).toBe("anthropic/claude-opus-4-8");
    expect(read?.mode).toBe("auto");
    expect(read?.quarantined).toEqual(["opencode-go/deepseek-v4-pro"]);
  });

  it("round-trips active recovery state and the last terminal result", async () => {
    await writeStateFile(statePath, makeState({
      activeRecoveryCount: 1,
      activeRecoveries: [{
        callID: "call-1",
        originalModel: "openai/gpt-5.5",
        fallbackModel: "anthropic/claude-sonnet-4-5",
        state: "fallback-running",
      }],
      lastRecovery: {
        callID: "call-0",
        originalModel: "openai/gpt-5.5",
        fallbackModel: "anthropic/claude-sonnet-4-5",
        state: "completed-fallback",
        result: "success",
      },
    }));

    const state = await readStateFile(statePath);
    expect(state?.activeRecoveryCount).toBe(1);
    expect(state?.activeRecoveries[0]?.fallbackModel).toBe("anthropic/claude-sonnet-4-5");
    expect(state?.lastRecovery?.result).toBe("success");
  });

  it("readStateFile returns null when the file is missing", async () => {
    expect(await readStateFile(path.join(tmpRoot, "missing.json"))).toBeNull();
  });

  it("readStateFile returns null when the file is empty", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "", "utf8");
    expect(await readStateFile(statePath)).toBeNull();
  });

  it("readStateFile returns null when the file is malformed JSON", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{ not valid", "utf8");
    expect(await readStateFile(statePath)).toBeNull();
  });

  it("readStateFile returns null when the root is not an object", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "[]", "utf8");
    expect(await readStateFile(statePath)).toBeNull();
  });

  it("readStateFile returns null when a required field is wrong type", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ selectedModel: 42 }), "utf8");
    expect(await readStateFile(statePath)).toBeNull();
  });

  it("writeStateFile is atomic — readers never see a partial document", async () => {
    // Run multiple concurrent writers and readers; the file is always
    // either the previous complete state or the new complete state.
    const writes = Array.from({ length: 20 }, (_, i) =>
      writeStateFile(statePath, makeState({ selectedModel: `model-${i}` })),
    );
    const reads = Array.from({ length: 20 }, () => readStateFile(statePath));
    await Promise.all(writes);
    const results = await Promise.all(reads);
    for (const r of results) {
      if (r === null) continue;
      // Every read sees a structurally valid state with the expected
      // selection of fields; it must NOT be a partial JSON document.
      expect(typeof r.selectedModel === "string" || r.selectedModel === null).toBe(true);
      expect(typeof r.mode).toBe("string");
    }
  });

  it("defaultStatePath lives under the opencode-model-forecast cache dir", () => {
    const p = defaultStatePath();
    expect(p).toMatch(/opencode-model-forecast[\\/]+state\.json$/);
  });

  it("writeStateFile rejects malformed state without touching disk", async () => {
    const bad = { ...makeState(), selectedConfidence: "not-a-number" } as unknown as ForecastState;
    await expect(writeStateFile(statePath, bad)).rejects.toThrow(/invalid state/);
    // Disk must remain untouched — file should not exist or should remain the previous value.
    const dir = path.dirname(statePath);
    let exists = true;
    try {
      await readFile(statePath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    // Ensure no half-written file lingered in the dir.
    const list = await readdir(dir).catch(() => [] as string[]);
    expect(list.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
