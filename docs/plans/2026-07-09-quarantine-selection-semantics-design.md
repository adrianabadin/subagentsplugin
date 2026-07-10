# Quarantine Selection Semantics

## Problem

The TUI currently expands some individual model selections, notably Gemini Flash aliases, into a whole model family. This makes an individual selection behave like an implicit group selection.

## Design

The quarantine target syntax will define behavior unambiguously:

- Explicit group targets shown at the top of the menu quarantine every model in that group.
- Individual model targets shown below quarantine only the exact selected model.
- Individual targets never trigger implicit family expansion, including Gemini Flash aliases.

The menu will continue to list group options first and all registry models afterward. Persistence, backend reconciliation, filtering, and release operations will preserve the resolved exact targets.

## Testing

Regression tests will verify that:

1. Every individual model target resolves to a singleton.
2. Explicit group targets still resolve to every member of the group.
3. Gemini Flash aliases no longer expand when selected individually.
4. Existing persistence and release behavior remains correct for both target types.

## Scope

This change only corrects quarantine target semantics and associated tests. It does not redesign the TUI or change automatic rate-limit quarantine behavior unless that behavior shares the same explicit target resolver.
