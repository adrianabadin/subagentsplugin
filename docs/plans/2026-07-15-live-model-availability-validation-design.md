# Live Model Availability Validation Before Dispatch

Generated profiles remain recommendations, not authority. A task rewrite is authorized only when the selected profile's exact `provider/model` is present in the current plugin session's successful `client.provider.list()` snapshot and is not quarantined.

## Required Invariants

| Concern | Invariant |
| --- | --- |
| Cached provider data | Advisory only. Cache data may generate/rank profiles but must never authorize dispatch. |
| Live availability | Match the complete, case-preserving `provider/model` key exactly. No alias, suffix, or canonical-family matching. |
| Quarantine | `isBlocked(exactModelId)` always rejects that candidate. `xiaomi/mimo-v2.5-pro` and `crof/mimo-v2.5-pro` are independent identities. |
| Refusal | Preserve the original subagent type, emit one concise CLI diagnostic and an audit cause, and create no tracking/fallback state for the rejected candidate. |

## Technical Approach

`modelForecastPlugin` owns a session-scoped live snapshot with two states: `ready(Set<provider/model>)` and `unavailable(reason)`. The config hook replaces this state only from the result of its bound, timeout-protected `client.provider.list()` call. Disk cache fallback may still populate `GeneratedProfileCatalog`, but it never mutates the live snapshot.

Selection remains advisory. After `select()` proposes a generated profile, `createTaskHook` runs a final authorization dependency immediately before mutating `output.args.subagent_type`. Authorization checks exact quarantine, snapshot readiness, then exact membership. A refusal converts the decision to `keep-default`, leaves the original type untouched, skips `tracking.set`, and does not try another generated profile.

The always-visible diagnostic uses the existing `warnSink`; `Logger.warn` keeps the same cause in the normal plugin log. `SelectionAuditEntry` records the rejected model and a machine-readable cause such as `candidate_quarantined`, `live_snapshot_unavailable`, or `candidate_not_live`.

## Architecture Decisions

| Option | Tradeoff | Decision |
| --- | --- | --- |
| Filter while profiles are generated | Simple, but cache-backed generation can accidentally authorize and the snapshot may change later. | Reject. |
| Filter candidates before `select()` | Allows silent selection of a different generated fallback instead of preserving the original type. | Reject. |
| Validate the selected candidate at the rewrite boundary | Central fail-closed guard; preserves advisory ranking and provides the exact refusal cause. | Adopt. |
| Canonicalize aliases across providers | Hides access-route differences and over-broadens quarantine. | Reject; exact identity only. |

## Data Flow

```text
client.provider.list() ──success──> session live Set<provider/model>
          │ failure/timeout ──────> unavailable(reason)
          │
          └─ cache fallback ──────> generated profiles (advisory only)

task → resolve/rank → selected generated profile
                    → exact quarantine + live-set authorization
                       ├─ allowed → rewrite + tracking
                       └─ refused → original type + CLI/audit cause
```

## Failure Behavior

| Condition | Behavior |
| --- | --- |
| Client/list method missing, throws, times out, or is unparseable | Mark live availability unavailable; refuse every generated rewrite. |
| Successful live snapshot lacks the exact key | Refuse with `candidate_not_live`; cached presence is irrelevant. |
| Exact key is quarantined | Refuse with `candidate_quarantined`; do not dispatch or invoke fallback for it. |
| Diagnostic/audit sink fails | Keep the refusal effective; sink failures remain best-effort. |

## Interruption JSONL Boundary

Do **not** append this refusal to `.opencode/logs/subagent-interruptions.jsonl`. That design is causally scoped to plugin-initiated `session.abort` operations and its `abort_requested/resolved/rejected/timeout` lifecycle. A pre-dispatch refusal creates no subagent session and no interruption; adding a non-abort event would make the file's name and event contract misleading. Keep the event in the normal logger and selection audit instead.

## Files Likely Affected

| File | Change |
| --- | --- |
| `src/plugin.ts` | Capture the live session snapshot separately from cache fallback and inject final authorization. |
| `src/hooks.ts` | Authorize immediately before rewrite; refuse visibly and skip tracking/fallback. |
| `src/profiles.ts` | Keep resolution/ranking advisory; remove quarantine behavior that silently selects another profile. |
| `src/types.ts` | Add an optional structured refusal cause to selection audit entries. |
| `tests/plugin.test.ts` | Cover live, unavailable, absent, and cache-only session wiring. |
| `tests/hooks.test.ts` | Pin fail-closed rewrite, diagnostic, audit cause, and no tracking. |
| `tests/profiles.test.ts`, `tests/quarantine.test.ts` | Pin advisory resolution and provider-specific exact identities. |

## Testing Acceptance Criteria

- [ ] A cache-only candidate never rewrites a task when the live snapshot is unavailable.
- [ ] An exact live, non-quarantined candidate can rewrite normally.
- [ ] An absent or quarantined selected candidate preserves the original type and cannot trigger fallback.
- [ ] Blocking `xiaomi/mimo-v2.5-pro` does not block `crof/mimo-v2.5-pro`.
- [ ] Each refusal emits one concise CLI line and the matching structured audit cause.
- [ ] Audit/logger failures cannot turn a refusal into an allowed dispatch.

## Out of Scope

- Cross-provider or model-family group quarantine and alias equivalence.
- Per-task provider refresh, cache schema changes, or provider discovery redesign.
- Changes to recursive post-dispatch fallback/error classification.
- Adding refusal events to the session-interruption JSONL schema.
- Data migration or feature flags; this is an in-session authorization guard.
