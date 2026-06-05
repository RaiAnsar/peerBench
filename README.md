# grok-companion

A Claude Code plugin that adds **xAI's Grok Build CLI** (`grok`) as a second AI
reviewer alongside the existing OpenAI Codex setup. Plan and spec reviews run
**both** reviewers in parallel (strict AND-pass: either `BLOCK:` blocks); Grok
is also available on demand for delegation and code review.

Built lean and Grok-native — every Grok call is one `grok -p <prompt>
--output-format json` spawn. No app-server, no broker, no persistent processes.

## Requirements

- Node 20+ (developed on 24)
- `grok` (Grok Build CLI) v0.2.20+ on `PATH`, authenticated (`grok` once to log in)
- The Codex companion plugin (`codex@openai-codex`) for the dual panel gates

## Install (local, private)

This repo doubles as a local-directory marketplace (`rai-tools`). In
`~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "rai-tools": { "source": { "source": "directory", "path": "/absolute/path/to/grok-companion" } }
  },
  "enabledPlugins": { "grok-companion@rai-tools": true }
}
```

Restart Claude Code; the `/grok:*` commands appear.

## Commands

- `/grok:setup` — check the grok binary, auth, and per-workspace state
- `/grok:task [--write] <prompt>` — delegate to Grok (read-only by default; `--write` allows edits)
- `/grok:review [--base <ref>]` — Grok code review of local git state
- `/grok:status` — recent grok-companion jobs for this workspace

## Dual-panel plan gates

The two global hooks in `global-hooks/` upgrade the Codex plan gates to run
Codex **and** Grok in parallel:

- `codex-plan-review.mjs` — PreToolUse on ExitPlanMode (native plan mode)
- `codex-plan-file-review.mjs` — PostToolUse on Write/Edit of `**/plans/*.md`, `**/specs/*.md`

Deploy them by copying alongside `panel-lib.mjs` into `~/.claude/hooks/`
(originals are backed up to `*.pre-panel.bak`). Either reviewer's `BLOCK`
blocks; if one reviewer errors the other decides; only when both error does the
gate fail open (with a visible note). Reviews are read-only: a deny-list +
post-run git content fingerprint discards any result where the workspace was
mutated.

## Read-only enforcement (gotchas worth knowing)

- **No `--effort`.** The `grok-build` model rejects `reasoningEffort` (400), so
  grok invocations omit it.
- **Content-only grok review.** Grok returns empty text when a review prompt
  invites it to explore the repo (it spends its turns on tools). The gate
  prepends a grok-specific "review from the provided content, no tools"
  directive — Codex still does the deep file-verifying review via the shared
  prompt.
- **Optional sandbox.** Set `GROK_SANDBOX_PROFILE` in settings `env` to add
  `--sandbox <profile>` once a valid read-only profile name for your grok
  version is known. Unset is fine — permission-mode + deny-list + mutation
  check enforce read-only.

## Test

```bash
npm test          # node --test 'tests/*.test.mjs'  (33 tests)
```

(Note: bare `node --test tests/` does not work on Node 24 — it treats the
directory as a module. Use the glob, or `npm test`.)
