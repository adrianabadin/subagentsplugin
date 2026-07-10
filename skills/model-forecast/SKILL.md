---
name: model-forecast
description: Use when a Gentle AI SDD orchestrator needs to recommend a model + effort for a difficult subagent task before delegating. Invokes the model-forecast CLI to read the live model-data cache and return either a 4-field Forecast (`{model, effort, reasoning, fallback}`) or, with `--select`, a 7-field SelectDecision (`{action, subagent_type, model, effort, reason, confidence, evidence}`). Auto-hook mode is opt-in via plugin options — default plugin behaviour returns `{}`.
---

# Model Forecast

This skill is the orchestrator-facing contract for the **model-forecast**
plugin (an OpenCode plugin that caches provider/model/variant/benchmark
data at session start and exposes a pure forecast engine through a CLI).

The plugin itself **never** injects `chat.params` or `tool.execute.before`
hooks. There is no auto-injection in the MVP. To get a recommendation, an
orchestrator must explicitly invoke this skill (or call the underlying CLI
directly).

## When to invoke

Invoke this skill **before delegating** any difficult subagent task where
the orchestrator would otherwise pick a model statically. Concrete
triggers:

- The phase is one of the known SDD/JD phases (`sdd-propose`,
  `sdd-design`, `sdd-spec`, `sdd-tasks`, `sdd-apply`, `sdd-verify`,
  `sdd-archive`, `sdd-onboard`, `sdd-explore`, `jd-judge-a`,
  `jd-judge-b`, `jd-fix-agent`, `orchestrator`).
- The task is non-trivial and the orchestrator wants a model + effort
  recommendation that reflects the live model catalog, not a static
  table.
- A graceful fallback is acceptable when the cache is missing or stale —
  the engine returns a phase-only recommendation using the static rubric
  in that case.

Do **not** invoke this skill:

- For trivial tasks where the orchestrator already knows the right model.
- When the user has explicitly pinned a model in the request — honour the
  user's choice and skip the forecast.

## CLI invocation

The forecast engine is a pure function. The CLI is the canonical entry
point for orchestrators running in a separate agent turn. From the plugin
install directory:

```
node dist/cli.js forecast --phase <phase> [--preset <name>] [--cache <path>]
                           [--verbose | --select]
                           [context flags...]
```

The output flag is mutually exclusive: `--verbose` emits a 7-field
`VerboseForecast`, `--select` emits a 7-field `SelectDecision`, and
without either, the canonical 4-field `Forecast` is emitted
(backward-compat). When both `--select` and `--verbose` are supplied,
`--select` wins (decision JSON).

### Core flags (always available)

| Flag        | Required | Description                                                                 |
|-------------|----------|-----------------------------------------------------------------------------|
| `--phase`   | Yes      | SDD/JD phase identifier, e.g. `sdd-design`, `sdd-apply`, `jd-judge-a`.       |
| `--preset`  | No       | Preset name. One of `balanced` (default), `performance`, `economy`, `diversity`. Unknown names fall back to `balanced`. |
| `--cache`   | No       | Path to a model-data cache JSON. Defaults to `~/.cache/opencode-model-forecast/model-data.json`. |
| `--verbose` | No       | Emit the full VerboseForecast JSON (7 fields: 4 base + `evidence[]`, `confidence`, `alternatives[]`). Without it, the CLI emits the canonical 4-field Forecast JSON (backward compatibility). Mutually exclusive with `--select` (and `--select` wins when both are set). |
| `--select`  | No       | Emit the 7-field `SelectDecision` JSON (advisory selection shape — see "Selecting the agent" below). Mutually exclusive with `--verbose`. Wins over `--verbose` when both are present. |
| `--help`    | No       | Show the usage message.                                                     |

### Context flags (evidence-based scoring; additive, optional)

These flags are **additive** — they do not change the chosen `model` field.
They feed the deterministic scoring pipeline that surfaces
`alternatives[]`, `confidence`, and (with the verbose flag) `evidence[]`.

