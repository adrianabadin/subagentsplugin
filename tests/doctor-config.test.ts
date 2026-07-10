/**
 * Tests for the new mode-resolution path in `runDoctor()`.
 *
 * Coverage:
 *   - `--mode <value>` flag override (auto / advisory / off).
 *   - `--mode <invalid>` rejection (stderr error, exit 1, no JSON).
 *   - Auto-detect from `opencode.json` plugin entry:
 *       happy path (model-forecast found with `mode: "auto"`)
 *       no plugin match in config
 *       no opencode.json at all
 *   - `--mode` flag wins over auto-detect.
 *
 * Isolation strategy:
 *   - `vi.stubEnv("OPENCODE_CONFIG", tmpPath)` points the helper at a
 *     controlled temp file.
 *   - `vi.stubEnv("USERPROFILE"|"APPDATA"|"HOME"|"XDG_CONFIG_HOME", tmpDir)`
 *     makes the platform-specific candidate paths resolve to a fresh
 *     empty temp dir so the user's real `~/.config/opencode/opencode.json`
 *     is never accidentally read during tests.
 *   - All env stubs are torn down in `afterEach` via
 *     `vi.unstubAllEnvs()`.
 *
 * Temp files live in `os.tmpdir()` and are removed in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { runDoctor } from "../src/cli.js";

/** Build a complete `opencode.json` skeleton with a single plugin entry. */
function buildOpencodeJson(
  pluginEntry: unknown,
): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginEntry],
  };
}

/** Convenience: a model-forecast plugin entry that matches `/subagentsplugin/dist/`. */
const DEV_PLUGIN_PATH =
  "file:///C:/Users/aabad/Documents/CODE/ia/subagentsplugin/dist/index.js";

/** Convenience: a model-forecast plugin entry that matches the npm name. */
const NPM_PLUGIN_PATH =
  "file:///C:/Users/aabad/.npm/_npx/node_modules/@aabadin/opencode-model-forecast/dist/index.js";

