---
description: Check Grok CLI availability, auth, and grok-companion state for this workspace
allowed-tools: Bash(node:*), Bash(grok:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" setup
```

Present the output to the user verbatim. If it reports GROK NOT AVAILABLE, tell the user to install Grok Build CLI and ensure `grok` is on PATH, then stop.
