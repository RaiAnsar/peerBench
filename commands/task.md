---
description: Delegate a task to Grok (read-only by default; --write to allow edits)
argument-hint: '[--write] <task description>'
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run — pass the arguments as ONE quoted string exactly as shown (the runner
lifts leading flags like --write safely from inside the quoted string; never
unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" task --json "$ARGUMENTS"
```

Rules:
- Default is read-only investigation. Only include --write when the user asked for actual edits.
- Return the `rawOutput` from the JSON verbatim. Do not paraphrase.
- If status is nonzero, show the error and suggest /grok:setup.
