# Design: OpenAI-compatible review gate (Kimi + MiMo) — extend peerbench

- **Date:** 2026-06-19
- **Status:** Draft for review (rev 8 — reliability lessons + observability; content-only prompts; reviewer rename)
- **Author:** Rai (with Claude)
- **Supersedes reviewer backends in:** `2026-06-05-peerbench-design.md`

## 1. Goal

Replace the **Codex** and **Bench** reviewer backends with **Kimi K2.7 Code** and
**Xiaomi MiMo**, over their **OpenAI-compatible APIs**, to: **(1)** cut AI cost;
**(2)** keep a **blocking** gate at three lifecycle points — plan/spec approval,
every code-editing turn, before `git push`; **(3)** add **plan→code continuity**
(per-turn review checks the diff against the approved plan); **(4)** **auto-arm
on plan approval** (no manual nudging); **(5)** be **reliable** (no silent
flakiness — §8) and **observable** (expand any review to see exactly what each
model saw and said — §9).

## 2. The decisive simplification: read-only by omission

The review call **never sends a `tools` array** — with no tools defined, the
model cannot touch the filesystem. The guarantee is *omission*, not `tool_choice`
(not sent). Review is a pure function of the prompt: `(text) -> ALLOW/BLOCK`.

Removed vs the CLI approach: process spawn, sandbox/worktree,
`workspaceFingerprint`, headless auth, CLI output parsing.

**Accepted trade-off:** no-tools reviewers **cannot crawl the repo**, so all
prompts are **content-only** — the plan-gate prompt builders
(`codex-plan-review.mjs:31`, `codex-plan-file-review.mjs:42`) must be **rewritten
to drop the "you have read access; verify references against live code"
framing**, which would otherwise invite hallucinated verification. Everything the
reviewer should judge is embedded inline. (Repo-aware plan review, if ever
wanted, is the one gate that could optionally keep an agentic reviewer — §10.)

## 3. Provider + reviewer config (env-independent)

| Reviewer | Base URL (`/v1`) | Model | Key |
|---|---|---|---|
| Kimi | `https://api.moonshot.ai/v1` | `kimi-k2.7-code` (256K) | `MOONSHOT_API_KEY` |
| MiMo | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `MIMO_API_KEY` |

- **Resolution order (both contexts — §4):** env vars first, then
  `~/.claude/plugins/data/bench-shared/companion.json` (keys, overrides,
  **and the `reviewers` selection list**). Base URLs + default models are
  built-in constants. The repo `.keys` (env-var form, **git-ignored**) is a dev
  convenience.
- **Why a shared file, not `state.json`:** the global plan hooks run **without**
  `CLAUDE_PLUGIN_DATA`; anything they read lives in this env-independent file
  (§7).
- No resolvable key → reviewer skipped (`{name, error:"no key"}`). Both keys set
  → Kimi+MiMo dual.

## 4. Two execution contexts (unchanged constraint)

| | **Plugin-local** | **Global self-contained** |
|---|---|---|
| Files | `scripts/panel-stop-hook.mjs`, `scripts/lib/*` | `global-hooks/*` |
| Runs from | plugin install dir | copied into `~/.claude/hooks/` |
| Imports | may import `scripts/lib/*` | only `./`-relative siblings (`panel-lib.mjs:1`) |
| Env | has `CLAUDE_PLUGIN_DATA` | no plugin env |

New shared siblings in `global-hooks/`: `review-client.mjs`, `reviewers.mjs`,
`config-store.mjs`, `plan-store.mjs`, `trace-store.mjs`, `pre-push-lib.mjs`.
`panel-lib.mjs` imports them `./`-relative; plugin-local hooks import via
`../global-hooks/…`.

## 5. Components

### 5.1 Review client (`global-hooks/review-client.mjs`)

`review({ baseURL, apiKey, model, system, user, timeoutMs }) -> { ok, text, usage } | { ok:false, error:{kind,detail} }`.
`POST ${baseURL}/chat/completions` via Node `fetch`, body
`{ model, messages, temperature:0 }` — **no `tools`, no `tool_choice`**.
AbortController timeout; returns typed errors (§8). Captures `usage` (tokens) for
the trace when the provider returns it.

### 5.2 Reviewer registry (`global-hooks/reviewers.mjs`)

