# peerbench

A Claude Code plugin that reviews your work with a **panel of AI reviewers** —
**Codex** (OpenAI), **Kimi** (Moonshot `kimi-k2.6`), **MiMo** (Xiaomi), and **GLM**
(z.ai `glm-5.2`) — instead of a single reviewer. The panel runs automatically as
**gates** (plans/specs, code turns, pushes) and on demand as a **bug hunt** that
scours the repo read-only. Kimi, MiMo, and GLM are cheap; the goal is Codex-grade
review at a fraction of the cost, with Codex kept alongside as a benchmark you can
drop with one command.

> **Project:** `peerbench`. **Command prefix:** `bench` — e.g. `/bench:hunt`,
> `/bench:investigate`, `/bench:review` (short to type; the project is peerbench).

## How it works

Two kinds of review:

**1. Gates (automatic).** Hooks intercept your work and run the panel before it
proceeds. Findings are returned to Claude via `asyncRewake` on **BLOCK** (the model
gets the findings and fixes them); **ALLOW** shows a brief status line.

| Gate | Fires on | Reviewers | Mode |
| --- | --- | --- | --- |
| Plan / spec | `ExitPlanMode`, and Writes to `**/plans/*.md` · `**/specs/*.md` | full panel (Codex + Kimi + MiMo) | content-only (reviews the plan text) |
| Code turn (Stop) | end of a code-editing turn | Codex (via the Codex plugin) | content-only |

The panel is **AND-pass**: any reviewer's `BLOCK:` blocks; if a reviewer errors, the
others decide; only if all error does the gate fail open (with a visible note).

**Auto deep-review on spec save + push (capabilities G & H).** When the fast plan/spec gate ALLOWs
a `**/plans/*.md` · `**/specs/*.md` save (**G**), or the pre-push gate clears a `git push` (**H**),
it **enqueues** a deep-review job to a crash-safe queue (`deep-queue/`); it never blocks the
save/push. At the next turn end, the `asyncRewake` Stop runner (`deep-review-runner.mjs`) claims
queued jobs, runs the deep panel **against the real repository** (repo-aware, read-only)
concurrently, and on a **high-severity** block writes the findings to stderr + **exits 2 — which
wakes Claude immediately, even if the session has gone idle** (the key property; a detached worker
surfaced only at the next stop could never wake an idle agent). The job lifecycle is crash-safe:
atomic-rename states (`.json` queued → `.claimed.<pid>` running → `.blocked` durable), a completed
block is retired ONLY when its content changes (the agent addresses it) or the target is deleted —
never lost on a crash, transient git error, or large file. Disabling the bench (`/bench:off`) skips
the runner. (This replaced an earlier detached-worker + `deep-result` + next-stop-surfacing design
that could not wake an idle agent — see `docs/superpowers/specs/2026-06-22-deep-review-wake-delivery-design.md`.)

**2. Bug hunt (on demand).** `/bench:hunt [focus]` runs the panel **agentically** —
each reviewer explores the repository read-only via tools (read_file, grep, glob,
list_dir), then reports concrete findings with `file:line`. Results are shown
side-by-side so you can compare reviewers on the same code. This is the
benchmark/debugging tool, and it's deep + slow (minutes) by design.

## Reviewers & cost model

- **Codex** — OpenAI, via the `codex@openai-codex` plugin's shared runtime (an
  agentic CLI that already reads files). The reliable reference.
- **Kimi** — Moonshot `kimi-k2.6` on the **coding-plan** endpoint
  (`api.kimi.com/coding/v1`) with **thinking disabled** (`thinking:{type:"disabled"}`,
  `temperature:0.6`). Fast, non-thinking, tool-calling — no Open Platform key needed.
- **MiMo** — Xiaomi `mimo-v2.5-pro` (`temperature:0`).

Switch the active panel any time with `/bench:reviewers` (e.g. `codex kimi mimo`,
or run `kimi mimo` only). Selectable reviewers: `kimi`, `mimo`, `codex`.

### Read-only by construction