| Flag name                 | Repeatable | Description                                                                                                |
|---------------------------|------------|------------------------------------------------------------------------------------------------------------|
| `--diff-lines <n>`        | No         | Number of changed lines in the task. Non-negative integer.                                                 |
| `--file <path>`           | Yes        | Path of a file in the task scope.                                                                          |
| `--symbol <name>`         | Yes        | Code symbol referenced by the task.                                                                        |
| `--risk-domain <dom>`     | No         | Risk domain (`feature`, `architecture`, `infra`, `security`, `data`, etc.). Free-form string.               |
| `--context-breadth <b>`   | No         | Breadth of context: `narrow`, `moderate`, or `wide`.                                                       |
| `--modality <type>`       | Yes        | Modality tags (`code`, `docs`, `tests`, etc.).                                                             |

Validation rules:
- `--diff-lines` must parse as a non-negative integer; otherwise the CLI exits 1 with an error mentioning `diff-lines`/`number`.
- `--context-breadth` must be one of `narrow`, `moderate`, `wide`; otherwise the CLI exits 1 with an error mentioning `breadth`.

Exit codes:

- `0` — a Forecast (4-field), VerboseForecast (7-field), or SelectDecision (7-field, with `--select`) JSON was printed to stdout.
- `1` — invalid arguments, or the forecast engine failed.

### Default output (no verbose flag)

```json
{
  "model": "anthropic/claude-opus-4-7",
  "effort": "high",
  "reasoning": "Phase 'sdd-design' → tier 'high' → preset 'balanced' → alias 'opus' → cache model 'anthropic/claude-opus-4-7' matched.",
  "fallback": false
}
```

### Verbose output (with verbose flag)

```json
{
  "model": "anthropic/claude-opus-4-7",
  "effort": "high",
  "reasoning": "Phase 'sdd-design' → tier 'high' → preset 'balanced' → alias 'opus' → cache model 'anthropic/claude-opus-4-7' matched. Evidence-based ranking: 'google/gemini-2.5-pro' (score=0.842, confidence=0.95, top-7).",
  "fallback": false,
  "evidence": [
    { "model": "anthropic/claude-opus-4-7", "factor": "context-fit", "value": 0.4, "source": "anthropic.com/docs/claude-opus-4-7", "date": "2026-04-01", "confidence": 0.95 },
    { "model": "anthropic/claude-opus-4-7", "factor": "cost",        "value": 0.05, "source": "anthropic.com/docs/claude-opus-4-7", "date": "2026-04-01", "confidence": 0.95 },
    { "model": "anthropic/claude-opus-4-7", "factor": "benchmark",   "value": 0.88, "source": "anthropic.com/docs/claude-opus-4-7", "date": "2026-04-01", "confidence": 0.95 },
    { "model": "anthropic/claude-opus-4-7", "factor": "availability","value": 1.0,  "source": "anthropic.com/docs/claude-opus-4-7", "date": "2026-04-01", "confidence": 0.95 }
  ],
  "confidence": 0.95,
  "alternatives": [
    { "model": "google/gemini-2.5-pro", "score": 0.842, "reasoning": "google/gemini-2.5-pro: dominant factor 'context-fit' (composite=0.887, confidence=0.95, evidence date=2026-03-15)." },
    { "model": "anthropic/claude-opus-4-7", "score": 0.731, "reasoning": "anthropic/claude-opus-4-7: dominant factor 'benchmark' (composite=0.769, confidence=0.95, evidence date=2026-04-01)." }
  ]
}
```

## Output shape

### Default (4-field Forecast)

The CLI emits exactly four fields by default:

| Field      | Type      | Meaning                                                                                   |
|------------|-----------|-------------------------------------------------------------------------------------------|
| `model`    | `string`  | `provider/model-id`. Use verbatim as the subagent's model.                                |
| `effort`   | `string`  | One of `""`, `low`, `medium`, `high`, `xhigh`, `max`. The empty string means "default".   |
| `reasoning`| `string`  | Human-readable chain explaining how the recommendation was derived.                       |
| `fallback` | `boolean` | `true` when the preset default was used because the cache was stale, missing, or no model in the cache matched the chosen alias. |

The 4-field shape is the **backward-compatible** contract. Existing
consumers parsing `JSON.parse(stdout)` MUST continue to see exactly
these four fields when the verbose flag is absent.

### Verbose (7-field VerboseForecast)

When the verbose flag is supplied, the CLI emits the 4 base fields PLUS three
additive extensions:

