# grok-companion — Grok Build CLI integration for Claude Code

**Date:** 2026-06-05
**Status:** Approved design (brainstormed with Rai; revised per Codex review rounds 1–2)
**Repo:** private GitHub (publish later), local at `~/Desktop/Personal/Tools/grok-companion`

## Purpose

Integrate xAI's Grok Build CLI (`grok`, v0.2.20+) into Claude Code as a second
AI reviewer and delegation target, alongside the existing OpenAI Codex setup.
Modeled on the codex plugin's *shape* (commands, rescue agent, hooks,
per-workspace state) but built lean and Grok-native — no app-server, no broker.

## Decisions (locked)

1. **Role:** parallel second reviewer + on-demand delegation. Not a Codex
   replacement.
2. **Verdict combination:** strict AND-pass — if either reviewer returns
   `BLOCK:`, the work is blocked. Findings labeled `[Codex]` / `[Grok]`.
3. **Default panel scope:** plan/spec reviews run BOTH reviewers in parallel;
   stop-gate reviews stay Codex-only. Per-project upgrade to dual stop gates
   via `/grok:panel on`.
4. **Architecture:** lean native plugin wrapping headless `grok` directly.
   Rejected: forking openai/codex-plugin-cc (~50% of it is app-server broker
   plumbing Grok doesn't need; upstream merge churn).
5. **Distribution:** private GitHub repo now, installed as a **local directory
   marketplace** — which requires a marketplace manifest from day one (see
   Distribution). Publishing later only changes repo visibility + docs.

## Why lean-native is safe for Grok

`grok` is already headless-friendly, verified on this machine:

- `grok -p "<prompt>" --output-format json` → single-turn, returns
  `{ text, stopReason, sessionId, requestId }` (live-tested: GROK-OK).
- `--cwd`, `--effort low|medium|high|xhigh|max`, `--max-turns N`,
  `--sandbox <profile>`, `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`,
  `--resume <sessionId>`, `--tools` / `--disallowed-tools`, `--no-subagents`,
  `--disable-web-search`.
- `grok agent` subcommand for richer headless runs if needed later.

No persistent process means the broker-corpse failure class (dead socket →
status-1 spam, stale-binary-after-upgrade) cannot exist here.

## Read-only enforcement for ALL review invocations

Applies identically to gate-side spawns (global hooks) and runner-side review
subcommands — review prompts must not be able to mutate workspaces:

1. **Primary:** `--permission-mode plan` (Grok's read-only planning mode) +
   `--disallowed-tools` covering Grok's write/exec tool names (exact names
   enumerated during implementation from `grok inspect`/docs) +
   `--no-subagents --disable-web-search --max-turns 8 --effort medium`.
2. **Sandbox profiles:** `--sandbox <PROFILE>` is additionally applied IF
   profile names can be discovered (try `grok inspect --json`, `GROK_SANDBOX`
   env docs, `grok --help` of the installed version). Discovery failure is
   expected (v0.2.20 exposes the flag but documents no profile names) and is
   NOT an error — the flag is simply omitted and layer 1 carries enforcement.
3. **Verification:** implementation includes a probe test — a review prompt
   instructed to attempt a file write must come back with the file untouched;
   if Grok's JSON reports edits/tool-use indicating mutation, the run is
   treated as a review failure (fail open, visible note), never trusted.

`--write` delegation tasks (rescue-style) relax this deliberately:
default permission mode, no disallowed write tools, higher `--max-turns`.

## Plugin layout

```
grok-companion/
  .claude-plugin/
    plugin.json           # name: grok-companion
    marketplace.json      # required for local-directory marketplace install:
                          # { name, owner, plugins: [{ name, source: "./" }] }
  commands/
    review.md      # /grok:review — review working tree or branch diff
    task.md        # /grok:task — delegate a task to Grok (rescue-style)
    panel.md       # /grok:panel on|off — toggle dual stop gate per project
    status.md      # /grok:status — recent jobs for this workspace
    setup.md       # /grok:setup — binary + auth + version health check
  agents/
    grok-rescue.md # delegation agent, mirrors codex-rescue contract
  hooks/
    hooks.json     # Stop hook → panel-stop-hook.mjs (no-op unless panelStops)
  scripts/
    grok-runner.mjs       # the runtime (~200 lines)
    panel-stop-hook.mjs   # Stop hook: Grok turn review when panel is on
  prompts/
    review.md, stop-gate.md, plan-review.md   # ALLOW:/BLOCK: contract prompts
```

## Component contracts

### grok-runner.mjs (runtime)

- **Input:** subcommand (`task|review`), prompt, flags (`--json`, `--write`,
  `--effort`, `--max-turns`).
- **Behavior:** spawn `grok -p <prompt> --output-format json --cwd <wsRoot>`
  with the read-only enforcement stack above for reviews; `--write` tasks
  relax it. 13-minute spawn timeout.
- **Output:** JSON to stdout: `{ status, rawOutput, sessionId }` —
  rawOutput is Grok's `text`. First line carries the `ALLOW:`/`BLOCK:`
  verdict for review prompts (same contract as the codex gates).
- **State (exact schema, codex-compatible shape):** per-workspace dir
  `<dataRoot>/state/<slug>-<sha16>/` where `<dataRoot>` resolves in order:
  `$CLAUDE_PLUGIN_DATA` *as provided by Claude Code to plugin-spawned
  processes* → fallback `~/.claude/plugins/data/grok-companion-fallback`.
  Slug-sha16 derivation copies codex-companion's exactly (basename sanitized
  + sha256(realpath)[0:16]). `state.json` schema:
  `{ "version": 1, "config": { "panelStops": false }, "jobs": [] }` — same
  envelope shape as codex state so debug habits carry over, distinct key
  (`config.panelStops`). Job records under `jobs/*.json` match codex job
  record fields (`title`, `status`, `result.rawOutput`, `completedAt`) — the
  contract that lets `statusline-command.sh` reuse its existing parsing for
  the `⚡` segment.

