# peerBench in-flow review: `edit-local` advisory gate + stop-gate thoroughness

**Status:** design (awaiting approval)
**Date:** 2026-06-22
**Author:** Rai + Claude, grounded in independent design input from Codex, GLM, and the official Claude Code hooks docs/repo.

## Goal

Reduce the cross-turn back-and-forth where issues are discovered one-at-a-time across many stop-gate rounds. Two complementary, clearly-subordinate additions to the existing per-turn stop gate:

- **Piece 1 — `edit-local`:** an ADVISORY per-edit reviewer (`PostToolUse(Write|Edit|MultiEdit)`) that catches *locally-provable* defects at the moment of the edit and surfaces them in-flow, so obvious local mistakes are fixed before they compound.
- **Piece 2 — stop-gate thoroughness:** make each stop review surface *all* concrete issues per pass (not the top one only) and present blocked findings grouped by file, so fewer issues are discovered sequentially across rewakes.

Both are GLOBAL hooks (every repo, zero per-project config). Neither replaces or weakens the authoritative stop gate.

## Non-goals

- Per-edit hard blocking (the unanimous advice is advisory; blocking incomplete edits thrash-loops).
- Cross-file / contract / type / architecture analysis at edit time — that needs whole-change context and stays the stop gate's job.
- Per-project lint/typecheck/test config (incompatible with the global-hooks model; deferred).
- A "critical-local → `exit 2`" escalation class (parse-break/committed-secret). Explicitly DEFERRED to a later iteration; v1 is advisory-only. The stop + pre-push gates already hard-block secrets and broken code at turn/push time.

## Background facts (from research)

- `PostToolUse` runs AFTER the tool; it cannot undo the edit. It CAN inject feedback the model reads via top-level `systemMessage` and `hookSpecificOutput.additionalContext` (exit 0). (Official docs.)
- There is no built-in loop guard for `PostToolUse` — dedup/cooldown is our responsibility.
- Precedent: the official `security-guidance` plugin runs per-edit validation on `Edit|Write|MultiEdit`; the `hook-development` skill ships a per-edit "code quality check" pattern.
- `tool_input` for Write has `{file_path, content}`; for Edit `{file_path, old_string, new_string}`; MultiEdit carries multiple edits. The edited file is already on disk when the hook runs.

---

## Piece 1 — `edit-local` advisory gate

### Component

New deploy-safe sibling `global-hooks/edit-local-review.mjs`, registered by `deploy-global-hooks.mjs` as:

```
PostToolUse  matcher "Write|Edit|MultiEdit"  → edit-local-review.mjs
  statusMessage: "⛩ bench: edit check…"
```

It runs in parallel with the existing `PostToolUse(Write|Edit)` plan-file gate; the two have disjoint file scopes (plan-file handles `plans/`·`specs/` `.md`; edit-local handles code files and explicitly skips what plan-file owns).

### Control flow

1. Read hook stdin JSON. Resolve `ws = git top-level of (input.cwd || CLAUDE_PROJECT_DIR || cwd)`. If `isBenchDisabled(ws)` → exit 0. If the per-feature flag `editLocal` is `false` in `companion.json` → exit 0.
2. Resolve `filePath` from `tool_input.file_path` (relative paths resolved against `ws`).
3. **Pre-filters (skip → exit 0, silent).** Skip when ANY holds:
   - Extension not in the reviewable-code allowlist (`.js .mjs .cjs .ts .tsx .jsx .py .go .rs .rb .java .kt .c .cc .cpp .h .hpp .cs .php .swift .scala .sh .bash .sql .json .yaml .yml .toml`).
   - Path matches a generated/vendored skip pattern (`node_modules/`, `dist/`, `build/`, `.next/`, `vendor/`, `*.min.js`, `*.map`, `*.lock`, `*-lock.json`, `*.snap`).
   - The file is not readable as UTF-8 text, or exceeds `MAX_FILE_BYTES` (200 KB).
   - The change is trivial: fewer than `MIN_CHANGED_LINES` (3) lines added/changed (computed from `git diff -- <file>`; for an untracked new file, the whole content counts as added).
   - The change is large: more than `MAX_CHANGED_LINES` (200) lines changed → systemic, defer to the stop gate.
   - The file's current content hash equals the last hash reviewed by this gate (dedup; see State).
4. Build the review input: the file's current content (capped at `MAX_FILE_BYTES`) plus the changed hunk (`git diff -- <file>`, or "whole file added" when untracked).
5. Run ONE reviewer (see Reviewer selection), content-only, with the local-scope prompt (see Prompt). Hook timeout 20 s; the reviewer call uses a short `timeoutMs` (30 s) and fails OPEN.
6. Interpret the response:
   - First line `OK` / no concrete findings → record the reviewed hash, exit 0 silently (no message — never spam on a clean edit).
   - Otherwise → emit advisory and record the reviewed hash:
     ```json
     {
       "systemMessage": "⛩ edit-local [<Reviewer>~] <file>: <findings, capped 400 chars>",
       "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "<findings>" }
     }
     ```
     Exit 0. ADVISORY only — never `decision:block`, never `exit 2`.
7. Any error (reviewer down, git failure, parse failure) → fail OPEN: a one-line `⛩ edit-local: …; skipped` note on stderr, exit 0.

### Reviewer selection

One reviewer, chosen as `companion.json.editReviewer` if set and available, else the first available non-Codex panel reviewer, preferring GLM (scorecard: 0% errors). Codex is never used here (it is the agentic per-turn reviewer; too slow/expensive per edit). Selectable so it can be retuned from the scorecard's latency/quality data.

