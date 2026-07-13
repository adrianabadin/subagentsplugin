# @aabadin/opencode-model-forecast

Model + effort forecast plugin for [OpenCode](https://opencode.ai): caches provider/model/benchmark data at startup, recommends a model per SDD phase, and (in auto mode) routes the next subagent phase to the cheapest viable rung on the cost ladder. Adds a **429 fallback quarantine** layer that, on rate limit, marks a model as unavailable for a configurable TTL (default 60 min) and auto-selects the next viable rung on subsequent tasks of the same phase.

## Features

- **Forecast engine** — pure `forecast(input)` returns `{ model, effort, reasoning, fallback }`. Verbose mode additively exposes evidence, confidence, and alternatives.
- **Generated profiles** — at session start (auto mode), the plugin generates one hidden `__mf_<base>__<model>_<hash>` agent per base SDD phase × connected model, in-memory via the OpenCode `config` hook. Prompts and permissions are preserved; only `model` changes.
- **Selection policy** — opt-in auto mode rewrites `task.subagent_type` to the cheapest viable rung that meets the confidence threshold. Threshold + ladder are configurable.
- **429 fallback quarantine** (new in 0.2.0) — when a subagent task output matches a known rate-limit pattern (`usage_limit_reached`, `HTTP 429`, `AI_APICallError: ...`, `\b429\b`, etc.), the model is quarantined for the configured TTL. Subsequent tasks of the same phase auto-skip that rung. Audit entry + stderr warning with the next viable model.
- **CLI** — `model-forecast --phase <phase> [--verbose] [--diff-lines N] [--risk-domain ...]` for offline forecasting.
- **Loader-clean** — plugin root is a single default export; OpenCode accepts the package directly.

## Install

### Global (recommended for personal use)

```bash
npm install -g @aabadin/opencode-model-forecast
```

Then add to your OpenCode config (`~/.config/opencode/opencode.json` or any project-level `.opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@aabadin/opencode-model-forecast"]
}
```

OpenCode auto-discovers the package from the global `node_modules`.

### Per-repo (recommended for teams / CI)

```bash
npm install @aabadin/opencode-model-forecast
```

Then add the same line to the repo's `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@aabadin/opencode-model-forecast"]
}
```

OpenCode scans the project's `node_modules` and loads the plugin from there.

### With options

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@aabadin/opencode-model-forecast", {
      "mode": "auto",
      "allowlist": ["sdd-design", "sdd-apply"],
      "quarantine": {
        "enabled": true,
        "ttlMs": 3600000
      }
    }]
  ]
}
```

## Plugin options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"advisory" \| "auto"` | `"advisory"` | `advisory` returns `{}` (no hooks). `auto` registers `config` + `tool.execute.before` + `tool.execute.after`. |
| `confidenceThreshold` | number | `0.6` | Minimum confidence for a switch decision. Below the threshold, the plugin keeps the configured default and emits an audit skip. |
| `allowlist` | string[] | `[]` | Only subagent types starting with one of these prefixes get rewritten. Empty = no allowlist. |
| `denylist` | string[] | `[]` | Models in this list are never switched to, even if the selection picks them. |
| `generatedProfiles.phasePrefixes` | string[] | `["sdd-"]` | Phase prefixes used to generate per-phase profile aliases. |
| `generatedProfiles.enabled` | boolean | `true` | Master switch for generated-profile routing. |
| `quarantine.enabled` | boolean | `true` (when `mode === "auto"`) | Enable the 429 fallback quarantine. Set `false` to skip the after hook entirely. |
| `quarantine.ttlMs` | number | `3600000` (60 min) | Time-to-live for a quarantined model. |
| `recovery.enabled` | boolean | `true` (when `mode === "auto"`) | Enable supervised recovery, watchdogs, and parent recovery without disabling model selection. |
| `recovery.timeouts.INACTIVITY_TIMEOUT_MS` | number | `180000` | Override the inactivity watchdog for reasoning models that do not emit OpenCode activity heartbeats. |

Reasoning models may spend several minutes before emitting visible output. The
recovery watchdog treats every child-session event, including repeated busy
status events, as activity. If a provider emits no heartbeats during reasoning,
increase `recovery.timeouts.INACTIVITY_TIMEOUT_MS` instead of disabling
recovery entirely.

## CLI

After install, the `model-forecast` binary is on your PATH:

```bash
model-forecast --phase sdd-design --verbose
model-forecast --phase sdd-apply --diff-lines 250 --risk-domain update
model-forecast --phase sdd-tasks --context-breadth package --modality code
```

Run `model-forecast --help` for the full flag list.

### `quarantine` subcommand

Manually block a model or a whole provider group — either permanently or
for a TTL you specify in hours. Persists to
`~/.cache/opencode-model-forecast/quarantine.json` so the block survives
plugin restarts. Rate-limit auto-quarantines (60-min TTL) stay in memory
only and are NEVER persisted, so the manual and automatic layers don't
interfere.

```bash
# Block a single model permanently
model-forecast quarantine add openai/gpt-5.5 --permanent --reason "billing issue"

# Block a model for 24 hours
model-forecast quarantine add openai/gpt-5.5 --ttl-hours 24

# Block an entire provider group (expands via the benchmark registry)
model-forecast quarantine add opencode-go/* --permanent

# List current quarantines
model-forecast quarantine list

# Release (group-expanded — `opencode-go/*` clears every alias)
model-forecast quarantine release openai/gpt-5.5
```

Mutations take effect on the next plugin load (the CLI lives in a
different process from the plugin). For **immediate in-session effect**
open the TUI (`/forecast-config` → Quarantine), which mutates the live
in-process `QuarantineStore` via a `globalThis`-backed cross-bundle
singleton.

An AI-agent skill (`mf-quarantine`) also ships inside the package at
`skills/mf-quarantine/SKILL.md`. Copy it into
`~/.config/opencode/skills/mf-quarantine/SKILL.md` to invoke it from
natural-language prompts.

## Plugin behavior contract

- **Default (`mode: "advisory"`)** — the plugin returns `{}`. OpenCode uses its native model resolution. The CLI and skill still work for offline forecasting.
- **Auto (`mode: "auto"`)** — the plugin registers three hooks:
  - `config` — generates per-phase profiles from connected models.
  - `tool.execute.before` — when the orchestrator launches a task for an allowed phase, rewrites `subagent_type` to a generated profile if the selection confidence exceeds the threshold.
  - `tool.execute.after` — when the task output matches a rate-limit pattern, quarantines the model and emits an audit + stderr warning with the next viable model.

The failing task still returns its error to the orchestrator. The next task of the same phase auto-picks the next rung of the cost ladder.

## Rollback

To disable everything without uninstalling:

```json
{
  "plugin": [
    ["@aabadin/opencode-model-forecast", {
      "mode": "advisory",
      "quarantine": { "enabled": false }
    }]
  ]
}
```

## Develop

```bash
git clone https://github.com/aabadin/opencode-model-forecast.git
cd opencode-model-forecast
npm install
npm test
npm run typecheck
npm run build
```

Requires Node `>=24 <25` and OpenCode `>=1.17.11`.

## Architecture

- `src/index.ts` — clean plugin entry (default export only).
- `src/plugin.ts` — plugin implementation; `modelForecastPlugin(input, options)` returns hooks or `{}`.
- `src/api.ts` — public API barrel (`forecast`, `refreshCache`, scoring, evidence, types).
- `src/quarantine.ts` — `QuarantineStore` (TTL-keyed, idempotent add, injectable clock).
- `src/hooks.ts` — `createTaskHook`, `createAfterHook`, `detectRateLimit`, `parseGeneratedAlias`.
- `src/profiles.ts` — generated-profile catalog + `createGeneratedProfileResolver` (with optional quarantine filter).
- `src/select.ts`, `src/scoring.ts`, `src/evidence.ts` — selection engine.
- `src/policy.ts` — default cost ladder (`minimax → google-antigravity → openai → glm-5.2 → anthropic`).
- `src/audit.ts` — non-throwing audit sink.
- `dist/` — ESM build (tsup) with `.d.ts` for `./api` and `.`.

## License

MIT — see [LICENSE](./LICENSE).

## Links

- Repository: <https://github.com/aabadin/opencode-model-forecast>
- Issues: <https://github.com/aabadin/opencode-model-forecast/issues>
- Related: [OpenCode plugin docs](https://opencode.ai/docs/plugins/)
