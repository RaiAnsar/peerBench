// Shared logic for the Codex+Kimi+MiMo panel gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the peerbench
// repo — self-contained on purpose: no repo imports).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSeverity, severityRank } from "./deep-review.mjs";

export function parseVerdict(rawOutput) {
  const raw = String(rawOutput ?? "").trim();
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("ALLOW:")) return { verdict: "ALLOW", firstLine, raw };
  if (firstLine.startsWith("BLOCK:")) return { verdict: "BLOCK", firstLine, raw };
  return { verdict: null, firstLine, raw };
}

// List untracked files and embed their (text) contents for content-only review. NUL-delimited
// (handles newlines in names) and NEVER follows a symlink out of the workspace — an untracked
// symlink to e.g. ~/.ssh/config must not leak into a reviewer prompt (found by the bench's own hunt).
// Shared by stop-review and bench-runner so both stay consistent.
export function untrackedBlock(ws, { maxFiles = 20, maxBytesEach = 20_000 } = {}) {
  let names = [];
  try {
    names = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: ws, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\0").filter(Boolean);
  } catch {
    return "";
  }
  let root; try { root = fs.realpathSync.native(ws); } catch { root = ws; }
  const parts = [];
  for (const name of names.slice(0, maxFiles)) {
    const abs = path.join(ws, name);
    let real;
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) { parts.push(`--- NEW UNTRACKED FILE (symlink skipped): ${name} ---`); continue; }
      real = fs.realpathSync.native(abs);
      if (real !== root && !real.startsWith(root + path.sep)) { parts.push(`--- NEW UNTRACKED FILE (outside workspace, skipped): ${name} ---`); continue; }
    } catch {
      parts.push(`--- NEW UNTRACKED FILE (unreadable): ${name} ---`); continue;
    }
    try {
      const body = fs.readFileSync(real, "utf8").slice(0, maxBytesEach);
      parts.push(`--- NEW UNTRACKED FILE: ${name} ---\n${body}`);
    } catch {
      parts.push(`--- NEW UNTRACKED FILE (unreadable/binary): ${name} ---`);
    }
  }
  if (names.length > maxFiles) parts.push(`(… ${names.length - maxFiles} more untracked files omitted)`);
  return parts.join("\n\n");
}

