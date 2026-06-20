# peerbench Gate Reliability & Auto-Review — Design Spec (v2)

**Date:** 2026-06-20
**Status:** Approved for planning (v2 incorporates the deep `/bench` panel review)
**Repo:** github.com/RaiAnsar/peerBench (private)

## Goal

Make the four peerbench review gates (plan, plan-file, pre-push, stop) **provably active and visibly honest** in every git project — eliminate the paths where a gate silently no-ops, reviews the wrong thing/repo/range, or *looks* inactive when it ran — and add automatic deep (repo-aware) review of specs/plans on save.

## Revision note (v1 → v2)

v1 was reviewed by the deep `/bench` panel (Codex + Kimi + MiMo + GLM) against the real code. All 14 verified bugs stand, but the panel found completeness gaps, three suite-breaking implementer traps, and an unworkable G architecture. v2 folds in every consensus correction and adds three findings v1 missed (X1 double-emit, X3 plan-file testability, status-id). Iterated plan-file gate reviews further tightened the spec: a G5 ordering contradiction; A2's explicit-refspec handling (source ref + named remote, not hardcoded `origin`); and A4/H1's emit-once guard being **invocation-scoped**, not module-level. Line numbers below are indicative — implementers must re-confirm against the working tree.

## Principles / Global Constraints