### Prompt scope (the noise control)

System: "You are reviewing a SINGLE in-progress file edit during a multi-step coding session. This is an intermediate state — other files and later edits may not be finished. Flag ONLY defects provably wrong from THIS file alone: syntax errors, undefined or duplicate identifiers, obvious null/undefined/await misuse, inverted conditionals, malformed JSON/YAML/TOML/config, or hardcoded secrets. DO NOT flag: missing imports (may be added next), references to symbols/types defined in other files, incomplete logic, missing tests, style, or anything needing other files or whole-change context. If nothing is provably wrong from this file alone, reply with exactly `OK`. Otherwise reply with a short bullet list of concrete findings, each with a line reference. Be conservative: when in doubt, reply `OK`."

User: the file path, its current content, and the changed hunk.

### State (dedup + thrash prevention)

Per-workspace dir `workspaceStateDir(ws)/edit-local/`. For each reviewed file, store a small JSON `{ hash, ts }` keyed by a sha256 of the file's absolute path. The gate skips when the current content hash matches the stored hash (so re-firing on an unchanged file is free, and re-running after a fix re-reviews exactly once). Because the gate is advisory (no forced loop) and only reviews on content change, there is no thrash cycle: edit → advisory → fix changes the hash → one re-review of the fixed content → `OK` → silence.

### Integration constraints (hard rules, from the architecture review)

- **Never reads or writes `reviewed-head`.** That marker is the stop/pre-push exactly-once contract; touching it from a single-file edit would break `resolveReviewBase`.
- **Never suppresses or short-circuits the stop gate.** edit-local is an independent advisory pass; the stop gate still reviews the full committed+working diff at turn end.
- **Separate trace bucket.** edit-local writes a trace with `gate: "edit-local"` (for `/bench:status` visibility), and `scorecard-store.autoStatsFromTraces` EXCLUDES `gate === "edit-local"` traces from the participation/blocks/unique metrics, so advisory local findings never inflate the strict scorecard. (A dedicated edit-local stats view is out of scope for v1.)
- The statusline segment ignores `edit-local` traces (it shows the latest strict gate trace, unchanged).

### Config / toggle

- `companion.json.editLocal` (boolean, default `true` once shipped) — feature flag, in addition to the global `isBenchDisabled` switch. A user who finds it noisy in one project can turn just this off.
- `companion.json.editReviewer` (string, optional) — which single reviewer runs it.

---

## Piece 2 — stop-gate thoroughness

Goal: surface more concrete issues per stop pass so fewer are discovered sequentially across rewakes.

1. **Exhaustive prompt:** add to the stop reviewers' instruction (in `buildPrompt`): "List EVERY concrete issue you find, not just the most important one — enumerate them so they can all be fixed in one pass." Low-risk wording change; reviewers already return bullet lists.
2. **Group blocked findings by file:** when the panel blocks, best-effort extract a leading `path/to/file` token from each finding bullet and group bullets under their file in the rewake message; bullets with no detectable path go under an "Other" group. Pure presentation of `panel.findings`; if no paths are detectable the output is unchanged (degrades gracefully).

Both are confined to `stop-review.mjs` / its prompt and finding-formatting; no change to decision logic, the marker, or loop-capping.

## Data flow

```
Write/Edit/MultiEdit
   └─ PostToolUse ─┬─ plan-file-review.mjs  (plans/·specs/ .md)        [existing]
                   └─ edit-local-review.mjs (code files)              [NEW, advisory]
                         → pre-filter → 1 reviewer (local scope) → systemMessage (advisory)
Turn end
   └─ Stop ── stop-review.mjs  (committed-since-marker + working tree, panel, BLOCKS)
                 → Piece 2: exhaustive prompt + per-file grouped findings
```

## Error handling

Every path fails OPEN (a developer's edit/turn is never wedged by the gate). edit-local: skip-on-any-error, exit 0. Reviewer/network/git errors → one-line stderr note, exit 0. Trace write is best-effort (stderr note on failure). No path uses `exit 2` or `decision:block`.

## Testing

- **edit-local pre-filters:** each skip rule (non-code ext, generated path, too-small, too-large, binary/over-cap, unchanged-hash) → no reviewer call, exit 0.
- **edit-local advisory:** a code edit with an injected provable bug → reviewer called → `systemMessage` advisory emitted, exit 0, NO `decision:block`/`exit 2`; a clean edit → silent exit 0.
- **edit-local dedup:** same content hash → second invocation skips the reviewer; changed content → re-reviews once.
- **edit-local integration invariants:** reviewed-head is untouched before/after; bench-disabled and `editLocal:false` both → exit 0 with no reviewer call; fail-open when the reviewer errors.
- **scorecard exclusion:** an `edit-local` trace does not change `autoStatsFromTraces` block/unique counts.
- **Piece 2:** `buildPrompt` system text contains the enumerate-all instruction; the finding-grouping helper groups bullets by leading file path and degrades to ungrouped when none are present.
- All via injected reviewers + temp git repos (no real API calls), matching the existing hook test harness.

## Deployment

`deploy-global-hooks.mjs` registers the new `PostToolUse Write|Edit|MultiEdit` → `edit-local-review.mjs` block (with `statusMessage`), and `bench-runner setup` reports the new gate's registration. Deploy parity verified against `~/.claude/hooks/edit-local-review.mjs`.
