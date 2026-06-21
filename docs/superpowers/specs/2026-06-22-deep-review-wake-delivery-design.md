# Deep-review wake delivery — never let a blocking review rot while the agent is idle

**Status:** design (awaiting approval)
**Date:** 2026-06-22
**Priority:** HIGH — live reliability bug in the existing deep reviews (Capabilities G + H).

## The bug (verified)

The deep reviews are launched fire-and-forget and surfaced passively, so their findings can never reach an idle agent:

- `plan-file-review.mjs` spawns the deep spec-review worker with `{ detached: true, stdio: "ignore" }` + `child.unref()`.
- `pre-push-review.mjs` launches the deep push-review the same detached way.
- The result is read ONLY by `stop-review.mjs`'s `surfaceDeepResult()` — i.e., at the *next* Stop hook.

Verified against the official Claude Code docs (claude-code-guide research, 2026-06-22):

1. "Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction. **Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle.**"
2. A process spawned `detached + unref'd + stdio:"ignore"` is **invisible to the harness** — it cannot trigger a rewake; its only delivery channel is a file read by a *later* hook invocation.
3. `asyncRewake` is a `type:"command"` hook field, valid on all events; default command-hook timeout is 600 s (overridable per hook).

So: agent writes a spec → fast panel ALLOWs → detached deep worker launches → agent presents and **goes idle** → deep worker finishes minutes later with a HIGH block → **no Stop fires while idle → the block sits in a file unseen.** Observed live repeatedly on this very spec series.

## Goal

Deliver a blocking deep-review finding to the agent **reliably, even when the agent has gone idle after its turn**, and **never lose a queued review or a completed blocking result even if the runner is killed at any point** — for spec (G) and push (H). Non-blocking (ALLOW) results stay quiet. No detached/invisible workers.

## Non-goals

- Changing what the deep reviews analyze (unchanged: agentic, repo-grounded).
- Making the deep review synchronous/blocking on the edit or push (it stays background — Claude keeps working; only a *block* re-engages it).
- **Changing the fast gates' synchronous behavior.** `plan-file-review.mjs` and `pre-push-review.mjs` keep their current synchronous fast-panel feedback exactly as today (async would forfeit that gating — a regression). Their only change is to *enqueue* a deep-review job instead of spawning a detached worker.

## Core mechanism

Two roles, exactly **one** async hook:

- **The fast gates stay SYNCHRONOUS and behaviorally unchanged.** They keep their inline fast-panel feedback; their ONLY change is to **enqueue a deep-review job** instead of launching a detached worker. They do NOT become `asyncRewake`; they do NOT run the deep review inline.
- **One harness-tracked `asyncRewake` Stop hook — `deep-review-runner.mjs` (new)** is the sole async host. At each turn end it claims a bounded batch of queued jobs, runs them concurrently in the background (Claude keeps working), and on a HIGH-severity block writes the findings to **stderr and exits 2** → the harness wakes the agent immediately, even if idle (`rewakeMessage` lead-in).

No `detached`/`unref`/`stdio:"ignore"` anywhere. The runner process IS the review; the harness tracks its exit. This is the docs' supported "async work must re-engage an idle agent" pattern (Stop + `asyncRewake` + exit 2), symmetric for G and H.

## Design

### Job lifecycle — crash-safe, NO delivery counter

A job is a file under `workspaceStateDir(ws)/deep-queue/`. `jobKey` = the existing `deepKey` (spec) / range-SHA hash (push) → identical content/range isn't queued twice. States move by **atomic rename**:

```
<jobKey>.json            queued (written by the sync gate)
<jobKey>.claimed.<pid>   a runner is reviewing it
<jobKey>.blocked         review found a HIGH block (DURABLE; stores {kind, findings, contentKey, firstBlockedTs})
(file removed)           ONLY on a CLEAN result, or when a .blocked job's content CHANGES (agent addressed it)
```

