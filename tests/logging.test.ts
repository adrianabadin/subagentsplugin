/**
 * Tests for the stderr transition-log helper in `src/plugin.ts`.
 *
 * The helper (`logTransition`) is intentionally private to the plugin
 * module — the production public API is `default`, `modelForecastPlugin`,
 * and `refreshCache`. We export the helper from `src/plugin.ts` for
 * direct testability, but it is NOT re-exported by `src/api.ts` so the
 * public surface stays unchanged.
 *
 * We verify three properties:
 *   1. Happy path — a single call writes ONE `[model-forecast] <msg>` line
 *      to stderr ending in a newline.
 *   2. Swallowed errors — when `process.stderr.write` throws, the helper
 *      does NOT propagate the throw (so a hook that calls it can never
 *      be broken by a stderr failure).
 *   3. End-to-end — calling `modelForecastPlugin` triggers the `init`
 *      transition line on stderr (integration sanity check).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger.js";
import { logTransition, modelForecastPlugin } from "../src/plugin.js";

describe("logTransition() — stderr trace helper", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("writes a single line containing '[model-forecast] <message>' to stderr", () => {
    logTransition("init mode=auto client=present");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const call = String(stderrSpy.mock.calls[0]?.[0]);
    expect(call).toContain("[model-forecast] init mode=auto client=present");
    expect(call).toMatch(/\n$/);
  });

  it("contains the '[model-forecast]' tag", () => {
    logTransition("config hook fired, generated profiles=3 across 2 base agents");
    expect(String(stderrSpy.mock.calls[0]?.[0])).toMatch(/\[model-forecast\] /);
  });

  it("does NOT write to stdout (stderr-only contract)", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      logTransition("only on stderr");
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("swallows errors from process.stderr.write (never throws)", () => {
    stderrSpy.mockImplementation(() => {
      throw new Error("stderr broken");
    });

    expect(() => logTransition("anything")).not.toThrow();
  });

  it("swallows non-Error throws (e.g. plain strings) too", () => {
    stderrSpy.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string-throw";
    });

    expect(() => logTransition("anything")).not.toThrow();
  });

  it("Logger is silent on stderr by default for non-error levels", () => {
    const logger = new Logger("project", "/tmp/project");

    logger.info("test", "hidden diagnostic");

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("Logger writes non-error levels to stderr when verbose is enabled", () => {
    const logger = new Logger("project", "/tmp/project", { verbose: true });

    logger.info("test", "visible diagnostic");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("visible diagnostic");
  });

  it("Logger always writes errors to stderr", () => {
    const logger = new Logger("project", "/tmp/project");

    logger.error("test", "visible error");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("visible error");
  });

  it("modelForecastPlugin() does not emit init diagnostics to stderr by default", async () => {
    await modelForecastPlugin();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("modelForecastPlugin({ verbose:true }) emits init diagnostics to stderr", async () => {
    await modelForecastPlugin(undefined, { verbose: true });

    const all = stderrSpy.mock.calls
      .map((c: [unknown, ...unknown[]]) => String(c[0]))
      .join("");
    expect(all).toContain("[model-forecast]");
    expect(all).toContain("init mode=advisory client=absent");
  });

  it("modelForecastPlugin({mode:'auto', verbose:true}) also emits a 'registering hooks' line", async () => {
    await modelForecastPlugin(undefined, { mode: "auto", verbose: true });

    const all = stderrSpy.mock.calls
      .map((c: [unknown, ...unknown[]]) => String(c[0]))
      .join("");
    expect(all).toContain("init mode=auto client=absent");
    expect(all).toContain("registering hooks (auto mode)");
  });
});