### panel-stop-hook.mjs (Stop hook, plugin-registered)

- Reads workspace `state.json`; exits instantly unless
  `config.panelStops: true`.
- When on: runs a Grok stop-gate review of the previous turn, concurrently
  with the codex plugin's own Stop hook (Claude Code runs Stop hooks in
  parallel → wall-clock ≈ slower reviewer, not sum).
- `BLOCK:` verdict → `decision: block` with Grok's findings.
- `ALLOW:` → visible `⚡ Grok gate: ALLOW — <reason>` systemMessage.
- Runtime failure → fail OPEN with visible `⚡ Grok gate: review FAILED` note.
- Respects `stop_hook_active` semantics; runtime failures never block.

### Plan-gate panel integration (lives in ~/.claude/hooks, not the plugin)

Upgrade the two existing global hooks:

- `codex-plan-review.mjs` (PreToolUse ExitPlanMode)
- `codex-plan-file-review.mjs` (PostToolUse Write|Edit on `**/plans/*.md`,
  `**/specs/*.md`)

**Hook ↔ plugin independence:** the global gate hooks do NOT depend on the
grok-companion plugin being installed. They spawn the `grok` binary resolved
from `PATH` directly with the full read-only enforcement stack defined above
(`--permission-mode plan --disallowed-tools <write set> --no-subagents
--disable-web-search --max-turns 8 --effort medium --output-format json`).
There is no `CLAUDE_PLUGIN_ROOT` to locate. Gate-side Grok runs are
**stateless** — no job records written anywhere; their only output is the
combined verdict message. (Job records exist only for plugin-internal flows.)
If `grok` is absent from `PATH`, the gate degrades to Codex-only with a
visible skip-note.

**Child env isolation:** the hooks build two separate child-env objects:

- Codex child: `process.env` + `CLAUDE_PLUGIN_DATA=<codex data dir>` +
  `CODEX_COMPANION_SESSION_ID` (unchanged from today).
- Grok child: a copy of `process.env` with `CLAUDE_PLUGIN_DATA` and all
  `CODEX_COMPANION_*` keys **explicitly deleted** — sessions export
  `CLAUDE_PLUGIN_DATA=<codex data dir>` into their environment via the codex
  plugin's SessionStart hook, so merely "not overriding" would inherit
  Codex's data dir. Deletion guarantees stateless gate-side Grok children
  can never write into Codex state, even if a future change routes them
  through grok-runner.mjs.