| Field           | Type     | Meaning                                                                                                |
|-----------------|----------|--------------------------------------------------------------------------------------------------------|
| `evidence`      | `array`  | Per-factor citations (`{model, factor, value, source, date, confidence}`). One citation per factor.   |
| `confidence`    | `number` | Aggregated confidence in [0, 1] reflecting evidence presence + freshness.                             |
| `alternatives`  | `array`  | Ranked alternatives (`{model, score, reasoning}`), highest-scoring first. Includes non-Anthropic candidates when present in the registry. |

Verbose output is **strictly additive**. A consumer that ignores the 3
extra fields will see the same 4 base fields as the default output.

## Evidence confidence semantics

Confidence is a composite signal derived from the static evidence
registry (`src/evidence.ts`). It is computed in `src/scoring.ts` via
`computeConfidence(input)`:

- `present=false` (no record) → `CONFIDENCE_MISSING` (0.1) regardless of `freshnessDays`.
- `present=true`, `freshnessDays ≤ CONFIDENCE_FRESH_DAYS` (30 days) → `CONFIDENCE_FRESH` (1.0).
- `present=true`, `freshnessDays ≥ CONFIDENCE_STALE_DAYS` (365 days) → `CONFIDENCE_MISSING` (0.1).
- Between the two thresholds → linear interpolation between `CONFIDENCE_FRESH` and `CONFIDENCE_MISSING`.

`freshnessDays` is computed from the record's `date` field
(ISO-8601) against the current UTC time. Every EvidenceRecord MUST
satisfy:

- `confidence` in [0, 1] (curated-value correctness gate).
- `date` parseable as ISO-8601.
- `source` non-empty (citation audit gate).

Records dated within the 30-day freshness window produce full
confidence. Records past the 365-day stale window collapse to the
missing floor. Records between the two windows produce a
linearly-interpolated confidence.

The orchestrator SHOULD treat `confidence` as a **trust signal**, not a
rank override — a model with low confidence is not necessarily a bad
choice, but the orchestrator should know the recommendation is built on
weak evidence.

## Additive ranking (W1 resolution)

