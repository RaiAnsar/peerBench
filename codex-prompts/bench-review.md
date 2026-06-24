---
description: Run peerBench review on the current working diff, or use --base REF for a range.
argument-hint: '[--base <ref>]'
---

Run this command from the current workspace:

```bash
node "{{BENCH_RUNNER}}" review --json "$ARGUMENTS"
```

Return each reviewer verdict and the combined result from the JSON output. Do not edit files.