**There is NO delivery counter, ever.** A counter is unsafe: a crash after incrementing but before the wake is confirmed would consume an attempt and could eventually delete an undelivered HIGH block. A `.blocked` file is therefore retired by exactly one durable, crash-proof signal — **its content changed** (the agent edited the spec, or the push range is no longer current). It is NEVER deleted by elapsed time or attempt count. Re-*waking* is bounded by TIME (a `.blocked` past `WAKE_WINDOW` downgrades from an exit-2 wake to a non-waking advisory note) but the file is **kept** until content-change, so a finding is never lost — only, eventually, made less intrusive.

Crash-safety by window:
- Crash before claim → stays `.json` → next runner claims it.
- Crash while reviewing (`.claimed.<pid>`) → orphan-recovery requeues it (runner step 1).
- Review finishes BLOCK → atomically rename `.claimed` → `.blocked` (durable) **before** any `exit 2`. A crash after the review but before/during the wake leaves `.blocked` on disk → re-delivered next Stop. No delete-before-delivery window; no counter to corrupt.
- Review finishes CLEAN → delete the claim (nothing to lose).

### Runner — `deep-review-runner.mjs` (new)

Registered on `Stop`, `asyncRewake:true`, `timeout:1320`, `rewakeMessage`. Constants: `CLAIM_LIMIT = 2`, `DEEP_BUDGET = 20 min` (`INVESTIGATE_TIMEOUT_MS`), `WAKE_WINDOW = 30 min`. `timeout (1320s) > DEEP_BUDGET`, and the claimed batch runs CONCURRENTLY, so wall-clock ≈ one review regardless of batch size. Each turn end:

1. **Recover orphans.** Requeue any `<jobKey>.claimed.<pid>` whose `pid` is dead OR whose mtime exceeds a 25-min staleness window (`> timeout`) by renaming back to `<jobKey>.json`. (Self-heals a killed/timed-out runner.)
2. **Re-deliver pending blocks.** For each `<jobKey>.blocked`, recompute the target's current content key:
   - content **changed** (agent addressed it) → delete the `.blocked` file (retired). It is gone because the agent acted, not because of time/count.
   - content **unchanged** and `now - firstBlockedTs < WAKE_WINDOW` → include its stored `findings` in this run's **wake** set.
   - content **unchanged** and `now - firstBlockedTs ≥ WAKE_WINDOW` → include its stored `findings` in this run's **advisory** set (non-waking), and KEEP the file (still surfaced every turn as a note until content changes; never deleted by time).
3. **Claim** at most `CLAIM_LIMIT` `<jobKey>.json` jobs by atomic rename → `<jobKey>.claimed.<pid>`. Surplus jobs are left UNCLAIMED (untouched `.json`) for a later Stop — never claimed-and-orphaned.
4. **Run** the claimed batch CONCURRENTLY (`Promise.all`), each `runSpecReview`/`runPushReview` wrapped in try/catch (fail-open: on error, requeue that job to `.json` and continue — a transient reviewer/API error must not drop a job).
5. **Persist results before delivering:** for each finished job — CLEAN → delete its claim; BLOCK → atomically rename its claim → `<jobKey>.blocked` storing `{kind, findings, contentKey, firstBlockedTs: now}`, and add its findings to this run's **wake** set.
6. **Deliver:** if the wake set is non-empty → write all those findings to **stderr + `exit 2`** (wake, even idle). Else if the advisory set is non-empty → write those to **stdout** as a systemMessage note and `exit 0`. Else → `exit 0`. (`.blocked` files are deleted ONLY in step 2 on content-change — never here, never by time/count — so a crash anywhere re-processes the durable file next Stop.)

No step advances any durable counter; the only durable mutations are: requeue-on-orphan (rename), claim (rename), CLEAN-delete (the result is empty, nothing to lose), BLOCK-persist (rename to `.blocked`), and content-change-retire (delete after the agent acted). Every one is crash-safe.

### Piece G — spec review

`plan-file-review.mjs` stays **synchronous and behaviorally unchanged** (fast panel, inline ALLOW/deny, registration `statusMessage`-only — NO `asyncRewake`). The ONLY change: replace `launchDeepReview`'s detached spawn with **enqueuing a `kind:"spec"` job** (`<jobKey>.json`; no spawn, no inline review).

