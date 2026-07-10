import { describe, expect, it, vi } from "vitest";

import tuiModule from "../src/tui.js";
import { tui } from "../src/tui.js";

type KeymapLayer = {
  mode?: string;
  commands?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
};

type RunnableKeymapLayer = {
  commands?: Array<{ run?: () => boolean | void | Promise<boolean | void> }>;
};

function makeApi(overrides: Record<string, unknown> = {}) {
  const register = vi.fn(() => () => {});
  const registerLayer = vi.fn(() => () => {});
  const replace = vi.fn();
  const toast = vi.fn();
  return {
    api: {
      command: {
        register,
      },
      keymap: {
        registerLayer,
      },
      lifecycle: {
        onDispose: vi.fn(),
      },
      state: {
        path: {
          directory: "C:/tmp/project",
        },
      },
      ui: {
        DialogSelect: vi.fn((props) => props),
        DialogPrompt: vi.fn((props) => props),
        DialogConfirm: vi.fn((props) => props),
        DialogAlert: vi.fn((props) => props),
        dialog: {
          replace,
          clear: vi.fn(),
        },
        toast,
      },
      ...overrides,
    },
    register,
    registerLayer,
    replace,
    toast,
  };
}

describe("tui entry", () => {
  it("exports an explicit TUI plugin module", () => {
    expect(tuiModule).toMatchObject({
      id: "aabadin.model-forecast.tui",
      tui,
    });
  });

  it("registers Forecast Config through the OpenCode keymap layer", async () => {
    const { api, registerLayer } = makeApi();

    await tui(api as never);

    expect(registerLayer).toHaveBeenCalledTimes(1);
    const calls = registerLayer.mock.calls as unknown as Array<[KeymapLayer]>;
    const layer = calls[0][0];
    expect(layer).toMatchObject({ mode: "base" });
    expect(layer.commands).toHaveLength(1);
    expect(layer.commands?.[0]).toMatchObject({
      name: ":forecast-config",
      title: "Forecast Config",
      category: "Plugin",
      namespace: "palette",
      nargs: "0",
      slashName: "forecast-config",
      slashAliases: ["mf-config"],
    });
    expect(layer.bindings).toContainEqual({
      key: "alt+g",
      cmd: ":forecast-config",
      desc: "Open Forecast Config",
    });
    expect(layer.bindings).toContainEqual({
      key: "super+g",
      cmd: ":forecast-config",
      desc: "Open Forecast Config",
    });
  });

  it("also registers the slash command when keymap is present", async () => {
    const { api, register } = makeApi();

    await tui(api as never);

    expect(register).toHaveBeenCalledTimes(1);
    const calls = register.mock.calls as unknown as Array<[() => Array<Record<string, unknown>>]>;
    const commands = calls[0][0]();
    expect(commands[0]).toMatchObject({
      title: "Forecast Config",
      value: "forecast-config",
      keybind: "alt+g, super+g",
      slash: { name: "forecast-config", aliases: ["mf-config"] },
    });
  });

  it("opens the integrated dialog flow from the keymap command", async () => {
    const { api, registerLayer, replace } = makeApi();

    await tui(api as never);

    const calls = registerLayer.mock.calls as unknown as Array<[RunnableKeymapLayer]>;
    const layer = calls[0][0];
    await layer.commands?.[0]?.run?.();

    expect(replace).toHaveBeenCalled();
  });

  it("falls back to legacy api.command when keymap is absent", async () => {
    const { api, register } = makeApi({ keymap: undefined });

    await tui(api as never);

    expect(register).toHaveBeenCalledTimes(1);
    const calls = register.mock.calls as unknown as Array<[() => Array<Record<string, unknown>>]>;
    const provider = calls[0][0];
    const commands = provider();
    expect(commands[0]).toMatchObject({
      title: "Forecast Config",
      value: "forecast-config",
      keybind: "alt+g, super+g",
      slash: { name: "forecast-config", aliases: ["mf-config"] },
    });
  });

  it("accepts shortcut overrides from TUI plugin options", async () => {
    const { api, registerLayer } = makeApi();

    await tui(api as never, { shortcuts: ["alt+m"] } as never);

    const calls = registerLayer.mock.calls as unknown as Array<[KeymapLayer]>;
    expect(calls[0][0].bindings).toContainEqual({
      key: "alt+m",
      cmd: ":forecast-config",
      desc: "Open Forecast Config",
    });
  });

  it("degrades gracefully when no command surface is present", async () => {
    const { api, toast, replace } = makeApi({ command: undefined, keymap: undefined });

    await tui(api as never);

    expect(replace).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatchObject({
      variant: "warning",
    });
  });
});