**Settings dedup + double-fire guard:** the current settings register
`codex-plan-file-review.mjs` four times under `PostToolUse`
(`if: Write/Edit × plans/specs`). Measured 2026-06-05: a `Write` to
`specs/*.md` fired exactly once, and a subsequent `Edit` fired exactly once
(the `if` rules discriminate by tool correctly). Nothing guarantees this
across Claude Code versions, so the upgraded script adds an atomic
`fs.mkdirSync` lock dir keyed on `sha1(file_path + mtime)` under
`$TMPDIR/plan-gate-locks/`, TTL 5 minutes. A duplicate concurrent invocation
for the same file revision exits silently in <50ms. The four `if`-gated
entries stay (they keep non-plan Writes at zero cost).

Change: dispatch Codex review and Grok review in parallel (async spawn, not
spawnSync), await both, combine:

| Codex | Grok | Result |
|-------|------|--------|
| ALLOW | ALLOW | allow; both one-liners shown |
| BLOCK | any | block; findings labeled `[Codex]` (+ `[Grok]` if it also blocked) |
| any | BLOCK | block; findings labeled `[Grok]` |
| error | verdict | the working reviewer decides; visible skip-note for the failed one |
| error | error | fail open with visible note (current behavior preserved) |

### Commands

All commands are thin wrappers over `grok-runner.mjs` outputs, following the
codex plugin's command conventions (review-only commands never fix; status
formats job records; setup checks binary + auth and reports version).

### grok-rescue agent

Mirrors codex-rescue's contract: dispatch investigation / second
implementation / diagnosis to Grok via the runner; `--write` for tasks that
must edit files; returns Grok's output verbatim with a short header.

## Distribution & install (concrete)

1. `.claude-plugin/marketplace.json` ships in v1:
   `{ "name": "rai-tools", "owner": { "name": "Rai Ansar" }, "plugins":
   [{ "name": "grok-companion", "source": "./" }] }` — this is what makes
   `claude marketplace add ~/Desktop/Personal/Tools/grok-companion` (local
   directory source) work; the codex plugin installs the same way from its
   marketplace manifest.
2. Enable in `~/.claude/settings.json`:
   `"grok-companion@rai-tools": true`.
3. Private GitHub remote added at the end of v1 (`git remote add origin … &&
   git push`); publishing later = flip repo public, add README/install docs.
   No structural change.

## Visibility

- Transcript: `⚡ Grok gate: ALLOW/BLOCK/FAILED — <reason>` lines (mirrors
  `⛩ Codex gate:` lines).
- Statusline: extend the existing `⛩` segment logic to also read Grok's
  state dir; show `⚡ ALLOW 04:53` style mini-segment only when a Grok verdict
  exists for the current workspace (absent otherwise — no clutter).

## Failure policy

Identical to the hardened Codex behavior (learned 2026-06-04/05):

- Runtime failures (quota, binary missing, timeout) → fail OPEN, visible note.
- Only genuine `BLOCK:` verdicts block.
- Panel degrades to single-reviewer when one side errors.
- No persistent processes → no stale-broker cleanup pathway needed.

## Testing plan

1. Pipe-tests with synthesized hook JSON for every hook (the codex-gates
   method): matching path, non-matching path (<50ms silent), malformed JSON,
   duplicate-invocation lock test.
2. Live ALLOW: trivial sane plan → both reviewers allow.
3. Live BLOCK: plan referencing nonexistent files → expect labeled findings.
4. Disagreement: prompt-engineered case where one blocks → must block.
5. Failure injection: PATH without `grok` → Codex-only with visible note;
   kill grok mid-review → fail open.
6. Read-only probe: review prompt that attempts a file write → file
   untouched, else run treated as failed.
7. Panel latency: confirm dual plan review wall-clock ≈ max(codex, grok).

## Rollout

- **v1:** runner + review/task/status/setup commands + marketplace manifest +
  dual plan gates (global hook upgrade).
- **v2:** panel stop hook + `/grok:panel` + statusline `⚡` segment +
  grok-rescue agent.
- **Publish (later):** README, strip machine-specific paths, public repo flip.

## Out of scope

- Replacing Codex anywhere.
- Grok MCP servers or tool mounting inside Grok sessions.
- Cross-machine sync of panel flags.
