# Live Model Availability Validation Before Dispatch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make generated task rewrites fail closed unless the exact selected `provider/model` is present in the current successful live provider snapshot and is not exactly quarantined, while keeping cached data advisory.

**Architecture:** `modelForecastPlugin` owns session-scoped live availability separate from `GeneratedProfileCatalog`. The config hook records `ready(Set<provider/model>)` only after a successful bound `client.provider.list()` parse; failures record `unavailable(reason)` while cache fallback may still generate/rank profiles. `createTaskHook` authorizes the selected candidate once, immediately before mutating `output.args.subagent_type`, preserving the original type and refusing fallback/tracking on failure.

**Tech Stack:** TypeScript, Vitest, OpenCode plugin hooks, `QuarantineStore`, existing `Logger`/`warnSink` and selection audit types.

---

## Contract and Non-Negotiable Invariants

- Eligible prediction candidates = exact models present in the current successful `client.provider.list()` snapshot ∩ models not currently quarantined by exact provider/model.
- Cache models may score or populate generated profiles, but cache-only data can never authorize a generated profile or task rewrite.
- Matching is case-preserving and exact on the complete `provider/model` string; `xiaomi/mimo-v2.5-pro` and `crof/mimo-v2.5-pro` remain independent.
- Authorization happens after `select()` and before `output.args.subagent_type` mutation. Do not silently choose another generated profile.
- Refusal keeps the original type, emits one concise CLI diagnostic and one structured selection-audit cause, skips `tracking.set`, and does not append to `.opencode/logs/subagent-interruptions.jsonl`.

### Task 1: Add session live-availability state and config-hook capture

**Files:**
- Modify: `src/plugin.ts` — `modelForecastPlugin`, config hook, `withTimeout`, `PluginClient`, and hook construction.
- Modify: `src/hooks.ts` — `TaskHookDependencies` and `createTaskHook` dependency wiring.
- Modify: `src/types.ts` — structured refusal-cause type on `SelectionAuditEntry`.
- Test: `tests/plugin.test.ts`.

**Step 1: Write RED tests.** Cover a bound successful `provider.list()` producing a case-preserving exact `Set`, a missing provider/list, synchronous throw, rejected promise, timeout, malformed/empty result, and cache fallback. Assert that only the successful live result becomes authorization state; cache fallback still populates the catalog but leaves state `unavailable`.

**Step 2: Run focused RED verification.** `npm exec vitest run tests/plugin.test.ts -t "live availability|provider.list|cache fallback"`; expected failures identify the missing state/dependency contract.

**Step 3: Implement GREEN behavior.** Add an internal `LiveAvailability` union (`ready`/`unavailable`), capture it only around the bound timeout-protected call in the config hook, and pass a read-only authorization callback/state into `createTaskHook`. Preserve existing best-effort cache/profile generation and diagnostics.

**Step 4: Run focused GREEN verification.** Repeat the focused Vitest command; expected PASS, including the method-binding and timeout cases.

### Task 2: Add final exact authorization at the rewrite boundary

**Files:**
- Modify: `src/hooks.ts` — `TaskHookDependencies`, `createTaskHook`, `keepDefaultFrom`, `safeAudit` call.
- Modify: `src/types.ts` — optional `refusalCause`/machine-readable cause on `SelectionAuditEntry`.
- Test: `tests/hooks.test.ts`.

**Step 1: Write RED tests.** Force `select()` to return a high-confidence switch and assert: (a) exact live/non-quarantined model rewrites and tracks; (b) cache-only model with unavailable snapshot keeps original type; (c) absent exact key keeps original type; (d) exact quarantine keeps original type; (e) no alternate candidate is selected; (f) `tracking` remains unchanged; (g) one `warnSink` line and matching audit cause are emitted.

**Step 2: Run focused RED verification.** `npm exec vitest run tests/hooks.test.ts -t "live|quarantined|not live|snapshot|tracking|refusal"`; expected failures before the authorization gate exists.

**Step 3: Implement GREEN behavior.** On a switch decision, check exact quarantine first, then snapshot readiness, then exact membership. Convert failures with `keepDefaultFrom`; attach `candidate_quarantined`, `live_snapshot_unavailable`, or `candidate_not_live`; only mutate and call `tracking.set` after all checks pass. Keep audit/warning failures best-effort and refusal-effective.