### Piece H — push review

`pre-push-review.mjs` stays **synchronous and behaviorally unchanged** (fast allow/deny gate). The ONLY change: replace `launchPushReview`'s detached spawn with **enqueuing a `kind:"push"` job** carrying the SHA-pinned range. Identical runner mechanism to G.

### Shared refactor — `spec-review-run.mjs`

`runSpecReview` / `runPushReview` **return** the result to the runner and write the per-run trace (gate `spec-review`/`push-review`) as today; they no longer write a `deep-result` file.

- **Return an aggregate `findings` string.** The structured result currently holds only `{ reviewers, findingCount, maxSeverity }` (+ `traceId, badge, summary, hash`). Add a combined `findings`. CONTRACT: the hunt deep-panel result objects (`hunt.mjs` ~79/~121) carry a per-reviewer `findings` field but NOT `raw`/`firstLine`, while `combinePanel` (`panel-lib.mjs` ~151/152) builds from `s.firstLine`/`s.raw` — so do NOT route deep results through `combinePanel`; aggregate the `findings` of each blocking reviewer directly.
- **Git errors fail open.** `runPushReview` ignores the `ok` flag from `gitImpl(["log","--oneline",range])` / `gitImpl(["diff",range])`; check both and on failure return a fail-open (no-block) result so the runner requeues/clears rather than waking on phantom content.
- **CLI entry retargeted.** Standalone `node spec-review-run.mjs <path> --ws` runs the review and `exit 2` on a HIGH block / `exit 0` otherwise (manual use). The runner imports + calls the exported functions in-process — no shell-out.
- **`bench-runner spec-review`** prints the returned result (currently silent).

### Retire the next-stop surfacing path

`surfaceDeepResult()` + `deep-result-*.json` become obsolete. `stop-review.mjs` stops importing/calling `surfaceDeepResult` (its committed-diff + reviewed-head logic untouched); `deep-review.mjs`'s `writeDeepResult`/`readLatestDeepResult`/`deleteDeepResult` are removed. `deepKey`/`parseSeverity`/`severityRank`/`shouldRewake` stay.

## Data flow

```
Spec/plan save → plan-file-review (SYNC, unchanged): fast panel inline ALLOW/deny + enqueue {kind:"spec"}.json
git push       → pre-push-review (SYNC, unchanged): fast allow/deny gate    + enqueue {kind:"push", SHA-pinned}.json
Turn end       → deep-review-runner (Stop, asyncRewake, timeout 1320s):
                   1 recover orphaned .claimed → .json
                   2 for each .blocked: content changed? delete : (age<WAKE_WINDOW? wake-set : advisory-set, keep file)
                   3 claim ≤ CLAIM_LIMIT .json → .claimed.<pid>   (surplus left queued)
                   4 run batch CONCURRENTLY (errors requeue → .json)
                   5 CLEAN→delete claim ; BLOCK→rename claim→.blocked (DURABLE) + add to wake-set
                   6 wake-set? stderr+EXIT 2 : advisory-set? stdout note+exit 0 : exit 0
                 (no counter; .blocked deleted ONLY on content-change; crash anywhere → re-processed next Stop)
```

## Error handling

Every path fails OPEN — an edit, push, or turn is never wedged. A review that throws (unreadable spec, git failure, reviewer/API error) requeues that job to `.json` (retries, never drops) with a one-line `⛩` stderr note. `exit 2` only ever delivers a real HIGH block. Empty/unreadable queue → exit 0. A `.blocked` file is never deleted except on content-change, so no crash can lose a completed block.

## Testing

Injected reviewers + temp git repos (no real API calls); the idle-wake itself is harness behavior (verified by docs) — tests assert the exit-code/stderr/file-state contract that drives it.