export function spawnCollect(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (error) {
      finish({ status: 127, stdout: "", stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ status: 124, stdout, stderr: "timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => { clearTimeout(timer); finish({ status: 127, stdout: "", stderr: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ status: code ?? 1, stdout, stderr }); });
  });
}

const TIMEOUT_MS = 13 * 60 * 1000;

// Codex side: companion task --json -> { rawOutput }
export async function runCodexReview({ companionPath, prompt, cwd, env }) {
  const r = await spawnCollect(process.execPath, [companionPath, "task", "--json", prompt], { cwd, env, timeoutMs: TIMEOUT_MS });
  if (r.status !== 0) return { name: "Codex", error: (r.stderr || r.stdout || "codex task failed").trim().slice(0, 300) };
  try {
    const raw = String(JSON.parse(r.stdout)?.rawOutput ?? "").trim();
    const v = parseVerdict(raw);
    if (!v.verdict) return { name: "Codex", error: "unexpected reviewer output" };
    return { name: "Codex", ...v };
  } catch {
    return { name: "Codex", error: "invalid JSON from codex companion" };
  }
}

// Codex open-ended TASK → raw output (for hunt; no verdict parsing, so findings are kept).
export async function runCodexTask({ companionPath, prompt, cwd, env }) {
  const r = await spawnCollect(process.execPath, [companionPath, "task", "--json", prompt], { cwd, env, timeoutMs: TIMEOUT_MS });
  if (r.status !== 0) return { name: "Codex", error: (r.stderr || r.stdout || "codex task failed").trim().slice(0, 300) };
  try {
    const raw = String(JSON.parse(r.stdout)?.rawOutput ?? "").trim();
    return raw ? { name: "Codex", raw } : { name: "Codex", error: "codex returned empty output" };
  } catch {
    return { name: "Codex", error: "invalid JSON from codex companion" };
  }
}

// Resolve a reviewer's effective severity: an already-parsed `severity` field (deep-result
// reviewers carry one) wins; otherwise parse it from the raw text (fast-gate reviewers carry
// `raw`). A BLOCK with neither parses to "high" via parseSeverity — safe.
function sideSeverity(s) {
  return s.severity != null ? String(s.severity).toLowerCase() : parseSeverity(s.raw, s.verdict);
}

// True when a reviewer's BLOCK is SUB-THRESHOLD under severity-gating: its severity is below
// blockMinSeverity, so it's an advisory (render `~`), not a hard block (`✗`). Only meaningful
// with a blockMinSeverity; a BLOCK with no severity at all resolves to "high" — NOT
// sub-threshold against "high" — safe.
function isAdvisoryBlock(s, blockMinSeverity) {
  if (!blockMinSeverity || !s || s.error || s.verdict !== "BLOCK") return false;
  return severityRank(sideSeverity(s)) < severityRank(blockMinSeverity);
}

// Per-reviewer verdict badge, in the order they appear (only reviewers that were
// meant to run for the gate — the caller decides the set, e.g. stop excludes Codex).
// ✓ = ALLOW (or hunt-success); ✗ = a real BLOCK; ! = errored/skipped (matches the
// statusline's error glyph); ~ = a sub-threshold BLOCK under severity-gating (advisory,
// not blocking — only emitted when a blockMinSeverity is supplied).
export function panelBadge(sides, { blockMinSeverity } = {}) {
  return sides
    .filter(Boolean)
    .map((s) => `${s.name}${s.error ? "!" : s.verdict === "BLOCK" ? (isAdvisoryBlock(s, blockMinSeverity) ? "~" : "✗") : "✓"}`)
    .join(" ");
}

// combinePanel(results, { blockMinSeverity })
// Default (no blockMinSeverity — stop/pre-push): UNCHANGED — any BLOCK → decision:"block".
// With blockMinSeverity (e.g. "high" — the plan/spec gates): a BLOCK is a REAL blocker only
// when its severity >= blockMinSeverity. Sub-threshold BLOCKs do NOT block; they are carried
// as `advisories` and folded into `summary` so the gate can surface them while allowing.
export function combinePanel(results, { blockMinSeverity } = {}) {
  const sides = Array.isArray(results) ? results : [results];
  const badge = panelBadge(sides, { blockMinSeverity });
  const errors = sides.filter((s) => s && s.error);
  const verdicts = sides.filter((s) => s && !s.error);
  const skipNotes = errors.map((s) => `${s.name} review skipped: ${s.error}`);
  if (verdicts.length === 0) return { decision: "fail-open", summary: skipNotes.join(" | "), findings: "", skipNotes, badge };
  const allBlocks = verdicts.filter((s) => s.verdict === "BLOCK");
  // Split BLOCKs into real (>= threshold, or no threshold at all) vs sub-threshold advisories.
  const blockers = allBlocks.filter((s) => !isAdvisoryBlock(s, blockMinSeverity));
  const advisorySides = allBlocks.filter((s) => isAdvisoryBlock(s, blockMinSeverity));
  const advisories = advisorySides.map((s) => `⚠ ${s.name}: ${s.firstLine} (${sideSeverity(s)})`);
  if (blockers.length > 0) return { decision: "block", summary: blockers.map((s) => `${s.name}: ${s.firstLine}`).join(" | "),
    findings: blockers.map((s) => `[${s.name}]\n${s.raw}`).join("\n\n"), skipNotes, advisories, badge };
  const allowParts = verdicts
    .filter((s) => s.verdict !== "BLOCK")
    .map((s) => `${s.name}: ${s.firstLine.slice("ALLOW:".length).trim().slice(0, 100)}`);
  const summary = allowParts.concat(advisories).concat(skipNotes).join(" · ");
  return { decision: "allow", summary, findings: "", skipNotes, advisories, badge };
}
