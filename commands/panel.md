---
description: Toggle the Grok stop-gate panel for this workspace (Grok reviews every code-editing turn alongside Codex)
argument-hint: '[on|off]'
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" panel "$ARGUMENTS"
```

Present the output verbatim. `on` enables Grok stop-gate review for this workspace; `off` disables it; no argument shows the current state. Default is off (plan/spec gates already run both reviewers; this adds Grok to the per-code-turn stop gate).
