---
description: Re-enable the bench review gates (use `--global` to clear a global disable).
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" on "$ARGUMENTS"
```

Present the output verbatim.
