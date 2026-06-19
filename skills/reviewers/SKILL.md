---
name: reviewers
description: Show or set the active review backends for the panel (kimi, mimo, codex, glm). No argument shows the current selection; names set it (e.g. "kimi mimo" or "codex kimi mimo glm"). Takes effect on the next gate run. User-invoked.
argument-hint: '[kimi|mimo|codex|glm ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" reviewers "$ARGUMENTS"
```

Present the output verbatim. With no argument, shows the current active reviewers. With names, sets them in the env-independent `companion.json` and confirms the new selection.
