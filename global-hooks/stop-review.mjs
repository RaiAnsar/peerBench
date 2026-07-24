#!/usr/bin/env node
// Lightweight Stop review: one MiMo content-only pass over the dirty worktree. Findings are
// advisory and never wake/re-block the agent. Completed verdicts are deduped by exact bytes;
// provider failures become eligible again only after their bounded cooldown expires.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectUntrackedEvidence, combinePanel } from "./panel-lib.mjs";
import { isMainModule } from "./is-main.mjs";
import {
  isBenchDisabled as defaultIsBenchDisabled,
  readReviewedHead,
  sessionKeyFromInput,
  workspaceStateDir,
  writeReviewedHead
} from "./config-store.mjs";
export { readReviewedHead, writeReviewedHead };
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";

export const MAX_STOP_EVIDENCE_BYTES = 64 * 1024;
export const STOP_TIMEOUT_MS = 15_000;
const REVIEWED_WORKTREE = (ws) => path.join(workspaceStateDir(ws), "reviewed-worktree");
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--full-index"];

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  }
  catch { return cwd; }
}

function gitRead(args, cwd, { maxBuffer = 512 * 1024 } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync("git", ["--no-replace-objects", ...args], {
        cwd,
        encoding: "utf8",
        maxBuffer,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull },
        stdio: ["ignore", "pipe", "ignore"]
      })
    };
  } catch {
    return { ok: false, out: "" };
  }
}

export function resolveReviewBase(_ws, curHead) { return curHead || ""; }

export function reviewFingerprint({ status = "", diff = "", staged = "", untracked = "", reviewers = [] } = {}) {
  return createHash("sha256").update(JSON.stringify({ status, diff, staged, untracked, reviewers })).digest("hex");
}

export function readReviewedWorktree(ws, { now = Date.now() } = {}) {
  let raw;
  try { raw = fs.readFileSync(REVIEWED_WORKTREE(ws), "utf8").trim(); } catch { return null; }
  if (!raw) return null;
  if (!raw.startsWith("{")) return raw; // pre-0.4.1 completed-verdict marker
  try {
    const marker = JSON.parse(raw);
    if (!marker?.fingerprint) throw new Error("missing fingerprint");
    if (Number(marker.retryAfter) > now) return marker.fingerprint;
  } catch { /* malformed/expired retry marker is not a completed review */ }
  clearReviewedWorktree(ws);
  return null;
}

export function writeReviewedWorktree(ws, fingerprint, { retryAfter } = {}) {
  if (!fingerprint) return;
  try {
    fs.mkdirSync(workspaceStateDir(ws), { recursive: true, mode: 0o700 });
    const value = Number(retryAfter) > 0
      ? JSON.stringify({ fingerprint, retryAfter: Number(retryAfter) })
      : fingerprint;
    fs.writeFileSync(REVIEWED_WORKTREE(ws), `${value}\n`, { mode: 0o600 });
  } catch { /* best effort dedupe */ }
}

export function clearReviewedWorktree(ws) {
  try { fs.rmSync(REVIEWED_WORKTREE(ws), { force: true }); } catch { /* already absent */ }
}

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

