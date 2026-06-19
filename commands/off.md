---
description: Disable the bench review gates for this workspace (or `--global` for everywhere). Re-enable with /bench:on.
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" off "$ARGUMENTS"
```

Present the output verbatim.