`DEFAULT_REVIEWERS=["kimi","mimo"]`; `resolveReviewers()` reads the selection +
provider config via `config-store.mjs` (missing/empty/invalid →default; unknown
→dropped with note). Hooks: `Promise.all(run…)` → `combinePanel(results)`.

### 5.3 `combinePanel` → N-ary (the change to `panel-lib.mjs`)

`combinePanel(codex,bench)` → **`combinePanel(results[])`**; AND-pass unchanged for
1/2/N. Call sites (enumerated for the plan): `codex-plan-review.mjs`,
`codex-plan-file-review.mjs`, plus the migrated stop hook — all become
`combinePanel([...])`. `parseVerdict` reused (with the robust pre-normalize, §8).

### 5.4 Plan store + continuity (`global-hooks/plan-store.mjs`)

Env-independent shared dir (§7), atomic temp+rename:
`savePlan(ws,{text,hash})` (armed:true, ts, text capped 16 KiB),
`loadPlan(ws)`, `clearPlan(ws)`.
- **Continuity block** appended when armed: `APPROVED PLAN (review the diff for
  conformance; BLOCK on deviations, scope creep, or unfinished items):\n<text>`.
- Truncation announced. New ExitPlanMode approval overwrites; stale armed plan is
  harmless (errs safe). `/bench:panel off` calls `clearPlan` (§5.6 edit site).

### 5.5 Stop hook migration (`scripts/panel-stop-hook.mjs`)

1. Activate if `state.config.panelStops || loadPlan(ws)?.armed`.
2. `user` = current captured turn diff + untracked (reuse existing capture/caps)
   + the armed-plan continuity block.
3. `resolveReviewers()` → `Promise.all` → `combinePanel(results)` → write trace
   (§9).
4. `block` → `{decision:"block", reason:findings}`; else `systemMessage` (fail
   open).

### 5.6 Auto-arm + disarm edit sites

- **`codex-plan-review.mjs` (ExitPlanMode) ALLOW → `savePlan(ws,{text:tool_input.plan})`** — the only thing that arms.
- **`codex-plan-file-review.mjs` (Write/Edit) ALLOW → no plan-store interaction**
  (spec-quality gate only; not a commitment to execute). Re-arm happens on the
  next ExitPlanMode.
- **`/bench:panel off` → `clearPlan(ws)`** — concrete edit site is
  `scripts/bench-runner.mjs` (the `panel` command currently only toggles
  `state.config.panelStops` at `bench-runner.mjs:194`); add the `clearPlan` import
  + call and update the panel integration test.

### 5.7 Pre-push gate — git hook (authoritative) + Claude hook (advisory) + safe disarm

Shared `global-hooks/pre-push-lib.mjs`: `reviewPushedRange({cwd,ranges,env})`.
- **`scripts/pre-push-git.mjs` — authoritative, FAIL CLOSED.** git `pre-push`
  hook target. Parses ref lines `<local_ref> <local_sha> <remote_ref>
  <remote_sha>`; range per line:
  - update → `<remote_sha>..<local_sha>`
  - **new ref (`remote_sha` zeros) → first-push base resolution order:**
    `<remote>/<branch>` if it exists → else `refs/remotes/<remote>/HEAD`
    (`origin/HEAD`) → else the configured upstream/tracking ref → else
    `git merge-base --fork-point`; use `merge-base(base,<local_sha>)..<local_sha>`;
    **only if none resolve** fall back to `<empty-tree>..<local_sha>` (true
    initial push). Remote name comes from the hook's `$1` argument.
  - deletion (`local_sha` zeros) → allow
  - multiple lines → review each; any BLOCK aborts
  - git error / indeterminate → **fail closed**
- **`scripts/pre-push-review.mjs` — advisory, FAIL OPEN / NO-OP.** Claude
  `PreToolUse(Bash)` target. Parses Claude hook JSON, no-ops unless `git push`.
  Indeterminate range → **no-op (allow)**; deny only with a clear range AND BLOCK.
- **`scripts/pre-push-disarm.mjs` — Claude `PostToolUse(Bash)`.** `clearPlan(ws)`
  only on explicit `tool_response` success; absent/ambiguous → stay armed.
