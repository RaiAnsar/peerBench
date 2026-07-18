---
name: bench
description: Run peerBench review, hunt, investigate, setup, status, and reviewer-management commands from Kimi Code CLI. Use when the user asks for peerBench, bench review, bench hunt, bench investigate, bench status, bench setup, or bench reviewers.
whenToUse: When the user asks for peerBench, a bench review, a bug hunt, an investigation or debug root-cause, bench setup/status/health/scorecard, managing the reviewer panel, or turning bench gates on/off.
---

<!-- peerBench-managed-kimi-skill -->

# peerBench

peerBench is a read-only multi-reviewer panel for code review and bug hunts.

The requested peerBench operation and arguments are:

```text
$ARGUMENTS
```

Infer the intended subcommand from those arguments and the user's request, then
run exactly one matching command below from the current workspace. Do not append
the raw `$ARGUMENTS` string after a hardcoded `review` command.

Use these subcommands:

- `setup` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" setup`
- `status [trace-id]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" status [trace-id]`
- `review --json [--base <ref>]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" review --json [--base <ref>]`
- `review <base..tip> --json` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" review --json <base..tip>`
- `hunt [focus]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" hunt [focus]`
- `investigate <problem>` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" investigate <problem>`
- `debug <failure>` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" debug <failure>`
- `reviewers [names...]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" reviewers [names...]`
- `on [--global]` / `off [--global]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" on [--global]` or `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" off [--global]`
- `scorecard` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" scorecard`
- `health [--all]` — `"${KIMI_SKILL_DIR}/peerbench-launcher.sh" health [--all]`

Return command output faithfully. Do not edit files unless the user explicitly
asks for fixes after seeing the peerBench output.