- **Piece G/H:** the sync gate writes a `deep-queue/<key>.json` of the right `kind` and does NOT spawn a detached worker / run inline; fast-panel decision unchanged.
- **Runner happy path:** claims `.json` (atomic; a 2nd runner finds none); CLEAN → claim deleted + `exit 0`; BLOCK → claim becomes `.blocked` (stores findings/contentKey/firstBlockedTs) + `exit 2` with findings; empty queue → `exit 0`.
- **Crash-safety (key):** a pre-existing `.blocked` (simulating crash after review, before/during wake) is RE-DELIVERED on the next invocation (`exit 2`, findings present) and is NOT deleted before that delivery.
- **No counter / time downgrade:** a `.blocked` with unchanged content and `firstBlockedTs` older than `WAKE_WINDOW` is delivered as a stdout ADVISORY (exit 0, no `exit 2`) and the FILE STILL EXISTS afterward (never deleted by time).
- **Content-change retirement:** a `.blocked` whose target content changed is deleted (retired) and NOT re-delivered.
- **Claim bound:** 3 queued + `CLAIM_LIMIT=2` → exactly 2 claimed+run, the 3rd left untouched `.json`, processed next invocation; claimed jobs run concurrently.
- **Orphan recovery:** a `.claimed.<deadpid>`/stale-mtime is requeued to `.json` then processed.
- **Resilience:** a review that throws requeues its job to `.json` (not dropped); runner exits 0.
- **Shared refactor:** `runSpecReview`/`runPushReview` return a non-empty `findings` aggregated from blocking reviewers' `findings` (not via `combinePanel`); write a `spec-review`/`push-review` trace; write NO `deep-result`; push review returns fail-open when `gitImpl` reports `ok=false`. `bench-runner spec-review` prints the result.

## Test migration (existing tests this change rewrites)

- `tests/plan-file-review.test.mjs` — G2/G3 detached-spawn asserts → assert it ENQUEUES a `kind:"spec"` job (no spawn/inline), fast panel unchanged.
- `tests/pre-push-review.test.mjs` — H detached-spawn asserts → assert it ENQUEUES a `kind:"push"` job (no spawn).
- `tests/stop-review.test.mjs` — G5/H `surfaceDeepResult`/deep-result tests → removed (path retired); reviewed-head + committed-diff tests kept.
- `tests/deep-review.test.mjs` — `writeDeepResult`/`readLatestDeepResult`/`deleteDeepResult` tests → removed; `parseSeverity`/`severityRank`/`shouldRewake`/`deepKey` kept.
- New `tests/deep-review-runner.test.mjs` — the runner cases above.

## Deployment

`deploy-global-hooks.mjs`:
- `plan-file-review.mjs` registration **unchanged** (`PostToolUse Write|Edit`, `statusMessage` only — NOT `asyncRewake`).
- `pre-push-review.mjs` registration **unchanged** (`PreToolUse Bash`, `if:"Bash(git *)"`, `statusMessage`).
- **Register `Stop` → `deep-review-runner.mjs`** with `asyncRewake:true, timeout:1320, statusMessage, rewakeMessage`. The `register(s.hooks.Stop, undefined, …)` helper appends matcher-less Stop hooks to the first matcher-less Stop block, so the runner becomes a second hook ENTRY there alongside `stop-review.mjs` (both fire on Stop, run in parallel, each with its own per-entry opts). Confirm the helper preserves distinct per-entry `asyncRewake`/`timeout`/`rewakeMessage`; if not, fix the helper.

`bench-runner.mjs`: the hardcoded `SETUP_GATES` (plan-review, plan-file-review, pre-push-review, stop-review) gains the `deep-review-runner.mjs` Stop gate so `bench:setup` reports it.

Deploy parity verified for the new (`deep-review-runner.mjs`) + changed (`plan-file-review`, `pre-push-review`, `stop-review`, `spec-review-run`, `deep-review`) hooks.

## Rollout note / lesson

Until this ships, the deep review can still miss an idle agent. Interim behavior: after writing a spec/plan, the agent must **check for the deep-review result (poll the trace / `/bench:status`) before declaring it good** rather than going idle — the manual workaround for the very gap this spec closes. (This spec was hardened across many deep-review rounds — false-async-premise, sync-behavior, contradiction, timeout, unbounded-batch, delete-before-delivery, and the delivery-counter race — each landing only because the agent stayed engaged instead of idling. Strong evidence the deep review is valuable and this wake fix is the right priority.)
