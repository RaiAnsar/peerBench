---
description: Multi-model agentic bug hunt. The active peerBench panel scours the repository READ-ONLY and reports concrete bugs (file:line + mechanism + trigger) side by side. Use when the user wants to find bugs, asks what is broken / wonky / unreliable, investigates a symptom, or wants a thorough multi-reviewer sweep of a codebase. Optionally focus it on an area (auth, payments, a specific symptom). Deep and slow (minutes); never edits files.
argument-hint: '[symptom/area/question]'
allowed-tools: Bash(node:*)
---

Run (pass args as ONE quoted string exactly as shown):

```bash
BENCH_SESSION_ID="${CLAUDE_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" hunt "$ARGUMENTS"
```

Present the output verbatim. Then add a short synthesis: which findings multiple reviewers agree on (highest confidence) versus single-reviewer ones. These are UNVERIFIED read-only findings — verify each before fixing.
