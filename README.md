# peerbench

A Claude Code + Codex helper that reviews your work with a **panel of AI reviewers** —
**Codex** (OpenAI) and **Grok** (xAI's [Grok Build](https://github.com/xai-org/grok-build)
CLI) as plan-billed agentic CLIs, plus API providers **Kimi** (Moonshot `k3`),
**GLM** (z.ai `glm-5.2`), **Qwen** (Alibaba MaaS `qwen3.7-max`), **MiMo** (Xiaomi), and
**MiniMax** (`MiniMax-M3`) — instead of a single reviewer. The panel runs automatically as
**gates** (plans/specs, protected-branch merges, code turns, pushes) and on demand as a **bug hunt** that
scours the repo read-only. The API providers are cheap and the CLI reviewers ride
existing subscription plans; the goal is frontier-grade review from several
independent models at once, each swappable with one command.

> **Project:** `peerbench`. **Command prefix:** `bench` — e.g. `/bench:hunt`,
> `/bench:investigate`, `/bench:review` (short to type; the project is peerbench).

## How it works

Two kinds of review:

**1. Gates (automatic).** Hooks intercept your work and run the panel before it
proceeds. Findings are returned to Claude via `asyncRewake` on **BLOCK** (the model
gets the findings and fixes them); **ALLOW** shows a brief status line.

| Gate | Fires on | Reviewers | Mode |
| --- | --- | --- | --- |
| Plan | `ExitPlanMode` | active panel | content-only plan review |
| Plan / spec file | Writes to `**/plans/*.md` · `**/specs/*.md` | active panel | fast content-only save gate, then repo-aware deep review on ALLOW |
| Merge | `git merge` into a protected branch | active panel | bounded content-only review, then repo-aware deep review |
| Code turn (Stop) | end of a turn with committed, staged, unstaged, or untracked changes | active non-Codex reviewers | content-only diff review; direct Codex never asks Codex to review itself |
| Push | Git's native `pre-push` hook | active panel | authoritative repo-aware review of Git's exact ref updates; cached by immutable object IDs |

The panel is **AND-pass**: any reviewer's blocking `BLOCK:` blocks. Plan/Stop gates let
healthy reviewers decide and fail open with a visible note only when all reviewers error.
Native pre-push additionally requires a verdict quorum and fails closed, so a degraded
one-reviewer run can never be presented as a clean push.

Automatic repair loops are bounded. Stop review permits at most three blocked repair cycles across
changed revisions in one task/session; unresolved counters never age into more automatic turns.
After that it keeps a visible advisory without spawning more repairs. A clean/ALLOW transition, a
new session, or a new one-shot `BENCH_STOP_CYCLE_RESET` nonce starts fresh. Plan and plan-file gates
share the same three slots, so switching surfaces cannot buy extra cycles. Incomplete/oversized
evidence is tracked separately as **UNREVIEWED** and is never written to reviewed markers.

At `SessionStart` (`startup` or `clear`), peerBench records full-content identities for pre-existing
untracked files. Stop omits only unchanged identities; new or modified paths remain reviewable, and
ALLOW adopts them for later turns. Capture races fail safe: an inventory not trusted when Stop began
cannot exclude paths later.

Transient deep-review jobs retry at most three times. Across completed blockers, deferred queue
continuations, and changed targets, the deep runner may cause at most three automatic follow-up
Stops total in one task/session; unresolved durable work never ages into more. It then remains a
non-waking advisory and progresses only on natural Stops or a new explicit reset nonce.

Protected-branch merge review follows the same anti-churn rule: one exhaustive pass must report all
verified independent blockers, grouped by root cause, and at most three automatic BLOCK/repair cycles
may run across changed merge targets in one task/session. Unresolved cycle records never age out into
more automatic repairs. The fourth attempt is
allowed locally with a durable **UNREVIEWED** warning (the native pre-push gate is still the hard
boundary); use a new one-shot nonce such as `BENCH_MERGE_CYCLE_RESET=$(date +%s) git merge …` for one
explicit fresh cycle. Leaving the same reset value exported does not repeatedly reset the ceiling. Exact ALLOWs are
cached by the sorted immutable incoming range set plus reviewer/model/policy identity, so unchanged
retries do not re-stream Git evidence or call reviewers. Every unique octopus target is peeled to
its commit, deduplicated, and inspected. The fast gate streams and hashes complete Git output; if all
evidence cannot fit its 200 KiB content-only budget, it records no clean verdict and visibly allows as
**UNREVIEWED / coverage incomplete** while the queued deep review and native push gate enforce it.

