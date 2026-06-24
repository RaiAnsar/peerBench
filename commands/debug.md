---
description: Get the active multi-model panel (Codex/Kimi/GLM/Qwen/MiMo) to root-cause a SPECIFIC failure read-only. Use when you are stuck debugging — an error, exception, stack trace, failing test, crash, or wrong/unexpected output — and want independent reviewers to find the root cause (file:line + mechanism) and the minimal fix. Pass the error text, what you expected vs. got, and where it happens. Faster and more targeted than a broad hunt; never edits files.
argument-hint: '[error / failing behavior / what you expected vs got]'
allowed-tools: Bash(node:*)
---

Reach for this when a bug is resisting you — instead of guessing alone, get four independent reviewers to trace it. Pass as much concrete detail as you have (error message, stack trace, the failing input, expected vs actual, the file/area you suspect) as ONE quoted string:

```bash
BENCH_SESSION_ID="${CLAUDE_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" debug "$ARGUMENTS"
```

Present the output verbatim. Each reviewer ends with `ROOT CAUSE:` and `FIX:`. Then synthesize: where they agree on the root cause (act on that first), and adjudicate any disagreement. These are READ-ONLY findings — confirm the root cause before applying a fix.
