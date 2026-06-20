# peerbench Gate Reliability & Auto-Review — Design Spec

**Date:** 2026-06-20
**Status:** Approved for planning
**Repo:** github.com/RaiAnsar/peerBench (private)

## Goal

Make the four peerbench review gates (plan, plan-file, pre-push, stop) **provably active and visibly honest** in every git project — eliminate the paths where a gate silently no-ops, reviews the wrong thing, or *looks* inactive when it ran — and add automatic deep (repo-aware) review of specs/plans on save.

## Background

A `/bench:hunt` self-review surfaced 15 silent-failure candidates; an adversarial per-finding verification pass (15 agents, isolated temp repos, concrete repros) confirmed **14** and refuted **1** (`codex-missing-failopen` — the fail-open path is actually loud, so not a bug). Two further issues came from a live session in a real client project (`/Users/rai/Desktop/Work/Clients4_0/Ryan-Persitza/adversaries`):

- The user believed the panel "didn't trigger" on spec edits. Trace evidence proved it **did** — 7 plan-file reviews, full `Codex+Kimi+MiMo+GLM` panel, all ALLOW. The cause was the **ALLOW summary truncating** before the cheap reviewers showed (→ finding **F**).
- The user expected the **deep repo-aware review** to run automatically on saving a spec; today only the fast content gate is automatic and the deep pass is manual (→ capability **G**).

## Principles / Global Constraints

1. **Loud, fail-open.** No gate ever changes its allow/deny *direction* on an internal error — a gate bug must never block a turn or a push. Every previously-silent degradation path instead emits a `⛩ …` diagnostic (stderr and/or `systemMessage`). No fail-closed conversions.
2. **TDD.** Every fix gets a failing test first; the verification repros become test cases. The suite (currently **145**, `node --test 'tests/*.test.mjs'`) must stay green and grow.
3. **Deploy parity.** Hooks run from `~/.claude/hooks` (deployed copies). After changes, `node scripts/deploy-global-hooks.mjs` re-syncs; tests target the repo sources.
4. **No Claude commit trailers** on this repo (see memory `no-claude-trailers`).
5. **Same-file edits stay sequential** (one task per file or ordered) to avoid conflicts during execution.

---

## Part 1 — Correctness & Visibility Fixes (15 items)

### Work-stream A — pre-push gate (`global-hooks/pre-push-review.mjs`)

- **A1 — spaces in repo path break push detection (HIGH).**
  *Symptom:* `git -C "/tmp/Ryan P/repo" push` is treated as "not a git push" → no review (verified: detector returns `false`).
  *Mechanism:* `isGitPushSegment` tokenizes with `split(/\s+/)`; a quoted path with a space splits into two tokens, so the `-C` value-skip lands on the wrong token and never sees `push`.
  *Fix:* add a quote-aware `shellTokenize(text)` (respects single/double quotes) and use it in `isGitPushSegment` instead of `split(/\s+/)`.
  *Test:* detector returns `true` for `git -C "/tmp/Ryan P/repo" push`, `git -C '/a b/r' push`, `git -c user.name="John Doe" push`; existing cases (`git push`, `git -C /tmp/repo push`, `cd /x && git push`) still pass.

- **A2 — wrong/empty push range (MED-HIGH).**
  *Symptom:* a repo with `origin/master` only (no `@{u}`, no `origin/HEAD`, no `origin/main`) → `resolvePushRange` returns `ok:false` → early "nothing to push" allow with real commits unreviewed. Also a git *error* is indistinguishable from "no commits."
  *Mechanism:* fallback chain is `@{u} → origin/HEAD → origin/main`, missing `origin/master`; `git()` maps all failures to `""`.
  *Fix:* add `origin/master` to the fallback chain (after `origin/main`); when falling back to a guessed base, attach an explicit note; use `gitTry` for the commits/diff lookups so a git error is reported (loud) rather than read as "nothing to push."
  *Test:* repo with only `origin/master` → range resolves to `origin/master..HEAD`; git-error path emits a `⛩` note and still fails open.

- **A3 — undetected push forms emit no decision (LOW).**
  *Symptom:* `(git push)`, `eval "git push"` → `findPushSegment` returns `null` → silent return, no decision.
  *Fix (loud/fail-open):* when the command plausibly contains a `git push` (both `git` and `push` word-tokens present) but can't be parsed cleanly, emit an explicit `allow` with an uncertainty note. A plain non-git command (`npm test`) still returns silently (no note).
  *Test:* `(git push)` → allow decision **with** uncertainty note; `npm test` → silent allow (no note).

### Work-stream B — plan-file gate (`global-hooks/plan-file-review.mjs`)

- **B1 — root-relative plan/spec paths skipped (MED).**
  *Symptom:* a `file_path` of `plans/p.md` / `specs/s.md` (no leading slash) is silently skipped.
  *Mechanism:* `PLAN_PATH_RE = /\/(plans|specs)\/[^/]*\.md$/i` requires a leading slash.
  *Fix:* `PLAN_PATH_RE = /(^|\/)(plans|specs)\/[^/]*\.md$/i`.
  *Test:* matches `plans/p.md`, `docs/plans/p.md`, `/repo/specs/s.md`; rejects `notplans/p.md`, `plans/sub/p.md`.

