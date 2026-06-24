import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeSessionId, sessionKeyFromInput, workspaceStateDir, wsKey } from "./config-store.mjs";
import { severityRank, SEVERITY_RANK } from "./deep-review.mjs";

const C = { ALLOW: 48, BLOCK: 196, error: 208, advisory: 245 };   // 256-color codes (match gate-status.py palette); advisory = dim grey
const col = (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const GATE_LABEL = { "plan-file": "plan", "pre-push": "push" };  // shorten; others pass through
// A BLOCK is ADVISORY (sub-threshold) when it carries a KNOWN explicit severity BELOW high —
// the plan/spec gates surface those without blocking. A BLOCK with NO severity (stop/pre-push
// traces) is strict → ✗. FIX 5: an UNKNOWN/malformed severity string also ranks 0, but must be
// treated as STRICT (✗), not advisory — so gate on the severity being a KNOWN rank, not merely
// non-null (else a corrupt "bogus" severity would silently soften a real BLOCK to `~`).
const isAdvisoryBlock = (r) =>
  r.verdict === "BLOCK" &&
  r.severity != null &&
  SEVERITY_RANK[String(r.severity).toLowerCase()] != null &&
  severityRank(r.severity) < severityRank("high");
// ✗ real block; ~ sub-threshold/advisory block; ! errored/skipped; ✓ allow OR hunt-success
const glyph = (r) => (r.verdict === "BLOCK" ? (isAdvisoryBlock(r) ? "~" : "✗") : (r.error && r.verdict !== "ALLOW") ? "!" : "✓");
const rColor = (r) => (r.verdict === "BLOCK" ? (isAdvisoryBlock(r) ? C.advisory : C.BLOCK) : (r.error && r.verdict !== "ALLOW") ? C.error : C.ALLOW);
const STALE_MS = 45 * 60 * 1000;  // a verdict older than this is past, not current → dim it

// Pure: render one trace as the format-C segment. Returns "" if nothing to show.
export function renderSegment(trace, { now = Date.now() } = {}) {
  if (!trace || !Array.isArray(trace.reviewers) || trace.reviewers.length === 0) return "";
  const gate = GATE_LABEL[trace.gate] || trace.gate || "review";
  const ts = trace.ts ? Date.parse(trace.ts) : NaN;
  if (Number.isFinite(ts) && now - ts > STALE_MS) {
    // stale: dim it with (idle) so an old verdict doesn't masquerade as an active block
    return dim(`⛩ ${gate}: ${trace.reviewers.map((r) => `${r.name}${glyph(r)}`).join(" ")} (idle)`);
  }
  // Only a REAL (non-advisory) block reddens the label; an advisory-only trace stays calm.
  const anyBlock = trace.reviewers.some((r) => r.verdict === "BLOCK" && !isAdvisoryBlock(r));
  const anyErr = trace.reviewers.some((r) => r.error && r.verdict !== "ALLOW" && r.verdict !== "BLOCK");
  const labelColor = anyBlock ? C.BLOCK : anyErr ? C.error : C.ALLOW;
  const parts = trace.reviewers.map((r) => col(rColor(r), `${r.name}${glyph(r)}`));
  return `${col(labelColor, `⛩ ${gate}:`)} ${parts.join(" ")}`;
}

// Trace filenames are `<ms-timestamp>-<hex>.json`. Read the newest by NUMERIC timestamp:
// a lexical sort mis-ranks timestamps of different digit lengths, and a bare `.endsWith(".json")`
// filter would also pick up stray non-trace files. Validate the shape so only real traces count.
const TRACE_RE = /^(\d+)-[0-9a-f]+\.json$/i;
function fileTs(name) { const m = TRACE_RE.exec(name); return m ? Number(m[1]) : -1; }
// Return the newest trace in `tracesDir` that BELONGS to `expectedWsKey`. The ownership guard skips
// any trace whose stamped `wsKey` is for a DIFFERENT workspace (a misplaced/leaked trace) so the
// statusline can never surface another project's gate verdict. Legacy traces (no wsKey) are accepted.
// If `expectedSessionKey` is present, only traces stamped for that session are accepted; unstamped
// legacy traces are skipped in that strict mode so one same-project chat cannot show another chat's
// latest badge.
export function latestTrace(tracesDir, expectedWsKey = null, expectedSessionKey = null) {
  const sessionKey = normalizeSessionId(expectedSessionKey);
  let files;
  try { files = fs.readdirSync(tracesDir); } catch { return null; }
  const newestFirst = files.map((f) => [f, fileTs(f)]).filter(([, ts]) => ts >= 0).sort((a, b) => b[1] - a[1]);
  // Two-tier when a session filter is active: (1) PREFER this session's own newest trace; (2) if it
  // has none, fall back to the newest UNSTAMPED (legacy / pre-feature) trace — project-level, so the
  // per-reviewer badge never just vanishes; (3) NEVER show a trace stamped for a DIFFERENT session.
  // Strict-skipping legacy made the badge disappear in every project with pre-feature history
  // (falling back to the old gate-status line) — this restores it without leaking another chat's badge.
  let legacyFallback = null;
  for (const [name] of newestFirst) {
    let t; try { t = JSON.parse(fs.readFileSync(path.join(tracesDir, name), "utf8")); } catch { continue; }
    if (expectedWsKey && t && t.wsKey && t.wsKey !== expectedWsKey) continue;   // misplaced workspace → skip
    if (!sessionKey) return t;                                                  // no session filter → newest wins (legacy behavior)
    const ts = normalizeSessionId(t?.sessionKey);
    if (ts === sessionKey) return t;                                            // tier 1: this session's own (newest) — preferred
    if (!ts && legacyFallback === null) legacyFallback = t;                     // tier 2: remember newest UNSTAMPED legacy
    // a trace stamped for ANOTHER session → never shown
  }
  return legacyFallback;   // no own-session trace → newest legacy (project-level), or null if none
}

// A trace's own chronological key — the numeric ms prefix of its id (`<ts>-<hex>`).
function traceTs(t) { const m = /^(\d+)-/.exec(String(t?.id || "")); return m ? Number(m[1]) : -1; }

// Hooks key a trace by git-toplevel; we also check the raw dir as a fallback for the rare case
// where git resolution fails and a hook wrote under the literal cwd. Take the chronologically
// newest across the (de-duplicated) roots, compared NUMERICALLY (not lexically) by id timestamp.
export function latestTraceForDir(dir, gitTopFn, sessionKey = null) {
  const roots = [];
  const top = gitTopFn ? gitTopFn(dir) : null;
  if (top) roots.push(top);
  if (dir && dir !== top) roots.push(dir);
  let best = null;
  for (const ws of roots) {
    // Read each root's traces with that root's OWN key as the ownership filter — a trace surfaces
    // only if it genuinely belongs to the dir it sits in (never another project's leaked trace).
    const t = latestTrace(path.join(workspaceStateDir(ws), "traces"), wsKey(ws), sessionKey);
    if (t && (!best || traceTs(t) > traceTs(best))) best = t;
  }
  return best;
}

// Resolve the project dir for the statusline from a PER-WINDOW signal only. The wrapper passes the
// open project as argv[2] (from stdin's workspace.current_dir); CLAUDE_PROJECT_DIR is the per-session
// env fallback. Both identify the WINDOW being rendered. We deliberately do NOT fall back to the
// process cwd: the statusline is a single GLOBAL process, so its cwd is the LAUNCHING project, not
// the window — guessing from it surfaces one project's gate badge in every other window (the
// cross-project mixup Rai hit). Reject the jq sentinels ("null"/"undefined"); return null when there
// is no reliable per-window signal, so the caller renders NOTHING rather than the wrong project.
export function resolveDir(argv2, env = process.env, input = null) {
  const bad = (v) => !v || v === "null" || v === "undefined";
  if (!bad(argv2)) return argv2;
  if (!bad(input?.workspace?.current_dir)) return input.workspace.current_dir;
  if (!bad(input?.cwd)) return input.cwd;
  if (!bad(env?.CLAUDE_PROJECT_DIR)) return env.CLAUDE_PROJECT_DIR;
  return null;
}

export function resolveSessionKey(argv3, env = process.env, input = null) {
  return normalizeSessionId(argv3) || sessionKeyFromInput(input || {}, env);
}

function readStatuslineInputSync() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readStatuslineInputSync();
  const dir = resolveDir(process.argv[2], process.env, input);
  if (!dir) process.exit(0);   // no reliable per-window project → render nothing (never guess via cwd)
  const sessionKey = resolveSessionKey(process.argv[3], process.env, input);
  // stdio: ignore git's stderr ("fatal: not a git repository") so a non-repo dir stays silent.
  const gitTop = (d) => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  const seg = renderSegment(latestTraceForDir(dir, gitTop, sessionKey));
  if (seg) process.stdout.write(seg);   // statusline appends this; prints nothing if no trace
}
