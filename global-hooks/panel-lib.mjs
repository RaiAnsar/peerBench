// Shared logic for the peerBench panel gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the peerbench
// repo — self-contained on purpose: no repo imports).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSeverity, severityRank, SEVERITY_RANK } from "./deep-review.mjs";

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

const TIMEOUT_MS = 25 * 60 * 1000;

// Codex side: companion task --json -> { rawOutput }
export async function runCodexReview({ companionPath, prompt, cwd, env }) {
  const childEnv = { ...env, BENCH_SUPPRESS_HOOKS: env?.BENCH_SUPPRESS_HOOKS || "1" };
  const r = await spawnCollect(process.execPath, [companionPath, "task", "--json", prompt], { cwd, env: childEnv, timeoutMs: TIMEOUT_MS });
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

// Grok side: the local Grok Build CLI (x.ai harness), plan-billed — no API key. Headless single-turn
// agent run: -p prints the response and exits; --permission-mode plan = read-only (no edits);
// --no-memory/--no-subagents/--disable-web-search keep a review deterministic and repo-scoped.
// BENCH_SUPPRESS_HOOKS: grok loads Claude Code settings (hooks included) — suppress ours inside it.
// Exported: the health probe must spawn grok with the SAME safety contract (plan mode, verbatim,
// suppressed hooks) — a probe outside it could mutate the workspace while reporting "(plan)".
// --output-format json: grok streams working NARRATION into plain stdout (even mid-sentence around
// the verdict — broke first-line parsing, seen on Grok's first live review). JSON cleanly separates
// the final answer (.text) from .thought/narration.
// Grok's OWN --sandbox read-only is a silent NO-OP on this build (verified live: with permissions
// bypassed it wrote breach.txt into the workspace cwd, no warning, exit 0 — caught by the Codex stop
// gate). So the HARD read-only guarantee is OURS: wrap grok in macOS Seatbelt (sandbox-exec, the same
// mechanism codex uses) via grokSpawnSpec below. The grok flags stay as defense-in-depth only.
export const GROK_ARGS = (prompt) => ["-p", prompt, "--verbatim", "--sandbox", "read-only", "--no-leader", "--permission-mode", "plan", "--no-memory", "--no-subagents", "--disable-web-search", "--max-turns", "40", "--output-format", "json"];

// Seatbelt profile (last-match-wins). This is an ALLOWLIST, not a blocklist: default-deny every
// write, then re-allow ONLY grok's non-executable runtime data — the exact set an empirical headless
// review touches (sessions/, docs/, logs/, active_sessions.json) plus the state/cache files it may
// refresh mid-run (auth token, model cache, worktrees db, ui state). EVERYTHING else under ~/.grok
// stays denied by falling through to the base deny: binaries (bin/, downloads/, vendor/), plugins &
// skills (bundled/, installed-plugins/, plugins/, marketplace-cache/, skills/), shell hooks
// (completions/, hooks/), and behavior/containment config (config.toml, sandbox.toml,
// user-settings.json). A blocklist here was the wrong shape — it left downloads/ and vendor/ (real
// binary-promotion surfaces) writable and would silently re-open on any NEW surface a future grok
// version adds; the allowlist denies unknown surfaces by DEFAULT. Writes outside ~/.grok are limited
// to a PER-RUN private tmpdir (not the shared /private/var/folders root) and /dev. Fail-closed:
// sandbox-exec refuses to exec on a bad profile and our spawn surfaces that as a reviewer error —
// never unsandboxed. (Every escalation here was caught by the Codex stop gate.)
export const GROK_DATA_SUBPATHS = ["sessions", "logs", "projects", "docs", "upload_queue"];
export const GROK_DATA_FILES = [
  "active_sessions.json", "active_sessions.lock", "auth.json", "auth.json.lock",
  "models_cache.json", "sandbox-events.jsonl", "worktrees.db", "slash-mru.json", "tip_cursor.json",
];
export const GROK_SEATBELT_PROFILE = (home, tmpDir) => {
  const g = `${home}/.grok`;
  const dataGrants = [
    ...GROK_DATA_SUBPATHS.map((d) => `(subpath "${g}/${d}")`),
    ...GROK_DATA_FILES.map((f) => `(literal "${g}/${f}")`),
  ].join(" ");
  return `(version 1)(allow default)(deny file-write*)` +
    `(allow file-write* ${dataGrants}${tmpDir ? ` (subpath "${tmpDir}")` : ""} (subpath "/dev"))`;
};

// The single source of how grok is spawned (reviews, hunts, health probe). Pure — unit-testable.
// darwin → sandbox-exec-wrapped (hard read-only); elsewhere → bare CLI flags (best effort) and the
// fail-open stderr check in the runners is the net.
export function grokSpawnSpec(prompt, { bin = "grok", platform = process.platform, home = os.homedir(), tmpDir } = {}) {
  const args = GROK_ARGS(prompt);
  if (platform === "darwin") return { cmd: "/usr/bin/sandbox-exec", args: ["-p", GROK_SEATBELT_PROFILE(home, tmpDir), bin, ...args] };
  return { cmd: bin, args };
}

// Per-run private TMPDIR (realpath'd — Seatbelt matches real paths, /var → /private/var). The child
// gets TMPDIR pointed here so its temp writes land in a dir no other process shares; best-effort
// cleanup afterwards. Returns null on failure (profile then simply grants no tmp surface).
function makeGrokTmpDir() {
  try { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "grok-bench-"))); }
  catch { return null; }
}
const cleanupTmpDir = (d) => { if (d) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

// grok prints "warning: sandbox could not be applied: …" and can CONTINUE unsandboxed (fail-open).
// Treat that as fatal on the paths where Seatbelt isn't wrapping.
const grokSandboxFailedOpen = (stderr) => /sandbox could not be applied/i.test(String(stderr ?? ""));

// Extract the final answer from grok stdout: JSON .text when parseable, else the raw stdout
// (fallback keeps us working if the CLI's JSON shape changes).
export function grokText(stdout) {
  const raw = String(stdout ?? "").trim();
  try { const j = JSON.parse(raw); if (typeof j?.text === "string") return j.text.trim(); } catch { /* not json */ }
  return raw;
}

export async function runGrokReview({ prompt, cwd, env, timeoutMs = TIMEOUT_MS, bin = "grok", platform, home }) {
  const tmpDir = makeGrokTmpDir();
  const childEnv = { ...env, BENCH_SUPPRESS_HOOKS: env?.BENCH_SUPPRESS_HOOKS || "1", ...(tmpDir ? { TMPDIR: tmpDir } : {}) };
  const spec = grokSpawnSpec(prompt, { bin, tmpDir, ...(platform ? { platform } : {}), ...(home ? { home } : {}) });
  const r = await spawnCollect(spec.cmd, spec.args, { cwd, env: childEnv, timeoutMs }).finally(() => cleanupTmpDir(tmpDir));
  if (r.status === 127) return { name: "Grok", error: "grok CLI not found (install: curl -fsSL https://x.ai/cli/install.sh | bash)" };
  if (r.status !== 0) return { name: "Grok", error: (r.stderr || r.stdout || "grok failed").trim().slice(0, 300) };
  if (grokSandboxFailedOpen(r.stderr)) return { name: "Grok", error: "grok sandbox could not be applied — refusing unsandboxed review" };
  const v = parseVerdict(grokText(r.stdout));
  if (!v.verdict) return { name: "Grok", error: "unexpected reviewer output" };
  return { name: "Grok", ...v };
}

// Grok open-ended TASK → raw output (for hunt/deep gates; findings kept, no verdict parsing).
export async function runGrokTask({ prompt, cwd, env, timeoutMs = TIMEOUT_MS, bin = "grok", platform, home }) {
  const tmpDir = makeGrokTmpDir();
  const childEnv = { ...env, BENCH_SUPPRESS_HOOKS: env?.BENCH_SUPPRESS_HOOKS || "1", ...(tmpDir ? { TMPDIR: tmpDir } : {}) };
  const spec = grokSpawnSpec(prompt, { bin, tmpDir, ...(platform ? { platform } : {}), ...(home ? { home } : {}) });
  const r = await spawnCollect(spec.cmd, spec.args, { cwd, env: childEnv, timeoutMs }).finally(() => cleanupTmpDir(tmpDir));
  if (r.status === 127) return { name: "Grok", error: "grok CLI not found (install: curl -fsSL https://x.ai/cli/install.sh | bash)" };
  if (r.status !== 0) return { name: "Grok", error: (r.stderr || r.stdout || "grok failed").trim().slice(0, 300) };
  if (grokSandboxFailedOpen(r.stderr)) return { name: "Grok", error: "grok sandbox could not be applied — refusing unsandboxed review" };
  const raw = grokText(r.stdout);
  return raw ? { name: "Grok", raw } : { name: "Grok", error: "grok returned empty output" };
}

// Codex open-ended TASK → raw output (for hunt; no verdict parsing, so findings are kept).
// timeoutMs overrides the default agentic budget — the deep-review GATE passes a short (~10 min)
// cap so a push/spec review lands promptly; hunt/investigate omit it and keep the full 25 min.
export async function runCodexTask({ companionPath, prompt, cwd, env, timeoutMs = TIMEOUT_MS }) {
  const childEnv = { ...env, BENCH_SUPPRESS_HOOKS: env?.BENCH_SUPPRESS_HOOKS || "1" };
  const r = await spawnCollect(process.execPath, [companionPath, "task", "--json", prompt], { cwd, env: childEnv, timeoutMs });
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
  const sev = sideSeverity(s);
  if (SEVERITY_RANK[sev] == null) return false;   // unknown/corrupt severity → STRICT (hard block), never advisory
  return severityRank(sev) < severityRank(blockMinSeverity);
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
