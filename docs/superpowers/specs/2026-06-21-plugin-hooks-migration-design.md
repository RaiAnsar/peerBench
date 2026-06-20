# Native Plugin Hooks Migration — Design Spec

**Date:** 2026-06-21
**Status:** Draft for planning (target: public-release prep)
**Repo:** github.com/RaiAnsar/peerBench (private)

> Hardened by the plugin's own gates: the deep spec-review (G) BLOCKed v1 (false "managed-header
> marker" cleanup premise; basename list omitted `review-client.mjs`; `/bench:setup` detection task;
> stale motivation). The plan-file gate then BLOCKed v2 (cleanup had no *guaranteed execution
> trigger* on upgrade → double-firing). All folded in.

## Goal

Replace the **deploy-copy** hook model (copy `global-hooks/*.mjs` → `~/.claude/hooks/` + register absolute-path command hooks in `~/.claude/settings.json` via `scripts/deploy-global-hooks.mjs`) with **native plugin hooks** in the plugin's `hooks/hooks.json`, using `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` placeholders.

## Why (what the deploy-copy model costs us)

The deploy-copy model copies only `global-hooks/*.mjs` FLAT into `~/.claude/hooks/`; `scripts/` is never deployed. That flat layout forced workarounds and friction:

- **Deploy-parity workaround (already shipped, not an open bug):** because a deployed hook can't reach `scripts/bench-runner.mjs`, the deep-review worker is a self-contained sibling `global-hooks/spec-review-run.mjs`. Migration would *remove the workaround* — under `${CLAUDE_PLUGIN_ROOT}`, `scripts/` and `global-hooks/` are siblings, so the whole "is X deployed/reachable?" class disappears.
- **D2 install gap:** a fresh install has `/bench:*` commands but ZERO active gates until the user runs `deploy-global-hooks.mjs`. Native plugin hooks register on install → no step, no gap.
- **Maintenance:** the copy + settings.json mutation + de-dupe + the D1 matcher-block hazard exist only to emulate what native plugin hooks do for free.

`commands/setup.md:7` **already** references `${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs`, so part of the repo already assumes plugin-root placeholders. The docs confirm native plugin hooks support all we use (matchers, `asyncRewake`, `statusMessage`, `if`, `timeout`, SessionStart) and expose `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` in command/args + env at runtime.

## Design

`hooks/hooks.json` — the four gates (exec form, `${CLAUDE_PLUGIN_ROOT}`-relative) **plus a SessionStart migration-cleanup hook** (see Migration trigger). `hooks.json` is NOT literally empty today (has a `description` + `"hooks": {}`); populate in place, preserving the description — no blind overwrite.

```jsonc
{
  "description": "peerbench review gates",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/migrate-cleanup.mjs"], "once": true }] }
    ],
    "PreToolUse": [
      { "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/global-hooks/plan-review.mjs"], "statusMessage": "⛩ bench: reviewing plan…" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/global-hooks/pre-push-review.mjs"], "statusMessage": "⛩ bench: reviewing push…", "if": "Bash(git *)" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/global-hooks/plan-file-review.mjs"], "statusMessage": "⛩ bench: reviewing plan/spec…" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/global-hooks/stop-review.mjs"],
        "timeout": 300, "asyncRewake": true, "statusMessage": "⛩ bench: reviewing turn…",
        "rewakeMessage": "…", "rewakeSummary": "⛩ bench stop" }] }
    ]
  }
}
```

Because `global-hooks/` + `scripts/` are siblings under `${CLAUDE_PLUGIN_ROOT}`, every gate's relative imports AND the worker spawn resolve with no copy.

## Migration trigger — how cleanup RELIABLY runs (v2 gap fix)

On upgrade, the old `~/.claude/settings.json` hooks + `~/.claude/hooks/` copies would coexist with the new native plugin hooks → **duplicate reviews**. Cleanup must therefore run on a **guaranteed, automatic trigger**, not a manual "remember to run X":

- **Primary (automatic): the `SessionStart` plugin hook above** runs `scripts/migrate-cleanup.mjs` on the first session after the upgraded plugin is enabled (SessionStart fires account-globally whenever the plugin is active). It performs the idempotent manifest-driven cleanup once, gated by a `cleanup-done` marker in `${CLAUDE_PLUGIN_DATA}` / `bench-shared` → no-op on every subsequent session. This guarantees cleanup without any user action.
- **Secondary (visibility): `/bench:setup`** detects lingering old peerbench settings.json hooks / `~/.claude/hooks/` copies and reports them ("legacy deploy-copy gates found; cleaned automatically on next session, or run /bench:migrate now").
- **Manual escape hatch: `/bench:migrate`** runs the same idempotent cleanup on demand.
- The cleanup is **idempotent**, so all three triggers are safe to run in any order / repeatedly.