- **`scripts/install-prepush.mjs`** — idempotent; honors `core.hooksPath`;
  installs a **shell shim that buffers stdin once** and chains an existing
  `pre-push` (moved to `pre-push.local`, run first), then our reviewer:
  ```sh
  #!/usr/bin/env sh
  input=$(cat)
  if [ -x "$(dirname "$0")/pre-push.local" ]; then
    printf '%s' "$input" | "$(dirname "$0")/pre-push.local" "$@" || exit $?
  fi
  printf '%s' "$input" | node "<PLUGIN>/scripts/pre-push-git.mjs" "$@"
  ```

## 6. Hook wiring

### 6.1 Plugin `hooks/hooks.json`

```jsonc
{ "hooks": {
  "Stop": [ { "hooks":[ { "type":"command",
      "command":"node \"${CLAUDE_PLUGIN_ROOT}/scripts/panel-stop-hook.mjs\"", "timeout":900 } ] } ],
  "PreToolUse": [ { "matcher":"Bash", "hooks":[ { "type":"command",
      "command":"node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-push-review.mjs\"", "timeout":900 } ] } ],
  "PostToolUse": [ { "matcher":"Bash", "hooks":[ { "type":"command",
      "command":"node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-push-disarm.mjs\"", "timeout":30 } ] } ]
} }
```

The git `pre-push` hook is installed by `install-prepush.mjs` (§5.7), not
`hooks.json`. The Bash entrypoints filter `command` for `git push` in-script.

### 6.2 Global hooks (`~/.claude/settings.json`, via deploy script)

- `PreToolUse` `ExitPlanMode` → `plan-review.mjs`
- `PostToolUse` `Write|Edit` → `plan-file-review.mjs` (path filter
  `/\/(plans|specs)\/[^/]*\.md$/i`)

### 6.3 Reviewer-file rename (drop "codex")

