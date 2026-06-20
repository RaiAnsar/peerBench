# peerbench Gate Reliability & Auto-Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 14 verified silent-failure fixes + verdict badge (F) + auto deep-review (G) + 3 panel-found additions, exactly as specified in `docs/superpowers/specs/2026-06-20-peerbench-gate-reliability-design.md`.

**Architecture:** Surgical fixes to the four global hooks (`global-hooks/*.mjs`) + the runner/deploy scripts. Each fix is loud/fail-open. The spec is the source of truth for every fix's mechanism + test cases; this plan supplies task ordering, boundaries, and the TDD checklist. Read the matching spec item before each task.

**Tech Stack:** Node ESM (`.mjs`), `node:test` (`node --test 'tests/*.test.mjs'`), no deps.

**Node entrypoint convention (use EVERYWHERE):** the standard executable-script shim in this repo is `if (import.meta.url === \`file://${process.argv[1]}\`) { ... }`. Do NOT use `import.meta.main` (not standard Node ESM — would break CLI hook execution). Every shim/emitter reference below means this `import.meta.url` form.

## Global Constraints

- Loud, fail-open: never change a gate's allow/deny direction on internal error; emit a `⛩` diagnostic instead.
- Suite stays green (baseline **146** `test(`); every task adds tests. `BENCH_ROOT` isolation in every test — never touch real `~/.claude/plugins/data`.
- TDD: failing test → run-fail → implement → run-pass → commit, per task.
- No Claude commit trailers (memory `no-claude-trailers`).
- Same-file edits are sequential (tasks are file-grouped for this reason).
- After all tasks: `node scripts/deploy-global-hooks.mjs` to re-sync `~/.claude/hooks`.
- Emit-once guards (A4/H1) MUST be invocation-scoped (per-`runMain` emitter), never module-level.

---

### Task 1 — P0: make `plan-file-review.mjs` injectable

**Spec:** Part 0 (P0). **Files:** Modify `global-hooks/plan-file-review.mjs`; Test `tests/plan-file-review.test.mjs` (create if absent).

**Interfaces — Produces:** `export async function runMain({ resolveReviewersImpl, writeTraceImpl, isBenchDisabledImpl, input } = {})` mirroring `stop-review.mjs`/`pre-push-review.mjs`. Keep the `if (import.meta.url === \`file://${process.argv[1]}\`)` entrypoint shim calling `runMain()`.

- [ ] **Step 1 (test, fail):** add a test that imports `runMain` from `plan-file-review.mjs`, calls it with injected `isBenchDisabledImpl: () => true` + a temp `input`, and asserts it returns without throwing (disabled short-circuit). Initially fails — `runMain` is not exported.
- [ ] **Step 2:** run `node --test tests/plan-file-review.test.mjs` → FAIL (no export).
- [ ] **Step 3:** rename `async function main()` → `export async function runMain({ resolveReviewersImpl = resolveReviewers, writeTraceImpl = writeTrace, isBenchDisabledImpl = isBenchDisabled, input: inputOverride } = {})`; read input via `inputOverride ?? <existing stdin read>`; route the singletons through the injected params. Keep behavior identical. Keep the `import.meta.url === \`file://${process.argv[1]}\`` shim calling `runMain()`.
- [ ] **Step 4:** run the test → PASS; run full suite → green.
- [ ] **Step 5:** `git add -A && git commit -m "refactor(plan-file): extract injectable runMain (P0) — enables B2/F/G tests"`

---

### Task 2 — `pre-push-review.mjs`: A1, A2, A3, A4, E2 (pre-push)

**Spec:** A1, A2, A3, A4, E2. **Files:** Modify `global-hooks/pre-push-review.mjs`; Test `tests/pre-push-review.test.mjs`.

Do the sub-fixes in this order, each TDD'd; commit once at the end (single file, cohesive).

