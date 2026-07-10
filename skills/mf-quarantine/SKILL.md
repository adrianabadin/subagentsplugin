---
name: mf-quarantine
description: Use when the user wants to block, quarantine, disable, or rate-limit a model or a whole provider group in OpenCode. Triggers include "quarantine model", "quarantine opencode-go", "block openai", "cuarentena modelo", "bloquear grupo de modelos", "bloquear opencode-go", "disable provider", "set ttl hours", "add manual quarantine", "list quarantines", "release quarantine", "remove from quarantine", "model no longer available". Determines target (exact model or provider group) and duration (permanent or N hours) from the natural-language request, then runs the `model-forecast quarantine` CLI to apply it.
---

# MF Quarantine

This skill lets an AI agent manually quarantine (block) a model or a whole
provider group in OpenCode via natural language. It wraps the
`model-forecast quarantine` CLI subcommand so the agent does NOT have to
hand-edit the persistence file.

## When to invoke

Invoke this skill when the user says anything equivalent to:

- "quarantine `opencode-go/*` for 24 hours"
- "block `openai/gpt-5.5` permanently"
- "disable the `anthropic` provider group"
- "cuarentena modelo google/gemini-3.5-flash 4 horas"
- "bloquear grupo de modelos opencode-go hasta mañana"
- "show me what's currently quarantined"
- "release `opencode-go/deepseek-v4-pro`"

Do NOT invoke this skill for:

- Trivial individual picks the user wants for ONE task — they can pass the
  model id directly to the subagent.
- Quarantines that should only last for the current task (no need to
  persist).
- Diagnosing rate-limit behaviour — the existing
  `forecast` / `doctor` paths surface that.

## Parsing the user request

Extract two pieces of information before running anything:

1. **Target** — `provider/model` for a single model OR `provider/*` for a
   whole provider group.
   - The CLI accepts the literal `provider/*` form. The TUI also has it
     under the Quarantine menu but that requires OpenCode to be loaded.
   - If the user is ambiguous, default to `provider/*` so the quarantine
     applies to every model under that provider.

2. **Duration** — `permanent` OR `N hours` (positive integer).
   - Permanent → `--permanent`
   - N hours → `--ttl-hours N`
   - When no duration is given, default to `--ttl-hours 24` (a day is the
     most common manual-quarantine horizon).

Optional third field:

3. **Reason** — a short free-form label captured in the persistence file
   so the user can audit later. Default: `manual-skill`.

## CLI invocation

```
model-forecast quarantine add <target> [--permanent | --ttl-hours N]
                                     [--reason "..."]
                                     [--file <path>] [--root <path>]
model-forecast quarantine list
model-forecast quarantine release <target>
```

The CLI lives in a separate Node process from the plugin, so it cannot
reach the live in-process `QuarantineStore`. It writes the persistence
file directly, and the change applies on the next plugin load / OpenCode
restart. This is the agent / skill path.

If the user wants the change to take effect WITHOUT a restart, tell them
to open `/forecast-config` → Quarantine in the TUI. The TUI reaches the
live store via the cross-bundle accessor so its mutations are
immediate.

## Examples

### Quarantine a single model for 4 hours

```
model-forecast quarantine add openai/gpt-5.5 --ttl-hours 4 \
  --reason "manual-skill: flaky today"
```

### Block a whole provider group permanently

```
model-forecast quarantine add opencode-go/* --permanent \
  --reason "manual-skill: provider outage"
```

### List current quarantines

```
model-forecast quarantine list
```

Output rows look like:

```
openai/gpt-5.5	manual-skill	expires 2026-07-09T12:00:00.000Z
opencode-go/deepseek-v4-pro	manual-skill	permanent
```

### Release a model

```
model-forecast quarantine release openai/gpt-5.5
```

`release` is group-expanded: `release opencode-go/*` clears every entry
under `opencode-go`.

## Behaviour notes

- `--permanent` and `--ttl-hours` are mutually exclusive.
- `--ttl-hours` must be a positive integer ≤ 8760 (1 year).
- Manual finite-TTL entries are persisted with their numeric `expiresAt`
  AND `manual: true` so a later load can distinguish them from
  rate-limit auto-quarantines (which are in-memory only).
- Manual TTL entries whose `expiresAt` is already in the past are dropped
  on load — a restart after expiry does not "revive" them.
- The TUI sees the same file at the same path. Mutating through the TUI
  also calls `saveToFile`, so the file is always the single source of
  truth.

## Installation / packaging

This skill ships INSIDE the `@aabadin/opencode-model-forecast` npm
package, at `skills/mf-quarantine/SKILL.md` (relative to the package
root). To install it into OpenCode's user-level skills directory:

```bash
# After `npm install -g @aabadin/opencode-model-forecast` (or local install)
mkdir -p ~/.config/opencode/skills/mf-quarantine
cp node_modules/@aabadin/opencode-model-forecast/skills/mf-quarantine/SKILL.md \
   ~/.config/opencode/skills/mf-quarantine/SKILL.md
```

(`.opencode/skills/` works too — OpenCode looks in both.)

## When NOT to invoke

- The user asked to FORECAST or RECOMMEND a model — use the `model-forecast`
  skill instead.
- The user wants to configure availability / benchmark scores — use
  `/forecast-config` → Edit model menu (or the `config` CLI subcommand).
- The user wants to view the current selection state — use `doctor`.