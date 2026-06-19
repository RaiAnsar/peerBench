---
description: "Three-way agentic bug hunt — Codex, Kimi, and MiMo each scour the repo read-only and report findings side-by-side. Optionally focus it: `/bench:hunt a monitor never alerted me` or `/bench:hunt the auth/session code`. Bare `/bench:hunt` does a broad sweep. Deep + slow (minutes); read-only."
argument-hint: '[symptom/area/question]'
allowed-tools: Bash(node:*)
---

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" hunt "$ARGUMENTS"
```

Present the output verbatim.