**Auto deep-review on spec save (capability G).** When the fast plan/spec file gate ALLOWs
a `**/plans/*.md` · `**/specs/*.md` save, it **enqueues** a deep-review job to a crash-safe
queue (`deep-queue/`) and does not block the save. At the next turn end, the `asyncRewake`
Stop runner (`deep-review-runner.mjs`) claims queued jobs, runs the deep panel **against the
real repository** (repo-aware, read-only) concurrently, and on a **high-severity** block writes
the findings to stderr + **exits 2 — which wakes Claude immediately, even if the session has
gone idle**. The job lifecycle is crash-safe:
atomic-rename states (`.json` queued → `.claimed.<pid>` running → `.blocked` durable), a completed
block is retired ONLY when its content changes (the agent addresses it) or the target is deleted;
exhausting its three automatic deliveries only downgrades it to an advisory. Findings are never
lost on a crash, transient git error, or large file. Disabling the bench (`/bench:off`) skips
the runner. Deep jobs are stamped with Claude's hook `session_id`, so two Claude chats in the same
git checkout do not claim or wake each other's queued findings. (This replaced an earlier detached
worker + `deep-result` + next-stop-surfacing design that could not wake an idle agent — see
`docs/superpowers/specs/2026-06-22-deep-review-wake-delivery-design.md`.)

**Authoritative native review before push (capability H).** Setup installs a chain-safe Git
`pre-push` dispatcher (honoring `core.hooksPath` and running an existing hook first). Git supplies
the exact `<local-ref> <local-object> <remote-ref> <remote-object>` updates, so peerBench never has
to emulate Bash/Zsh quoting, redirects, wrappers, or compound-command timing. Multiple refs are
reviewed individually; deletions and updates containing no new commits are instant. The lightweight
Claude `Bash(git *)` hook only installs/refreshes this dispatcher and is not the trust boundary.

The dispatcher must already be installed in a repository before Git can invoke it. Direct pushes
with statically visible targets are armed automatically, including common `sudo`/`doas`/`env`/
`timeout` wrappers and static `cd`, wrapper-chdir, `git -C`, or `GIT_DIR` paths. A push hidden inside
an arbitrary script body (`bash release.sh`), shell alias/function, make task, or dynamically
expanded `eval`/`sh -c` command or command substitution does not expose its eventual repository to
a pre-execution shell hook. Run `/bench:setup` once inside every repository that such automation may
push. After that one-time setup, the persistent native Git hook is authoritative regardless of how
the push starts; peerBench does not claim universal interception of previously unseen repositories
hidden in code.

Clean and blocked results are cached by the immutable ref-update set plus reviewer panel. Retrying
unchanged code is instant. A clean push requires two verdicts by default (and a Codex verdict when
Codex is configured), so one surviving reviewer can no longer make a degraded run look green. Each
panel is explicitly required to finish one exhaustive pass and report every verified independent
blocker, grouping sibling manifestations without imposing a finding-count cap. After
three distinct blocked revisions, automatic reviews pause permanently for that unresolved ref scope
and replay the consolidated findings; use a new nonce such as
`BENCH_PUSH_CYCLE_RESET=$(date +%s) git push …` for one fresh verification after fixing them.
Leaving the same reset value exported cannot repeatedly reopen the loop.

Native reviews run in a detached worker instead of depending on the lifetime of the foreground
`git push`. The hook waits for a bounded interactive window; if the review is still running, that
push attempt fails closed with a visible "continues in background" message. Retry the exact push
after it finishes and the cached verdict is reused without another complete review. Once handed
off to the detached worker, killing or timing out the original shell no longer discards the review,
trace, or completed-range cache, and no bypass is needed for a legitimately slow panel.

