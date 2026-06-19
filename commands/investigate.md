---
description: "Deep investigation — the full panel (Codex + Kimi + MiMo) scours the repo read-only with Kimi **thinking enabled** and a generous budget. For a hard, specific problem: `/gang:investigate why does the uptime monitor never escalate?`. Slower than /gang:hunt; thorough. Read-only."
argument-hint: '[symptom/area/question]'
allowed-tools: Bash(node:*)
---

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" investigate "$ARGUMENTS"
```

Present the output verbatim.
