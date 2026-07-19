---
description: Run peerBench investigate: a deeper read-only multi-reviewer investigation.
argument-hint: '[symptom/area/question]'
---

Run this command from the current workspace:

```bash
BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "{{BENCH_RUNNER}}" investigate "$ARGUMENTS"
```

Return the command output verbatim. Then synthesize the likely root cause and call out any reviewer disagreement. Do not edit files unless the user explicitly asks for fixes after reviewing the output.