- **B2 — silent on malformed stdin (MED).**
  *Symptom:* bad stdin JSON → bare `return`, no stderr/trace/decision (unlike `plan-review.mjs`).
  *Fix:* on the catch, emit `⛩ plan-file-review: could not parse hook input (<msg>); treating as empty.` to stderr and continue (let the existing path/content checks handle the empty state).
  *Test:* malformed stdin → non-empty stderr note.

### Work-stream C — enable/disable correctness (`scripts/bench-runner.mjs`, `global-hooks/config-store.mjs`)

- **C1 — `/bench:on` lies after a global disable (HIGH).**
  *Symptom:* after `/bench:off --global`, plain `/bench:on` prints `bench: enabled (workspace)` but `isBenchDisabled` is still `true` (global marker untouched) → every gate no-ops.
  *Fix (conservative refuse — user's choice):* plain `on` clears the workspace marker; if the **global** marker is still present it does **not** clear it (no silent global re-enable) and returns a loud, accurate message: `bench: workspace re-enabled, but STILL DISABLED GLOBALLY — run /bench:on --global to clear it.` `on --global` clears the global marker as today.
  *Test:* `off --global` then `on` → `isBenchDisabled` stays `true` **and** the message says still-disabled-globally; `on --global` → `isBenchDisabled` false.

- **C2 — `isBenchDisabled` swallows FS errors (LOW).**
  *Symptom:* `fs.existsSync` throwing (e.g. `EACCES`) is caught and treated as "no marker."
  *Fix (loud/fail-open):* keep returning `false` (enabled — a review gate that runs is the safe direction) but emit a `⛩` stderr warning naming the error.
  *Test:* `existsSync` stubbed to throw → returns `false` **and** warns.

- **C3 — `/bench:reviewers <bad>` failure invisible to stdout (LOW).**
  *Symptom:* `setReviewers` throws → error only on stderr; stdout-only consumers assume success.
  *Fix:* wrap the call in `reviewersCommand`; write `Error: <msg>` to stdout and set `process.exitCode = 1`.
  *Test:* bad name → stdout contains `Error:`, exit code 1, reviewer list unchanged.

### Work-stream D — deploy / install / observability

- **D1 — deploy can bury `stop-review` in a matcher-scoped block (HIGH).** (`scripts/deploy-global-hooks.mjs`)
  *Symptom:* if the first `Stop` block in `settings.json` carries an unrelated `matcher`, `register()` injects `stop-review` into it → the gate only fires for that tool's Stop events, never normal turns.
  *Mechanism:* the `matcher === undefined` arm does `list.find(b => Array.isArray(b.hooks))` regardless of `b.matcher`.
  *Fix:* prefer a block that has `hooks` **and** no `matcher`; if none, create a fresh matcher-less block. Never inject into a matcher-scoped block.
  *Test:* `settings.json` pre-seeded with `{matcher:"SomeTool",hooks:[…]}` first → after sync, `stop-review` lands in a matcher-less block.

- **D2 — fresh install has commands but no gates (HIGH).** (`README.md`, `scripts/bench-runner.mjs` setup)
  *Symptom:* the documented install never runs `deploy-global-hooks.mjs` (the only place the 4 gates get registered); `/bench:setup` reports reviewers/keys/disabled but not hook registration, so it looks healthy while review is inactive.
  *Fix:* (a) README install path gains an explicit `node <abs>/scripts/deploy-global-hooks.mjs` step; (b) `/bench:setup` inspects `~/.claude/settings.json` and reports which of the 4 gates are registered (`ExitPlanMode→plan-review`, `Bash→pre-push-review`, `Write|Edit→plan-file-review`, `Stop→stop-review`), with a pointer to the deploy script if any are missing.
  *Test:* setup run against a settings file missing hooks reports each gate's present/missing status.

- **D3 — trace-write failures swallowed (LOW).** (`global-hooks/trace-store.mjs` + 4 gate callers)
  *Symptom:* disk-full / read-only / permission errors vanish; `/bench:status` shows no history with no reason.
  *Fix (loud/fail-open):* keep best-effort (never throw out of a gate), but each gate's trace `catch` emits a `⛩ … trace write failed` stderr note.
  *Test:* `writeTrace` stubbed to throw → gate emits the note and still allows.

### Work-stream E — stop gate + cleanup (`global-hooks/stop-review.mjs`, `global-hooks/panel-lib.mjs`)

- **E1 — staged-only changes in a fresh repo skip review (MED).**
  *Symptom:* a repo with no commits and all changes `git add`ed → `git diff HEAD` empty + no untracked → stop gate early-returns.
  *Fix:* include `git diff --cached` in change detection **and** in the reviewed content (merge staged into the diff block with a label).
  *Test:* fresh repo, staged-only change → stop gate reviews (does not skip).

- **E2 — `readInput` silent on malformed stdin (LOW).** (`stop-review.mjs` + `pre-push-review.mjs`)
  *Symptom:* bad stdin → `{}` → `cwd` silently falls back to `process.cwd()` (possibly wrong workspace).
  *Fix:* on parse failure, emit a `⛩` stderr note before returning `{}`.
  *Test:* malformed stdin → non-empty stderr note (both files).

- **E3 — delete dead `workspaceFingerprint` (cleanup).**
  *Symptom:* `workspaceFingerprint` returns `null` on any git error; verification found it is **never imported** (orphaned at Grok removal) and untested.
  *Fix:* delete the function; remove any references/tests.
  *Test:* `grep` confirms no imports; suite passes after removal.

### Work-stream F — verdict visibility, all gates (`global-hooks/panel-lib.mjs` + 4 gate emit sites)

- **F — ALLOW/BLOCK summary hides which reviewers ran (the adversaries confusion).**
  *Symptom:* the summary is `Codex: <≤100c> · Kimi: <≤100c> · MiMo … · GLM …` then truncated (`slice(0, ~220)`), so MiMo/GLM get chopped and it reads as Codex-only.
  *Fix:* `combinePanel` returns a compact `badge` string of per-reviewer verdict glyphs (e.g. `Codex✓ Kimi✓ MiMo✓ GLM✗`, `✗` = skipped/errored); every gate leads its message with the badge **before** the truncated reasons: `⛩ <gate>: ALLOW [Codex✓ Kimi✓ MiMo✓ GLM✓] — <summary…>`. The badge survives truncation, so the panel's participation is always visible.
  *Test:* `combinePanel` exposes `badge`; a 4-reviewer ALLOW renders all four glyphs; an errored reviewer shows `✗`.

---

## Part 2 — Auto deep-review on spec/plan save (capability G)

**What:** today the fast **content-only** plan-file gate auto-fires on every spec/plan save; the **deep repo-aware** pass (the `/bench:hunt`-style review that scours the codebase against the spec) is manual. G makes the deep pass fire automatically on save, in the background.

**Trigger:** in `plan-file-review.mjs`, after the fast content review returns **ALLOW** (and after the existing content-dedup check), launch the deep pass. (On a fast-gate BLOCK, skip — the content has issues to fix first.)

**Mechanism:** spawn the existing deep engine (`bench-runner.mjs`, deep/repo-aware mode) **detached and unref'd**, seeded with the saved spec/plan path, read-only. The hook returns immediately — the save is never blocked.

**Debounce / cost control:** a per-workspace marker keyed on the spec's content hash (reuse the plan-file gate's approval-key machinery) records the last deep run. Before launching: skip if a deep pass for this exact content hash already ran or is in flight, and enforce a minimum interval per workspace. This prevents stacking on rapid saves and re-scanning identical content.