describe("runDoctor() — --mode flag override", () => {
  let tempDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdout: { write: (data: string) => void };
  let stderr: { write: (data: string) => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "doctor-config-test-"));
    stdoutWrites = [];
    stderrWrites = [];
    stdout = {
      write: (data: string): void => {
        stdoutWrites.push(data);
      },
    };
    stderr = {
      write: (data: string): void => {
        stderrWrites.push(data);
      },
    };
    // Always stub env vars so the auto-detect helper has a clean slate.
    vi.stubEnv("OPENCODE_CONFIG", path.join(tempDir, "no-config.json"));
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies --mode auto override: three-hook list, source 'override'", async () => {
    const result = await runDoctor(
      ["--mode", "auto"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.modeSource).toBe("override");
    expect(parsed.wouldRegisterHooks).toEqual([
      "config",
      "tool.execute.before",
      "tool.execute.after",
    ]);
    // No auto-detect provenance surfaced when overriding.
    expect(parsed.modeConfigPath).toBeUndefined();
    expect(parsed.modePluginPath).toBeUndefined();
  });

  it("applies --mode advisory override: empty hook list, source 'override'", async () => {
    const result = await runDoctor(
      ["--mode", "advisory"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("override");
    expect(parsed.wouldRegisterHooks).toEqual([]);
  });

  it("applies --mode off override: empty hook list, source 'override'", async () => {
    const result = await runDoctor(
      ["--mode", "off"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("off");
    expect(parsed.modeSource).toBe("override");
    expect(parsed.wouldRegisterHooks).toEqual([]);
  });

  it("rejects --mode with an invalid value (stderr error, exit 1, no JSON)", async () => {
    const result = await runDoctor(
      ["--mode", "invalid"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/--mode/);
    expect(stderrWrites.join("")).toMatch(/invalid/);
    // No JSON snapshot on the failure path.
    expect(stdoutWrites.join("")).toBe("");
  });

  it("rejects --mode when the value is omitted (stderr error, exit 1, no JSON)", async () => {
    const result = await runDoctor(
      ["--mode"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/--mode requires a value/);
    expect(stdoutWrites.join("")).toBe("");
  });

  it("supports the --mode=<value> form", async () => {
    const result = await runDoctor(
      ["--mode=auto"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.modeSource).toBe("override");
  });
});

describe("runDoctor() — auto-detect from opencode.json", () => {
  let tempDir: string;
  let configPath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdout: { write: (data: string) => void };
  let stderr: { write: (data: string) => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "doctor-config-test-"));
    configPath = path.join(tempDir, "opencode.json");
    stdoutWrites = [];
    stderrWrites = [];
    stdout = {
      write: (data: string): void => {
        stdoutWrites.push(data);
      },
    };
    stderr = {
      write: (data: string): void => {
        stderrWrites.push(data);
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("auto-detects mode: 'auto' from a config with the dev plugin entry", async () => {
    const config = buildOpencodeJson([DEV_PLUGIN_PATH, { mode: "auto" }]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    // Other env vars don't matter — OPENCODE_CONFIG takes priority.
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    expect(stderrWrites.join("")).toBe("");
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.modeSource).toBe("config");
    expect(parsed.modeConfigPath).toBe(configPath);
    expect(parsed.modePluginPath).toBe(DEV_PLUGIN_PATH);
    expect(parsed.wouldRegisterHooks).toEqual([
      "config",
      "tool.execute.before",
      "tool.execute.after",
    ]);
    // Auto-mode recommendation surfaces in the list.
    expect(
      parsed.recommendations.some((r: string) => /auto mode active/i.test(r)),
    ).toBe(true);
  });

  it("auto-detects mode: 'advisory' from a config with the npm plugin entry", async () => {
    const config = buildOpencodeJson([NPM_PLUGIN_PATH, { mode: "advisory" }]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("config");
    expect(parsed.modeConfigPath).toBe(configPath);
    expect(parsed.modePluginPath).toBe(NPM_PLUGIN_PATH);
  });

  it("falls back to default when the config has no model-forecast plugin match", async () => {
    const config = buildOpencodeJson([
      "opencode-claude-auth@latest",
      { some: "options" },
    ]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("default");
    // No provenance surfaced when defaulting.
    expect(parsed.modeConfigPath).toBeUndefined();
    expect(parsed.modePluginPath).toBeUndefined();
  });

  it("falls back to default when no opencode.json exists at all", async () => {
    // Point every candidate at the temp dir which has no `opencode` subdir.
    vi.stubEnv("OPENCODE_CONFIG", path.join(tempDir, "no-config.json"));
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("default");
    expect(parsed.modeConfigPath).toBeUndefined();
    expect(parsed.modePluginPath).toBeUndefined();
  });

  it("falls back to default when the matched entry has no mode in its options", async () => {
    // Entry matches the substring but `options` is an empty object.
    const config = buildOpencodeJson([DEV_PLUGIN_PATH, {}]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("default");
  });

  it("falls back to default when the matched entry has an invalid mode value", async () => {
    // Entry matches but the mode is "nonsense" — not in the valid set.
    const config = buildOpencodeJson([DEV_PLUGIN_PATH, { mode: "nonsense" }]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("advisory");
    expect(parsed.modeSource).toBe("default");
  });

  it("skips a malformed config file and falls through to the next candidate", async () => {
    // First candidate: malformed JSON at OPENCODE_CONFIG.
    await writeFile(configPath, "{not valid json");
    // Second candidate (via USERPROFILE/.config/opencode/opencode.json) —
    // build a config WITH the plugin entry.
    const secondConfig = buildOpencodeJson([DEV_PLUGIN_PATH, { mode: "auto" }]);
    const secondDir = path.join(tempDir, "userprofile");
    const secondConfigDir = path.join(secondDir, ".config", "opencode");
    const { mkdir } = await import("fs/promises");
    await mkdir(secondConfigDir, { recursive: true });
    await writeFile(
      path.join(secondConfigDir, "opencode.json"),
      JSON.stringify(secondConfig),
    );

    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", secondDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor([], {}, { stdout, stderr });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.modeSource).toBe("config");
    expect(parsed.modePluginPath).toBe(DEV_PLUGIN_PATH);
  });
});

describe("runDoctor() — override wins over auto-detect", () => {
  let tempDir: string;
  let configPath: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdout: { write: (data: string) => void };
  let stderr: { write: (data: string) => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "doctor-config-test-"));
    configPath = path.join(tempDir, "opencode.json");
    stdoutWrites = [];
    stderrWrites = [];
    stdout = {
      write: (data: string): void => {
        stdoutWrites.push(data);
      },
    };
    stderr = {
      write: (data: string): void => {
        stderrWrites.push(data);
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("--mode auto wins over an auto-detected advisory config", async () => {
    const config = buildOpencodeJson([DEV_PLUGIN_PATH, { mode: "advisory" }]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor(
      ["--mode", "auto"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("auto");
    expect(parsed.modeSource).toBe("override");
    // When --mode wins, the config-derived fields are NOT surfaced.
    expect(parsed.modeConfigPath).toBeUndefined();
    expect(parsed.modePluginPath).toBeUndefined();
    expect(parsed.wouldRegisterHooks).toEqual([
      "config",
      "tool.execute.before",
      "tool.execute.after",
    ]);
  });

  it("--mode off wins over an auto-detected auto config", async () => {
    const config = buildOpencodeJson([DEV_PLUGIN_PATH, { mode: "auto" }]);
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);

    const result = await runDoctor(
      ["--mode", "off"],
      {},
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.mode).toBe("off");
    expect(parsed.modeSource).toBe("override");
    expect(parsed.wouldRegisterHooks).toEqual([]);
  });
});

describe("runDoctor() — --help", () => {
  let tempDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdout: { write: (data: string) => void };
  let stderr: { write: (data: string) => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "doctor-config-test-"));
    stdoutWrites = [];
    stderrWrites = [];
    stdout = {
      write: (data: string): void => {
        stdoutWrites.push(data);
      },
    };
    stderr = {
      write: (data: string): void => {
        stderrWrites.push(data);
      },
    };
    vi.stubEnv("OPENCODE_CONFIG", path.join(tempDir, "no-config.json"));
    vi.stubEnv("USERPROFILE", tempDir);
    vi.stubEnv("APPDATA", tempDir);
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints the doctor usage to stderr and returns exit 1 on --help", async () => {
    const result = await runDoctor(["--help"], {}, { stdout, stderr });

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/Usage: doctor/);
    expect(stderrWrites.join("")).toMatch(/--mode/);
    // No JSON on the help path.
    expect(stdoutWrites.join("")).toBe("");
  });

  it("prints the doctor usage on -h too", async () => {
    const result = await runDoctor(["-h"], {}, { stdout, stderr });

    expect(result.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/Usage: doctor/);
  });
});
