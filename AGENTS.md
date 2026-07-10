

<!-- pmc:autostart -->
## PMC Session Autostart

PMC installs an auto-loaded OpenCode plugin at `.opencode/plugins/pmc.mjs`. On every OpenCode startup the plugin runs a zero-token Node runtime that: launches `refresh-context --enrich` in the background (hash-incremental), launches background enrichment + watchdog if pending symbols exist, ensures a single detached file watcher per project (5-minute per-file quiet debounce → automatic refresh + enrich), and writes the startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` / `latest.md`. Nothing blocks the session; check `pmc watch . --status` or the snapshot to inspect state.

**If the PMC plugin is not installed or is disabled**, run this once per session:

```bash
pmc session-start .
```

Do not manually recreate startup checks in the chat if the plugin already handled startup.

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed
- Ensures the file watcher is running (PID + heartbeat tracked; `pmc watch . --status` / `--stop` to manage)

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent to drain those entries — that is the only step that requires LLM involvement.

## Memory Protocol — Deterministic Triggers

Follow these triggers without being asked. Use the exact, fully-qualified tool names below — never abbreviated or generic names.

### Session lifecycle

- **Session start**: call `pmc-agent-memory_set_session_context` once.
- **Before reading source / changing code**: run `pmc get-context <target>` (default depth `compact`).
- **After implementing code changes**: run `pmc refresh-context --enrich` (PTY-first when available, otherwise Bash) then `pmc sync-context`.
- **Session close**: call `pmc-agent-memory_store_session_summary`.
- **Before AND after compaction**: call `pmc-agent-memory_store_session_summary` immediately to persist the pre-compaction state, then call `pmc-agent-memory_recall` to recover prior context before continuing.

### Plugin-active exception (do NOT duplicate auto-capture)

When the PMC OpenCode plugin is active, do **NOT** manually call these three auto-captured tools:

- `pmc-agent-memory_store_session_prompt`
- `pmc-agent-memory_store_session_response`
- `pmc-agent-memory_store_session_tool_call`

All other memory tools remain your manual responsibility.

### Save triggers → `pmc-agent-memory_store`

Call `pmc-agent-memory_store` IMMEDIATELY after any of these, without being asked:

- Bug fix completed (include root cause)
- Architecture or design decision made
- Tool or library choice made with tradeoffs
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

### Search triggers (local vs global)

| Scope | When | Tools (exact names) |
|-------|------|---------------------|
| Local (current project) | Before reading source, changing code, or answering project-structure questions | `pmc-agent-memory_recall`, `pmc-agent-memory_search`, `pmc-agent-memory_find_related`, `pmc-agent-memory_list_recent` |
| Global (cross-project) | User recalls prior work, conventions, fixes, or patterns that may live outside this project | `pmc-agent-memory_search_global_errors` (read), `pmc-agent-memory_record_error` (write, after a fix) |

### Error tracking

- **BEFORE debugging anything non-trivial**: call `pmc-agent-memory_search_global_errors` to check for a known fix.
- **AFTER resolving an error**: call `pmc-agent-memory_record_error` to persist the root cause and fix for future sessions.

### Topic keys (evolving topics)

- For an evolving topic, call `pmc-agent-memory_suggest_topic_key` then `pmc-agent-memory_upsert_topic_alias` so future updates reuse the same key instead of creating duplicates.
- To look up an existing topic, call `pmc-agent-memory_resolve_topic`.

### Memory lifecycle

- When a stored memory becomes stale or obsolete, call `pmc-agent-memory_update_memory_status` to mark it — do not silently leave outdated facts as trusted context.

### Project registration (install/setup only — NOT agent runtime)

`pmc-agent-memory_register_project` and `pmc-agent-memory_sync_project_metadata` run during PMC install/bootstrap. Do **NOT** call them from agent runtime; the install/setup flow already handles project registration.

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context --enrich` (refreshes graph incrementally, queues and launches enrichment) then `pmc sync-context` to persist new memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `pmc refresh-context --enrich` then `pmc sync-context` | — |
<!-- /pmc:autostart -->
