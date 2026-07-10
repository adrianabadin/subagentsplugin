---
description: Open the model forecast config menu. Runs the interactive CLI to edit availability, benchmarks, and pricing in forecast-data/benchmarks.json.
agent: general
---

Run the model forecast configuration menu from the current project root.

Use this exact command:

```bash
node dist/cli.js config $ARGUMENTS
```

Rules:

- Preserve any user-provided `$ARGUMENTS` exactly.
- Do not rewrite the command into another tool or another path.
- If the command fails, report the stderr output briefly and stop.
- If it succeeds, briefly confirm that the interactive menu was launched.
