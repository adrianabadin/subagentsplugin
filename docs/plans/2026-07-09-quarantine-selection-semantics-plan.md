# Quarantine Selection Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Commit steps are intentionally omitted — the user has not authorized commits for this change.

**Goal:** Make explicit `provider/*` targets expand to every group member while exact `provider/model` targets always resolve to a singleton, removing the implicit Gemini Flash family expansion on individual selections.

**Architecture:** Replace the single resolution call inside `resolveQuarantineTarget`'s exact-id branch with a literal singleton return, and route `QuarantineStore.loadFromFile` through the same `resolveQuarantineTarget` helper so persistence preserves exact targets. The automatic rate-limit path (`QuarantineStore.add`) keeps its existing `resolveModelGroup` expansion because it does not share the manual resolver. All TUI / CLI callers of `resolveQuarantineTarget` are automatically aligned by this single behaviour change.

**Tech Stack:** TypeScript (ESM), Vitest 4.1.6, tsup 8.5.1, Node 24. `npm test` = `vitest run`, `npm run build` = `tsup`, `npm run typecheck` = `tsc --noEmit`.

---

## Background

Current contract (bug):
- `src/model-groups.ts:152-153` — `resolveQuarantineTarget("google/gemini-3.5-flash")` returns the full Flash family (4 aliases) via `resolveModelGroup`.
- `src/quarantine.ts:393, 424` — `loadFromFile` calls `resolveModelGroup` directly and expands any hand-edited Flash entry on load.
- `src/quarantine.ts:174` — `addManual` uses `resolveQuarantineTarget` (so it inherits the expansion).
- `src/quarantine.ts:232` — `release` uses `resolveQuarantineTarget` (same).
- `src/tui.ts:586` — `applyQuarantine` uses `resolveQuarantineTarget` (same; toast shows `expandedCount: 4` for a singleton selection).
- `src/cli-quarantine.ts:343, 379` — `runQuarantine` add/release use `resolveQuarantineTarget` (same).

Approved contract:
- `provider/*` form keeps its current group expansion (unchanged path through `resolveProviderGroup`).
- `provider/model` form returns `[trimmed]` — NO implicit family expansion.
- `QuarantineStore.add` (automatic rate-limit, uses `resolveModelGroup`) is OUT OF SCOPE.
- Persistence round-trips exact targets — `loadFromFile` must use `resolveQuarantineTarget`, not `resolveModelGroup`.

Test runner reminder: every "verify RED / GREEN" step is `npm test -- tests/<file>.test.ts`. The full sweep is `npm test`.

---

## Task 1: RED — pin the new `resolveQuarantineTarget` singleton contract

**Files:**
- Modify: `tests/model-groups.test.ts:143-162` (the `describe("resolveQuarantineTarget — provider/model form", ...)` block)
- Read-only reference: `src/model-groups.ts:137-154`

**Step 1: Replace the two expansion tests with singleton assertions**

In `tests/model-groups.test.ts`, replace the existing `describe("resolveQuarantineTarget — provider/model form", ...)` block (currently lines 143–162) with:

```ts
describe("resolveQuarantineTarget — provider/model form", () => {
  it("returns singleton for a non-group model id", () => {
    const result = resolveQuarantineTarget("anthropic/claude-opus-4-8");
    expect(result).toEqual(["anthropic/claude-opus-4-8"]);
  });

  it("returns singleton for a Gemini Flash alias (NO implicit family expansion)", () => {
    const result = resolveQuarantineTarget("google/gemini-3.5-flash");
    expect(result).toEqual(["google/gemini-3.5-flash"]);
  });

  it("returns singleton for an antigravity Gemini Flash alias (NO implicit expansion)", () => {
    const result = resolveQuarantineTarget("google/antigravity-gemini-3-flash");
    expect(result).toEqual(["google/antigravity-gemini-3-flash"]);
  });

  it("returns singleton for any non-flash model id under google", () => {
    expect(resolveQuarantineTarget("google/gemini-3.1-pro")).toEqual(["google/gemini-3.1-pro"]);
  });
});
```

Also update the file-level doc comment at the top of the file (lines 1–15) so the listed contract no longer claims Gemini Flash expansion under the `provider/model` form. The new bullet for `resolveQuarantineTarget` is:

