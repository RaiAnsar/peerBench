import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceStateDir } from "./config-store.mjs";
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

// Read the newest trace (<ts>-<hex>.json, so lexical sort == chronological) from a dir.
export function latestTrace(tracesDir) {
  let files;
  try { files = fs.readdirSync(tracesDir).filter((f) => f.endsWith(".json")); } catch { return null; }
  if (!files.length) return null;
  files.sort();
  try { return JSON.parse(fs.readFileSync(path.join(tracesDir, files[files.length - 1]), "utf8")); } catch { return null; }
}

// Hooks may key a trace by git-toplevel (stop hook) OR by cwd (plan hooks); check both, take newest.
export function latestTraceForDir(dir, gitTopFn) {
  const roots = [];
  const top = gitTopFn ? gitTopFn(dir) : null;
  if (top) roots.push(top);
  roots.push(dir);
  let best = null;
  for (const ws of roots) {
    const t = latestTrace(path.join(workspaceStateDir(ws), "traces"));
    if (t && (!best || String(t.id || "") > String(best.id || ""))) best = t;
  }
  return best;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || process.cwd();
  const gitTop = (d) => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d, encoding: "utf8", timeout: 3000 }).trim(); } catch { return null; } };
  const seg = renderSegment(latestTraceForDir(dir, gitTop));
  if (seg) process.stdout.write(seg);   // statusline appends this; prints nothing if no trace
}
