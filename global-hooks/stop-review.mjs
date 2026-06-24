#!/usr/bin/env node
// global-hooks/stop-review.mjs
// Stop hook: review the turn's code diff with the configured non-Codex panel,
// content-only (no tools). On BLOCK: write findings to stderr + exit 2 (asyncRewake).
// On ALLOW: emit systemMessage + exit 0. Fails OPEN on any error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { combinePanel, untrackedBlock } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput, workspaceStateDir, readReviewedHead, writeReviewedHead } from "./config-store.mjs";
export { readReviewedHead, writeReviewedHead };   // re-exported so tests + siblings share one impl
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";

const MAX_DIFF_BYTES = 200_000;
const MAX_STOP_LOOPS = 4;                  // cap CONSECUTIVE bench blocks → then allow, to avoid a runaway re-review loop
const LOOP_WINDOW_MS = 10 * 60 * 1000;     // …only count blocks within this window as "consecutive"

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ bench stop: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

// --- reviewed-head marker (helpers live in config-store, shared with the pre-push gate) -------
// The last HEAD this gate stop-reviewed up to. WITHOUT this, a turn that COMMITS its work leaves
// an empty `git diff HEAD`, so the gate's no-diff early-return fires and the committed changes
// escape review entirely — a session that commits 50 things gets ZERO review (the VisualSentinel
// gap). With it, every change is reviewed exactly once: committed-this-session AND uncommitted.
// The pre-push gate bootstraps the marker on the first `git` command (before any commit) so even
// committed-AND-pushed work is reviewed on the first stop (where @{upstream} has already advanced).
//
// The base commit to diff HEAD against = "everything not yet reviewed". Prefer the last-reviewed
// marker when it is a valid ANCESTOR of HEAD; else fall back to the upstream (unpushed commits) so
// even the FIRST stop of a session that committed-but-didn't-push is reviewed; else HEAD (review
// the working tree only — first run with no upstream, or a rebase that orphaned the marker).
export function resolveReviewBase(ws, curHead, gitImpl = git) {
  if (!curHead) return "";
  const last = readReviewedHead(ws);
  if (last === curHead) return curHead;                          // already reviewed up to HEAD
  if (last) {
    const mb = gitImpl(["merge-base", last, curHead], ws).trim();
    if (mb === last) return last;                                // marker is an ancestor → diff since it
  }
  const up = gitImpl(["rev-parse", "--verify", "--quiet", "@{upstream}"], ws).trim();
  if (up) {
    const mb = gitImpl(["merge-base", up, curHead], ws).trim();
    if (mb && mb !== curHead) return mb;                         // unpushed commits
  }
  return curHead;                                                // nothing better → working tree only
}

const REVIEWED_WORKTREE = (ws) => path.join(workspaceStateDir(ws), "reviewed-worktree");

export function reviewFingerprint({ status = "", base = "", curHead = "", committed = "", diff = "", staged = "", untracked = "", reviewers = [] } = {}) {
  return createHash("sha256")
    .update(JSON.stringify({ status, base, curHead, committed, diff, staged, untracked, reviewers }))
    .digest("hex");
}

export function readReviewedWorktree(ws) {
  try { return fs.readFileSync(REVIEWED_WORKTREE(ws), "utf8").trim() || null; } catch { return null; }
}

export function writeReviewedWorktree(ws, fingerprint) {
  if (!fingerprint) return;
  try {
    fs.mkdirSync(workspaceStateDir(ws), { recursive: true });
    fs.writeFileSync(REVIEWED_WORKTREE(ws), `${fingerprint}\n`);
  } catch { /* best-effort marker */ }
}

