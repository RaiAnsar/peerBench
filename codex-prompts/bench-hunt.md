---
description: Run peerBench hunt: a read-only multi-reviewer bug hunt over the current repo.
argument-hint: '[symptom/area/question]'
---

Run this command from the current workspace:

```bash
BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "{{BENCH_RUNNER}}" hunt "$ARGUMENTS"
```

Return the command output verbatim. Then add a short synthesis separating findings multiple reviewers agree on from single-reviewer findings. Do not edit files unless the user explicitly asks for fixes after reviewing the output.