Since the Codex backend is removed, the two global hook files
`codex-plan-review.mjs` / `codex-plan-file-review.mjs` are **renamed** to
`plan-review.mjs` / `plan-file-review.mjs` (Phase 1) to avoid a stale-name
maintenance trap; `settings.json` entries and `panel-lib.mjs` references updated
together. (`panel-lib.mjs` keeps its name — it's reviewer-agnostic.)

### 6.4 Deploy script (NEW — repo currently documents only manual copying)

`scripts/deploy-global-hooks.mjs` (Phase 1): copies the whole `global-hooks/` set
**flat** into `~/.claude/hooks/` (siblings, so `./` imports resolve), backs up
originals to `*.pre-panel.bak`, ensures the §6.2 `settings.json` entries.

### 6.5 Fail policy

| Gate | All reviewers error / indeterminate |
|---|---|
| Plan (ExitPlanMode / plan-file) | fail **open** + note |
| Stop (per-turn) | fail **open** + note |
| Pre-push — Claude `PreToolUse` (advisory) | fail **open / no-op** |
| Pre-push — git hook (authoritative) | fail **closed** (abort) |

## 7. State / files — what changes and what does NOT

- **`scripts/lib/bench-state.mjs` + `state.json` + their tests: UNCHANGED**
  (env-dependent, shared with codex). Holds `panelStops` (read only by the
  plugin-local stop hook) + `jobs`. `reviewers` selection is **not** stored here.
- **Env-independent shared dir** (pure `os.homedir()` + workspace, no env):
  `…/bench-shared/companion.json` (reviewer selection + provider config,
  `config-store.mjs`); `…/bench-shared/state/<slug>-<sha256(canonWs)[:16]>/`
  with `plan.json` (`plan-store.mjs`) and `traces/<id>.json` (`trace-store.mjs`).

## 8. Reliability — designed against the failures we actually hit

Each row is a real failure observed with the Bench/Codex gate this session:

| Observed failure | Mitigation in this design |
|---|---|
| Bench "mutated the workspace during read-only review — discarded" (silent flaky skips) | No-tools API reviewers have **no filesystem access** — structurally impossible; no fingerprint/discard dance. |
| "returned non-JSON / unexpected reviewer output" → silent skip | **Robust verdict extraction:** normalize (trim, strip ``` fences / leading filler) before `parseVerdict`; if first line still ≠ `ALLOW:`/`BLOCK:`, **one strict retry** ("respond with ONLY a first line `ALLOW: …`/`BLOCK: …`"); still bad → typed `parse` error with the **raw text preserved and surfaced** (never a silent disappearance). |
| Codex broker/auth down → gate silently unavailable | Typed errors `{kind: auth\|network\|http\|timeout\|parse\|nokey, detail}`; missing key → explicit skip note; every outcome recorded + summarized inline. |
| Non-determinism | `temperature:0`, no tools → stable, repeatable verdicts. |
| Hang | per-call AbortController timeout; aggregate governed by §6.5 fail policy. |

No reviewer outcome is ever silently dropped — allow, block, or typed-error, it
is recorded (§9) and shown in the gate's summary line.

## 9. Observability — expand any review to see what Kimi/MiMo did

- **Trace per gate run** (`trace-store.mjs`, written to the shared dir §7):
  `{ id, ts, gate, ws, reviewers:[{ name, model, latencyMs, verdict, firstLine,
  usage?, error? }], systemPrompt, userPrompt, rawResponses }` (prompt/response
  size-capped, e.g. 64 KiB each). Also mirrored as a one-line entry in the
  existing jobs store so `/bench:status` sees it.
- **Inspect (the "expand" Rai asked for):**
  - `/bench:status` — recent reviews: gate · per-reviewer verdict · latency · id.
  - **`/bench:status <id>` — expands one review**: the exact system+user prompt
    sent and each model's raw response, side by side.
- **Live:** `BENCH_COMPANION_DEBUG=1` streams the full prompt + responses to stderr
  during the hook; one human-readable line per review appended to
  `…/bench-shared/review.log` for `tail -f`.
- **Inline:** each gate `systemMessage` shows a compact summary + the id, e.g.
  `⚡ panel: Kimi ALLOW · MiMo BLOCK — expand: /bench:status 2f3a`.

## 10. Open questions

1. **Repo-aware plan review** — keep one agentic reviewer for the plan gate, or
   content-only? Default: content-only.
2. **Single Kimi vs Kimi+MiMo panel** — default dual AND-pass (both keys set).
3. **Rename `peerbench`** (the package) — out of scope; track separately.

## 11. Probes (run once before Phase 1)

- Kimi (`kimi-k2.7-code`) + MiMo (`mimo-v2.5-pro`): no-tools completion returns
  parseable `ALLOW:`/`BLOCK:` first line at `temperature:0`; capture `usage`
  shape for the trace.
- Bash `PostToolUse` `tool_response` success-signal shape (encode fail-safe: no
  signal → no disarm).

## 12. Rollout (phased, reversible)

- **Phase 0** — `review-client` (+ robust parse/retry/typed errors),
  `config-store`, `reviewers`, `trace-store`; `combinePanel`→array (enumerated
  call sites); tests with stubbed `fetch`. New code path only.
- **Phase 1** — switch plan hooks + stop hook to the registry; **rename**
  `codex-plan-*.mjs` → `plan-*.mjs`; content-only prompt rewrite; add
  `deploy-global-hooks.mjs`; deploy. Both reviewers live; traces flowing.
- **Phase 2** — `plan-store` + plan-aware stop prompt + ExitPlanMode-only
  auto-arm + `/bench:panel off` disarm; `/bench:status <id>` expand.
- **Phase 3** — `pre-push-lib` + git entrypoint (shim, install, first-push base
  order) + Claude entrypoints (advisory + disarm).

Each phase is independently shippable and leaves a working gate.

## 13. Testing strategy

- **Unit (stubbed `fetch`):** request shape (**no `tools`/`tool_choice`**) +
  typed errors + timeout + **retry-on-nonconforming then preserve raw**;
  `resolveReviewers` (missing/empty/invalid/unknown/no-key) via shared config;
  `config-store` identical with/without `CLAUDE_PLUGIN_DATA`; `combinePanel`
  1/2/N + all-error (open vs closed); `plan-store` round-trip (truncation+announce,
  atomic, clear); **`trace-store` round-trip + `/bench:status <id>` renders prompt
  + raw responses**; `bench-state` tests stay green (unchanged module).
- **Pre-push:** ref-line parsing — update / **new-ref base-resolution order
  (empty-tree only when no base)** / delete / multi / error→fail-closed — abort on
  BLOCK; advisory hook no-ops on non-`git push` and indeterminate; shim buffers
  stdin + chains; `install-prepush` idempotent + `core.hooksPath`.
- **Integration:** armed plan injects continuity block + blocks a planted
  regression; ExitPlanMode arms, plain spec save does not; pre-push git hook
  aborts on planted BLOCK and does not disarm; successful push disarms; a forced
  malformed reviewer reply produces a visible typed error + trace, **not** a
  silent skip.
```