Per the design (#1227) and the PR2 gate (#1235) / decision (#1236),
**the chosen `model` field is ALWAYS derived from the existing
phase/cache path**. Evidence-based scoring is **additive only**:

- The chosen `model` is selected by the same logic as the MVP: phase
  tier → preset alias → cache match → static fallback.
- Evidence-based preference for a non-Anthropic model is surfaced in
  three ADDITIVE places, NEVER as a model override:
  1. `alternatives[]` — the full ranked list, with the highest-scoring
     non-Anthropic candidate (when applicable) included alongside the
     cache-matched model.
  2. `reasoning` — augmented with a one-line "Evidence-based ranking"
     summary when context is supplied.
  3. `confidence` — the top-ranked alternative's confidence score.

**Hard contract:** the chosen `model` is NEVER the top-scored
`alternatives[0].model`. The cache/preset path wins; the alternative is
surfaced for orchestrator visibility but does NOT override.

If a future change introduces evidence-driven model-selection override,
it MUST be a breaking-change proposal — the current contract
guarantees backward compatibility for existing consumers parsing the
4-field Forecast JSON.

When `fallback` is `true`, the orchestrator SHOULD surface a short note
to the user so they know the recommendation came from a static preset
rather than the live catalog.

## Graceful degradation

The forecast engine degrades gracefully in three ways:

1. **Stale cache** — if the cache is older than the 24h TTL, the engine
   returns `DEFAULT_MODEL_FOR_ALIAS[alias]` (the static preset) with
   `fallback: true` and a reasoning note explaining the staleness.
2. **Missing cache** — if the cache file does not exist or is unreadable,
   the engine returns the same static default, with a reasoning note
   that mentions the missing path.
3. **Phase-only fallback** — when project context (PMC/Engram) is
   unavailable, the skill still returns a usable recommendation using the
   static rubric. The orchestrator does not need to retry.

The orchestrator may rely on a forecast being available **always** —
there is no failure path that returns nothing.

## No automatic injection in MVP — opt-in required

The plugin is intentionally non-invasive by default:

- It returns `{}` from its plugin entry. OpenCode therefore uses its
  default chat / tool flow unchanged.
- Without `mode: "auto"`, it does NOT register any hooks.
- `tool.execute.before` is registered **only** when the caller
  passes `mode: "auto"` in plugin options (see "Opting into
  auto-hook mode" above).
- All `--select` recommendations must be requested explicitly via
  this skill (or by calling the CLI directly).
- No `chat.params` mutation, no `model` rewrite, no conversation-
  shaping — only `task` `output.args.subagent_type` may be touched,
  and only in auto mode.

The default-off behaviour matches the user constraint recorded in
`sdd/model-forecast-plugin/decision/hybrid-mvp`. Auto-injection is
opt-in (plugin options) rather than default-on; orchestrators that
do not opt in continue to receive `{}` and must call this skill
(or `--select`) for any forecast.

## How to apply the recommendation

When the orchestrator receives a forecast, it MUST:

1. Read `model` and pass it verbatim to the subagent's `model` parameter.
2. Read `effort`. If it is `""`, omit the effort parameter entirely
   (the empty string means "use the session/model default effort" and
   MUST NOT be written as frontmatter). Otherwise pass the value
   verbatim.
3. If `fallback` is `true`, log a one-line note so the user can decide
   whether to retry later when the cache is fresh.
4. Ignore `reasoning` for control flow — it is informational only.

## When NOT to apply the recommendation

- The user pinned a model explicitly in the original request.
- The task is trivial and a forecast is overkill (see "When to invoke"
  above).
- The forecast is for an unknown phase AND the orchestrator prefers to
  fail loudly rather than use the lowest-tier fallback — in that case,
  surface the unknown-phase warning from `reasoning` to the user.

## Selecting the agent: `--select` and the SelectDecision contract

The CLI accepts an advisory mode flag that emits a structured
selection decision instead of the default Forecast shape. This is
the orchestrator-friendly contract for "what should the next
subagent phase actually run on?":

```
node dist/cli.js forecast --phase <phase> [--preset <name>] [--cache <path>]
                          [--select]
                          [context flags...]
```

`--select` is mutually exclusive with the default Forecast path: a
single CLI invocation emits ONE of the two shapes (decision JSON or
forecast JSON), never both. When both `--select` and `--verbose` are
present, `--select` wins. Without `--select`, the canonical
**4-field Forecast** is emitted (backward-compat, regression-pinned).

### SelectDecision shape (7 fields, all required)

| Field            | Type     | Meaning |
|------------------|----------|---------|
| `action`         | `string` | Closed enum: `"switch"` or `"keep-default"`. Refused auto-mode rewrites also surface as `"keep-default"` with a `reason` text. |
| `subagent_type`  | `string` | The agent alias to dispatch to. Empty string (`""`) when `action === "keep-default"` — signal to the caller: "do not rewrite the agent alias". |
| `model`          | `string` | `provider/model-id` form. Verbatim. |
| `effort`         | `string` | One of `""`, `low`, `medium`, `high`, `xhigh`, `max`. Empty string means "use the session/model default effort" and MUST NOT be written as frontmatter. |
| `reason`         | `string` | Human-readable chain explaining the choice. Contains the rung name and threshold value when a switch fires. |
| `confidence`     | `number` | Aggregated confidence in [0, 1] carried by the chosen candidate. Capped at `MISSING_EVIDENCE_CONFIDENCE` (0.1) when evidence is uncurated. |
| `evidence`       | `string` | Short single-line citation explaining where the score came from. |

Example output:

```json
{
  "action": "switch",
  "subagent_type": "sdd-design",
  "model": "minimax/MiniMax-M3",
  "effort": "medium",
  "reason": "cheapest capable candidate on rung 'minimax' clears threshold 0.6",
  "confidence": 0.85,
  "evidence": "registry: minimax fresh"
}
```

When the runner cannot find a capable candidate, the output stays at
the same 7-field shape but `action` is `"keep-default"` and
`subagent_type` is the empty string:

```json
{
  "action": "keep-default",
  "subagent_type": "",
  "model": "minimax/MiniMax-M3",
  "effort": "",
  "reason": "below threshold 0.6; best candidate 'minimax/MiniMax-M3' at confidence 0.10",
  "confidence": 0.1,
  "evidence": "MISSING_EVIDENCE: no orchestrator scoring supplied to hook"
}
```

### Selection rules (deterministic, pure)

The runner in `src/select.ts` applies the following rules in order.
Same inputs (context, policy, ladder, candidates) → identical
decision. No I/O, no clock, no randomness.

1. **Curated-only confidence** — a candidate whose `evidence`
   string carries a `MISSING_EVIDENCE` / `no-evidence` marker has
   its effective confidence capped at `MISSING_EVIDENCE_CONFIDENCE`
   (0.1) before any threshold check. Uncurated models can never
   slip past the bar.
2. **Anthropic reserved for hardest tier** — the `anthropic` ladder
   rung is consulted ONLY when the task context signals the hardest
   tier (wide context breadth, OR `diffLines >= 1000`, OR a
   security / infra / data risk domain). For moderate tasks, even a
   high-confidence anthropic candidate is treated as if it were
   below threshold.
3. **Cheapest capable wins** — the runner walks the ladder in order
   and picks the EARLIEST rung whose best candidate (cap-then-rank)
   clears `policy.confidenceThreshold`.
4. **Default threshold** — `policy.confidenceThreshold` defaults to
   `0.6` (matches the curated-confidence gate).
5. **Default ladder** — when no project/user override is present,
   the ladder is `[minimax, google-antigravity, openai, glm-5.2,
   anthropic]` (cheapest → hardest).

## Opting into auto-hook mode (PR3 — production-grade)

Auto-hook mode registers a `tool.execute.before` hook on the
`task` tool that can REWRITE the `subagent_type` before OpenCode
dispatches the subagent. **Auto mode is opt-in** — the default
plugin entry still returns `{}` and the orchestrator keeps full
control unless `mode: "auto"` is set.

### Plugin entry (the opt-in)

```ts
// opencode.json — opt into auto-hook mode for the model-forecast plugin
{
  "plugin": [
    ["opencode-model-forecast", {
      "mode": "auto",
      "confidenceThreshold": 0.6,
      "allowlist": ["sdd-design", "sdd-apply", "sdd-verify"],
      "denylist": ["anthropic/claude-opus-4-7"]
    }]
  ]
}
```

When `mode: "auto"` is set, the plugin returns:

```ts
{
  "tool.execute.before": createTaskHook(config, deps)
}
```

The hook ONLY rewrites `task` `output.args.subagent_type`. It never
touches `chat.params`, `model` param, or any other tool argument.
The audit trail is written for every decision (switch, keep-default,
refused).

### Refusal rules (auto-mode safeguards)

The hook refuses a rewrite (keeps the original `subagent_type`,
emits a stderr warning, audits the reason) when:

1. **Missing alias ladder** — the decision is `switch` but its
   `subagent_type` is empty (`""`).
2. **Denylisted model** — the decision's `model` matches an entry
   in `options.denylist`.
3. **Below allowlist** — the orchestrator's `subagent_type` does
   not match an entry in `options.allowlist` (with `''` meaning
   "all").
4. **True re-entry (same callID)** — the hook already handled a
   `task` invocation with this exact `callID`. The guard tracks
   per-call IDs, NOT per-session IDs, so legitimate sequential
   task launches in the same session are still optimised.

Refusals produce a stderr line of the shape:

```
model-forecast: refused auto-mode rewrite for "sdd-design" — <reason>; keeping default.
```

The same refusal is also captured in the audit trail (JSONL +
optional Engram callback). Audit failure NEVER breaks the task
call — it is fire-and-forget and isolated in `safeAudit` /
`writeAuditEntry`.

### Candidate wiring (production-grade)

In production, the hook synthesises a candidate set per task call
because OpenCode does not pass orchestrator-side scores into the
hook. The default candidate factory (`defaultCandidateFactory`) emits
ONE candidate on the cheapest ladder rung, marked with the
missing-evidence confidence floor. That guarantees:

- The hook is **non-inert end-to-end** — the real `select()` runs
  with a non-empty candidate set on every call.
- Without orchestrator scoring, the decision is `keep-default`
  (capped confidence is below threshold) and the hook keeps the
  original `subagent_type`.

Orchestrators with richer scoring can inject a custom factory via
the `resolveCandidates` dep at construction time. The custom factory
must not throw; a thrown factory falls back to the default.



The plugin refreshes its model-data cache at OpenCode session start.
The refresh:

1. Calls `input.client.provider.list()` if OpenCode supplies a client
   (this is the primary data source).
2. Reads `~/.gentle-ai/cache/model-variants.json` as a fallback.
3. Reads `~/.cache/opencode/models.json` as a last-ditch fallback.
4. Writes the merged cache to
   `~/.cache/opencode-model-forecast/model-data.json` atomically
   (tmp + rename, mirroring gentle-ai's `model-variants.ts`).
5. Never throws — every failure is absorbed and the cache is still
   written with whatever the sources + static rubric provided.

The CLI reads the same cache file in a separate process, so the disk is
the only handoff between the plugin init path and the forecast consumer.

## Logging — silent by default

The plugin writes structured logs to
`~/.cache/opencode-model-forecast/plugin.log` regardless of mode. By
default the plugin does NOT write diagnostics to stderr, so it stays
quiet during a normal OpenCode session.

To opt back into full stderr diagnostics (for example when triaging a
routing bug), pass `verbose: true` to the plugin entry:

```js
import modelForecastPlugin from "@aabadin/opencode-model-forecast";
export default modelForecastPlugin(input, { verbose: true });
```

`error`-level entries always reach stderr — verbose only controls
`info`, `warn`, and `trace`.

## Repo-local forecast data (`forecast-data/`)

Override compiled benchmark/cost data without rebuilding the plugin:

```
project-root/
└── forecast-data/
    ├── benchmarks.json   // BenchmarkEntry[] — replace-by-key
    └── overrides.json    // optional preset/ladder/quarantine overrides
```

Each entry in `benchmarks.json` MUST include: `key`, `benchmarks`,
`availability`, `source`, `date`, `confidence`. Merge is
**replace-by-key**: any compiled entry with the same `key` is
shadowed; absent keys stay on the compiled registry. The plugin loads
this file once at init via the project root (defaults to `process.cwd()`).

When `forecast-data/` is absent, malformed, or empty, the plugin logs
a warning and falls back to the compiled registry — never crashes.

## `update-data` CLI

Refresh repo-local benchmark data from a JSON file:

```
node dist/cli.js update-data --from-file <path> [--root <dir>]
```

- `--from-file <path>` (required): JSON array of `BenchmarkEntry`-shaped
  objects. Each entry is validated; if ANY entry is invalid the command
  exits 1 without touching `<root>/forecast-data/benchmarks.json`.
- `--root <dir>` (optional): project root. Defaults to `process.cwd()`.
  The output is `<root>/forecast-data/benchmarks.json` (created via
  `mkdir -p`).

Recommended schedule: run at session start, on project checkout, or
when benchmark sources are refreshed manually. The CLI is
best-effort and never mutates existing data on validation failure.

## `config` CLI

Open an interactive terminal menu to edit repo-local benchmark data
without hand-editing JSON:

```
node dist/cli.js config [--root <dir>] [--non-interactive]
```

- Default mode is interactive and requires a TTY.
- `--root <dir>` points at the target project root. The menu reads and
  writes `<root>/forecast-data/benchmarks.json`.
- `--non-interactive` is a safety flag for scripts/CI: it exits with a
  clear error instead of hanging on stdin.

The menu supports listing, diffing, showing, adding, editing, and
removing model entries. Persistence still uses the same replace-by-key
`forecast-data/benchmarks.json` contract as `update-data`.

## OpenCode integrated config UI

When the TUI entry is available, OpenCode can expose the same config
flow inside the application instead of spawning the terminal menu.

Entry points:

- Slash command: `/forecast-config`
- Alias: `/mf-config`
- Shortcut: `Alt+G` / `Super+G`

The integrated UI edits the same `forecast-data/benchmarks.json` file as
the CLI menu, so both surfaces share one source of truth. The primary
integration uses OpenCode's TUI `api.keymap.registerLayer` surface with a
palette/slash command and configurable shortcut bindings (`Alt+G` / `Super+G` by default). The legacy optional
`api.command` surface is only a fallback; if neither command surface is
present, the plugin degrades gracefully rather than crashing.

## Forecast state file

The plugin writes a JSON snapshot to
`~/.cache/opencode-model-forecast/state.json` after each relevant hook
(config completion, after-hook quarantine). The TUI module reads the
same file to surface the selected model, fallback, quarantine count, and
cache age.

Writes are atomic (`tmp + rename`) and serialized per-path so
concurrent writers cannot tear the file. Readers tolerate missing,
empty, malformed, or wrong-type payloads and fall back to "no state" —
never crash the TUI.
