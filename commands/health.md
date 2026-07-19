---
description: LIVE health check of the Grok/MiMo review panel, so you know each active reviewer actually works (CLI/login, key, endpoint, model id, and auth) instead of guessing. Pass --all to probe every supported reviewer. User-invoked.
argument-hint: '[--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run (pass args as ONE quoted string exactly as shown):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" health "$ARGUMENTS"
```

Present the output verbatim. ✓ = live probe succeeded (real completion returned). ✗ on an ACTIVE reviewer means the panel will skip it until it recovers — fix Grok login/quota or the MiMo key/endpoint before relying on it.
