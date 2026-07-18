---
name: bench
description: Run peerBench review, hunt, investigate, setup, status, and reviewer-management commands from Codex. Use when the user asks for peerBench, bench review, bench hunt, bench investigate, bench status, bench setup, or bench reviewers.
---

# peerBench

peerBench is a read-only multi-reviewer panel for code review and bug hunts.

Resolve the plugin root as two directories above this skill directory, infer the
requested subcommand from the user's request and `$ARGUMENTS`, then run exactly
one matching `scripts/bench-runner.mjs` command from the current workspace. For
direct Codex sessions, suppress the Codex reviewer so Codex does not review
itself. Do not append every invocation to a hardcoded `review` command.

```bash
BENCH_SUPPRESS_CODEX_REVIEWER=1 BENCH_SESSION_ID="${CODEX_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "<plugin-root>/scripts/bench-runner.mjs" <subcommand> [arguments]
```

`<plugin-root>`, `<subcommand>`, and `[arguments]` are notation: resolve or
replace them before execution and never pass those literal tokens to the shell.

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
- `health [--all]` — probe configured reviewer health.

Return command output faithfully. Do not edit files unless the user explicitly
asks for fixes after seeing the peerBench output.
