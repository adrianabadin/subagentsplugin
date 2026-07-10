# Forecast Config TUI Design

> Approved by user on 2026-07-08.

## Goal

Add an OpenCode-integrated configuration UI for model availability, benchmarks, and pricing, accessible by both a slash command (`/forecast-config`) and a keyboard shortcut.

## Recommendation

Implement a separate TUI plugin entry (`./tui`) that provides:

- a route-based integrated view for editing model config
- keyboard shortcuts (`Alt+G` / `Super+G` by default) to open it
- a legacy slash command registration when `api.command` is present

This gives the integrated UX the user wants while degrading safely when the host runtime omits deprecated command APIs.

## Verified SDK Constraints

- Server and TUI modules are mutually exclusive in the OpenCode SDK.
- `api.route.register(...)`, `api.keymap`, `api.slots`, and `api.ui` only exist in the TUI plugin entry.
- `api.command` still exists, but is deprecated and optional.
- `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` are optional peer dependencies.

## Architecture

### New entry point

- Add `src/tui.ts` exporting `{ tui }`.
- Add package export `./tui`.
- Add a TUI build entry in `tsup.config.ts`.

### New UI modules

- `src/tui-config.tsx` — integrated config screen components.
- `src/tui-config-store.ts` — state loader/saver for editing `forecast-data/benchmarks.json`.

### Shared persistence

Reuse existing repo-local config infrastructure:

- `forecast-data/benchmarks.json` remains the only persisted source of truth for benchmark edits.
- The existing CLI config and TUI config both load and save through shared helpers.

## Command and keybinding behavior

### Slash command

Register only when `api.command` exists:

- `/forecast-config`
- optional alias: `/mf-config`

When selected, it navigates to the TUI route instead of spawning the CLI.

### Keybinding

Register a keymap layer that binds:

- `Alt+G` / `Super+G` -> open `forecast-config`

This is the primary supported entrypoint because it uses non-deprecated APIs.

## UI behavior

Single integrated route with:

- left panel: model list/filter
- right panel: selected model details
- edit actions for:
  - availability
  - source
  - date
  - confidence
  - pricing values
  - benchmark values
  - context window / max output
- save / discard controls

If `@opentui/solid` is unavailable, the module must no-op without breaking plugin load.

## Error handling

- Missing TUI peers: plugin loads, but route/command/shortcut are skipped.
- Missing `api.command`: keybinding + route still work.
- Malformed repo-local JSON: show warning dialog / toast, fall back to compiled view.
- Save failure: show error toast and keep unsaved state in memory.

## Testing

- `tests/tui-config.test.ts`
  - route registration
  - keybinding dispatch
  - slash command registration when `api.command` exists
  - no slash command registration when absent
  - guarded import path when `@opentui/*` deps are unavailable
- extend `tests/integration.test.ts`
  - SKILL docs allowlist for any newly documented flags/command names if needed

## Out of scope

- editing `forecast-data/overrides.json`
- bulk edit across provider groups
- sidebar embedding in this same change unless route work is already stable