**Surfacing findings:** PostToolUse hooks cannot `asyncRewake`. The detached deep pass writes (a) a trace (`gate: "spec-review"`) and (b) a `deep-pending.json` in the workspace state dir. The next `stop-review` invocation (start of the next turn) checks for `deep-pending.json`, emits `⛩ deep spec review complete — <badge> <summary> (trace …)` as a `systemMessage` (or rewakes on findings), and clears the file. This guarantees findings reach the user without blocking any save.

**Tests:** (a) fast ALLOW save → a detached deep run is launched (mock the spawn; assert invoked with the spec path); (b) identical-content re-save within the interval → not launched; (c) `deep-pending.json` present at next stop → findings surfaced and file cleared.

---

## Non-goals

- No changes to panel/reviewer/model selection or prompts (beyond F's badge and G's deep seed).
- No new user-facing gates beyond G.
- No fail-closed conversions anywhere (Principle 1).
- No refactor beyond the E3 dead-code deletion.

## Test strategy

Per-item unit tests in the existing `tests/*.test.mjs` (`node --test`), with `process.env.BENCH_ROOT` isolation so no test touches real `~/.claude/plugins/data`. Verification repros become fixtures (Ryan-P spaces path, `origin/master` range, matcher-scoped Stop block, root-relative plan path, staged-only fresh repo, truncated-summary badge). Suite stays green (≥145, growing).

## Rollout

1. Land Part 1 (fast, low-risk) → `deploy-global-hooks.mjs` → verify suite + a live stop/push/plan smoke check.
2. Land Part 2 (G) → deploy → verify a spec save auto-launches the deep pass and findings surface next turn.

## Verification against the real-world case (adversaries / Ryan-Persitza)

After Part 1: editing `specs/orders-new-unified-form.md` shows `⛩ plan panel: ALLOW [Codex✓ Kimi✓ MiMo✓ GLM✓] — …` (F), and a `git -C "/…/Ryan-Persitza/…" push` is detected and reviewed (A1). After Part 2: saving that spec auto-launches the deep repo-aware pass with no manual trigger (G).