- [ ] **A1.1 (test, fail):** assert `isGitPushSegment('git -C "/tmp/Ryan P/repo" push')` is truthy and `isGitPushSegment('git -c user.name="John Doe" push')` truthy; keep negatives (`git pushx`, `git push --help`, `git push --dry-run`) falsy.
- [ ] **A1.2:** run → FAIL.
- [ ] **A1.3:** add `function shellTokenize(text)` that walks chars tracking `'`/`"` quote state and **strips** the quote chars, splitting on unquoted whitespace (yields `["git","-C","/a b/r","push"]`). Replace `split(/\s+/)` in `isGitPushSegment` with `shellTokenize(text)`. Keep the existing `-C`/`GIT_VALUE_OPTS` skip + `push` check.
- [ ] **A1.4:** add a test that `runMain` resolves the review cwd to the `-C` target: parse `-C` values from the push segment (reuse `GIT_VALUE_OPTS` skip) and apply them, in order, after `cdTargetBeforePush(...)` in `runMain`. Assert the panel is invoked with `cwd` = the `-C` dir (inject a mock reviewer capturing `cwd`). Verify the existing quoted-`cd` test still passes.
- [ ] **A1.5:** run pre-push tests → PASS.
- [ ] **A2.1 (test, fail):** in a temp repo helper, assert `resolvePushRange` (threaded with the parsed command) yields: `git push origin HEAD:main` → `origin/main..HEAD`; `git push origin feature:release` → `origin/release..feature`; `git push upstream feature:release` → `upstream/release..feature`; `git push origin topic` → `origin/topic..topic`; only-`origin/master` repo (no refspec) → `origin/master..HEAD`; `git push origin :stale` → clean allow; `git push --tags` → visible fail-open note.
- [ ] **A2.2:** run → FAIL.
- [ ] **A2.3:** parse the push command into `{ remote, refspecs[], flags[] }` (remote defaults to `origin`); change `resolvePushRange(cwd, parsed)` to resolve `<base>..<source>` per the spec's A2 rules (named-remote tracking refs `<remote>/…`; explicit-refspec precedence; delete/`--all`/`--tags`/`--mirror`/multi → clean-allow or visible fail-open note; unresolvable → fail-open note). Convert the `git log`/`git diff` content lookups to `gitTry`; on git error emit a `⛩` note + fail-open; empty = clean allow.
- [ ] **A2.4:** run → PASS.
- [ ] **A3.1 (test, fail):** assert `findPushSegment("(git push)")` is non-null; existing negatives stay `null`.
- [ ] **A3.2:** run → FAIL.
- [ ] **A3.3:** in `findPushSegment`, for each segment, also try stripping a balanced leading `(`/trailing `)` and re-check `isGitPushSegment`.
- [ ] **A3.4:** run → PASS.
- [ ] **A4.1 (test, fail):** assert (a) within one `runMain` invocation a second `decision()` writes no second stdout line; (b) two separate `runMain` invocations in one process each emit (no cross-invocation suppression); (c) an error after emit goes to stderr.
- [ ] **A4.2:** run → FAIL.
- [ ] **A4.3:** add `function createEmitter(){ let emitted=false; return { hasEmitted:()=>emitted, emit(p){ if(emitted) return false; emitted=true; process.stdout.write(JSON.stringify(p)+"\n"); return true; } }; }`. Create the emitter **inside `runMain`** (or accept it as a param); route `decision()`/`emit()` through it. The entrypoint shim (`if (import.meta.url === \`file://${process.argv[1]}\`)`) creates the emitter, passes it to `runMain`, and its `.catch` calls the fallback only if `!emitter.hasEmitted()` (else `process.stderr.write`). **Invocation-scoped, never module-level.**
- [ ] **A4.4:** run → PASS.
- [ ] **E2.1 (test, fail):** assert `readInput` emits a `⛩` stderr note on malformed stdin (capture via a wrapper or subprocess).
- [ ] **E2.2 → E2.3:** run-FAIL; in `readInput`'s catch, `process.stderr.write("⛩ pre-push: could not parse hook input (...); treating as empty.\n")` before `return {}`.
- [ ] **Step final:** run full suite → green; `git add -A && git commit -m "fix(pre-push): A1 spaces/-C cwd, A2 refspec range, A3 subshell, A4 emit-once, E2 stdin note"`

