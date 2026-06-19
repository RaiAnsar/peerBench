---
description: On-demand panel review (Codex+Kimi+MiMo) of your current changes; `--base <ref>` to review a range. Content-only, fast.
argument-hint: '[--base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

This command runs a panel review of your current working diff. Do not fix issues or apply patches.

Run — pass the arguments as ONE quoted string exactly as shown (the runner
lifts --base from inside the quoted string; never unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" review --json "$ARGUMENTS"
```

Present each reviewer's verdict and the combined result verbatim. Do not paraphrase.
