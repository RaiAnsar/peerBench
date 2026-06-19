---
description: Disable the gang review gates for this workspace (or `--global` for everywhere). Re-enable with /gang:on.
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" off "$ARGUMENTS"
```

Present the output verbatim.
