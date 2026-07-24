---
description: Run a bounded one-shot peerBench review on current changes or an exact positional base..head range.
argument-hint: '[--strict] [--base <ref> | <range>]'
---

Run this command from the current workspace:

```bash
BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "{{BENCH_RUNNER}}" review --json "$ARGUMENTS"
```

Return each reviewer verdict and the combined result from the JSON output. Do not edit files.
A concrete `decision: "block"` stops the requested work. `fail-open` or `unreviewed` means no
usable reviewer approval, but is advisory by default: do not report peerBench as a blocking gate;
continue using the primary agent's own local validation unless the user passed `--strict`.
Under `--strict`, every active reviewer must return a usable non-blocking verdict. One `ALLOW`
plus one provider error is `decision: "unreviewed"` and returns nonzero.