1. **Loud, fail-open.** No gate ever changes its allow/deny *direction* on an internal error — a gate bug must never block a turn or a push. Previously-silent degradations emit a `⛩ …` diagnostic (stderr and/or `systemMessage`). No fail-closed conversions.
2. **Don't break the suite.** Current suite is **146** `test(` declarations (`node --test 'tests/*.test.mjs'`). Every change keeps it green and adds tests. The panel flagged three changes that would break existing tests if implemented naively (A1, A3, C1) — their specs below carry explicit guardrails.
3. **TDD**, `process.env.BENCH_ROOT` isolation in every test (never touch real `~/.claude/plugins/data`). Verification/panel repros become fixtures.
4. **Deploy parity.** After changes, `node scripts/deploy-global-hooks.mjs` re-syncs `~/.claude/hooks`; tests target repo sources.
5. **No Claude commit trailers** (memory `no-claude-trailers`).
6. **Same-file edits sequential** during execution.

---

## Part 0 — Prerequisite refactor (X3, blocks B2/F/G testing)

- **P0 — make `plan-file-review.mjs` injectable.**
  *Why:* unlike `stop-review.mjs` and `pre-push-review.mjs` (which export `runMain({resolveReviewersImpl, writeTraceImpl, isBenchDisabledImpl, input})`), `plan-file-review.mjs` has a bare `main()` calling module-level singletons — so B2, F, and G can't be unit-tested with mocks.
  *Do:* extract `main()` into an exported `runMain({...impls, input})` mirroring the other two gates; keep the `import.meta.main` shim. No behavior change.
  *Test:* a smoke test invoking `runMain` with injected impls + a temp repo (proves the seam) — must pass before B2/F/G land.

---

## Part 1 — Correctness & Visibility Fixes

### Work-stream A — pre-push gate (`global-hooks/pre-push-review.mjs`)

- **A1 — spaces in repo path break push detection AND review the wrong repo (HIGH).**
  *Symptom:* `git -C "/tmp/Ryan P/repo" push` → `isGitPushSegment` returns `false` (verified) → no review. *And* (panel/Codex) even once detected, `runMain` derives the review cwd only from preceding `cd` segments (`cdTargetBeforePush`), ignoring `git -C`, so it would review the wrong repo.
  *Mechanism:* `isGitPushSegment` tokenizes with `split(/\s+/)`; a quoted path splits in two, so the `-C` value-skip lands wrong and never sees `push`.
  *Fix:* add `shellTokenize(text)` that **strips** surrounding quotes and yields clean tokens (`git -C "/a b/r" push` → `["git","-C","/a b/r","push"]`); use it in `isGitPushSegment`. Then **apply `git -C <dir>`** (in order, like git) to the resolved review cwd: parse `-C` values from the push segment and resolve them after the shell `cd` cwd in `runMain`.
  *Guardrails (panel):* keep `git pushx` / `git push --help` / `git push --dry-run` rejected; keep `cdTargetBeforePush`'s quoted-path handling working (its own regex stays, or is unified onto `shellTokenize` — either way its existing test must pass).
  *Test:* detector true for `git -C "/tmp/Ryan P/repo" push`, `git -c user.name="John Doe" push`; the resolved review cwd equals the `-C` target; existing negatives + quoted-`cd` test still pass.

- **A2 — wrong/empty push range (MED-HIGH).**
  *Symptom:* a repo with only `origin/master` (no `@{u}`/`origin/HEAD`/`origin/main`) → `resolvePushRange` returns `ok:false` → early "nothing to push" allow with real commits unreviewed; a feature branch with no `@{u}` is silently diffed against `origin/main`/`origin/HEAD` (wrong divergence); and an explicit refspec push (`git push origin HEAD:main`, `git push upstream feature:release`) is diffed against the wrong base, source, **or remote**.
  *Mechanism:* fallback is `@{u} → origin/HEAD → origin/main`; the **range resolution already uses `gitTry`** — but `resolvePushRange(ws)` never sees the command (remote/refspec), and the `git log`/`git diff` *content* lookups use `git()`, which maps a git **error** to `""` (indistinguishable from "no commits").
  *Fix:* thread the parsed push command (remote + ordered refspec list + flags) into `resolvePushRange`. Determine `<remote>` = the named remote (`git push <remote> …`), defaulting to `origin` when unnamed. Resolve range as `<base>..<source>` (NOT always `..HEAD`), using the **named remote's** tracking refs (`<remote>/…`, never hardcoded `origin/…`):
    - **`<src>:<dst>`** → source = the local `<src>` ref/commit (resolve it; `HEAD` if `<src>` is `HEAD`); base = `<remote>/<dst>` when that remote-tracking ref exists (else the base chain below). Range = `<base>..<src>`. Explicit refspecs **take precedence over** `@{u}` and `<remote>/<current-branch>`.
    - **`HEAD:<dst>`** → `<remote>/<dst>..HEAD`.
    - **bare `<ref>`** (`git push <remote> <ref>`) → src = dst = `<ref>` → `<remote>/<ref>..<ref>`.
    - **delete refspec `:<dst>`** → pushes no commits → clean allow, no review.
    - **no explicit refspec** (`git push` / `git push <remote>`) → source = `HEAD`; resolve base by precedence on the named remote: `@{u}` → `<remote>/<current-branch>` → `<remote>/HEAD` → `<remote>/main` → `<remote>/master`; range = `<base>..HEAD`.
    - **multiple refspecs** → review the union of their ranges; if it can't be resolved cleanly, fail-open with a visible `⛩` limitation note.
    - **`--all` / `--tags` / `--mirror`** (push many refs at once) → out of clean-scope → fail-open with a visible `⛩` limitation note.
    - any unresolvable source/base ref → fail-open with a visible `⛩` note.
    Attach a `note` whenever a guessed (non-explicit, non-`@{u}`) base is used. Convert the `git log`/`git diff` content lookups to `gitTry`; on a git **error** (not empty), emit a `⛩` note and fail-open — "no commits" stays a clean allow.
  *Test:* `git push origin HEAD:main` → `origin/main..HEAD`; `git push origin feature:release` → `origin/release..feature` (source = `feature`, not HEAD); `git push upstream feature:release` → `upstream/release..feature` (named remote); `git push origin topic` → `origin/topic..topic`; `git push origin :stale` (delete) → clean allow, no review; `git push --tags` → visible fail-open note; two refspecs → union reviewed (or visible fail-open note); only-`origin/master` repo, no refspec → `origin/master..HEAD`; feature branch with `origin/<branch>` and no explicit refspec → that range, not `origin/main`; git-error path emits a note and allows; "no commits" stays a silent clean allow.

- **A3 — wrapped push forms undetected (LOW).**
  *Symptom:* `(git push)` is not detected → silent allow.
  *Fix (narrowed per panel):* in detection, strip a balanced leading `(` / trailing `)` on a segment and re-check `isGitPushSegment`, so subshell `(git push)` is **detected and reviewed**. Do **not** add a loose "git+push tokens present" heuristic (it false-positives on `echo "remember to git push" && git status`, which an existing test asserts must stay `null`). `eval "git push"` is an explicit, documented out-of-scope limitation (reliably re-parsing eval'd strings is brittle).
  *Test:* `(git push)` detected; all existing negatives (`echo "…git push" && git status`, `git push --help`, `git pushx`) still `null`.

- **A4 (X1) — emit-once guard, INVOCATION-SCOPED (MED).**
  *Symptom:* the top-level `.catch` calls `decision("allow", …)` even when `runMain` already emitted a decision; Claude Code reads only the **first** JSON line, so the error is silently dropped (violates "loud").
  *Fix:* an **invocation-scoped** emitter created per `runMain` call (e.g. `createEmitter()` returning `{ emit, hasEmitted }`, where `emit` writes only the first payload and returns `false` thereafter), or one passed into `runMain`. `decision()`/`emit()` route through that invocation's emitter. **Must NOT be module-level** — a module-global `emitted` flag would suppress emits on later `runMain` calls in the same Node process and break the suite (which invokes `runMain` repeatedly). The production `import.meta.main` shim creates the emitter, hands it to `runMain`, and its `.catch` emits the fallback only if `!emitter.hasEmitted()` (else writes the error to stderr).
  *Test:* within one invocation a second `decision()` writes no second stdout line; **two separate `runMain` invocations in one process each emit normally** (no cross-invocation suppression); an error after emit goes to stderr.

### Work-stream B — plan-file gate (`global-hooks/plan-file-review.mjs`)

- **B1 — root-relative plan/spec paths skipped + relative read fails (MED).**
  *Symptom:* `file_path: "plans/p.md"` (no leading slash) → regex skip; *and* (panel/Codex) even with the regex fixed, `fs.statSync/readFileSync(filePath)` run before `cwd/ws` is resolved, so a relative path is read against the hook process cwd and fails → silent return.
  *Fix:* (a) `PLAN_PATH_RE = /(^|\/)(plans|specs)\/[^/]*\.md$/i`; (b) resolve a non-absolute `file_path` against `input.cwd || CLAUDE_PROJECT_DIR || process.cwd()` **before** stat/read and before computing the approval-key path context.
  *Test:* matches `plans/p.md`, `docs/plans/p.md`, `/repo/specs/s.md`; rejects `notplans/p.md`, `plans/sub/p.md`; a relative `file_path` with `input.cwd` set is read from the resolved absolute path.

- **B2 — silent on malformed stdin (MED).**
  *Symptom:* bad stdin JSON → bare `return`, no stderr/trace/decision.
  *Fix:* emit a `⛩ plan-file-review: could not parse hook input (<msg>); treating as empty.` stderr note (the diagnostic `plan-review.mjs` already writes), then return on the empty input (the path check rejects `""`) — fail-open with a **visible** note. (This returns after the note rather than continuing as `plan-review.mjs` does; both are fail-open — the goal is the visible diagnostic, not identical control flow.)
  *Test:* malformed stdin → non-empty stderr note.

### Work-stream C — enable/disable correctness (`scripts/bench-runner.mjs`, `global-hooks/config-store.mjs`)

- **C1 — `/bench:on` lies (both directions) (HIGH).**
  *Symptom:* after `off --global`, plain `on` prints `enabled (workspace)` while `isBenchDisabled` stays `true`; symmetrically, `on --global` after a workspace `off` prints `enabled (global)` while the workspace marker still disables.
  *Fix:* `gateToggleCommand` **always clears the selected scope's marker first**, then derives its message from a fresh `isBenchDisabled(ws)`: if still disabled, name the remaining source (`workspace re-enabled, but STILL DISABLED GLOBALLY — run /bench:on --global` / the symmetric message). Forward the `root` option for test isolation. Conservative refuse: a workspace `on` never clears the global marker.
  *Implementer trap (panel):* do **not** add an early `return` that skips clearing the selected scope's marker — the existing `off→on (workspace) → isBenchDisabled false` test must still pass.
  *Test:* `off --global` then `on` → `isBenchDisabled` true **and** message says still-disabled-globally; `off` then `on` (no global) → `isBenchDisabled` false (unchanged); `off` then `off --global` then `on --global` → message names the remaining workspace disable.

- **C2 — `isBenchDisabled` swallows FS errors (LOW).** Keep fail-open (`false`/enabled) but emit a `⛩` stderr warning naming the error. *Test:* `existsSync` stubbed to throw → returns `false` + warns.

- **C3 — `/bench:reviewers <bad>` invisible to stdout (LOW).** Wrap `setReviewers` in `reviewersCommand`; write `Error: <msg>` to stdout, set `process.exitCode = 1`; list unchanged (validation precedes write — verified). *Test:* bad name → stdout `Error:`, exit 1.

### Work-stream D — deploy / install / observability

- **D1 — deploy buries `stop-review` in a matcher-scoped block (HIGH).** (`scripts/deploy-global-hooks.mjs`)
  *Mechanism (corrected):* it is **order-dependent**, not unconditional — the `matcher===undefined` arm does `list.find(b => Array.isArray(b.hooks))`, returning the *first* hooks-block; if that block carries a `matcher`, `stop-review` lands in it and only fires for that tool's Stop events.
  *Fix:* `list.find(b => Array.isArray(b.hooks) && !b.matcher)`; if none, push a fresh matcher-less block. The de-dupe loop already scans all blocks (keep it); empty-block cleanup already handles a vacated matcher block (verified).
  *Test:* settings pre-seeded with a `{matcher:"SomeTool",hooks:[…]}` Stop block **first** → after sync, `stop-review` is in a matcher-less block; idempotent on re-run.

- **D2 — fresh install has commands but no gates (HIGH).** (`README.md`, `scripts/bench-runner.mjs` setup)
  *Fix:* (a) README install path gains an explicit `node <abs>/scripts/deploy-global-hooks.mjs` step; (b) `/bench:setup` inspects `~/.claude/settings.json` and reports each gate's registration by **event + matcher + correct hook file** (`ExitPlanMode→plan-review`, `Bash→pre-push-review`, `Write|Edit→plan-file-review`, `Stop(matcher-less)→stop-review`) — so a hook trapped in the wrong matcher block (D1 class) reports as misregistered, not "present." Unreadable/malformed settings → report "unable to check" and fail-open (no crash).
  *Test:* setup against settings missing hooks / with a mis-scoped stop hook reports the correct per-gate status.

- **D3 — trace-write failures swallowed (LOW).** (`trace-store.mjs` callers)
  *Fix:* each caller's trace `catch` emits a `⛩ … trace write failed` stderr note (still best-effort, never throws). Scope includes the **four gates *and* `bench-runner.mjs`** hunt/review trace writes (panel: honest `/bench:status` needs all of them).
  *Test:* `writeTrace` stubbed to throw → caller emits the note and still allows.

- **D4 — `/bench:status <id>` promised but unimplemented (LOW).** (`scripts/bench-runner.mjs`, README, `commands/status.md`)
  *Symptom:* README/commands say `/bench:status [id]` expands a trace, but `status` ignores args (`readTrace` already exists in `trace-store.mjs`); G's surfacing message references `(trace <id>)`.
  *Fix:* implement id expansion (read `rest` args, `readTrace(ws, id)`, print the stored trace's reviewers + prompts/responses); fall back to the list when no id.
  *Test:* `status <known-id>` prints that trace's contents; unknown id → friendly "not found".

### Work-stream E — stop gate + cleanup (`global-hooks/stop-review.mjs`, `global-hooks/panel-lib.mjs`)

- **E1 — staged-only fresh repo skips review (MED).**
  *Symptom:* no commits + all changes staged → `git diff HEAD` empty + no untracked → early return.
  *Fix (de-dup-safe per panel):* add a staged diff **only as a fallback** — when `git diff HEAD` is empty/unavailable (no HEAD), use `git diff --cached` for both the change-detection condition and the reviewed content (labelled, e.g. a `<staged_diff>` block or `[STAGED]` prefix). Do **not** append `--cached` unconditionally (in a normal repo `git diff HEAD` already includes staged-vs-HEAD → duplication). Reuse the proven pattern from the (to-be-removed) `workspaceFingerprint`.
  *Test:* fresh repo, staged-only change → reviewed; normal repo with a staged modification → diff is **not** duplicated.

- **E2 — `readInput` silent on malformed stdin (LOW).** (stop + pre-push) Emit a `⛩` stderr note before returning `{}` (fallback to `process.cwd()` stays — fail-open — but now visible). *Test:* malformed stdin → note (both files).

- **E3 — remove dead `workspaceFingerprint` (cleanup, grep-gated).**
  *Panel correction:* the "dead" claim must be **grep-verified** (`rg workspaceFingerprint`) — the first verification pass found no runtime imports, but its staged-diff logic is exactly what E1 needs.
  *Fix:* confirm zero imports; land **E1 first** (reusing the staged-diff pattern), then delete the now-redundant `workspaceFingerprint` and its export. If a grep ever shows a consumer, keep + add error logging instead.
  *Test:* `rg` shows no imports; suite passes after removal.

### Work-stream F — verdict visibility, all gates + consumers (`global-hooks/panel-lib.mjs` + emit sites + `bench-runner.mjs`)

- **F — ALLOW/BLOCK/fail-open summary hides which reviewers ran (the adversaries confusion).**
  *Symptom:* summary is `Codex: … · Kimi: … · MiMo … · GLM …` then `slice(0,~220)` → MiMo/GLM chopped → reads as Codex-only.
  *Fix:* `combinePanel` **always** returns a `badge` covering **every** decision branch (allow, block, fail-open). Glyphs are distinct: `✓` = ALLOW, `✗` = BLOCK, **`!`** = errored/skipped (matches the statusline's error glyph; avoids reusing `✗` for two meanings). Every emit site (`stop-review`, `pre-push-review`, `plan-file-review`, **`plan-review`** which only sets `permissionDecisionReason`, and **`bench-runner` `review`** output) leads with the badge **before** the truncated reasons. The badge lists only reviewers that were *meant to run for that gate* — the stop gate deliberately excludes Codex, so its badge shows `Kimi✓ MiMo✓ GLM✓` (no Codex glyph), never a misleading absence.
  *Test:* `combinePanel` exposes `badge` on allow/block/fail-open; a 4-reviewer ALLOW → four `✓`; a mixed Kimi-ALLOW/MiMo-BLOCK/GLM-error → `Kimi✓ MiMo✗ GLM!`; stop-gate badge omits Codex.

### Work-stream H — plan gate robustness (`global-hooks/plan-review.mjs`)

- **H1 (X1) — invocation-scoped emit-once guard for plan-review** (same pattern as A4 — per-invocation emitter, **never** module-level): guard the top-level catch so it doesn't emit a second decision after one was already emitted (dropped by the harness). Apply the **same invocation-scoped guard to `pre-push-review` (A4) and `plan-file-review`'s `failOpen()` path** (after P0; lower-harm there — `systemMessage`, not `permissionDecision` — but consistent). *Test:* no double-emit within an invocation; two separate invocations in one process each emit (no module-level suppression).

---

## Part 2 — Auto deep-review on spec/plan save (capability G, redesigned)

The panel showed v1's G was unworkable (no spec-review engine; race-y surfacing; wrong-ws risk; "complete" lie). v2 redesign:

**G1 — a real deep spec-review subcommand.** Add `bench-runner.mjs spec-review <abs-path> --ws <abs-ws>`: runs the panel (repo-aware, read-only) seeded with the file's content **and** a repo-aware system prompt, writes a trace with `gate:"spec-review"`, and returns a **structured result** (machine-readable: per-reviewer verdict + a finding count / max-severity), not free-form text. (The existing `huntCommand`/`investigate` is a bug-hunt with a seed and returns human text — insufficient.)

**G2 — trigger.** In `plan-file-review.runMain`, **after** the fast content review returns ALLOW (and after the dedup-skip path — do not launch from a dedup hit), spawn `spec-review` **detached + unref'd**, passing the resolved **absolute spec path and absolute `ws`** explicitly (so the child resolves the *same* `workspaceStateDir` as the hook — avoids the wrong-state-dir silent failure). The hook returns immediately; the save is never blocked.

**G3 — debounce.** A dedicated `deep-debounce` marker keyed on the spec's content hash + a minimum interval per workspace. Skip launch if a deep pass for this exact content hash has run or is in flight. This is separate from the fast gate's `allowMarker`; both are cleared/updated consistently (document the two-marker lifecycle).

**G4 — completion-marker, not pending.** The detached pass writes its results to `deep-result-<hash>.json` **on completion** (with the content hash + trace id + structured badge/summary). There is no "pending" lie — absence means "not done yet."

**G5 — surfacing in stop-review, disable-first (ordering fixed per plan-file gate review).** At the top of `stop-review.runMain`: **first** check `isBenchDisabled(ws)` — if disabled, do **not** surface deep results (consistent with gates being off) and take the normal disabled exit. Otherwise, **before** the loop-cap / no-diff early returns, check for a completed `deep-result-*.json`, emit `⛩ deep spec review: <badge> <summary> (trace <id>)` (or rewake if the structured result flags findings at/above a threshold), and delete the file. If the spec's content hash no longer matches the current file, note the result may be stale.

**G6 — known limitations (documented, not hidden).** Detached-child survival across the hook runner's process-group teardown is POSIX-`detached:true`+`unref()` and is harness-dependent; the unit test mocks the spawn (asserts invocation + args + ws), and a **manual smoke test** verifies real survival. Surfacing is "next stop after completion" — if the user never stops again, findings wait in the result file (visible via `/bench:status`).

**Tests:** (a) fast ALLOW → detached `spec-review` spawned with abs path + abs ws (mocked spawn); (b) identical-content re-save within interval → not launched; (c) a completed `deep-result` present at next stop (even with no diff / loop-capped, while enabled) → surfaced and deleted before the no-diff return; (d) content-hash mismatch → "stale" note; (e) `/bench:off` (disabled) → not surfaced (disable checked first).

---

## Non-goals

- No panel/reviewer/model or prompt changes beyond F's badge and G's spec-review seed/contract.
- No new user-facing gates beyond G.
- No fail-closed conversions (Principle 1).
- `eval "…git push…"` detection (A3) and reliable verification of detached-child survival in unit tests (G6) are explicitly out of scope (documented limitations).

## Test strategy

Per-item unit tests in `tests/*.test.mjs` with `BENCH_ROOT` isolation; panel/verification repros as fixtures (Ryan-P spaces path **and** `-C` review-cwd, `origin/master`+feature-branch range, explicit refspec source/dst/remote, matcher-scoped-first Stop block, root-relative + relative-read plan path, staged-only-vs-normal repo, badge across allow/block/fail-open, C1 both directions, invocation-scoped double-emit guard, `spec-review` spawn + surfacing). Suite stays green (≥146, growing). P0 (plan-file DI) lands before B2/F/G.

## Rollout

1. **P0** (plan-file DI refactor) → suite green.
2. **Part 1** (A–F, H) → `deploy-global-hooks.mjs` → suite + live stop/push/plan smoke.
3. **Part 2** (G) → deploy → verify a spec save auto-launches `spec-review` and the result surfaces at the next stop.

## Verification against the real-world case (adversaries / Ryan-Persitza)

After Part 1: editing `specs/orders-new-unified-form.md` shows `⛩ plan panel: ALLOW [Codex✓ Kimi✓ MiMo✓ GLM✓] — …` (F); a `git -C "/…/Ryan-Persitza/…" push` is detected **and reviewed against that repo** (A1). After Part 2: saving that spec auto-launches the deep repo-aware pass with no manual trigger, and the findings surface on the next stop (G).
