---
name: off
description: Disable the bench review gates for this workspace (or --global for everywhere). Re-enable with the on skill. User-invoked.
argument-hint: '[--global]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" off "$ARGUMENTS"
```

Present the output verbatim.