`BENCH_NATIVE_PUSH_BYPASS=1 git push …` bypasses peerBench once while still running an existing
chained hook. `git push --no-verify` is the emergency all-hooks bypass; `/bench:off` disables all
peerBench gates for the workspace.

**2. Bug hunt (on demand).** `/bench:hunt [focus]` runs the panel **agentically** —
each reviewer explores the repository read-only via tools (read_file, grep, glob,
list_dir), then reports concrete findings with `file:line`. Results are shown
side-by-side so you can compare reviewers on the same code. This is the
benchmark/debugging tool, and it's deep + slow (minutes) by design.

## Reviewers & cost model

- **Codex** — OpenAI, via the
  [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
  `codex@openai-codex` Claude plugin's shared runtime (an agentic CLI that
  already reads files). ChatGPT-plan billing. The reliable reference.
- **Grok** — xAI's [Grok Build](https://github.com/xai-org/grok-build) CLI
  (now open source), run headless in plan mode. Grok-plan billing, no metered
  API key. Review verdicts are **schema-constrained** (`--json-schema`), so the
  verdict can't be lost to narration. peerBench wraps every run in its own
  **macOS Seatbelt sandbox** with grok's writable state redirected to an
  ephemeral per-run directory. Grok now wires its own nono/Seatbelt sandbox,
  so peerBench explicitly passes `--sandbox off` inside its stricter macOS
  wrapper to avoid nested-Seatbelt `EPERM`; the hard read-only guarantee remains
  peerBench's outer policy because Grok's built-in profile can fail open.
- **Kimi** — Moonshot **K3** (`k3`) on the **coding-plan** endpoint
  (`api.kimi.com/coding/v1`). K3 is always-thinking with server-fixed sampling, so
  peerBench omits `temperature` and the K2.x `thinking` param entirely. No Open
  Platform key needed.
- **GLM** — z.ai `glm-5.2` on the coding endpoint. Selectable, but inactive unless explicitly chosen.
- **Qwen** — Alibaba MaaS `qwen3.7-max` through the OpenAI-compatible endpoint.
- **MiMo** — Xiaomi `mimo-v2.5-pro` (`temperature:0`). Uniquely good at
  secret/PII/deploy-hygiene catches.
- **MiniMax** — `MiniMax-M3` on the flat coding plan. A reasoning model whose
  inline `<think>` output is stripped automatically; thinking tokens are free on
  the flat plan.

Switch the active panel any time with `/bench:reviewers` (for example `codex grok mimo`,
or `kimi glm qwen`). Selectable reviewers come from the registry (`kimi`, `mimo`,
`glm`, `qwen`, `minimax`, `codex`, `grok`).

### Read-only by construction

