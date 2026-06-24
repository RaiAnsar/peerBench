---
description: Deep multi-model investigation. The full panel (Codex + Kimi + MiMo + GLM) scours the repo READ-ONLY with Kimi thinking ENABLED and a generous budget to trace a hard, specific problem to its root cause. Use for a tough bug or a "why does X happen" question that a quick hunt will not crack. Slower and more thorough than the hunt skill; never edits files.
argument-hint: '[symptom/area/question]'
allowed-tools: Bash(node:*)
---

Run (pass args as ONE quoted string exactly as shown):

```bash
BENCH_SESSION_ID="${CLAUDE_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" investigate "$ARGUMENTS"
```

Present the output verbatim. Then synthesize the root cause and adjudicate any disagreement between the reviewers.
