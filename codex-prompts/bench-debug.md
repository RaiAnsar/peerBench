---
description: Run peerBench debug for a specific failure and print the reviewer root-cause output.
argument-hint: '[error / failing behavior / expected vs actual]'
---

Run this command from the current workspace:

```bash
BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "{{BENCH_RUNNER}}" debug "$ARGUMENTS"
```

Return the command output verbatim. Then briefly state the highest-confidence root cause if multiple reviewers agree. Do not edit files unless the user explicitly asks for a fix after reviewing the output.
