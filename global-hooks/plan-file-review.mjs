#!/usr/bin/env node
// PostToolUse hook on Write|Edit: plan/spec markdown -> reviewer-registry panel
// review (strict AND-pass). Preserves: path filter, revision dedupe lock,
// single-Write revision instruction. ALLOW skip is CONTENT-keyed: only a save
// whose content hash equals the last APPROVED hash skips review. Fails OPEN
// only when ALL reviewers error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled } from "./config-store.mjs";
import { resolveReviewers } from "./reviewers.mjs";
import { writeTrace } from "./trace-store.mjs";
import { execFileSync } from "node:child_process";

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

const MAX_PLAN_BYTES = 64 * 1024;
const PLAN_PATH_RE = /\/(plans|specs)\/[^/]*\.md$/i;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function failOpen(note) {
  emit({ systemMessage: `⛩ plan gate: review skipped — ${String(note).slice(0, 250)}` });
}

export function buildPrompt(filePath, content) {
  return {
    system: "You are reviewing an implementation plan/spec document from ONLY the text provided. Do not assume filesystem access. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW.",
    user: `<plan_document file="${filePath}">\n${content}\n</plan_document>`
  };
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = String(input.tool_input?.file_path ?? "");
  if (!PLAN_PATH_RE.test(filePath)) {
    return;
  }

  let content = "";
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
    content = fs.readFileSync(filePath, "utf8").slice(0, MAX_PLAN_BYTES);
  } catch {
    return;
  }
  if (!content.trim()) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);              // git top-level — matches /bench:off marker + the other gates
  if (isBenchDisabled(ws)) process.exit(0);    // bench layer disabled — no-op before any lock/review

  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  // Context-complete approval key: identical plan text must NOT skip review
  // when the review CONTEXT differs (different file path/workspace, hook kind,
  // or review policy/prompt version). Bump POLICY_VERSION whenever the review
  // prompt or panel logic changes so all prior approvals re-review.
  const POLICY_VERSION = "2026-06-19.kimi-mimo.1";
  const HOOK_KIND = "plan-file-panel";
  const approvalKey = createHash("sha256")
    .update(POLICY_VERSION).update("\0")
    .update(HOOK_KIND).update("\0")
    .update(filePath).update("\0")
    .update(content)
    .digest("hex");
  const fileKey = createHash("sha1").update(filePath).digest("hex");
  const allowMarker = path.join(locksRoot, `allow-${fileKey}`);

  // ALLOW skip: only an identical approval key (same content AND same context)
  // skips. ANY content change, or a policy/hook/path change, re-reviews.
  try {
    const approved = fs.readFileSync(allowMarker, "utf8").trim();
    if (approved === approvalKey) {
      emit({
        systemMessage: "⛩ plan gate: save not re-reviewed (content identical to the last approved version)."
      });
      return;
    }
  } catch {
    // no marker — proceed
  }

  const lockKey = createHash("sha1").update(`${filePath}|${mtimeMs}`).digest("hex");
  const lockDir = path.join(locksRoot, lockKey);
  const LOCK_TTL_MS = 5 * 60 * 1000;
  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.mkdirSync(lockDir);
  } catch {
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_TTL_MS;
    } catch {
      stale = true;
    }
    if (!stale) {
      return;
    }
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    } catch {
      return;
    }
  }

  const { system, user } = buildPrompt(filePath, content);

  const results = await Promise.all(resolveReviewers().map((r) => r.run({ system, user, cwd: ws })));
  const panel = combinePanel(results);

  try {
    writeTrace(ws, {
      gate: "plan-file",
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
    failOpen(panel.summary);
    return;
  }

  if (panel.decision === "block") {
    try {
      fs.rmSync(allowMarker, { force: true });
    } catch {
      // best-effort
    }
    // asyncRewake: write findings to STDERR and exit 2 so the harness WAKES
    // Claude with them (exit-2 blocking feedback is read from stderr, not
    // stdout) instead of blocking the turn.
    process.stderr.write(`Review panel blocked the plan file ${filePath}:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address ALL findings, then save it as ONE complete rewrite using a single Write call. Do NOT apply fixes as multiple incremental Edits — each save triggers another background review.`);
    process.exit(2);
  }

  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.writeFileSync(allowMarker, approvalKey);
  } catch {
    // skip-marker is best-effort
  }
  emit({ systemMessage: `⛩ plan panel: ALLOW — ${panel.summary.slice(0, 220)}` });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  failOpen(error instanceof Error ? error.message : String(error));
});
