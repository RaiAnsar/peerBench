# Deep-review wake delivery — never let a blocking review rot while the agent is idle

**Status:** design (awaiting approval)
**Date:** 2026-06-22
**Priority:** HIGH — live reliability bug in the existing deep reviews (Capabilities G + H).

## The bug (verified)

The deep reviews are launched fire-and-forget and surfaced passively, so their findings can never reach an idle agent:

- `plan-file-review.mjs:46` spawns the deep spec-review worker with `{ detached: true, stdio: "ignore" }` + `child.unref()`.
- `pre-push-review.mjs` launches the deep push-review the same detached way.
- The result is read ONLY by `stop-review.mjs`'s `surfaceDeepResult()` — i.e., at the *next* Stop hook.

Verified against the official docs (claude-code-guide research, 2026-06-22):

1. "Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction. **Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle.**"
2. A process spawned `detached + unref'd + stdio:"ignore"` is **invisible to the harness** — it cannot trigger a rewake; its only delivery channel is a file read by a *later* hook invocation.
3. `asyncRewake` is a `type:"command"` hook field, valid on all events; default command-hook timeout is 600 s.

So: agent writes a spec → fast panel ALLOWs → detached deep worker launches → agent presents and **goes idle** → deep worker finishes minutes later with a HIGH block → **no Stop fires while idle → the block sits in a file unseen.** Observed live: a 28-finding HIGH block on this very spec series reached the agent only because the user manually noticed.

## Goal

Deliver a blocking deep-review finding to the agent **reliably, even when the agent has gone idle after its turn** — for both the spec review (G) and the push review (H). Non-blocking (ALLOW) results stay quiet. No detached/invisible workers.

## Non-goals

- Changing what the deep reviews analyze (unchanged: agentic, repo-grounded).
- Making the deep review synchronous/blocking on the edit or push (it must stay background — Claude continues working; only a *block* re-engages it).
- Reworking the fast content-only panels (plan-file fast panel, pre-push fast gate) — they keep their current synchronous behavior.

## Core mechanism

Run each deep review inside a **harness-tracked `asyncRewake` command hook** that:
- runs the review in the background (Claude continues immediately),
- on a HIGH-severity block: writes the findings to **stderr and exits 2** → the harness wakes the agent immediately, even if idle (with `rewakeMessage` as the lead-in),
- otherwise: exits 0 (silent; or an advisory `additionalContext` on stdout for non-blocking notes).

No `detached`/`unref`/`stdio:"ignore"`. The hook process IS the review; the harness tracks its exit.

## Design

### Piece G — spec review (the easy half)

**Current state (verified `deploy-global-hooks.mjs:111`):** `plan-file-review.mjs` is registered with **only `statusMessage`** — it is NOT `asyncRewake`, has no `timeout`, no `rewakeMessage`. (Only `stop-review.mjs` is `asyncRewake:true`.) So the wake mechanism does NOT exist for plan-file yet and must be ADDED.

Changes:
1. **Registration (deploy):** add `asyncRewake:true`, `timeout:600`, and a `rewakeMessage` to plan-file's registration. Without `asyncRewake:true` the exit-2 wake cannot reach an idle agent — this is the linchpin.
2. **Hook logic**, after the synchronous fast panel:
   - Fast panel HIGH block → stderr + `exit 2` (wake) immediately; skip the deep pass.
   - Fast panel ALLOW/advisory → run the deep spec-review **inline**, wrapped in try/catch: `try { result = await runSpecReview(...) } catch (e) { stderr note; exit 0 }` — `runSpecReview` THROWS on an unreadable spec (`spec-review-run.mjs:37`), so the catch is mandatory to honor fail-open.
   - Deep review HIGH block → stderr + `exit 2` (wake, even idle). Else → `exit 0`.

Remove `launchDeepReview`'s detached spawn. The deep review no longer writes a `deep-result` file for next-stop surfacing — delivery is the exit-2 wake.

### Piece H — push review (the hard half)

`pre-push-review.mjs` is a **synchronous** `PreToolUse` hook — it must return a fast allow/deny to gate the push, so it cannot host a minutes-long async review. Instead:

