---
description: Show the cross-project reviewer scorecard — per-model participation, error/quota rate, blocks, unique catches (blocked when no one else did), and verified TP/FP/precision with a grade. User-invoked.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" scorecard
```

Present the output verbatim. The table merges two layers: objective stats auto-computed from every workspace's review traces, plus the TP/FP/miss grades Claude records after verifying findings. "uniq" (unique blocks — flagged when no other reviewer did) is each model's marginal value; "prec" and the letter grade only firm up once findings have been graded.