---

### Task 3 — `plan-file-review.mjs`: B1, B2

**Spec:** B1, B2. **Files:** Modify `global-hooks/plan-file-review.mjs`; Test `tests/plan-file-review.test.mjs`. (Depends on Task 1.)

- [ ] **B1.1 (test, fail):** assert `PLAN_PATH_RE` matches `plans/p.md`, `docs/plans/p.md`, `/repo/specs/s.md`; rejects `notplans/p.md`, `plans/sub/p.md`. Assert `runMain` with `{cwd:tmpRepo, tool_input:{file_path:"plans/p.md"}}` reads the file from `tmpRepo/plans/p.md` (create it; inject a reviewer capturing the content).
- [ ] **B1.2:** run → FAIL.
- [ ] **B1.3:** `const PLAN_PATH_RE = /(^|\/)(plans|specs)\/[^/]*\.md$/i;`. Before stat/read/approval-key: `const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), filePath);` and use `resolved` for stat/read and the path context.
- [ ] **B1.4:** run → PASS.
- [ ] **B2.1 (test, fail):** assert malformed stdin → a `⛩ plan-file-review: could not parse hook input` stderr note.
- [ ] **B2.2:** run → FAIL.
- [ ] **B2.3:** in the stdin catch, `process.stderr.write(\`⛩ plan-file-review: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n\`)` then return on empty input.
- [ ] **B2.4:** run → PASS; suite green.
- [ ] **Step final:** `git add -A && git commit -m "fix(plan-file): B1 root-relative+relative-read path, B2 stdin note"`

---

### Task 4 — `config-store.mjs`: C2

**Spec:** C2. **Files:** Modify `global-hooks/config-store.mjs`; Test `tests/config-store.test.mjs` (or `bench-disable.test.mjs`).

- [ ] **C2.1 (test, fail):** stub `fs.existsSync` to throw; assert `isBenchDisabled(ws)` returns `false` AND writes a `⛩` stderr warning.
- [ ] **C2.2:** run → FAIL.
- [ ] **C2.3:** in each `catch` of `isBenchDisabled`, `process.stderr.write(\`⛩ bench: could not check disable marker (${err.code || err}); treating as enabled.\n\`)` (still returns `false`).
- [ ] **C2.4:** run → PASS; suite green.
- [ ] **Step final:** `git add -A && git commit -m "fix(config-store): C2 warn on existsSync error (stays fail-open enabled)"`

---

### Task 5 — `bench-runner.mjs`: C1, C3, D2 (setup), D4

**Spec:** C1, C3, D2(b), D4. **Files:** Modify `scripts/bench-runner.mjs`; Test `tests/bench-disable.test.mjs`, `tests/bench-runner.test.mjs` (or nearest).

