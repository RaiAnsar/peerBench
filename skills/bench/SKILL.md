---
name: bench
description: Run peerBench review, hunt, investigate, setup, status, and reviewer-management commands from Codex. Use when the user asks for peerBench, bench review, bench hunt, bench investigate, bench status, bench setup, or bench reviewers.
---

# peerBench

peerBench is a read-only multi-reviewer panel for code review and bug hunts.

Resolve the plugin root as two directories above this skill directory, then run
`scripts/bench-runner.mjs` with Node from the current workspace. For direct Codex
sessions, suppress the Codex reviewer so Codex does not review itself:

```bash
BENCH_SUPPRESS_CODEX_REVIEWER=1 BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "<plugin-root>/scripts/bench-runner.mjs" review --json "$ARGUMENTS"
```

Use these subcommands:

- `setup` — show reviewer keys, hook health, and active reviewers.
- `status [trace-id]` — show recent traces or expand one trace.
- `review --json [--base <ref>]` — review the current diff/range.
- `hunt [focus]` — run a read-only multi-reviewer bug hunt.
- `investigate <problem>` — run a deeper focused investigation.
- `debug <failure>` — root-cause a specific error or failing behavior.
- `reviewers [names...]` — show or set the active reviewer panel.
- `on [--global]` / `off [--global]` — enable or disable gates.
- `scorecard` — show reviewer performance stats.

Return command output faithfully. Do not edit files unless the user explicitly
asks for fixes after seeing the peerBench output.
