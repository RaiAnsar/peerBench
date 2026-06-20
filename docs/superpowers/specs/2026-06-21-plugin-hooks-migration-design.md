# Native Plugin Hooks Migration — Design Spec

**Date:** 2026-06-21
**Status:** Draft for planning (target: public-release prep)
**Repo:** github.com/RaiAnsar/peerBench (private)

## Goal

Replace the **deploy-copy** hook model (copy `global-hooks/*.mjs` → `~/.claude/hooks/` and register absolute-path command hooks in `~/.claude/settings.json` via `scripts/deploy-global-hooks.mjs`) with **native plugin hooks** declared in the plugin's `hooks/hooks.json`, using `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` placeholders. This eliminates an entire bug class and a manual install step.

## Why (what the current model costs us)

The deploy-copy model copies only `global-hooks/*.mjs` FLAT into `~/.claude/hooks/`; `scripts/` is never deployed. Direct consequences we hit this build:

- **Deploy-parity bug class (the G critical):** the deep-review worker spawn pointed at `scripts/bench-runner.mjs`, which isn't deployed → silent `ERR_MODULE_NOT_FOUND`. We had to make a self-contained sibling worker (`global-hooks/spec-review-run.mjs`) just to survive the flat layout.
- **D2 install gap:** a fresh install has the `/bench:*` commands but **zero active gates** until the user manually runs `deploy-global-hooks.mjs` — and `/bench:setup` had to grow a hook-registration check to surface it.
- **Maintenance:** the copy + settings.json mutation + de-dupe + the D1 matcher-block hazard all exist only to emulate what native plugin hooks do for free.

The docs (code.claude.com/docs/en/hooks) confirm native plugin hooks support everything we use — matchers, `asyncRewake`, `statusMessage`, `if`, `timeout` — and expose `${CLAUDE_PLUGIN_ROOT}` (plugin install dir) and `${CLAUDE_PLUGIN_DATA}` (persistent data dir) in command/args (exec form) and as env vars at hook runtime.

## Design

Populate `hooks/hooks.json` (today an empty stub) with the four gates, exec form, `${CLAUDE_PLUGIN_ROOT}`-relative:

```jsonc
{
  "hooks": {
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

Because `global-hooks/` and `scripts/` are siblings under `${CLAUDE_PLUGIN_ROOT}`, every gate's relative imports (`./config-store.mjs`) AND the deep-review worker spawn resolve with no copy. The G sibling-worker workaround can stay (it's deploy-safe regardless) or simplify to spawn `${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs` directly.

## Load-bearing assumption — verify FIRST (spike gate)

**The entire migration rests on:** plugin `hooks.json` hooks fire in **EVERY** project when the plugin is enabled (account-global), exactly like our copied settings.json hooks do — not only when the cwd is inside the plugin's own repo. **Task 0 is a spike that proves this** (install the plugin locally, open an unrelated project, confirm the Stop/Bash/Write gates fire and `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` resolve at runtime). If it does NOT fire globally, abandon the migration and keep deploy-copy. Everything below is gated on the spike passing.

## Decisions to make in the plan

1. **State dir:** keep `~/.claude/plugins/data/bench-shared/` (sharedRoot) for state, or move to `${CLAUDE_PLUGIN_DATA}`? `bench-shared` is currently shared independent of install; `${CLAUDE_PLUGIN_DATA}` is the blessed per-plugin dir. Keep `bench-shared` unless there's a reason to move (codex coexistence, cross-version sharing). Tests already isolate via `BENCH_ROOT`.
2. **Codex Stop-gate coexistence:** the codex multi-repo gate is a separate registration. Under plugin hooks, the bench Stop hook is its own block; both run in parallel (docs: all matching Stop hooks run in parallel). The D1 matcher-block hazard disappears (no manual settings.json merge). Confirm no double-review or ordering issue.
3. **Migration cleanup — SCOPED TO PEERBENCH-MANAGED ARTIFACTS ONLY (never broad):** users on the old model have the gates in `settings.json` + copies in `~/.claude/hooks/`. On upgrade, BOTH the old settings.json hooks AND the new plugin hooks would fire → double review. The cleanup must therefore remove ONLY peerbench's own artifacts and NOTHING else:
   - **Hook-file copies:** delete ONLY files whose basename is in the known peerbench gate set (`plan-review.mjs`, `plan-file-review.mjs`, `pre-push-review.mjs`, `stop-review.mjs`, plus the shared modules deploy copied: `spec-review-run.mjs`, `deep-review.mjs`, `config-store.mjs`, `panel-lib.mjs`, `reviewers.mjs`, `trace-store.mjs`, `hunt.mjs`, `agentic-review.mjs`, `review-tools.mjs`, `statusline-segment.mjs`) **AND** only after confirming the file is peerbench-managed (verify its content carries the managed-header marker — every deployed module begins with a `// global-hooks/<name>.mjs` comment; alternatively, deploy writes a `manifest.json` of exactly the files it copied and cleanup deletes only those). **NEVER glob `~/.claude/hooks/*.mjs`** — that could delete user- or other-tool-owned hooks.
   - **settings.json entries:** remove ONLY hook entries whose `command`/`args` reference a peerbench gate path (the existing deploy de-dupe already matches by basename — reuse that exact matching), dropping a block only if it becomes empty. NEVER remove arbitrary hook blocks or unrelated entries (preserve the codex gate, user hooks, etc.).
   - The cleanup is idempotent and a no-op when nothing peerbench-managed is present.
4. **Dev workflow:** developing peerbench itself isn't a marketplace install, so `${CLAUDE_PLUGIN_ROOT}` won't resolve from the working tree. Define the dev path: install the local dir as a plugin (e.g. a local marketplace entry) so hooks.json is exercised, OR keep `deploy-global-hooks.mjs` as a DEV-ONLY fallback (clearly labelled), with hooks.json the production path.

## Non-goals

- No change to review logic, the panel, reviewers, or G/H behavior.
- Not removing `deploy-global-hooks.mjs` outright until the dev workflow (Decision 4) is settled.

## Rollout

1. **Task 0 — spike (GATE):** prove global firing + `${CLAUDE_PLUGIN_ROOT}` resolution at hook runtime. Abort if it fails.
2. Populate `hooks/hooks.json` with the four gates (exec form, placeholders, statusMessage/`if`/asyncRewake parity).
3. Add the **scoped** migration cleanup (Decision 3): a one-time step (in `deploy-global-hooks.mjs` or a `bench:migrate`) that removes ONLY peerbench-managed hook copies (known basenames + managed-header/manifest verification — never a `*.mjs` glob) and ONLY peerbench-matching settings.json entries, so the old and new registrations don't double-fire. Idempotent.
4. Settle the state-dir + dev-workflow decisions; update tests.
5. README install: "install the plugin" — no deploy step (closes D2 permanently).
6. Verify: fresh project, gates fire; a deploy push triggers H; a spec save triggers G; `/bench:setup` reports gates active.

## Test strategy

`hooks.json` is data — assert it declares the four gates with correct matchers/placeholders/parity fields (a small JSON-shape test). The spike (Task 0) is a manual/integration check, documented as such. The cleanup step gets unit tests proving it removes ONLY peerbench-managed files/entries (a planted unrelated `~/.claude/hooks/user-thing.mjs` and an unrelated settings.json hook MUST survive), and is idempotent. Suite stays green.