- [ ] **C1.1 (test, fail):** `off --global` then `on` → `isBenchDisabled(ws)` true AND message matches `/still disabled globally/i`; `off` then `on` → `isBenchDisabled` false (unchanged); `off` + `off --global` + `on --global` → message names remaining workspace disable. Use `{root}`-isolated `BENCH_ROOT`.
- [ ] **C1.2:** run → FAIL.
- [ ] **C1.3:** `gateToggleCommand(ws, args)`: clear the selected scope's marker first (`setBenchDisabled(ws, false, {scope, root})` for `on`; set for `off`), then `const stillDisabled = isBenchDisabled(ws, {root})` and build the message from it (name remaining source). Forward `root`. Never early-return before clearing the selected scope.
- [ ] **C1.4:** run → PASS (incl. the existing `off→on→false` test).
- [ ] **C3.1 (test, fail):** `reviewersCommand(["bogusname"])` → stdout contains `Error:`, `process.exitCode === 1`, reviewer list unchanged.
- [ ] **C3.2 → C3.3:** run-FAIL; wrap `setReviewers` in try/catch in `reviewersCommand`: on throw, `process.stdout.write(\`Error: ${msg}\n\`); process.exitCode = 1;`.
- [ ] **C3.4:** run → PASS.
- [ ] **D4.1 (test, fail):** write a trace via `writeTrace`, then `status <id>` prints that trace's reviewers/prompts; unknown id → "not found".
- [ ] **D4.2 → D4.3:** run-FAIL; in the `status` branch, if `rest[0]` is an id, `readTrace(ws, id)` and print its contents; else list.
- [ ] **D2b.1 (test, fail):** `setup` against a settings file (point via `CLAUDE_*`/temp HOME or an injected reader) missing hooks reports each of the 4 gates' registration by event+matcher+file; a stop hook in a matcher-scoped block reports as misregistered.
- [ ] **D2b.2 → D2b.3:** run-FAIL; add a `settings.json` inspection to `setup` reporting per-gate presence (event + matcher + hook-file basename); unreadable/malformed → "unable to check" (no crash).
- [ ] **Step final:** run suite → green; `git add -A && git commit -m "fix(runner): C1 honest on/off both directions, C3 reviewers stdout, D2 setup hook-status, D4 status <id>"`

---

### Task 6 — `deploy-global-hooks.mjs` (D1) + `README.md` (D2a)

**Spec:** D1, D2(a). **Files:** Modify `scripts/deploy-global-hooks.mjs`, `README.md`; Test `tests/deploy-global-hooks.test.mjs`.

- [ ] **D1.1 (test, fail):** seed `settings.json` with `Stop: [{matcher:"SomeTool",hooks:[...]}]` FIRST; after `syncSettings`, assert `stop-review` lands in a **matcher-less** block (not the SomeTool block); idempotent on a second sync.
- [ ] **D1.2:** run → FAIL.
- [ ] **D1.3:** in `register`'s `matcher===undefined` arm, `const block = list.find((b) => Array.isArray(b.hooks) && !b.matcher); if (block) {...push} else list.push({ hooks: [cmd] });`.
- [ ] **D1.4:** run → PASS.
- [ ] **D2a:** add to README install section an explicit step: `node /absolute/path/to/peerbench/scripts/deploy-global-hooks.mjs` (one-time, registers the 4 gates). (No test; doc.)
- [ ] **Step final:** run suite → green; `git add -A && git commit -m "fix(deploy): D1 matcher-less Stop block select; docs(readme): D2 deploy step"`

---

### Task 7 — `stop-review.mjs`: E1, E2 (stop)

**Spec:** E1, E2. **Files:** Modify `global-hooks/stop-review.mjs`; Test `tests/stop-review.test.mjs`.

- [ ] **E1.1 (test, fail):** fresh repo (no commits), stage a file (`git add`), no untracked → `runMain` reviews it (inject a reviewer; assert called, staged content present). Normal repo with a staged modification → the diff block does NOT contain the staged hunk twice.
- [ ] **E1.2:** run → FAIL.
- [ ] **E1.3:** the existing `const diff = git(["diff","HEAD"],ws)...` uses the repo's **non-throwing** `git()` helper — on an unborn HEAD (fresh repo, no commits) it catches the error and returns `""`, so execution reaches the fallback (do NOT switch to a throwing call; if you do, wrap it in try/catch). When `!diff.trim()`, compute `const staged = git(["diff","--cached"],ws).slice(0,MAX_DIFF_BYTES)` and use it (labelled, e.g. `<staged_diff>`) for both the change-detection condition (`if (!diff.trim() && !staged.trim() && !untracked.trim()) return;`) and the reviewed content. Do NOT append `--cached` when `diff` is non-empty (avoids duplicating staged hunks `git diff HEAD` already shows).
- [ ] **E1.4:** run → PASS.
- [ ] **E2.1 (test, fail):** malformed stdin → `⛩` stderr note.
- [ ] **E2.2 → E2.3:** run-FAIL; add the stderr note in `readInput`'s catch (mirror pre-push E2).
- [ ] **Step final:** run suite → green; `git add -A && git commit -m "fix(stop): E1 staged-diff fallback (fresh repo), E2 stdin note"`

