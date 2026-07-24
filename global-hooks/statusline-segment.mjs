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

// Selection must SEARCH, never sample a fixed newest-N window: a busy sibling chat in the same
// checkout writes traces continuously, and any fixed window lets those evict this session's own
// trace — the badge then disappears while an owned trace sits on disk. So the scan is unbounded but
// cheap: `wsKey`/`sessionKey` are written BEFORE the (capped, but large) prompt fields, so a head
// slice containing `"reviewers"` proves we have already seen them. Only a candidate is fully parsed,
// and the first own-session hit exits immediately.
const HEAD_BYTES = 8192;

function readHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally { fs.closeSync(fd); }
}

const field = (head, name) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(head)?.[1] ?? null;

function* traceCandidates(ws) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
  files.sort().reverse();   // ids are `<epochMs>-<hex>` → lexical desc is newest-first
  for (const name of files) {
    const file = path.join(dir, name);
    let meta = null;
    let record = null;
    try {
      const head = readHead(file);
      if (head.includes("\"reviewers\"")) meta = { wsKey: field(head, "wsKey"), sessionKey: field(head, "sessionKey") };
      else meta = record = JSON.parse(fs.readFileSync(file, "utf8"));   // head was truncated early — stay correct
    } catch { continue; }
    yield { meta, load: () => record || (record = JSON.parse(fs.readFileSync(file, "utf8"))) };
  }
}

function usable(candidate) {
  try {
    const record = candidate.load();
    return (record?.reviewers || []).length ? record : null;
  } catch { return null; }
}

export function selectFrom(candidates, ws, sessionId) {
  const owner = wsKey(ws);
  const session = normalizeSessionId(sessionId);
  let fallback = null;
  for (const candidate of candidates) {
    const meta = candidate.meta || {};
    // Defense in depth: traces are already ws-scoped on disk, but the stamp proves ownership
    // survives symlink/relative-path aliasing of the same state dir.
    if (meta.wsKey && meta.wsKey !== owner) continue;
    if (session && meta.sessionKey === session) {
      const record = usable(candidate);
      if (record) return record;          // newest own-session trace wins outright
      continue;
    }
    if (!meta.sessionKey && !fallback) fallback = usable(candidate);
  }
  return fallback;                        // newest UNSTAMPED legacy — never another session's
}

export function selectTrace(records, ws, sessionId) {
  return selectFrom((records || []).filter(Boolean).map((r) => ({ meta: r, load: () => r })), ws, sessionId);
}

export function renderSegment(dir, sessionId, { candidatesImpl = traceCandidates, color = true } = {}) {
  if (!dir) return "";   // no per-window signal → render nothing, never cwd
  const trace = selectFrom(candidatesImpl(dir), dir, sessionId);
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
