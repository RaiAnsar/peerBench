#!/usr/bin/env node
// PostToolUse hook on Write|Edit: plan/spec markdown -> DUAL Codex+Grok panel
// review (strict AND-pass). Preserves: path filter, revision dedupe lock,
// single-Write revision instruction. ALLOW skip is CONTENT-keyed: only a save
// whose content hash equals the last APPROVED hash skips review. Fails OPEN
// only when BOTH reviewers error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel, runCodexReview, runGrokReview } from "./panel-lib.mjs";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");
const MAX_PLAN_BYTES = 64 * 1024;
const PLAN_PATH_RE = /\/(plans|specs)\/[^/]*\.md$/i;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function failOpen(note) {
  emit({ systemMessage: `⛩ plan gate: review skipped — ${String(note).slice(0, 250)}` });
}

function latestCodexRoot() {
  let entries;
  try {
    entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d));
  } catch {
    return null;
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function buildPrompt(filePath, content) {
  return [
    "<task>",
    `Review the implementation plan/spec document below (file: ${filePath}).`,
    "Claude Code is about to execute this plan in the repository at the current working directory.",
    "You have read access to that repository. Verify the plan's claims and file references against the actual code where relevant.",
    "Challenge correctness, completeness, missing edge cases, risky design choices, and anything that would force rework during implementation.",
    "Do NOT implement anything or modify files. This is review only.",
    "</task>",
    "",
    "<compact_output_contract>",
    "Your first line must be exactly one of:",
    "- ALLOW: <short reason>",
    "- BLOCK: <short reason>",
    "Do not put anything before that first line.",
    "If you block, follow the first line with a concise bullet list of the specific problems Claude must fix in the plan.",
    "</compact_output_contract>",
    "",
    "<policy>",
    "Use ALLOW when the plan is sound enough to execute, even if not perfect; mention minor suggestions after the ALLOW line.",
    "Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort if executed as written.",
    "</policy>",
    "",
    "<plan_document>",
    content,
    "</plan_document>"
  ].join("\n");
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

  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  // Context-complete approval key: identical plan text must NOT skip review
  // when the review CONTEXT differs (different file path/workspace, hook kind,
  // or review policy/prompt version). Bump POLICY_VERSION whenever the review
  // prompt or panel logic changes so all prior approvals re-review.
  const POLICY_VERSION = "2026-06-05.panel.1";
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

  const codexRoot = latestCodexRoot();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prompt = buildPrompt(filePath, content);

  const codexEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || CODEX_DATA,
    ...(input.session_id ? { CODEX_COMPANION_SESSION_ID: input.session_id } : {})
  };

  const [codex, grok] = await Promise.all([
    codexRoot
      ? runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt, cwd, env: codexEnv })
      : Promise.resolve({ name: "Codex", error: "codex plugin not found" }),
    runGrokReview({ prompt, cwd, env: process.env })
  ]);

  const panel = combinePanel(codex, grok);

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

main().catch((error) => {
  failOpen(error instanceof Error ? error.message : String(error));
});
