import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceStateDir } from "./config-store.mjs";

const C = { ALLOW: 48, BLOCK: 196, error: 208 };           // 256-color codes (match gate-status.py palette)
const col = (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`;
const GATE_LABEL = { "plan-file": "plan", "pre-push": "push" };  // shorten; others pass through

// Pure: render one trace as the format-C segment. Returns "" if nothing to show.
export function renderSegment(trace) {
  if (!trace || !Array.isArray(trace.reviewers) || trace.reviewers.length === 0) return "";
  const gate = GATE_LABEL[trace.gate] || trace.gate || "review";
  const anyBlock = trace.reviewers.some((r) => r.verdict === "BLOCK");
  const allAllow = trace.reviewers.every((r) => r.verdict === "ALLOW");
  const labelColor = anyBlock ? C.BLOCK : (allAllow ? C.ALLOW : C.error);
  const parts = trace.reviewers.map((r) => {
    if (r.verdict === "ALLOW") return col(C.ALLOW, `${r.name}✓`);
    if (r.verdict === "BLOCK") return col(C.BLOCK, `${r.name}✗`);
    return col(C.error, `${r.name}!`);                      // error / skipped reviewer
  });
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
