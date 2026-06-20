#!/usr/bin/env node
// global-hooks/stop-review.mjs
// Stop hook: review the turn's code diff with the full panel (Kimi + MiMo + Codex),
// content-only (no tools). On BLOCK: write findings to stderr + exit 2 (asyncRewake).
// On ALLOW: emit systemMessage + exit 0. Fails OPEN on any error.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { combinePanel, untrackedBlock } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled, workspaceStateDir } from "./config-store.mjs";
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

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function buildPrompt(status, diff, untracked, lastMsg, staged = "") {
  const system =
    "You are reviewing the code changes from a Claude turn. Review based ONLY on the content " +
    "provided in this message. Do NOT use any tools or explore the filesystem. " +
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
  input: inputOverride
} = {}) {
  const input = inputOverride ?? readInput();
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);

  if (isBenchDisabledImpl(ws)) {
    process.exit(0);
  }

  // Loop protection scoped to THIS gate. We deliberately do NOT key off `stop_hook_active`: that
  // flag is SHARED across all Stop hooks, so another asyncRewake gate (e.g. the codex gate) looping
  // would starve this one — it would skip on every turn. Instead, cap our OWN consecutive blocks.
  const loopFile = path.join(workspaceStateDir(ws), "stop-loop");
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
  const diff = git(["diff", "HEAD"], ws).slice(0, MAX_DIFF_BYTES);
  // Staged-diff FALLBACK only: on an unborn HEAD (fresh repo, no commits) `git diff HEAD`
  // is empty, so a staged-only change would be missed. Use `git diff --cached` only when
  // `diff` is empty — appending it unconditionally would duplicate the staged hunk that
  // `git diff HEAD` already shows in a normal repo.
  const staged = diff.trim() ? "" : git(["diff", "--cached"], ws).slice(0, MAX_DIFF_BYTES);
  const untracked = untrackedBlock(ws);

  if (!diff.trim() && !staged.trim() && !untracked.trim()) {
    // No code changes this turn (status/report-only) — nothing to review.
    return;
  }

  const lastMsg = String(input.last_assistant_message ?? "").slice(0, 4000);
  const { system, user } = buildPrompt(status, diff, untracked, lastMsg, staged);

  // (c) Codex reviews each turn via its OWN agentic gate (codex-plugin), where it scours files;
  // this content-only gate adds just the cheap reviewers. To make this the sole per-turn gate
  // (incl. Codex) later, drop this filter and disable Codex's own gate.
  const reviewers = resolveReviewersImpl({ env }).filter((r) => String(r.name).toLowerCase() !== "codex");
  if (!reviewers.length) {
    // e.g. reviewers configured as codex-only — nothing left for this content-only gate to run.
    emit({ systemMessage: "⛩ bench stop: no non-Codex reviewers configured — turn allowed (Codex runs its own gate)." });
    return;
  }
  const results = await Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env })));
  const panel = combinePanel(results);

  try {
    writeTraceImpl(ws, {
      gate: "stop",
      ws,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch {
    // trace is best-effort
  }

  if (panel.decision === "fail-open") {
    try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }   // not a block — reset the loop counter
    emit({ systemMessage: `⛩ bench stop: review failed (turn allowed) — ${panel.summary.slice(0, 250)}` });
    return;
  }

  if (panel.decision === "block") {
    // Record this block so a runaway re-review loop is capped (see MAX_STOP_LOOPS above).
    try { fs.mkdirSync(workspaceStateDir(ws), { recursive: true }); fs.writeFileSync(loopFile, JSON.stringify({ count: priorBlocks + 1, ts: Date.now() })); } catch { /* noop */ }
    // asyncRewake: write findings to STDERR and exit 2 so the harness wakes
    // Claude with them instead of blocking the turn inline.
    process.stderr.write(
      `Review panel blocked the turn:\n\n${panel.findings}\n\n` +
      `${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}` +
      `Address ALL findings before ending the session.`
    );
    process.exit(2);
  }

  // allow — clear the loop counter
  try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
  emit({ systemMessage: `⛩ bench stop: ALLOW — ${panel.summary.slice(0, 220)}` });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ bench stop: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
