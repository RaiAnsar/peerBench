---
description: On-demand panel review (Codex + Kimi + GLM + Qwen + MiMo). Plain — content-only review of the current working changes (fast). Pass a git RANGE (e.g. origin/main..staging) for a DEEP, repo-aware review of those committed commits with the real diff embedded. User-invoked.
argument-hint: '[<range> | --base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

Runs a panel review. Do NOT fix issues or apply patches.

- **No range** → fast content-only review of the current working diff.
- **A git range** (contains `..`, e.g. `origin/main..staging` or `origin/main..HEAD`) → a DEEP, repo-aware review of exactly those committed commits: the real `git diff` is embedded and reviewers may read the repo read-only to verify. This is the correct tool for "review these commits before I merge" — `/bench:hunt` cannot review a diff.

Run — pass the arguments as ONE quoted string exactly as shown (the runner lifts `--base`/the range from inside the quoted string; never unquote):

```bash
BENCH_SESSION_ID="${CLAUDE_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" review --json "$ARGUMENTS"
```

Present each reviewer's verdict and the combined result verbatim. Do not paraphrase. For a range review, also surface the trace id so findings can be re-pulled with `/bench:show <id>`.
