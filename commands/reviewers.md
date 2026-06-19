---
description: Show or set the active review backends. `/bench:reviewers` shows current; `/bench:reviewers codex` uses Codex only; `/bench:reviewers kimi mimo` uses Kimi+MiMo. Takes effect on the next gate run.
argument-hint: '[kimi|mimo|codex ...]'
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" reviewers "$ARGUMENTS"
```

Present the output verbatim. With no argument, shows the current active reviewers. With names (e.g. `codex` or `kimi mimo`), sets the active reviewers in the env-independent `companion.json` and confirms the new selection.