---

### Task 8 — `panel-lib.mjs` badge (F) + emit-site wiring; then E3 delete `workspaceFingerprint`

**Spec:** F, E3. **Files:** Modify `global-hooks/panel-lib.mjs`, and emit sites `stop-review.mjs`, `pre-push-review.mjs`, `plan-file-review.mjs`, `plan-review.mjs`, `scripts/bench-runner.mjs`; Test `tests/panel-lib.test.mjs`. (E1 already landed in Task 7, so the staged-diff pattern is in place — E3 deletion is safe.)

- [ ] **F.1 (test, fail):** `combinePanel` returns a `badge` on allow/block/fail-open. 4-reviewer ALLOW → `Codex✓ Kimi✓ MiMo✓ GLM✓`; Kimi-ALLOW/MiMo-BLOCK/GLM-error → `Kimi✓ MiMo✗ GLM!`; fail-open (all error) → all `!`.
- [ ] **F.2:** run → FAIL.
- [ ] **F.3:** in `combinePanel`, build `badge` from every result (`✓` ALLOW, `✗` BLOCK, `!` error/skip) and return it on all three decision branches.
- [ ] **F.4 (test, fail):** each emit site leads with the badge before the truncated summary (assert the emitted systemMessage/reason starts with `[…✓…]` or includes the badge). Stop-gate badge omits Codex (it doesn't run there).
- [ ] **F.5:** update emit sites to prepend `[${panel.badge}]` (stop-review, pre-push-review, plan-file-review, plan-review's `permissionDecisionReason`, bench-runner `review` output). For stop, the badge reflects only the reviewers run (Codex excluded).
- [ ] **F.6:** run → PASS.
- [ ] **E3.1 (verify):** `rg workspaceFingerprint global-hooks scripts tests` shows only the definition (no imports).
- [ ] **E3.2:** delete `workspaceFingerprint` + its export from `panel-lib.mjs`; run suite → green.
- [ ] **Step final:** `git add -A && git commit -m "feat(panel): F verdict badge across all gates+review; chore: E3 drop dead workspaceFingerprint"`

---

### Task 9 — `plan-review.mjs` (H1) + plan-file emit-once + D3 trace notes

**Spec:** H1, A4-pattern for plan-file, D3. **Files:** Modify `global-hooks/plan-review.mjs`, `global-hooks/plan-file-review.mjs`, `global-hooks/stop-review.mjs`, `global-hooks/pre-push-review.mjs`, `scripts/bench-runner.mjs`; Tests in the matching files.

- [ ] **H1.1 (test, fail):** plan-review — within one invocation, a second `decision()` writes no second line; two invocations each emit.
- [ ] **H1.2 → H1.3:** run-FAIL; apply the invocation-scoped `createEmitter` pattern (from Task 2 A4) to `plan-review.mjs`, and to `plan-file-review.mjs`'s `failOpen()`/emit path (now testable post-P0). Use the `import.meta.url === \`file://${process.argv[1]}\`` shim consistently.
- [ ] **D3.1 (test, fail):** stub `writeTrace` to throw; assert each caller emits a `⛩ … trace write failed` stderr note and still allows. Cover the 4 gates + `bench-runner` hunt/review trace writes.
- [ ] **D3.2 → D3.3:** run-FAIL; replace each empty trace `catch {}` with one that writes the `⛩` note (never re-throws).
- [ ] **Step final:** run suite → green; `git add -A && git commit -m "fix: H1 plan-review emit-once, plan-file emit-once, D3 trace-write notes"`

---

### Task 10 — Part 2 (G): auto deep-review on spec/plan save

**Spec:** G1-G6. **Files:** Modify `scripts/bench-runner.mjs` (G1 subcommand), `global-hooks/plan-file-review.mjs` (G2 trigger + G3 debounce), `global-hooks/stop-review.mjs` (G5 surfacing); new helpers as needed; Tests in matching files. (Depends on Tasks 1, 7.)

- [ ] **G1.1 (test, fail):** `bench-runner spec-review <abs-path> --ws <abs-ws>` (inject a mock panel) writes a `gate:"spec-review"` trace and returns a structured result `{ reviewers:[{name,verdict}], findingCount, maxSeverity }`.
- [ ] **G1.2 → G1.3:** run-FAIL; add the `spec-review` subcommand: read the file, run the panel with a repo-aware system prompt, `writeTrace({gate:"spec-review",...})`, return structured result; write `deep-result-<contentHash>.json` (with hash, traceId, badge, summary) on completion (G4).
- [ ] **G2/G3.1 (test, fail):** `plan-file-review.runMain` on a fast-ALLOW save spawns `spec-review` detached with the abs path + abs ws (mock `child_process.spawn`; assert args). Identical-content re-save within the interval → not spawned (debounce marker). Dedup-hit path → not spawned.
- [ ] **G2/G3.2 → G3.3:** run-FAIL; after a fast ALLOW (not on dedup-hit), check/update the `deep-debounce` marker (content hash + min interval); if clear, `spawn(process.execPath, [benchRunnerPath, "spec-review", absPath, "--ws", absWs], {detached:true, stdio:"ignore"}).unref()`.
- [ ] **G5.1 (test, fail):** with a completed `deep-result-*.json` present and bench ENABLED, `stop-review.runMain` surfaces `⛩ deep spec review: <badge> <summary> (trace <id>)` and deletes the file — even when there is no diff / loop-capped. With bench DISABLED, it does NOT surface (disable checked first). Content-hash mismatch → "stale" note.
- [ ] **G5.2 → G5.3:** run-FAIL; at the TOP of `stop-review.runMain`, after the `isBenchDisabled` check (disabled → no surface, normal exit), and BEFORE the loop-cap/no-diff early returns, read+emit+delete any completed `deep-result-*.json` (stale note on hash mismatch; rewake if `maxSeverity`/`findingCount` ≥ threshold).
- [ ] **G6:** add a manual smoke-test note in the spec/README (detached survival is harness-dependent; unit tests mock spawn).
- [ ] **Step final:** run suite → green; `git add -A && git commit -m "feat(G): auto deep-review on spec save — spec-review subcommand, debounced detached launch, disable-first surfacing"`

---

### Task 11 — deploy, full verification, push

**Files:** none (verification).

- [ ] **Step 1:** `node --test 'tests/*.test.mjs'` → all green (≥146 + new).
- [ ] **Step 2:** `node scripts/deploy-global-hooks.mjs` → re-sync `~/.claude/hooks`; confirm the 4 gates registered (matcher-less Stop).
- [ ] **Step 3:** live smoke — a stop turn shows `⛩ bench stop: ALLOW [Kimi✓ MiMo✓ GLM✓]`; a `git -C "/path with space/repo" push` is detected; a `specs/x.md` save shows the badge + auto-launches the deep pass.
- [ ] **Step 4:** `git push origin main` (pre-push gate reviews the batch).

## Self-Review

- **Spec coverage:** P0(T1), A1-A4+E2(T2), B1-B2(T3), C2(T4), C1/C3/D2b/D4(T5), D1/D2a(T6), E1/E2(T7), F/E3(T8), H1/plan-file-emit/D3(T9), G1-G6(T10), deploy/verify/push(T11). All spec items mapped.
- **Ordering:** P0 before B2/F/G ✓; E1 (T7) before E3 (T8) ✓; same-file items grouped (pre-push T2, plan-file T3, bench-runner T5, stop T7) ✓; F emit-wiring (T8) after the per-file functional fixes ✓.
- **No placeholders:** each task has concrete code/regex/assertions or references the committed spec item (which carries the verbatim fix+tests).
- **Consistency:** `createEmitter` shape shared by A4/H1; `<remote>/…` range rules from A2; badge glyphs `✓/✗/!` from F; `import.meta.url` entrypoint shim everywhere — all consistent across tasks.
