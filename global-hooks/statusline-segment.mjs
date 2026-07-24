#!/usr/bin/env node
// global-hooks/statusline-segment.mjs
// Compact peerBench statusline badge: `bench ✓✓` — one symbol per reviewer of the newest trace this
// window's project and session OWNS. Codex renders its own `codex ✓` segment separately; peerBench
// never speaks for it.
//
// CRITICAL deploy-parity: deployed hooks live FLAT in ~/.claude/hooks/ — this file imports ONLY
// global-hooks siblings.
//
// Two invariants this file exists to protect (both were real, user-visible bugs):
//  1. The statusline is ONE GLOBAL process whose cwd is the LAUNCHING project. Resolving the project
//     from `process.cwd()` renders peerBench's badge inside every other project's window. So the
//     directory comes ONLY from a per-window signal (argv → CLAUDE_PROJECT_DIR) and we render
//     NOTHING rather than guess.
//  2. Two chats in one checkout must not show each other's verdicts, but projects with pre-session
//     history must not lose the badge entirely. Hence the two-tier pick: this session's newest
//     trace → else the newest UNSTAMPED legacy trace → never another session's.
import fs from "node:fs";
import path from "node:path";
import { normalizeSessionId, workspaceStateDir, wsKey } from "./config-store.mjs";
import { isMainModule } from "./is-main.mjs";

const GREEN = "[38;5;48m";
const RED = "[38;5;196m";
const AMBER = "[38;5;208m";
const RESET = "[0m";

// Same vocabulary as panel-lib's panelBadge, minus the reviewer names: ✓ allow, ✗ block,
// ~ advisory block, ! failed/skipped. Duplicated deliberately — panel-lib pulls in the review
// runtime, and the statusline must stay a cheap read-only file read on every prompt render.
export function reviewerSymbol(reviewer) {
  if (!reviewer) return "!";
  if (reviewer.error || reviewer.skipped) return "!";
  if (reviewer.verdict === "BLOCK") return reviewer.advisory ? "~" : "✗";
  if (reviewer.verdict === "ALLOW") return "✓";
  return "!";
}

export function benchBadge(trace) {
  return (trace?.reviewers || []).map(reviewerSymbol).join("");
}

function readTraceRecords(ws, limit = 12) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  files.sort().reverse();
  const records = [];
  for (const file of files.slice(0, limit)) {
    try { records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))); } catch { /* skip unreadable */ }
  }
  return records;
}

export function selectTrace(records, ws, sessionId) {
  const owner = wsKey(ws);
  const session = normalizeSessionId(sessionId);
  // Defense in depth: traces are already ws-scoped on disk, but the stamp proves ownership survives
  // symlink/relative-path aliasing of the same state dir.
  const owned = (records || []).filter((t) => t && (!t.wsKey || t.wsKey === owner) && (t.reviewers || []).length);
  if (session) {
    const mine = owned.find((t) => t.sessionKey === session);
    if (mine) return mine;
  }
  return owned.find((t) => !t.sessionKey) || null;
}

export function renderSegment(dir, sessionId, { readTraceRecordsImpl = readTraceRecords, color = true } = {}) {
  if (!dir) return "";   // no per-window signal → render nothing, never cwd
  const trace = selectTrace(readTraceRecordsImpl(dir), dir, sessionId);
  if (!trace) return "";
  const badge = benchBadge(trace);
  if (!badge) return "";
  const text = `bench ${badge}`;
  if (!color) return text;
  const tone = badge.includes("✗") ? RED : badge.includes("!") || badge.includes("~") ? AMBER : GREEN;
  return `${tone}${text}${RESET}`;
}

// CLI: statusline-segment.mjs <project-dir> [session-id]. Any failure prints nothing — a statusline
// must never emit a stack trace into the user's prompt.
if (isMainModule(import.meta.url)) {
  try {
    const dir = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || "";
    process.stdout.write(renderSegment(dir, process.argv[3] || ""));
  } catch { /* silent by design */ }
}
