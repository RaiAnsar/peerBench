// global-hooks/deep-review.mjs
// Shared helpers for capability G — the auto deep spec/plan review.
//
// Two files live under workspaceStateDir(ws):
//   deep-debounce            JSON { hash, ts } — last content hash a deep pass was launched for
//   deep-result-<hash>.json  JSON written ON COMPLETION by the detached spec-review pass
//
// G4: absence of a deep-result file means "not done yet" — there is no "pending" lie.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceStateDir } from "./config-store.mjs";

// Severity ladder — higher rank is more severe. Unknown/none → 0.
export const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Surface deep findings as a REWAKE (exit 2) when at/above this severity, or when there
// is at least one finding from a BLOCK verdict. Tunable in one place.
export const DEEP_REWAKE_SEVERITY = "high";

export function contentHash(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex").slice(0, 16);
}

// FIX 4: the deep debounce/result key. Keyed on (filePath, content) so two DIFFERENT
// spec files with byte-identical content do NOT collide (which would skip the second
// deep pass and clobber the first's result file). Use this everywhere a deep key is
// derived (launch debounce, the result hash, and the stale-check).
export function deepKey(filePath, content) {
  return contentHash(`${String(filePath)} ${String(content)}`);
}

export function severityRank(sev) {
  return SEVERITY_RANK[String(sev ?? "none").toLowerCase()] ?? 0;
}

// Extract the worst severity a reviewer declared from its raw text. Mirrors the
// severity logic in hunt.parseSpecFindings so the fast plan/spec gates and the deep
// pass read severity identically. A `SEVERITY: <x>` line wins; otherwise a BLOCK with
// no SEVERITY line defaults to "high" (safe — a BLOCK is treated as a real blocker),
// and a non-BLOCK with no line is "none". `verdict` is the already-parsed ALLOW/BLOCK.
export function parseSeverity(raw, verdict) {
  const s = String(raw ?? "");
  const m = s.match(/^\s*SEVERITY:\s*(none|low|medium|high|critical)\b/im);
  if (m) return m[1].toLowerCase();
  return verdict === "BLOCK" ? "high" : "none";
}

// Aggregate per-reviewer spec-review results into the machine-readable contract
// used by the surfacing gate. results: [{ name, verdict, findingCount, severity }]
export function summarizeSpecReview(results) {
  const list = Array.isArray(results) ? results : [];
  // Carry per-reviewer severity so the surfaced badge + statusline can render a
  // sub-threshold BLOCK as `~` (advisory) rather than the alarming `✗`.
  const reviewers = list.map((r) => ({ name: r.name, verdict: r.verdict ?? null, severity: r.severity ?? null }));
  const findingCount = list.reduce((n, r) => n + (Number(r.findingCount) || 0), 0);
  let maxSeverity = "none";
  for (const r of list) {
    if (severityRank(r.severity) > severityRank(maxSeverity)) maxSeverity = String(r.severity).toLowerCase();
  }
  return { reviewers, findingCount, maxSeverity };
}

// True when a deep result should rewake (exit 2) rather than just surface a note.
export function shouldRewake({ maxSeverity, findingCount } = {}) {
  return severityRank(maxSeverity) >= severityRank(DEEP_REWAKE_SEVERITY) && (Number(findingCount) || 0) > 0;
}

export function deepResultPath(ws, hash) {
  return path.join(workspaceStateDir(ws), `deep-result-${hash}.json`);
}

export function deepDebouncePath(ws) {
  return path.join(workspaceStateDir(ws), "deep-debounce");
}

// G3: skip launching a deep pass if one for this exact content hash ran/launched within `intervalMs`.
export function isDeepDebounced(ws, hash, { intervalMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(deepDebouncePath(ws), "utf8"));
    return j.hash === hash && (now - (j.ts || 0)) < intervalMs;
  } catch {
    return false;   // no marker (or unreadable) → not debounced
  }
}

export function markDeepDebounce(ws, hash, { now = Date.now() } = {}) {
  const file = deepDebouncePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hash, ts: now }));
}

export function writeDeepResult(ws, result) {
  const file = deepResultPath(ws, result.hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic-ish: write then rename so a reader never sees a half-written file.
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

// G5: find the single most-recent completed deep-result file for this workspace.
// Returns { file, result } or null.
export function readLatestDeepResult(ws) {
  const dir = workspaceStateDir(ws);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^deep-result-.*\.json$/.test(f) && !f.includes(".tmp."));
  } catch {
    return null;
  }
  if (!files.length) return null;
  // Newest by mtime so the freshest completed pass surfaces first.
  files.sort((a, b) => {
    let ta = 0, tb = 0;
    try { ta = fs.statSync(path.join(dir, a)).mtimeMs; } catch { /* gone */ }
    try { tb = fs.statSync(path.join(dir, b)).mtimeMs; } catch { /* gone */ }
    return tb - ta;
  });
  const file = path.join(dir, files[0]);
  try {
    // FIX 3: defensively cap the read — an absurdly large result file is treated as corrupt
    // (a deep-result is small structured JSON; megabytes means something went wrong).
    if (fs.statSync(file).size > 256 * 1024) throw new Error("deep-result too large");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // FIX 2: valid JSON `null` (or an array/non-object) parses fine but would crash
    // surfaceDeepResult at `result.specPath`, leaving the file undeleted → the gate
    // re-throws every future stop. Require a non-null plain object so the catch drops it.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("deep-result not an object");
    return { file, result: parsed };
  } catch {
    // Corrupt result file — remove it so it never wedges the stop gate.
    try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
    return null;
  }
}

export function deleteDeepResult(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
}
