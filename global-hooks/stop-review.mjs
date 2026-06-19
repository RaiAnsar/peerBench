#!/usr/bin/env node
// global-hooks/stop-review.mjs
// Stop hook: review the turn's code diff with the full panel (Kimi + MiMo + Codex),
// content-only (no tools). On BLOCK: write findings to stderr + exit 2 (asyncRewake).
// On ALLOW: emit systemMessage + exit 0. Fails OPEN on any error.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { combinePanel, untrackedBlock } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";

const MAX_DIFF_BYTES = 200_000;

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
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

export function buildPrompt(status, diff, untracked, lastMsg) {
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

  // Loop guard: if a prior stop-hook block is already being processed, skip.
  if (input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);

  if (isBenchDisabledImpl(ws)) {
    process.exit(0);
  }

  const status = git(["status", "--short", "--untracked-files=all"], ws);
  const diff = git(["diff", "HEAD"], ws).slice(0, MAX_DIFF_BYTES);
  const untracked = untrackedBlock(ws);

  if (!diff.trim() && !untracked.trim()) {
    // No code changes this turn (status/report-only) — nothing to review.
    return;
  }

  const lastMsg = String(input.last_assistant_message ?? "").slice(0, 4000);
  const { system, user } = buildPrompt(status, diff, untracked, lastMsg);

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
    emit({ systemMessage: `⛩ bench stop: review failed (turn allowed) — ${panel.summary.slice(0, 250)}` });
    return;
  }

  if (panel.decision === "block") {
    // asyncRewake: write findings to STDERR and exit 2 so the harness wakes
    // Claude with them instead of blocking the turn inline.
    process.stderr.write(
      `Review panel blocked the turn:\n\n${panel.findings}\n\n` +
      `${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}` +
      `Address ALL findings before ending the session.`
    );
    process.exit(2);
  }

  // allow
  emit({ systemMessage: `⛩ bench stop: ALLOW — ${panel.summary.slice(0, 220)}` });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ bench stop: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