**Step 4: Run focused GREEN verification.** Repeat the command and confirm all refusal assertions pass.

### Task 3: Keep profile resolution advisory and quarantine provider-specific

**Files:**
- Modify: `src/profiles.ts` — `createGeneratedProfileResolver` and any silent quarantine filtering.
- Test: `tests/profiles.test.ts`, `tests/quarantine.test.ts`.

**Step 1: Write RED tests.** Assert resolver ranking can still return cache-backed profiles for advisory scoring, but authorization is not performed there; assert exact quarantine blocks only its exact route and does not canonicalize aliases or model families.

**Step 2: Run focused RED verification.** `npm exec vitest run tests/profiles.test.ts tests/quarantine.test.ts -t "advisory|exact|provider|quarantine"`.

**Step 3: Implement GREEN behavior.** Remove/avoid resolver behavior that silently changes the selected candidate solely because it is quarantined; leave final refusal to the rewrite boundary. Preserve profile generation and score ordering.

**Step 4: Run focused GREEN verification.** Repeat the command; expected PASS for advisory ranking and provider isolation.

### Task 4: Add CLI diagnostic and integration assertions

**Files:**
- Modify: `src/plugin.ts`/`src/hooks.ts` — concise `model-forecast` refusal diagnostics through existing logger/warn sink.
- Test: `tests/plugin.test.ts`, `tests/hooks.test.ts`, `tests/integration.test.ts`.

**Step 1: Write RED tests.** Assert one CLI line per refusal with the original subagent type, exact model, and cause; assert logger/audit sink exceptions do not allow rewriting; assert live success rewrites normally and cache-only/unavailable does not.

**Step 2: Run focused RED verification.** `npm exec vitest run tests/plugin.test.ts tests/hooks.test.ts tests/integration.test.ts -t "diagnostic|audit|sink|live|rewrite"`.

**Step 3: Implement GREEN behavior.** Centralize the message formatting at the refusal branch, retain normal logger output, and ensure sink failures are swallowed without changing the decision.

**Step 4: Run focused GREEN verification.** Repeat the command and inspect captured stderr/audit entries for exact counts and causes.

### Task 5: Dependent work item — implement interruption JSONL separately

This work starts only after Tasks 1–4 are complete. It must not classify availability refusals as interruptions.

**Files:**
- Create/modify: `src/interruption-audit.ts` — append-only event sink and abort lifecycle helper for `abort_requested`, `abort_resolved`, `abort_rejected`, `abort_timeout`.
- Modify: the existing centralized `session.abort` wrapper identified by repository search; do not connect it to `createTaskHook` refusal handling.
- Modify: `src/types.ts` — interruption event union and correlation fields.
- Modify: `.gitignore` — ignore `.opencode/logs/subagent-interruptions.jsonl`.
- Test: new focused interruption-audit tests plus the existing abort-wrapper tests.

RED/GREEN coverage must assert JSONL validity, correlation IDs, immediate stderr output, timeout/rejection outcomes, best-effort filesystem failure, and no event for completed tasks. Verify that a `candidate_not_live` or `candidate_quarantined` refusal writes zero interruption events.

## Staged Verification Commands

1. `npm exec vitest run tests/plugin.test.ts -t "live availability|provider.list|cache fallback"`
2. `npm exec vitest run tests/hooks.test.ts tests/profiles.test.ts tests/quarantine.test.ts -t "live|refusal|exact|provider|quarantine"`
3. `npm exec vitest run tests/plugin.test.ts tests/hooks.test.ts tests/integration.test.ts`
4. `npm exec tsc --noEmit`
5. `npm exec vitest run`
6. For the dependent interruption work only: `npm exec vitest run tests/interruption-audit.test.ts` and inspect a temporary JSONL fixture with `node` JSON parsing.

Expected final verification: all focused tests pass, type checking passes, full Vitest passes, exact provider/model identity is preserved, cache-only candidates never authorize rewrites, and availability refusals do not appear in interruption JSONL.

Changed file: `docs/plans/2026-07-15-live-model-availability-validation-plan.md`
skill_resolution: paths-injected