1. The pre-push hook keeps its synchronous fast gate, and **enqueues** a deep-push-review request: write a small pending-job file under `workspaceStateDir(ws)/deep-queue/<rangeShaHash>.json` containing the SHA-pinned range (range pinning already exists) + a content key. No detached worker.
2. A **dedicated `asyncRewake` Stop hook** — `deep-review-runner.mjs` (new, registered on `Stop`, `asyncRewake: true`, `timeout: 600`) — fires at each turn end, claims any pending deep-queue jobs (atomic rename to avoid double-run), runs them inline in the background, and on a HIGH block writes findings to stderr + `exit 2` (wake, even idle). Jobs with no block are removed silently.
3. Debounce/dedupe by the existing `deepKey`/range hash so the same push isn't reviewed twice; a per-job "claimed" marker prevents two runners racing.

This Stop-hosted runner is the supported "async work must re-engage an idle agent" pattern from the docs. It also gives G a fallback host if ever needed, but G's primary path stays the inline plan-file hook.

### Shared refactor — `spec-review-run.mjs`

`runSpecReview` / `runPushReview` are refactored to **return** the review result to the caller, and to write the per-run trace (gate `spec-review` / `push-review`) as today. The caller (plan-file hook for G; deep-review-runner for H) decides delivery (exit 2 vs 0). They no longer write a `deep-result` file as the delivery channel.

- **Return shape must include an aggregate `findings` string.** Currently the structured result holds only `{ reviewers, findingCount, maxSeverity }` (+ `traceId, badge, summary, hash`). Add a combined `findings` field (the per-reviewer blocking findings text, as `combinePanel` produces) so the exit-2 wake delivers the actual findings, not just the summary line. Both `runSpecReview` and `runPushReview` must populate it (push findings exist per-reviewer pre-summarization in the hunt panel).
- **Git errors must fail open.** `runPushReview` currently ignores the `ok` flag from `gitImpl(["log","--oneline",range])` and `gitImpl(["diff",range])`; on a git failure it would review empty/placeholder content. Check the `ok` flags and, on failure, return a fail-open result (no block) so the caller exits 0 rather than waking on a phantom review.
- **`bench-runner spec-review` subcommand must print the result.** It currently calls `await runSpecReview(...)` and returns with no stdout. Update it to print the returned result so the manual path isn't silent.

**CLI entry + `spec-review` subcommand:** the standalone `spec-review-run.mjs` worker CLI is no longer spawned by any hook after this change. Retarget it to the new delivery contract — it runs the review and exits 2 on a HIGH block / 0 otherwise (so it stays usable as a manual `node spec-review-run.mjs <path> --ws` invocation and by the deep-review-runner) — rather than left as dead code. The `bench-runner spec-review` subcommand (which delegates to `runSpecReview`) keeps working against the new return contract (it prints the returned result).

### Retire the next-stop surfacing path

`surfaceDeepResult()` + the `deep-result-*.json` files become obsolete (delivery is now the exit-2 wake). `stop-review.mjs` stops importing/calling `surfaceDeepResult`; `deep-review.mjs`'s `writeDeepResult`/`readLatestDeepResult`/`deleteDeepResult` are removed. This deletes the buggy passive path entirely rather than leaving dead code.

### Loop safety

An exit-2 wake delivers the findings; the agent fixes and re-saves the spec / re-pushes, which re-enqueues a review. Reuse the existing `deepKey` debounce so identical content isn't re-reviewed, and add a per-workspace consecutive-deep-wake cap (mirroring `stop-loop`, MAX≈4 within a window) so a stubborn finding can't wake-loop forever — on cap, downgrade to an advisory note and stop waking.

## Data flow

```
Spec save  → plan-file hook (asyncRewake): fast panel → [block? exit2 wake]
                                            → inline deep spec-review → [HIGH block? exit2 wake : exit0]
git push   → pre-push hook (sync): fast gate (allow/deny) + ENQUEUE deep-push job (SHA-pinned)
Turn end   → deep-review-runner (Stop, asyncRewake): claim queued jobs → run inline
                                            → [HIGH block? stderr+exit2 wake (even idle) : remove job, exit0]
```

