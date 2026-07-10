# Forecast Config TUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an OpenCode-integrated model config UI reachable via `/forecast-config` and keyboard shortcuts (`Alt+G` / `Super+G` by default), without breaking the existing server plugin entry.

**Architecture:** Build a separate `./tui` plugin entry that registers a route, a keybinding, and an optional legacy slash command. Reuse `forecast-data/benchmarks.json` as the single persisted store so the CLI and TUI edit the same data.

**Tech Stack:** TypeScript, tsup, OpenCode plugin SDK `@opencode-ai/plugin`, optional `@opentui/*` peer deps, Vitest.

---

### Task 1: Add TUI package/build plumbing

**Files:**
- Modify: `package.json`
- Modify: `tsup.config.ts`

**Step 1:** Write the failing tests that expect a TUI entry/build export.

**Step 2:** Run the tests to verify they fail.

**Step 3:** Add `./tui` export and optional `@opentui/core`, `@opentui/keymap`, `@opentui/solid` peer deps.

**Step 4:** Add a `tui` entry to `tsup.config.ts`.

**Step 5:** Run tests and build.

### Task 2: Create the TUI route entry

**Files:**
- Create: `src/tui.ts`
- Test: `tests/tui-config.test.ts`

**Step 1:** Write failing tests for route registration and guarded no-op behavior without peers.

**Step 2:** Run the tests to verify they fail.

**Step 3:** Implement `src/tui.ts` with guarded imports and route registration.

**Step 4:** Run tests and make them pass.

### Task 3: Add slash command and keybinding

**Files:**
- Modify: `src/tui.ts`
- Test: `tests/tui-config.test.ts`

**Step 1:** Write failing tests for:
- slash command registration when `api.command` exists
- no registration when it is absent
- keybinding opening the route

**Step 2:** Run the tests to verify they fail.

**Step 3:** Implement the command and keybinding.

**Step 4:** Run tests and make them pass.

### Task 4: Build the config screen state layer

**Files:**
- Create: `src/tui-config-store.ts`
- Modify: `src/cli-config.ts` only if shared helpers need extraction
- Test: `tests/tui-config.test.ts`

**Step 1:** Write failing tests for loading/saving `forecast-data/benchmarks.json` in the TUI path.

**Step 2:** Run the tests to verify they fail.

**Step 3:** Implement shared state helpers or reuse extracted helpers from CLI config.

**Step 4:** Run tests and make them pass.

### Task 5: Build the integrated route UI

**Files:**
- Create: `src/tui-config.tsx`
- Modify: `src/tui.ts`
- Test: `tests/tui-config.test.ts`

**Step 1:** Write failing render tests for the model list and selected model detail view.

**Step 2:** Run the tests to verify they fail.

**Step 3:** Implement the route UI with save/discard behavior.

**Step 4:** Run tests and make them pass.

### Task 6: Update docs and lock regressions

**Files:**
- Modify: `skills/model-forecast/SKILL.md`
- Modify: `tests/integration.test.ts`

**Step 1:** Write or update tests that pin documented TUI access paths.

**Step 2:** Update docs for `/forecast-config` and the configured keyboard shortcuts.

**Step 3:** Run the full test suite.

**Step 4:** Build and verify the `dist/` output contains the TUI bundle.
