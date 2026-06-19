---
description: Show recent bench review traces for this workspace (gate and hunt history). Pass a trace id to expand a single run. User-invoked.
argument-hint: '[trace-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" status "$ARGUMENTS"
```

Present the output verbatim.