## Error handling

Every path fails OPEN: a review/network/git error → one-line `⛩` stderr note + exit 0 (never wedge an edit, push, or turn). The deep-review-runner claiming/running a job that errors removes the job and exits 0. Exit 2 is used ONLY to deliver a real HIGH block.

## Testing

- **G:** plan-file hook with a HIGH-block deep result → process exits 2 with findings on stderr; ALLOW deep result → exit 0; fast-panel HIGH block → exit 2 without running the deep pass; deep review invoked INLINE (no detached spawn — assert the spawn impl is never called, `runSpecReview` is awaited).
- **H:** pre-push hook enqueues a SHA-pinned job file on a real push and does NOT spawn a detached worker; the deep-review-runner claims a queued job (atomic — a second runner finds none), runs it, exits 2 on a HIGH block / exit 0 + removes the job otherwise.
- **Shared:** `runSpecReview`/`runPushReview` return the structured result and write a `spec-review`/`push-review` trace; no `deep-result` file is written.
- **Loop cap:** N consecutive deep-wakes within the window → downgrade to advisory, no exit 2.
- **Fail-open:** reviewer/git errors on every path → exit 0.
- The actual idle-wake is harness behavior (verified by docs), not unit-tested; tests assert the exit-code + stderr contract that drives it.

## Deployment

`deploy-global-hooks.mjs`:
- **ADD** `asyncRewake:true`, `timeout:600`, and a `rewakeMessage` to the `plan-file-review.mjs` registration (it currently has ONLY `statusMessage` — this is a NEW addition, not a "keep").
- **Register** the new `Stop` → `deep-review-runner.mjs` with `asyncRewake:true, timeout:600, rewakeMessage` (a second matcher-less Stop block alongside `stop-review.mjs`).
- `pre-push` stays synchronous (it only enqueues now) — registration unchanged except it no longer launches a detached worker in code.

`bench-runner.mjs`: the `SETUP_GATES` list (`bench-runner.mjs:~348`, currently hardcoded "the four gates": plan-review, plan-file-review, pre-push-review, stop-review) gains the `deep-review-runner.mjs` Stop gate so `bench:setup` reports it.

Deploy parity verified for the new (`deep-review-runner.mjs`) + changed (`plan-file-review`, `pre-push-review`, `stop-review`, `spec-review-run`, `deep-review`) hooks.

## Test migration (existing tests this change rewrites)

This change deliberately removes the detached-spawn + `deep-result` + `surfaceDeepResult` machinery, so the tests asserting that machinery must be rewritten to the new exit-2/return contract (not left to break the build):
- `tests/plan-file-review.test.mjs` — G2/G3 tests assert the detached `launchDeepReview` spawn shape → rewrite to assert inline `runSpecReview` + exit-2-on-block / exit-0-on-allow / exit-0-on-error (fail-open).
- `tests/pre-push-review.test.mjs` — H tests assert the detached `launchPushReview` spawn → rewrite to assert the pre-push hook ENQUEUES a SHA-pinned job file (no spawn).
- `tests/stop-review.test.mjs` — G5/H tests exercise `surfaceDeepResult`/deep-result surfacing → remove (path retired); keep the reviewed-head + committed-diff tests untouched.
- `tests/deep-review.test.mjs` — `writeDeepResult`/`readLatestDeepResult`/`deleteDeepResult` tests → remove (functions deleted); keep `parseSeverity`/`severityRank`/`shouldRewake`/`deepKey` tests.
- New `tests/deep-review-runner.test.mjs` — the Stop runner: claims a queued job (atomic; a second runner finds none), runs it, exits 2 on a HIGH block / exit 0 + removes the job otherwise, fail-open on error, loop-cap downgrades to advisory.

## Rollout note / lesson

Until this ships, the deep review can still miss an idle agent. Interim behavior: after writing a spec/plan, the agent must **check for the deep-review result (e.g., `/bench:status` or the trace) before declaring it good** rather than going idle — the manual workaround for the very gap this spec closes.
