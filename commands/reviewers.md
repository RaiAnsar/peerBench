---
description: Show or set the active review backends for the panel (grok and mimo). No argument shows the current selection; names set it (for example, "grok mimo" or "mimo"). Takes effect on the next gate run. User-invoked.
argument-hint: '[grok|mimo ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" reviewers "$ARGUMENTS"
```

Present the output verbatim. With no argument, shows the current active reviewers. With names, sets them in the env-independent `companion.json` and confirms the new selection.