## Load-bearing assumption — verify FIRST (spike gate)

The whole migration rests on: plugin `hooks.json` hooks (incl. SessionStart) fire in EVERY project when the plugin is enabled — not only inside the plugin's own repo. **Task 0 spike proves this** (install locally, open an unrelated project, confirm gates fire + `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` resolve at runtime). Abort the migration if it fails.

## Decisions to make in the plan

1. **State dir:** keep `~/.claude/plugins/data/bench-shared/` or move to `${CLAUDE_PLUGIN_DATA}`? Keep `bench-shared` unless codex-coexistence / cross-version sharing argues otherwise. Tests isolate via `BENCH_ROOT`.
2. **Codex Stop-gate coexistence:** bench Stop hook is its own block; both run in parallel; the D1 matcher-block hazard disappears (no manual settings.json merge).
3. **Cleanup is MANIFEST-DRIVEN, scoped to peerbench artifacts only (the v1 header-marker premise was false — modules start with shebang/import/varied comments):**
   - `deploy()` (and the dev fallback) **writes a manifest** `~/.claude/hooks/.peerbench-manifest.json` — it already iterates `global-hooks/*.mjs` (`deploy-global-hooks.mjs:34`); record exact filenames + each file's content hash.
   - Cleanup deletes ONLY manifest entries whose on-disk hash still matches (a user-modified copy is left). Complete by construction (covers `review-client.mjs` + any future module); no header assumption; never globs `*.mjs`.
   - Old installs without a manifest: fall back to the COMPLETE current basename set (all 15 `global-hooks/*.mjs`, incl. `review-client.mjs`), deleting only files whose hash matches a known shipped module version; else leave + report.
   - settings.json: remove ONLY entries whose `command`/`args` reference a peerbench gate path (reuse the de-dupe match); drop a block only when empty; never touch unrelated blocks.
4. **`/bench:setup` detection migration (REQUIRED):** `setupStatus` (`scripts/bench-runner.mjs:~147,316`) reads ONLY settings.json + hardcodes `Gate registration (~/.claude/settings.json):`. Post-migration the gates live in `hooks.json`, so setup would report them MISSING. Update `setupStatus` to detect plugin-hook registration (inspect the plugin `hooks.json` / resolved active hooks) and relabel; also surface legacy-deploy detection (Migration trigger secondary).
5. **Dev workflow:** developing peerbench isn't a marketplace install, so `${CLAUDE_PLUGIN_ROOT}` won't resolve from the working tree. Define it: install the local dir as a plugin (local marketplace entry) so `hooks.json` is exercised, OR keep `deploy-global-hooks.mjs` as a clearly-labelled DEV-ONLY fallback (must keep writing the manifest), with `hooks.json` the production path.

## Non-goals

- No change to review logic, panel, reviewers, or G/H behavior.
- Not removing `deploy-global-hooks.mjs` until the dev workflow (Decision 5) is settled.

## Rollout

1. **Task 0 — spike (GATE):** prove global firing (incl. SessionStart) + `${CLAUDE_PLUGIN_ROOT}` resolution at hook runtime. Abort if it fails.
2. `deploy()` writes `.peerbench-manifest.json` (filenames + hashes) — ship FIRST so even pre-migration installs start producing a manifest the cleanup can trust.
3. Implement `scripts/migrate-cleanup.mjs` (idempotent, marker-gated, manifest-driven; settings.json + copies; preserves unrelated hooks/files) + `/bench:migrate`.
4. Populate `hooks/hooks.json` with the four gates + the SessionStart cleanup hook (preserve `description`).
5. Update `/bench:setup` (Decision 4): detect plugin-hook registration + legacy-deploy presence.
6. Settle state-dir + dev-workflow; update tests + README ("install the plugin" — no deploy step; closes D2).
7. Verify: fresh project gates fire; upgrade path auto-cleans on next session (no double-review); deploy push triggers H; spec save triggers G; `/bench:setup` reports gates active under the new model.

## Test strategy

`hooks.json` shape test (four gates + SessionStart cleanup, correct matchers/placeholders/parity). Spike (Task 0) is a documented manual/integration check. Manifest writer + `migrate-cleanup` unit tests: a planted unrelated `~/.claude/hooks/user-thing.mjs` AND an unrelated settings.json hook MUST survive; a user-MODIFIED peerbench copy (hash mismatch) MUST survive; only manifested-unmodified copies removed; the `cleanup-done` marker makes a second run a no-op; running via SessionStart, `/bench:migrate`, and `/bench:setup` all converge to the same clean state. `setupStatus` plugin-hook-detection test. Suite stays green.
