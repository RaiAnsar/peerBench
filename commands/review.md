---
description: On-demand panel review (Codex + Kimi + MiMo + GLM) of the current working changes; pass --base REF to review a commit range instead. Content-only and fast. User-invoked.
argument-hint: '[--base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

Runs a panel review of the current working diff. Do NOT fix issues or apply patches.

Run — pass the arguments as ONE quoted string exactly as shown (the runner lifts `--base` from inside the quoted string; never unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" review --json "$ARGUMENTS"
```

Present each reviewer's verdict and the combined result verbatim. Do not paraphrase.