Reviewers **cannot modify your code**. Content-only gate calls send no tools at all.
The agentic hunt exposes only read tools (read_file / grep / glob / list_dir),
sandboxed to the repo — there is no write, edit, or shell tool. (A model that tries
to "fix" a file during review simply can't.)

The CLI reviewers get OS-level containment: on macOS, Grok runs inside
a peerBench-built macOS Seatbelt profile (`sandbox-exec`) that denies all writes
except an ephemeral per-run temp dir its entire state (`GROK_HOME`) is redirected
into — nothing a review run writes survives it, and all of `~/.grok` (binaries,
plugins, config, model routing) stays read-only. peerBench sets Grok's inner
`--sandbox off` only under that stricter outer wrapper, avoiding nested-Seatbelt
`EPERM`. Off macOS it requests Grok's built-in read-only profile but refuses to
run by default because that profile can fail open; `BENCH_GROK_UNSANDBOXED=1` is
the explicit operator opt-in.

## Agentic engine (the hunt loop)

A bounded, instrumented read-only agent loop, designed to never hang and always
produce output:

- **Streaming** (`stream:true`) — headers arrive immediately, so undici's 300s
  header timeout can't fire on long model rounds.
- **Per-round watchdog** — an exploration round that runs too long (default 90s) is
  cut and the model is forced to conclude; the final synthesis round gets the full
  remaining budget.
- **Conclude budget** — past ~120 KB of gathered context the model is told to stop
  reading and write its findings (prevents endless exploration).
- **Network retry** + **wall-clock timeout** + per-tool try/catch.
- **Budgets** — hunt/debug get a 12-minute wall clock; investigate stays deep
  at 20 minutes. Automatic deep gate reviews are capped at 10 minutes via
  `BENCH_DEEP_REVIEW_BUDGET_MS`, with the Claude deep-runner hook capped at
  12 minutes so a stale or hung reviewer cannot keep waking the session long
  after the turn has moved on.
- **Diagnostics** — set `BENCH_DEBUG=1` to stream per-round detail (request size,
  tool calls, latency, the underlying error cause) to stderr; the same diagnostics
  are saved into each hunt's trace for later inspection.

### Thinking config

Kimi is now on **K3**, which is always-thinking with server-fixed sampling — the
K2.x `thinking` parameter and any `temperature` override are **rejected**, so
peerBench omits both on every path (fast gates and deep/agentic reviews alike).
`KIMI_THINKING` / `KIMI_TEMPERATURE` in `.keys` only apply if you pin an older
K2.x model via `KIMI_MODEL`; on K3 leave them unset. Providers whose thinking
param IS a live toggle (GLM, Qwen) still flip on for deep reviews automatically.

## Commands

- `/bench:hunt [focus]` — multi-model agentic bug hunt (read-only). Optionally focus it:
  `/bench:hunt a monitor never alerted me` or `/bench:hunt the auth/session code`.
- `/bench:debug <failure>` — root-cause a SPECIFIC error / failing test / wrong output
  with the panel (read-only); each reviewer returns a root cause + minimal fix. Model-invokable.
- `/bench:investigate <problem>` — deep tier: active panel, generous budget, for a
  hard specific problem. Slower than hunt.
- `/bench:review [--base <ref>]` — on-demand panel review of your current changes.
- `/bench:reviewers [names…]` — show or set the active panel (e.g. `grok mimo` or
  `codex grok mimo`). Selectable: `grok`, `mimo`, `kimi`, `glm`, `qwen`, `minimax`, `codex`.
- `/bench:status [id]` — recent gate/hunt runs for this workspace; pass a trace id to expand it.
- `/bench:scorecard` — cross-project reviewer performance: objective stats computed from
  traces plus your TP/FP/miss grades (`bench-runner.mjs grade <traceId> <Reviewer>:<tp|fp|miss>`),
  so swap-or-keep panel decisions stay evidence-based.
- `/bench:setup` — check reviewer availability and per-workspace state.
- `/bench:off` / `/bench:on` — disable / re-enable the gates for this workspace (`--global` for everywhere).

`hunt`, `debug`, and `investigate` are **model-invokable** — Claude can reach for them on its own
when a task calls for finding or root-causing a bug. The rest are user-invoked.

## Reliability contract (anti-loop + honest failures)

The gates are wrapped in hard reliability rules so a degraded panel can never wedge a session:

- **Out-of-quota/auth failures say so and skip.** HTTP 402/exhausted-429 (and quota-keyword
  bodies) classify as `quota`, 401/403 as `auth` — for API *and* CLI reviewers. A classified
  failure records a short global cooldown (quota ≈ 5 min, auth ≈ 10 min in
  `~/.claude/plugins/data/bench-shared/reviewer-cooldowns.json`); while it lasts, every gate skips
  that reviewer **instantly** with a `"<name> out of quota/credits — skipped"` note instead of
  re-burning retries and timeouts on every stop/push.
- **Session-total wake budgets.** The consecutive-block streak (3) still resets on ALLOW/clean —
  but the **session total does not** (stop gate: 9, plan gate: 9 with a 2 h inactivity refund).
  A BLOCK→fix→ALLOW→BLOCK alternation can no longer wake a session forever; after the budget the
  gate downgrades to a visible, non-waking advisory. `BENCH_STOP_CYCLE_RESET` / plan-cycle reset
  nonces are the explicit refunds.
- **Git-scoped gates.** Stop, plan (ExitPlanMode), and plan/spec-file gates run only inside a git
  work tree — non-git chats are never gated.
- **Push gate fails fast and honestly.** If cooldowns make the policy unsatisfiable (required
  Codex out of quota, or quorum unreachable), the push blocks immediately with the exact reason
  and the explicit bypass — no multi-minute doomed panel run.
- **Queued deep reviews supersede by path.** A newer saved revision of a plan/spec retires any
  still-queued older revision, so the deep runner never wakes a session to review dead bytes.
- **Deploys must be committed + tested.** `scripts/install.mjs` refuses a dirty working tree and
  runs the test suite first (`--allow-dirty` / `--skip-tests` are the explicit overrides) — a
  mid-development snapshot can no longer ship into the live gates.
- **No blanket Codex-gate enabling.** Installing peerBench (and `/bench:on --global`) no longer
  flips the official codex plugin's `stopReviewGate` on across every workspace; enabling it is a
  per-repo act (`/bench:on` in that repo).

## Configuration

- **`companion.json`** (shared, env-independent path under
  `~/.claude/plugins/data/bench-shared/`) — the active `reviewers` list and
  each provider's `baseURL`, `model`, `apiKey`, `temperature`, `thinking`, headers.
- **`.keys`** (repo, **gitignored** — never commit) — source secrets/config for the
  providers (`KIMI_*`, `GLM_*`, `QWEN_*`, `MIMO_*`, `MINIMAX_*`). Start from `.keys.example`.
  The CLI reviewers (`codex`, `grok`) need no keys — they use their own plan sign-ins.
- `BENCH_ROOT` — override the shared dir (used for test isolation).
- `BENCH_DEBUG=1` — verbose agentic diagnostics.
- `BENCH_STOP_CYCLE_RESET=<nonce>` — explicitly start one fresh Stop-review cycle; each value is consumed once per task/session.
- `BENCH_PLAN_CYCLE_RESET=<nonce>` — explicitly start one fresh shared plan/plan-file cycle; each value is consumed once per task/session.
- `BENCH_MERGE_CYCLE_RESET=<nonce>` — explicitly start one fresh protected-branch merge-review cycle; the same persistent value is consumed only once, so change the nonce for a later reset.
- `BENCH_MERGE_REVIEW_REFRESH=1` — ignore an exact merge ALLOW cache entry and rerun the complete fast panel once.
- `BENCH_DEEP_CYCLE_RESET=<nonce>` — explicitly resume automatic deep-review waking after its global three-wake task/session ceiling. Each value is consumed once per task/session (`1` works once); change the nonce for another deliberate reset, so an inherited environment value cannot disable the ceiling.
- `BENCH_PUSH_REVIEW_QUORUM=<n>` — required native push verdict count (default: two, or all when fewer are configured; values above the configured panel clamp to all reviewers).
- `BENCH_PUSH_REQUIRE_CODEX=0` — do not require Codex specifically when it is in the active push panel.
- `BENCH_PUSH_MAX_BLOCK_CYCLES=<n>` — choose a stricter automatic blocked-revision ceiling; values are hard-capped at three.
- `BENCH_PUSH_CYCLE_RESET=<nonce>` — clear one ref-scope hold once and perform one fresh native verification; change the nonce for a later deliberate reset.
- `BENCH_PUSH_REVIEW_REFRESH=1` — ignore an exact-result cache entry and rerun the reviewer panel once.
- `BENCH_NATIVE_PUSH_BYPASS=1` — bypass peerBench for one push while preserving other pre-push hooks.
- `BENCH_LEGACY_PUSH_PREFLIGHT=1` — explicitly re-enable the old shell-string preflight for diagnosis; it is not authoritative.

State is keyed first by **workspace** (git top-level). Git facts that are truly
workspace-wide, such as `/bench:off` and the stop gate's `reviewed-head` marker,
stay project-scoped. Delivery/status artifacts that can interrupt a conversation
(`deep-queue` jobs, durable deep blocks, stop-loop counters, and hook traces used
by the statusline) are additionally stamped by Claude `session_id` when available.
The provider config in `companion.json` is global/shared.

When peerBench is installed for direct Codex work, the Codex Stop hook uses the
same stop-review logic but always removes the `codex` reviewer before the panel
runs. That means Codex work is reviewed by Grok/Kimi/GLM/Qwen/etc., never by
Codex itself. The native push hook applies the same self-review suppression when it inherits a
direct Codex `CODEX_THREAD_ID`. Codex processes launched as Claude reviewers/delegates are skipped with
`BENCH_SUPPRESS_HOOKS` / `CODEX_COMPANION_SESSION_ID`, so `codex-plugin-cc`
does not recursively trigger peerBench.

## Fallback (revert anytime)

1. **Config toggle** — `/bench:reviewers kimi glm` (or any subset of
   `kimi glm qwen mimo minimax codex grok`) re-selects the active panel without redeploying.
2. **Disable gates** — `/bench:off` disables this workspace; `/bench:off --global`
   disables everywhere. Use `/bench:on` to re-enable.
3. **Rollback script** — `node scripts/rollback.mjs` restores the pre-install hook
   snapshot and settings created under `~/.claude/plugins/data/bench-shared/backup-*`.

## Statusline

A compact segment renders the latest gate/hunt for the current workspace and,
when Claude provides a `session_id`, the current chat —
`⛩ plan: Codex✓ Grok✓ MiMo✓` (green all-allow, red on block, `!` on error/skip,
`✓` for hunt findings). Verdicts older than ~45 min dim to `(idle)` so a stale
result never looks like an active block. A session-aware statusline shows only
that session's traces; it never falls back to an old unstamped panel. If no
session id is available, workspace-level trace selection remains for compatibility.

## Requirements

- Node 20+ (developed on 24).
- Claude Code for `/bench:*` commands and Claude hooks.
- Codex with hook support for direct Codex Stop reviews and `/prompts:bench-*`.
- The [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
  Claude plugin only if you enable the `codex` reviewer inside Claude.
- The [Grok Build CLI](https://github.com/xai-org/grok-build)
  (`curl -fsSL https://x.ai/cli/install.sh | bash`, then sign in once with
  `GROK_HOME=~/.grok-headless grok -p OK` for the gate's dedicated auth) only if
  you enable the `grok` reviewer.
- The enabled reviewers' own credentials: the Grok Build CLI signed in for
  `grok`, and a MiMo coding-plan key for `mimo`. The fallback panel is exactly
  `grok` + `mimo`; expired providers are never silently reactivated.

## Install

The most effort peerBench will ever ask of you:

The Claude Code and Codex plugins run tiny Node.js lifecycle hooks, so `node`
needs to be on your PATH. For Nix, `nvm`, or `asdf` users: it must be on the
non-interactive shell's PATH. If it is not, the skills still work; the always-on
gates just stay quiet instead of erroring on every prompt.

### Claude Code

```bash
/plugin marketplace add RaiAnsar/peerBench
```

```bash
/plugin install bench@aiwithrai
```

(You have to send two separate prompts for the install to work.)

The Claude Code desktop app has no `/plugin` command. Install it from the UI
instead: Customize, the `+` by personal plugins, Create plugin and add
marketplace, Add from repository, then enter `https://github.com/RaiAnsar/peerBench`.

Optional, only if you want Claude Code to use Codex as one of peerBench's
reviewers:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

```bash
/plugin install codex@openai-codex
```

```bash
/reload-plugins
/codex:setup
```

Without `openai/codex-plugin-cc`, Claude can still run peerBench with Grok, Kimi,
GLM, Qwen, MiMo, and MiniMax, and Codex can still run peerBench directly. What will not work is
selecting `codex` as a reviewer from inside Claude.

### Codex

```bash
codex plugin marketplace add RaiAnsar/peerBench
codex
```

Open `/plugins`, select the AI with Rai marketplace, and install peerBench.
Then open `/hooks`, review and trust its lifecycle hook, and start a new thread.

This same install also covers the Codex desktop app: restart the app after
installing and it picks up the plugin.

CLI-only Codex install:

```bash
codex plugin add bench@aiwithrai
```

### Kimi Code

Kimi Code CLI gets peerBench as a user-level Agent Skill. From a local clone:

```bash
npm run setup:kimi
```

This installs the `bench` skill into `~/.kimi-code/skills/bench/` (honoring
`KIMI_CODE_HOME`), pointed at this checkout's `bench-runner.mjs`. Start a new
Kimi session and ask for a "bench review", "bench hunt", "bench status", and so
on, or invoke it directly with `/skill:bench`. Re-run `npm run setup:kimi`
after moving the checkout; `node scripts/install-kimi.mjs --status` reports
drift and `--uninstall` removes it.

### Local Clone

If you are developing peerBench locally or migrating an older install:

```bash
git clone https://github.com/RaiAnsar/peerBench.git
cd peerBench
node scripts/install.mjs
```

Already cloned:

```bash
npm run setup
```

The local installer is idempotent. It:

- registers the local Claude marketplace as `aiwithrai`, installs/enables the
  plugin as `bench@aiwithrai`, and migrates old local `bench@rai-tools` /
  `bench@peerbench` ids when they point at this checkout;
- scrubs local secret files such as `.keys` from Claude's installed plugin cache
  after local marketplace installs;
- copies review hooks into `~/.claude/hooks` and `~/.codex/hooks`;
- registers Claude gates for `ExitPlanMode`, plan/spec file writes, Stop, and deep
  Stop review delivery, plus installs Git's authoritative native `pre-push` dispatcher;
- registers the direct Codex Stop hook, which removes `codex` from the reviewer
  panel so Codex never asks itself to review its own work;
- installs Codex manual prompts into `~/.codex/prompts`;
- prints a local-vs-`origin/<branch>` comparison before syncing.

Focused local installs:

```bash
node scripts/install.mjs --claude-only
node scripts/install.mjs --codex-only
```

Set provider keys:

```bash
cp .keys.example .keys
$EDITOR .keys
node scripts/load-keys.mjs
```

Or load keys during install after `.keys` exists:

```bash
node scripts/install.mjs --load-keys
```

`load-keys` writes provider config to
`~/.claude/plugins/data/bench-shared/companion.json` and never prints key values.

Verify Claude's plugin side:

```bash
claude plugin list | grep bench
claude plugin details bench@aiwithrai
```

Claude commands are `/bench:hunt`, `/bench:investigate`, `/bench:debug`,
`/bench:review`, `/bench:status`, `/bench:setup`, `/bench:on`, `/bench:off`,
`/bench:reviewers`, and `/bench:scorecard`.

Codex prompts are installed as
`/prompts:bench-hunt`, `/prompts:bench-investigate`, `/prompts:bench-debug`,
`/prompts:bench-review`, `/prompts:bench-status`, `/prompts:bench-setup`,
`/prompts:bench-on`, `/prompts:bench-off`, `/prompts:bench-reviewers`, and
`/prompts:bench-scorecard`. These prompts run the same `scripts/bench-runner.mjs`
commands that Claude's `/bench:*` commands use.

Verify setup:

```bash
node scripts/bench-runner.mjs setup
npm test
```

### Credential hygiene

- `.keys`, `.env`, `*.keys`, logs, and local result dumps are git-ignored.
- `.keys.example` contains placeholders only.
- Installer and key-loading output redacts key values.
- Before making a fork or release public, run:

```bash
git ls-files | xargs rg -n --hidden -S "sk-[A-Za-z0-9_-]{20,}|github_pat_|ghp_|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|BEGIN .*PRIVATE KEY"
git log --all --oneline -G "sk-[A-Za-z0-9_-]{20,}|github_pat_|ghp_|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|BEGIN .*PRIVATE KEY" -- .
```

Use a dedicated secret scanner such as `gitleaks` before publishing if you have
ever committed real credentials and then removed them.

## Test

```bash
npm test          # node --test 'tests/*.test.mjs'
```

(Bare `node --test tests/` does not work on Node 24 — it treats the directory as a
module. Use the glob, or `npm test`.)
