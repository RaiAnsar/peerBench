---
description: Run a Grok code review against local git state
argument-hint: '[--base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

This command is review-only. Do not fix issues or apply patches.

Run — pass the arguments as ONE quoted string exactly as shown (the runner
lifts --base from inside the quoted string; never unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" review --json "$ARGUMENTS"
```

Return the `rawOutput` verbatim, exactly as-is. Do not paraphrase, summarize, or fix anything it mentions.