```
 *   - `resolveQuarantineTarget(target)` accepts either `provider/*`
 *     (group) or `provider/model` (exact id, ALWAYS a singleton — no
 *     implicit family expansion, even for Gemini Flash aliases).
```

**Step 2: Verify RED**

Run: `npm test -- tests/model-groups.test.ts`
Expected: FAIL — `resolveQuarantineTarget("google/gemini-3.5-flash")` currently returns 4 aliases, but the new assertion expects exactly `["google/gemini-3.5-flash"]`. The "singleton for any non-flash model id under google" test also passes already (no regression) — only the Flash assertions are red.

If the test passes, the production code was already correct — STOP and re-read the design before continuing.

---

## Task 2: GREEN — make `resolveQuarantineTarget` return a singleton for `provider/model`

**Files:**
- Modify: `src/model-groups.ts:151-154` (the final `return` of `resolveQuarantineTarget`)
- Modify: `src/model-groups.ts:1-27` (file-level doc comment — drop the implicit-expansion claim from the `Contract:` block)
- Modify: `src/model-groups.ts:121-136` (function-level doc comment for `resolveQuarantineTarget`)

**Step 1: Replace the exact-id branch with a literal singleton return**

In `src/model-groups.ts`, replace the trailing comment + return at lines 152–153:

```ts
  // Exact id — apply the existing model-group expansion.
  return resolveModelGroup(trimmed);
```

with:

```ts
  // Exact id — singleton only. The manual flow must NOT trigger
  // implicit family expansion: only the `provider/*` form expands,
  // and the automatic rate-limit path keeps its own expansion via
  // `resolveModelGroup` (separate resolver, separate concern).
  return [trimmed];
```

**Step 2: Refresh the doc comments so the new contract is the documented contract**

- File-level header (lines 1–27): replace the `An exact provider/model id expands to the singleton [modelId] UNLESS it is a Gemini Flash model (which expands to the full Flash family as above).` bullet under `Design:` with:
  ```
  - An exact `provider/model` id ALWAYS expands to the singleton [modelId].
    The manual quarantine flow never triggers implicit family expansion;
    this includes Gemini Flash aliases.
  ```
  And update the `Contract:` bullet for `resolveQuarantineTarget` to:
  ```
  - `resolveQuarantineTarget(target)` accepts either `provider/*` (a
    group, returns every member) or `provider/model` (an exact id,
    ALWAYS returns the singleton `[modelId]` — no implicit expansion).
  ```

- Function-level doc for `resolveQuarantineTarget` (lines 121–136): rewrite the second bullet under `Accepted forms:`:
  ```
  - `provider/model` (e.g. `openai/gpt-5.5`, `google/gemini-3.5-flash`)
    → always returns the singleton `[trimmed]`. No implicit family
    expansion — Gemini Flash aliases no longer auto-expand to the full
    Flash family; the automatic rate-limit path uses `resolveModelGroup`
    instead when it needs that behaviour.
  ```

**Step 3: Verify GREEN**

Run: `npm test -- tests/model-groups.test.ts`
Expected: PASS. All four `provider/model` form tests green; the `provider/*` form tests and the `resolveModelGroup` regression block stay green (these exercise functions we did not touch).

If `resolveModelGroup — regression (existing behaviour preserved)` fails, the fix accidentally broke the rate-limit path — STOP, the implementation has scope creep.

---

## Task 3: RED — pin exact-target preservation in `loadFromFile`

**Files:**
- Modify: `tests/quarantine.test.ts:393-442` (the `describe("loadFromFile group expansion (hand-edited file)", ...)` block)

**Step 1: Replace the two load-expansion tests with exact-target tests**

In `tests/quarantine.test.ts`, replace the entire `describe("loadFromFile group expansion (hand-edited file)", ...)` block (currently lines 393–442) with:

```ts
describe("loadFromFile preserves exact targets (no implicit expansion)", () => {
  it("loads a single Gemini Flash alias as a singleton — only that alias is blocked", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    // Hand-edited file: exactly ONE Flash alias listed. After the fix
    // the loader must NOT expand to the rest of the Flash family.
    const handEdited = JSON.stringify([
      { model: "google/gemini-3.5-flash", reason: "invalid_api_key", expiresAt: null },
    ]);
    await writeFile(filePath, handEdited, "utf8");

    const store = new QuarantineStore({ now: () => 2_000_000 });
    await store.loadFromFile(filePath);

    // Exactly the listed alias is loaded.
    expect(store.isBlocked("google/gemini-3.5-flash")).toBe(true);
    // Other Flash aliases — even though they share the family — are NOT blocked.
    expect(store.isBlocked("google/gemini-3-flash")).toBe(false);
    expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(false);
    expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(false);
    expect(store.isBlocked("google/gemini-2.5-flash")).toBe(false);
    // Non-flash Gemini model — NOT affected.
    expect(store.isBlocked("google/gemini-3.1-pro")).toBe(false);

    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.model).toBe("google/gemini-3.5-flash");
  });

  it("loads an antigravity Flash alias as a singleton — canonical aliases not auto-blocked", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    const handEdited = JSON.stringify([
      { model: "google/antigravity-gemini-3-flash", reason: "invalid_api_key", expiresAt: null },
    ]);
    await writeFile(filePath, handEdited, "utf8");

    const store = new QuarantineStore({ now: () => 2_000_000 });
    await store.loadFromFile(filePath);

    expect(store.isBlocked("google/antigravity-gemini-3-flash")).toBe(true);
    expect(store.isBlocked("google/gemini-3-flash")).toBe(false);
    expect(store.isBlocked("google/gemini-3.5-flash")).toBe(false);
    expect(store.isBlocked("google/antigravity-gemini-3.5-flash")).toBe(false);
  });

  it("loads provider/* entries with full group expansion (group form unchanged)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "quarantine.json");

    // provider/* form still expands — this is the only form that does.
    const payload = JSON.stringify([
      { model: "openai/*", reason: "manual-tui", expiresAt: null },
    ]);
    await writeFile(filePath, payload, "utf8");

    const store = new QuarantineStore({ now: () => 2_000_000 });
    await store.loadFromFile(filePath);

    expect(store.isBlocked("openai/gpt-5.5")).toBe(true);
    expect(store.isBlocked("openai/o4-mini")).toBe(true);
  });
});
```

**Step 2: Verify RED**

Run: `npm test -- tests/quarantine.test.ts`
Expected: FAIL — the singleton assertions (e.g. `expect(store.isBlocked("google/gemini-3-flash")).toBe(false)`) currently fail because the loader still expands via `resolveModelGroup`. The third test (provider/* form) passes already — it pins the unchanged group path.

If the test passes, the loader was already calling the new resolver — STOP and confirm whether the source already changed.

---

## Task 4: GREEN — route `loadFromFile` through `resolveQuarantineTarget`

**Files:**
- Modify: `src/quarantine.ts:53-56` (imports — `resolveModelGroup` is no longer used)
- Modify: `src/quarantine.ts:393` (permanent branch — `resolveModelGroup` → `resolveQuarantineTarget`)
- Modify: `src/quarantine.ts:424` (manual TTL branch — same)

**Step 1: Drop the unused import and switch both call sites**

In `src/quarantine.ts`, replace the import block at lines 53–56:

```ts
import {
  resolveModelGroup,
  resolveQuarantineTarget,
} from "./model-groups.js";
```

with:

```ts
import { resolveQuarantineTarget } from "./model-groups.js";
```

Then at line 393 (permanent branch), replace:

```ts
        const group = resolveModelGroup(entry.model);
```

with:

```ts
        // Route through `resolveQuarantineTarget` so persistence
        // preserves exact targets: `provider/*` entries still expand
        // to the full group; `provider/model` entries restore as
        // singletons (no implicit family expansion).
        const group = resolveQuarantineTarget(entry.model);
```

And at line 424 (manual TTL branch), replace the same `resolveModelGroup(entry.model)` call with the same `resolveQuarantineTarget(entry.model)` line, with an identical comment (or a short "same rationale" comment).

**Step 2: Verify GREEN**

Run: `npm test -- tests/quarantine.test.ts`
Expected: PASS. The new exact-target tests are green. The untouched blocks (`Gemini Flash group expansion`, `permanent group quarantine persistence`, `TTL group does NOT persist`, `deepseek — separate group from opencode-go`, `non-group models — singleton`, `manual entries`, `shared globalThis accessor`) stay green — they exercise `store.add()` (untouched) and the unchanged `provider/*` form.

If any of those untouched blocks fail, the change accidentally touched `add()` — STOP, scope creep.

---

## Task 5: Align the plugin integration test with the new contract

**Files:**
- Modify: `tests/plugin.test.ts:839-845` (the `JSON.stringify` payload inside `"quarantine loaded from file excludes all Gemini Flash aliases from generated profiles"`)

**Step 1: Switch the file payload from a single alias to the `provider/*` form**

In `tests/plugin.test.ts`, replace the payload written inside the first test of the `describe("plugin — quarantine ↔ resolver integration (group expansion)", ...)` block (lines 839–845):

```ts
      await writeFile(
        quarantinePath,
        JSON.stringify([
          { model: "google/gemini-3.5-flash", reason: "invalid_api_key", expiresAt: null },
        ]),
        "utf8",
      );
```

with:

```ts
      await writeFile(
        quarantinePath,
        JSON.stringify([
          // Use the group form so the loader still quarantines every
          // Gemini Flash alias via the unchanged `provider/*` expansion
          // path. The exact-target semantic is pinned by the unit tests
          // in `tests/quarantine.test.ts` and `tests/model-groups.test.ts`.
          { model: "google/*", reason: "invalid_api_key", expiresAt: null },
        ]),
        "utf8",
      );
```

The second test in the same block (lines 937–981, `"quarantines loaded before config hook: permanent entries survive clearNonPermanent()"`) does not assert any specific exclusion — it only asserts `typeof subagent_type === "string"`. No change required there.

**Step 2: Verify GREEN**

Run: `npm test -- tests/plugin.test.ts`
Expected: PASS. The first test now exercises `provider/*` group expansion (which still works); the second test still only checks for no-crash.

---

## Task 6: Focused suite sweep + typecheck

**Files:** none — verification only.

Run, in order, and require each to be green before moving on:

1. `npm test -- tests/model-groups.test.ts` — Task 1 / 2 outcome.
2. `npm test -- tests/quarantine.test.ts` — Task 3 / 4 outcome.
3. `npm test -- tests/tui-quarantine.test.ts` — no source changes here, but the file shares the resolver via `applyQuarantine`. Confirm `buildQuarantineToast` singular/plural cases still pass (the new contract makes `expandedCount: 1` the only valid outcome for individual model targets).
4. `npm test -- tests/plugin.test.ts` — Task 5 outcome.
5. `npm test -- tests/cli-quarantine.test.ts` — no source changes here; the CLI inherits the new singleton semantic through `resolveQuarantineTarget`. Verify the existing release / add / parse tests still pass; any test that asserted Flash expansion through the CLI release path needs the same singleton update as Task 3 (only if discovered here).
6. `npm run typecheck` — `tsc --noEmit` must be clean (doc-comment refresh + signature changes must not introduce type errors).

If any step fails: STOP, fix the failing test or source, re-run the failing step + the previous one. Do not advance with a red signal.

---

## Task 7: Full suite + build

**Files:** none — verification only.

Run:

1. `npm test` — full Vitest sweep across every `tests/*.test.ts` file. Require 100% pass.
2. `npm run build` — `tsup` must produce `dist/index.js`, `dist/api.js`, `dist/cli.js`, `dist/tui.js` with no errors.
3. Optional smoke (manual, not part of CI): launch the TUI, pick `Quarantine → Add`, select `google/gemini-3.5-flash`, confirm the toast reports `Quarantined 1 model (google/gemini-3.5-flash) — permanent` and that `google/gemini-3-flash` is NOT blocked. Then select `openai/*` and confirm `Quarantined N models (openai/*) — permanent` where N is the full openai group.

A red full-sweep or red build blocks the change. Investigate, do not silence.

---

## Scope boundaries — what this plan intentionally does NOT touch

- `QuarantineStore.add()` and `resolveModelGroup` — automatic rate-limit path. Per the design: "It does not redesign the TUI or change automatic rate-limit quarantine behavior unless that behavior shares the same explicit target resolver." `add()` does NOT share `resolveQuarantineTarget`, so it is left alone.
- `src/tui-quarantine.ts` — `providerGroupOptions`, `modelOptions`, `quarantineMenuOptions`, `validateHours`, `formatExpiry`, `buildQuarantineToast`. Menu shape, helpers, and glue are unchanged.
- `src/tui.ts` — `promptQuarantineTarget` / `applyQuarantine` glue. Source unchanged; behaviour change is entirely inherited from `resolveQuarantineTarget`. The toast's `expandedCount` will read `1` for individual selections instead of the previous expanded count.
- `src/cli-quarantine.ts` — `runQuarantine` add / release. Source unchanged; the new singleton semantic flows through unchanged call sites.
- The CLI binary — no flag / behaviour change.

If any future work needs the automatic rate-limit path to also stop expanding Gemini Flash, that is a separate change with its own design + plan.

---

## File-by-file change summary

| File | Change | Reason |
|------|--------|--------|
| `tests/model-groups.test.ts` | Rewrite the `provider/model` describe block (4 tests now); refresh header doc comment | Pin the new singleton contract |
| `src/model-groups.ts` | One-line `return [trimmed];`; refresh file-level + function-level doc comments | Minimal fix to align with the approved design |
| `tests/quarantine.test.ts` | Rewrite the `loadFromFile group expansion` describe block (3 tests now) | Pin exact-target preservation on load |
| `src/quarantine.ts` | Drop `resolveModelGroup` import; replace both call sites in `loadFromFile` with `resolveQuarantineTarget` | Persistence preserves exact targets |
| `tests/plugin.test.ts` | One `JSON.stringify` payload swap from single alias to `provider/*` | Integration test aligns with the new contract |
| All other source / test files | Untouched | Out of scope per design |

---

## Reference: key symbols + paths

- `src/model-groups.ts`:
  - `providerOf(modelId)` — unchanged.
  - `resolveProviderGroup(provider)` — unchanged; still drives `provider/*` expansion.
  - `resolveModelGroup(modelId)` — unchanged; still drives the automatic rate-limit path via `QuarantineStore.add` and `loadFromFile`'s manual TTL branch will no longer call this.
  - `resolveQuarantineTarget(target)` — **the only resolver change**: exact-id branch returns `[trimmed]`.
  - `listKnownProviders()` — unchanged.
- `src/quarantine.ts`:
  - `QuarantineStore.add` — unchanged (still expands via `resolveModelGroup`).
  - `QuarantineStore.addManual` — source unchanged; behaviour change inherited from `resolveQuarantineTarget` (individual targets → singleton).
  - `QuarantineStore.release` — source unchanged; same inheritance.
  - `QuarantineStore.loadFromFile` — **call-site change**: `resolveModelGroup` → `resolveQuarantineTarget` at both branches.
  - `QuarantineStore.saveToFile`, `isBlocked`, `snapshot`, `clear`, `clearNonPermanent`, `syncPersistentEntries` — unchanged.
- `src/tui-quarantine.ts` — unchanged.
- `src/tui.ts` — unchanged; `applyQuarantine` inherits the new semantic.
- `src/cli-quarantine.ts` — unchanged; `runQuarantine` add / release inherit the new semantic.

---

## Risk notes for the implementer

- **Legacy file compatibility**: a pre-fix `~/.cache/opencode-model-forecast/quarantine.json` that contained a single Gemini Flash alias used to expand to the full Flash family on next load. After this change, only the listed alias loads. Document this in the PR description so users who relied on the legacy expansion understand the behaviour shift. The plugin will still see the listed alias as blocked; the only difference is the auto-expansion no longer happens.
- **Toast message in TUI**: pre-fix the TUI toast reported e.g. `Quarantined 4 models (google/gemini-3.5-flash) — permanent` for a singleton selection (misleading). Post-fix it correctly reads `Quarantined 1 model (google/gemini-3.5-flash) — permanent`. No user action required; behaviour is now consistent with intent.
- **`buildQuarantineToast` test coverage**: the existing `expandedCount: 1` and `expandedCount: 4` cases cover both shapes — no new test required in `tests/tui-quarantine.test.ts`.
- **No source / test file in this plan is committed in this turn**. The user has not authorized commits; the implementer session will handle commit / PR creation once the change is verified.