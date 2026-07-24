---
description: On-demand bounded Grok/MiMo review of working changes or an exact Git range. Infrastructure failure is advisory unless --strict is passed. User-invoked.
argument-hint: '[--strict] [<range> | --base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

Runs a panel review. Do NOT fix issues or apply patches.

- **No range / `--base REF`** → bounded one-shot review of committed, staged, worktree, and
  untracked evidence (one-minute reviewer budget).
- **A git range** (contains `..`, e.g. `origin/main..staging` or `origin/main..HEAD`) → the exact
  commit list and real `git diff` are embedded in the same one-shot review. Use `/bench:hunt` or
  `/bench:investigate` separately when deeper repository exploration is actually wanted.

Run — pass the arguments as ONE quoted string exactly as shown (the runner lifts `--base`/the range from inside the quoted string; never unquote):

```bash
BENCH_SESSION_ID="${CLAUDE_SESSION_ID:-${BENCH_SESSION_ID:-}}" node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" review --json "$ARGUMENTS"
```

Present each reviewer's verdict and the combined result verbatim. Do not paraphrase. A concrete
`decision: "block"` stops the requested work. `fail-open` or `unreviewed` is not reviewer approval,
but is advisory: do not describe peerBench as a blocking gate and continue the requested work using
the primary agent's local validation unless `--strict` was requested. Under `--strict`, every
active reviewer must return a usable non-blocking verdict; one `ALLOW` plus one provider error is
`decision: "unreviewed"` and must return nonzero.
For a range review, also surface the trace id so findings can be re-pulled with `/bench:show <id>`.