export function clearReviewedWorktree(ws) {
  try { fs.rmSync(REVIEWED_WORKTREE(ws), { force: true }); } catch { /* best-effort marker */ }
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST line on stdout, so a second
// stdout emit in the same invocation is silently dropped. MUST be created per runMain invocation: a
// module-level flag would suppress later invocations in the same process and break the suite. The
// BLOCK path uses stderr + exit 2 (NOT stdout) and is unaffected.
export function createEmitter() {
  let emitted = false;
  return {
    hasEmitted: () => emitted,
    emit(payload) {
      if (emitted) return false;
      emitted = true;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return true;
    }
  };
}

export function buildPrompt(status, diff, untracked, lastMsg, staged = "", committed = "", { agentName = "Claude" } = {}) {
  const turnLabel = agentName ? `${agentName} turn` : "agent turn";
  const system =
    `You are reviewing the code changes from a ${turnLabel}. Review based ONLY on the content ` +
    "provided in this message. Do NOT use any tools or explore the filesystem. " +
    "Changes may be ALREADY COMMITTED this session (<committed_diff>) and/or UNCOMMITTED in the " +
    "working tree (<git_diff>/<staged_diff>) — review ALL of them. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. " +
    "BLOCK only if there is a concrete bug, regression, or unsafe change that should be fixed " +
    "before the session ends; otherwise ALLOW (minor notes may follow the first line).";
  const user = [
    "<previous_assistant_message>",
    lastMsg,
    "</previous_assistant_message>",
    "",
    "<git_status>",
    status,
    "</git_status>",
    "",
    "<committed_diff>",
    committed,
    "</committed_diff>",
    "",
    "<git_diff>",
    diff,
    "</git_diff>",
    "",
    "<staged_diff>",
    staged,
    "</staged_diff>",
    "",
    "<untracked_files>",
    untracked,
    "</untracked_files>"
  ].join("\n");
  return { system, user };
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  agentName = "Claude",
  blockHandler = null
} = {}) {
  // FIX 5 — ALL stdout emits in this invocation (the surfaced deep note AND every runMain
  // emit below) route through one emit-once guard so only the FIRST line reaches the harness.
  const emit = (obj) => emitter.emit(obj);
  const input = inputOverride ?? readInput();
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);
  const sessionKey = sessionKeyFromInput(input, env);

  if (isBenchDisabledImpl(ws)) {
    process.exit(0);   // disabled-first
  }

  // (Deep spec/push review delivery now lives in deep-review-runner.mjs — a separate asyncRewake
  // Stop hook — so this gate only reviews the turn's own diff.)

  // Loop protection scoped to THIS gate. We deliberately do NOT key off `stop_hook_active`: that
  // flag is SHARED across all Stop hooks, so another asyncRewake gate (e.g. the codex gate) looping
  // would starve this one — it would skip on every turn. Instead, cap our OWN consecutive blocks.
  const loopFile = path.join(workspaceStateDir(ws), sessionKey ? `stop-loop.${sessionKey}` : "stop-loop");
  let priorBlocks = 0;
  try {
    const j = JSON.parse(fs.readFileSync(loopFile, "utf8"));
    if (Date.now() - j.ts < LOOP_WINDOW_MS) priorBlocks = j.count || 0;
  } catch { /* no marker yet */ }
  if (priorBlocks >= MAX_STOP_LOOPS) {
    try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
    emit({ systemMessage: `⛩ bench stop: ${MAX_STOP_LOOPS} consecutive blocks — allowing to avoid a loop. Address remaining findings manually, or /bench:off.` });
    return;
  }

  const status = git(["status", "--short", "--untracked-files=all"], ws);
  const curHead = git(["rev-parse", "HEAD"], ws).trim();   // "" on an unborn HEAD (fresh repo)
  // GAP FIX: review changes COMMITTED since the last review, not just the working tree. A turn that
  // commits (and/or pushes) all its work leaves `git diff HEAD` empty; without this the gate would
  // skip and the committed changes would never be reviewed.
  const base = resolveReviewBase(ws, curHead);
  const committed = (base && curHead && base !== curHead)
    ? git(["diff", `${base}..${curHead}`], ws).slice(0, MAX_DIFF_BYTES) : "";
  const diff = git(["diff", "HEAD"], ws).slice(0, MAX_DIFF_BYTES);
  // Staged-diff FALLBACK only: on an unborn HEAD (fresh repo, no commits) `git diff HEAD`
  // is empty, so a staged-only change would be missed. Use `git diff --cached` only when
  // `diff` is empty — appending it unconditionally would duplicate the staged hunk that
  // `git diff HEAD` already shows in a normal repo.
  const staged = diff.trim() ? "" : git(["diff", "--cached"], ws).slice(0, MAX_DIFF_BYTES);
  const untracked = untrackedBlock(ws);

  if (!committed.trim() && !diff.trim() && !staged.trim() && !untracked.trim()) {
    // Nothing changed since the last review (status/report-only) — keep the baseline current so
    // the NEXT committing turn diffs from here, then skip.
    writeReviewedHead(ws, curHead);
    clearReviewedWorktree(ws);
    return;
  }

  // Never ask Codex to review a Codex turn. Claude can still use Codex through codex-plugin-cc;
  // direct Codex work is reviewed by the non-Codex bench reviewers configured for this workspace.
  const reviewers = resolveReviewersImpl({ env }).filter((r) => String(r.name).toLowerCase() !== "codex");
  const reviewerNames = reviewers.map((r) => String(r.name).toLowerCase()).sort();

  // Dirty working-tree changes can persist across many purely conversational turns. `reviewed-head`
  // only handles committed history, so remember the exact uncommitted review payload that already
  // passed and stay silent until that payload OR the reviewing panel changes. BLOCK/fail-open paths
  // below deliberately do NOT write this marker, so unsafe or unreviewed snapshots keep getting checked.
  const worktreeFingerprint = reviewFingerprint({ status, base, curHead, committed, diff, staged, untracked, reviewers: reviewerNames });
  if (readReviewedWorktree(ws) === worktreeFingerprint) {
    return;
  }

  const lastMsg = String(input.last_assistant_message ?? "").slice(0, 4000);
  const { system, user } = buildPrompt(status, diff, untracked, lastMsg, staged, committed, { agentName });

  if (!reviewers.length) {
    // e.g. reviewers configured as codex-only — nothing left after self-review suppression.
    writeReviewedWorktree(ws, worktreeFingerprint);
    emit({ systemMessage: "⛩ bench stop: no non-Codex reviewers configured — turn allowed (Codex reviewer excluded to avoid self-review)." });
    return;
  }
  const results = await Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env })));
  const panel = combinePanel(results);

  try {
    writeTraceImpl(ws, {
      gate: "stop",
      ws,
      sessionKey,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — but say so on stderr instead of swallowing (D3).
    process.stderr.write(`⛩ bench stop: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }   // not a block — reset the loop counter
    emit({ systemMessage: `⛩ bench stop: review failed (turn allowed) [${panel.badge}] — ${panel.summary.slice(0, 250)}` });
    return;
  }

  if (panel.decision === "block") {
    // Record this block so a runaway re-review loop is capped (see MAX_STOP_LOOPS above).
    try { fs.mkdirSync(workspaceStateDir(ws), { recursive: true }); fs.writeFileSync(loopFile, JSON.stringify({ count: priorBlocks + 1, ts: Date.now() })); } catch { /* noop */ }
    // asyncRewake: write findings to STDERR and exit 2 so the harness wakes
    // Claude with them instead of blocking the turn inline.
    const message =
      `Review panel blocked the turn [${panel.badge}]:\n\n${panel.findings}\n\n` +
      `${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}` +
      `Address ALL findings before ending the session.`;
    if (blockHandler) {
      await blockHandler({ panel, message });
      return;
    }
    process.stderr.write(message);
    process.exit(2);
  }

  // allow — clear the loop counter and ADVANCE the reviewed-head marker so this range isn't
  // re-reviewed next turn (committed work is reviewed exactly once). We deliberately do NOT advance
  // on block/fail-open above: a blocked or unreviewed range must be re-reviewed until it's clean.
  try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
  writeReviewedHead(ws, curHead);
  writeReviewedWorktree(ws, worktreeFingerprint);
  emit({ systemMessage: `⛩ bench stop: ALLOW [${panel.badge}] — ${panel.summary.slice(0, 220)}` });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ bench stop: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