export function buildPrompt(status, diff, untracked, lastMsg, staged = "", _committed = "", { agentName = "agent" } = {}) {
  const system =
    `Review the uncommitted changes from this ${agentName} turn using only the supplied evidence. ` +
    "Do not use tools. First line: `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for a concrete " +
    "bug, regression, security issue, or unsafe change; keep the response concise.";
  const user = [
    "<git_status>", status, "</git_status>",
    "<worktree_diff>", diff, "</worktree_diff>",
    "<staged_diff>", staged, "</staged_diff>",
    "<untracked_files>", untracked, "</untracked_files>",
    "<assistant_context>", String(lastMsg || "").slice(0, 1000), "</assistant_context>"
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
  agentName = "agent"
} = {}) {
  const input = inputOverride ?? readInput();
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);
  if (isBenchDisabledImpl(ws)) return;

  const statusRead = gitRead(["status", "--short", "--untracked-files=all"], ws);
  const hasHead = gitRead(["rev-parse", "--verify", "HEAD"], ws).ok;
  const diffRead = hasHead
    ? gitRead(["diff", ...SAFE_DIFF_FLAGS, "HEAD"], ws, { maxBuffer: MAX_STOP_EVIDENCE_BYTES + 4096 })
    : { ok: true, out: "" };
  const stagedRead = !hasHead || (diffRead.ok && !diffRead.out.trim())
    ? gitRead(["diff", ...SAFE_DIFF_FLAGS, "--cached"], ws, { maxBuffer: MAX_STOP_EVIDENCE_BYTES + 4096 })
    : { ok: true, out: "" };
  const status = statusRead.out;
  const diff = diffRead.out;
  const staged = stagedRead.out;
  const untrackedRead = collectUntrackedEvidence(ws, { maxFiles: 12, maxBytesEach: 8_000 });
  const untracked = untrackedRead.text;
  if (!status.trim() && !diff.trim() && !staged.trim() && !untracked.trim()) {
    clearReviewedWorktree(ws);
    return;
  }

  const reviewers = resolveReviewersImpl({ env, reviewers: ["mimo"] });
  const reviewerNames = reviewers.map((reviewer) => reviewer.reviewIdentity || reviewer.name);
  const readFailed = !statusRead.ok || !diffRead.ok || !stagedRead.ok || !untrackedRead.complete;
  const fingerprint = reviewFingerprint({
    status,
    diff,
    staged,
    untracked: readFailed ? `${untracked}\n[evidence read failed]` : untracked,
    reviewers: reviewerNames
  });
  if (readReviewedWorktree(ws) === fingerprint) return;

  if (readFailed) {
    writeReviewedWorktree(ws, fingerprint);
    emitter.emit({ systemMessage: `⛩ bench stop: UNREVIEWED — Git evidence could not be read within the limit ${MAX_STOP_EVIDENCE_BYTES} bytes; use /bench:review on a smaller range if needed.` });
    return;
  }

  const { system, user } = buildPrompt(status, diff, untracked, input.last_assistant_message, staged, "", { agentName });
  const evidenceBytes = Buffer.byteLength(`${system}\n${user}`);
  if (evidenceBytes > MAX_STOP_EVIDENCE_BYTES) {
    writeReviewedWorktree(ws, fingerprint);
    emitter.emit({ systemMessage: `⛩ bench stop: UNREVIEWED — dirty evidence is ${evidenceBytes} bytes (limit ${MAX_STOP_EVIDENCE_BYTES}); use /bench:review explicitly if needed.` });
    return;
  }

  if (!reviewers.length) {
    writeReviewedWorktree(ws, fingerprint);
    emitter.emit({ systemMessage: "⛩ bench stop: UNREVIEWED — MiMo is not configured; turn allowed." });
    return;
  }

  const results = await Promise.all(reviewers.map((reviewer) => reviewer.run({
    system,
    user,
    cwd: ws,
    env,
    timeoutMs: STOP_TIMEOUT_MS,
    cooldownScope: `stop:${ws}`
  })));
  const panel = combinePanel(results);
  // A provider failure is not a review. Suppress duplicate Stop noise only until the provider's
  // cooldown expires, then make the unchanged snapshot eligible again.
  if (panel.decision !== "fail-open") {
    writeReviewedWorktree(ws, fingerprint);
  } else {
    const retryAfter = Math.max(0, ...results.map((result) => Number(result.cooldownUntil) || 0));
    if (retryAfter > Date.now()) writeReviewedWorktree(ws, fingerprint, { retryAfter });
  }

  try {
    writeTraceImpl(ws, {
      gate: "stop",
      ws,
      sessionKey: sessionKeyFromInput(input, env),
      reviewers: results.map(({ raw: _raw, ...result }) => result),
      rawResponses: Object.fromEntries(results.map((result) => [result.name, result.firstLine || result.error || ""]))
    });
  } catch { /* traces are non-critical */ }

  if (panel.decision === "block") {
    emitter.emit({ systemMessage: `⛩ bench stop advisory [${panel.badge}] — ${String(panel.findings || panel.summary).slice(0, 1200)}\nThis does not block the turn.` });
  } else if (panel.decision === "fail-open") {
    emitter.emit({ systemMessage: `⛩ bench stop: UNREVIEWED [${panel.badge}] — ${panel.summary.slice(0, 250)}; turn allowed.` });
  }
}

if (isMainModule(import.meta.url)) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ bench stop: ${error instanceof Error ? error.message : String(error)} (turn allowed)\n`);
    process.exit(0);
  });
}