Reviewers **cannot modify your code**. Content-only gate calls send no tools at all.
The agentic hunt exposes only read tools (read_file / grep / glob / list_dir),
sandboxed to the repo — there is no write, edit, or shell tool. (A model that tries
to "fix" a file during review simply can't.)

## Agentic engine (the hunt loop)

A bounded, instrumented read-only agent loop, designed to never hang and always
produce output:

- **Streaming** (`stream:true`) — headers arrive immediately, so undici's 300s
  header timeout can't fire on long model rounds.
- **Per-round watchdog** — an exploration round that runs too long (default 90s) is
  cut and the model is forced to conclude; the final synthesis round gets the full
  remaining budget.
- **Conclude budget** — past ~150 KB of gathered context the model is told to stop
  reading and write its findings (prevents endless exploration).
- **Network retry** + **wall-clock timeout** + per-tool try/catch.
- **Diagnostics** — set `BENCH_DEBUG=1` to stream per-round detail (request size,
  tool calls, latency, the underlying error cause) to stderr; the same diagnostics
  are saved into each hunt's trace for later inspection.

### Thinking tiers

`kimi-k2.6` supports thinking on **or** off via the `thinking` parameter:

- **Default (gates, `/bench:hunt`)** — thinking **off**: fast (~3s rounds), reliable.
- **`/bench:investigate` (planned)** — thinking **on**: deeper reasoning for hard
  problems, with a generous budget. Same panel, opt-in depth.

## Commands

- `/bench:hunt [focus]` — multi-model agentic bug hunt (read-only). Optionally focus it:
  `/bench:hunt a monitor never alerted me` or `/bench:hunt the auth/session code`.
- `/bench:debug <failure>` — root-cause a SPECIFIC error / failing test / wrong output
  with the panel (read-only); each reviewer returns a root cause + minimal fix. Model-invokable.
- `/bench:investigate <problem>` — deep tier: full panel, Kimi **thinking on**, generous
  budget, for a hard specific problem. Slower than hunt.
- `/bench:review [--base <ref>]` — on-demand panel review of your current changes.
- `/bench:reviewers [names…]` — show or set the active panel (e.g. `kimi mimo` or
  `codex kimi mimo glm`). Selectable: `kimi`, `mimo`, `codex`, `glm`.
- `/bench:status [id]` — recent gate/hunt runs for this workspace; pass a trace id to expand it.
- `/bench:setup` — check reviewer availability and per-workspace state.
- `/bench:off` / `/bench:on` — disable / re-enable the gates for this workspace (`--global` for everywhere).

`hunt`, `debug`, and `investigate` are **model-invokable** — Claude can reach for them on its own
when a task calls for finding or root-causing a bug. The rest are user-invoked.

## Configuration

- **`companion.json`** (shared, env-independent path under
  `~/.claude/plugins/data/bench-shared/`) — the active `reviewers` list and
  each provider's `baseURL`, `model`, `apiKey`, `temperature`, `thinking`, headers.
- **`.keys`** (repo, **gitignored** — never commit) — source secrets/config for the
  providers (`KIMI_*`, `MIMO_*`).
- `BENCH_ROOT` — override the shared dir (used for test isolation).
- `BENCH_DEBUG=1` — verbose agentic diagnostics.

State (panel on/off, gate history, traces) is **per-workspace**, keyed by git
top-level. The provider config in `companion.json` is global/shared.

## Fallback (revert anytime)

1. **Config toggle** — `/bench:reviewers kimi mimo` (or any subset of
   `kimi mimo codex`) re-selects the active panel without redeploying.
2. **Rollback script** — `node scripts/rollback.mjs` restores the pre-deploy hook
   snapshot and settings.
3. **Branch** — the work lives on a feature branch; `main` is untouched.

## Statusline

A compact segment renders the latest gate/hunt per workspace —
`⛩ plan: Codex✓ Kimi✓ MiMo✓` (green all-allow, red on block, `!` on error/skip,
`✓` for hunt findings). Verdicts older than ~45 min dim to `(idle)` so a stale
result never looks like an active block.

## Requirements

- Node 20+ (developed on 24).
- The `codex@openai-codex` plugin for the Codex reviewer.
- Valid Kimi (coding-plan) and MiMo API credentials in `.keys` / `companion.json`.

## Install (local, private)

This repo doubles as a local-directory marketplace (`rai-tools`). In
`~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "rai-tools": { "source": { "source": "directory", "path": "/absolute/path/to/bench" } }
  },
  "enabledPlugins": { "bench@rai-tools": true }
}
```

Restart Claude Code; the `/bench:*` commands appear.

Then register the four review gates (one-time — copies the hooks into
`~/.claude/hooks` and wires them into `~/.claude/settings.json`):

```bash
node /absolute/path/to/bench/scripts/deploy-global-hooks.mjs
```

This registers the Stop gate (matcher-less), the ExitPlanMode plan gate, the
`Write|Edit` plan-file gate, and the `Bash` pre-push gate. Re-run it any time to
re-sync; it is idempotent and de-dupes existing entries. Without this step the
commands work but the automatic gates do not fire.

## Test

```bash
npm test          # node --test 'tests/*.test.mjs'
```

(Bare `node --test tests/` does not work on Node 24 — it treats the directory as a
module. Use the glob, or `npm test`.)
