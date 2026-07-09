---
description: LIVE health check of the review panel — real 1-token API call per provider and a real codex exec in the gate home, so you know each reviewer actually works (key, endpoint, model id, auth) instead of guessing. Pass --all to also probe keyed-but-inactive providers (e.g. verify a new key before activating it). User-invoked.
argument-hint: '[--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" health "$ARGUMENTS"
```

Present the output verbatim. ✓ = live probe succeeded (real completion returned). ✗ on an ACTIVE reviewer means gates are silently skipping it — fix the key/endpoint or swap it out with /bench:reviewers. Note: the Codex probe runs a real `codex exec` at the gate's configured reasoning effort and can take a minute.
