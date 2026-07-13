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

// Seatbelt profile (last-match-wins). grok's ENTIRE writable state is redirected into the per-run
// ephemeral tmpdir via GROK_HOME (see grokChildEnv), so this profile grants writes ONLY to that
// tmpdir + /dev and denies everything else — ALL of ~/.grok is READ-ONLY. That closes every ~/.grok
// surface at once, without enumerating any: binaries (bin/, downloads/, vendor/), plugins & skills
// (bundled/, installed-plugins/, marketplace-cache/, skills/), shell hooks (completions/, hooks/),
// behavior/containment config (config.toml, sandbox.toml, user-settings.json), AND the model-routing
// models_cache.json. An enumerated allowlist was still too clever — it kept models_cache.json (a
// persistent routing surface) writable; the redirect makes the whole question moot: nothing under
// ~/.grok is writable and the tmpdir is deleted after the run, so NOTHING grok writes persists to the
// next session. grok's own --sandbox read-only is a VERIFIED NO-OP (wrote into the workspace under
// bypassPermissions) — never trust it; this OS wrapper + `--no-leader` are the hard guarantee.
// Fail-closed: sandbox-exec refuses a bad profile and our spawn surfaces that as a reviewer error.
// (Every escalation here was caught by the Codex stop gate.)
// A path is safe to embed in the profile ONLY if it's an absolute path free of characters that could
// break out of the SBPL double-quoted string literal and inject arbitrary sandbox rules. SBPL string
// literals are `"…"`; a `"` closes the string, `\` starts an escape, and control chars are illegal —
// any of those in a caller-influenced path (e.g. GROK_AUTH_PATH) would let it inject its own
// (allow file-write* …) grant. We REFUSE such paths rather than try to escape them (there is no safe
// escape). Non-absolute is rejected too (only fully-resolved paths belong in a sandbox policy).
export function sbplPathSafe(p) {
  // eslint-disable-next-line no-control-regex
  return typeof p === "string" && p.length > 0 && path.isAbsolute(p) && !/["\\\x00-\x1f]/.test(p);
}

// authWrite (optional) = a credential file grok must persist ROTATING OAuth tokens back to. With auth
// fully read-only the first post-expiry gate run gets "401 no auth context" and every review shows Grok!.
//
// The GRANT SHAPE depends on WHO owns the auth file (gateManaged):
//  • Gate's OWN dedicated ~/.grok-headless (gateManaged=true) → grant the PARENT DIR as a subpath.
//    Grok persists auth via atomic write (create sibling temp + rename over auth.json); Seatbelt
//    `literal` allows open/write on the existing file but DENIES creating auth.json.tmp, surfacing as
//    "auth update disk write failed: Operation not permitted" → RT rotates in-memory while disk keeps
//    the dead RT → invalid_grant re-auth loop. Live-verified: literals = atomic FAIL, subpath = OK.
//    Safe because bench CREATES and CONTROLS ~/.grok-headless (never interactive ~/.grok; not on the
//    review exec/config path — GROK_HOME is the ephemeral tmpdir during runs).
//  • A caller's designated GROK_AUTH_PATH (gateManaged=false) → grant ONLY the exact file + its .lock.
//    Its parent dir is ARBITRARY (a caller could set GROK_AUTH_PATH=$HOME/auth.json or /auth.json),
//    and granting that dir would DISABLE write isolation for the whole review (caught by the Codex
//    gate). So caller auth gets bounded literals; atomic temp+rename may then be denied → the caller's
//    token rotation is degraded (use the gate home for atomic rotation) but the sandbox stays intact.
// Every interpolated path is still refused by sbplPathSafe (no SBPL injection).
export const GROK_SEATBELT_PROFILE = (tmpDir, authWrite, gateManaged = false) => {
  const tmpGrant = sbplPathSafe(tmpDir) ? ` (subpath "${tmpDir}")` : "";
  let authGrant = "";
  if (sbplPathSafe(authWrite)) {
    const authDir = path.dirname(authWrite);
    authGrant = gateManaged && sbplPathSafe(authDir)
      ? ` (subpath "${authDir}")`                                          // bench-controlled dir → atomic write OK
      : ` (literal "${authWrite}") (literal "${authWrite}.lock")`;         // caller path → bounded, isolation intact
  }
  return `(version 1)(allow default)(deny file-write*)(allow file-write*${tmpGrant}${authGrant} (subpath "/dev"))`;
};

// The single source of how grok is spawned (reviews, hunts, health probe). Pure — unit-testable.
// darwin → sandbox-exec-wrapped (hard read-only); elsewhere → bare CLI flags (best effort) and the
// fail-open stderr check in the runners is the net.
export function grokSpawnSpec(prompt, { bin = "grok", platform = process.platform, tmpDir, authWrite, authGateManaged = false } = {}) {
  const args = GROK_ARGS(prompt);
  if (platform === "darwin") return { cmd: "/usr/bin/sandbox-exec", args: ["-p", GROK_SEATBELT_PROFILE(tmpDir, authWrite, authGateManaged), bin, ...args] };
  return { cmd: bin, args };
}

// Which auth the gate's grok uses. Precedence:
//   1. GROK_AUTH inline token → null; nothing to inject, no file to persist.
//   2. Caller's own GROK_AUTH_PATH → we don't inject (it's already in the env) but we DO mark it
//      writable so the Seatbelt grants that file + its .lock: the caller designated it as grok's
//      credential file, and grok's rotating OAuth tokens must persist back to it — respecting the
//      path while denying the write would 401 custom-auth users the same way the read-only default
//      did (caught by the Codex gate).
//   3. The gate's DEDICATED auth home ~/.grok-headless/auth.json when it exists → writable, so
//      token refresh persists and its rotation chain stays INDEPENDENT of the user's interactive
//      ~/.grok login (mirror of CODEX_HOME=~/.codex-headless; sharing ~/.grok/auth.json burns the
//      user's refresh chain because rotated tokens can't be persisted read-only).
//      One-time setup: GROK_HOME=~/.grok-headless grok -p OK  (complete the browser sign-in).
//   4. Fallback: the original home's auth.json, READ-ONLY (works until token expiry; degraded —
//      401s there carry the one-time setup hint).
export function grokAuthPath(env, home, { fsImpl = fs } = {}) {
  if (env?.GROK_AUTH) return null;
  // A caller path is honored, but it only earns a WRITE grant if it's safe to embed in the sandbox
  // policy; an unsafe path (SBPL-breaking chars) degrades to read-only rather than injecting a grant.
  if (env?.GROK_AUTH_PATH) return { path: env.GROK_AUTH_PATH, writable: sbplPathSafe(env.GROK_AUTH_PATH), callerManaged: true };
  const h = home || os.homedir();
  const headless = path.join(h, ".grok-headless", "auth.json");
  try { if (fsImpl.existsSync(headless)) return { path: headless, writable: sbplPathSafe(headless) }; } catch { /* fall through */ }
  const originalGrokHome = env?.GROK_HOME || path.join(h, ".grok");
  return { path: path.join(originalGrokHome, "auth.json"), writable: false };
}

// Child env for every grok spawn. GROK_HOME repoints grok's whole state dir at the ephemeral,
// Seatbelt-writable tmpdir (so ~/.grok stays read-only and nothing persists); GROK_AUTH_PATH comes
// from grokAuthPath (gate auth home > read-only fallback; caller-provided auth never clobbered);
// BENCH_SUPPRESS_HOOKS stops grok from firing Claude Code hooks.
export function grokChildEnv(env, tmpDir, home, opts) {
  const auth = grokAuthPath(env, home, opts);
  return {
    ...env,
    BENCH_SUPPRESS_HOOKS: env?.BENCH_SUPPRESS_HOOKS || "1",
    ...(auth && !auth.callerManaged ? { GROK_AUTH_PATH: auth.path } : {}),
    ...(tmpDir ? { TMPDIR: tmpDir, GROK_HOME: tmpDir } : {}),
  };
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

// Failure text for a non-zero grok exit. On an auth error (401 / invalid_grant) it appends the
// EFFECTIVE recovery — which depends on the auth SOURCE and the PLATFORM.
//
// PLATFORM matters: the Seatbelt sandbox (and thus every write-grant / atomic-rotation limitation) is
// applied ONLY on darwin — grokSpawnSpec runs grok BARE elsewhere. So off darwin grok writes auth
// freely and token rotation works; a 401 there is simply an expired/dead token, and the darwin-only
// "the sandbox can't create the temp file / unset GROK_AUTH_PATH" guidance would be WRONG (caught by
// the Codex gate). Default the platform from process.platform for direct/legacy callers.
export function grokFailureMessage(r, auth, platform = process.platform) {
  const msg = (r.stderr || r.stdout || "grok failed").trim().slice(0, 300);
  const isAuthErr = /401|unauthorized|expired credentials|no auth context|invalid_grant/i.test(msg);
  if (!isAuthErr || !auth) return msg;

  const gateReauth = '`GROK_HOME=~/.grok-headless grok -p "Reply OK"`';

  if (platform !== "darwin") {
    // No OS sandbox → rotation works; the token itself is dead. Re-auth wherever grok reads it from.
    const isGateHome = !auth.callerManaged && String(auth.path || "").includes("/.grok-headless/");
    return `${msg}\n→ grok auth token expired/invalid; re-auth grok (sign in again), then retry.${isGateHome ? ` For the gate home: run ${gateReauth}.` : ""}`;
  }

  // darwin (Seatbelt-wrapped): a caller-managed GROK_AUTH_PATH can NEVER persist a rotating token, so
  // its 401s recur every session and need explicit guidance (knowingly degraded for isolation; a prior
  // gate catch). SAFE path (writable) → granted only its exact file, not its dir → grok can't create
  // the atomic temp sibling → refresh denied. UNSAFE path (not writable) → no write grant. Same fix:
  // the gate home rotates atomically, but is only consulted if GROK_AUTH_PATH is UNSET (caller path
  // takes precedence), so the recovery MUST say to unset it.
  if (auth.callerManaged) {
    const why = auth.writable
      ? "a custom GROK_AUTH_PATH is granted only its exact file (not its directory) for sandbox isolation, so grok can't create the temp file its atomic token-rotation needs"
      : "GROK_AUTH_PATH can't be granted sandbox write access (needs an absolute path with no quotes/backslashes/control chars)";
    return `${msg}\n→ ${why}, so a refreshed token can't persist → this recurs every session. For durable rotation, UNSET GROK_AUTH_PATH and run ${gateReauth} (the gate home rotates atomically).`;
  }
  // Read-only fallback (no gate home, no caller auth): set the gate home up.
  if (!auth.writable) {
    return `${msg}\n→ grok gate auth not set up. One-time fix: run ${gateReauth} and complete the browser sign-in, then retry.`;
  }
  // Gate home IS writable but still 401 → its stored token is genuinely dead; re-auth the gate home.
  return `${msg}\n→ grok gate token expired. Re-auth: run ${gateReauth} and complete the browser sign-in.`;
}

// Extract the final answer from grok stdout: JSON .text when parseable, else the raw stdout
// (fallback keeps us working if the CLI's JSON shape changes).
export function grokText(stdout) {
  const raw = String(stdout ?? "").trim();
  try { const j = JSON.parse(raw); if (typeof j?.text === "string") return j.text.trim(); } catch { /* not json */ }
  return raw;
}

export async function runGrokReview({ prompt, cwd, env, timeoutMs = TIMEOUT_MS, bin = "grok", platform, home }) {
  const tmpDir = makeGrokTmpDir();
  // Fail CLOSED: without the private tmpdir there is no ephemeral GROK_HOME to absorb grok's writes
  // and (off darwin) no Seatbelt either — grok would write ~/.grok unsandboxed. Refuse instead.
  if (!tmpDir) return { name: "Grok", error: "grok sandbox tmpdir could not be created — refusing unsandboxed review" };
  const auth = grokAuthPath(env, home);
  const childEnv = grokChildEnv(env, tmpDir, home);
  const spec = grokSpawnSpec(prompt, { bin, tmpDir, ...(platform ? { platform } : {}), ...(auth?.writable ? { authWrite: auth.path, authGateManaged: !auth.callerManaged } : {}) });
  const r = await spawnCollect(spec.cmd, spec.args, { cwd, env: childEnv, timeoutMs }).finally(() => cleanupTmpDir(tmpDir));
  if (r.status === 127) return { name: "Grok", error: "grok CLI not found (install: curl -fsSL https://x.ai/cli/install.sh | bash)" };
  if (r.status !== 0) return { name: "Grok", error: grokFailureMessage(r, auth, platform) };
  if (grokSandboxFailedOpen(r.stderr)) return { name: "Grok", error: "grok sandbox could not be applied — refusing unsandboxed review" };
  const v = parseVerdict(grokText(r.stdout));
  if (!v.verdict) return { name: "Grok", error: "unexpected reviewer output" };
  return { name: "Grok", ...v };
}

// Grok open-ended TASK → raw output (for hunt/deep gates; findings kept, no verdict parsing).
export async function runGrokTask({ prompt, cwd, env, timeoutMs = TIMEOUT_MS, bin = "grok", platform, home }) {
  const tmpDir = makeGrokTmpDir();
  // Fail CLOSED (see runGrokReview): no private tmpdir → no containment → refuse.
  if (!tmpDir) return { name: "Grok", error: "grok sandbox tmpdir could not be created — refusing unsandboxed review" };
  const auth = grokAuthPath(env, home);
  const childEnv = grokChildEnv(env, tmpDir, home);
  const spec = grokSpawnSpec(prompt, { bin, tmpDir, ...(platform ? { platform } : {}), ...(auth?.writable ? { authWrite: auth.path, authGateManaged: !auth.callerManaged } : {}) });
  const r = await spawnCollect(spec.cmd, spec.args, { cwd, env: childEnv, timeoutMs }).finally(() => cleanupTmpDir(tmpDir));
  if (r.status === 127) return { name: "Grok", error: "grok CLI not found (install: curl -fsSL https://x.ai/cli/install.sh | bash)" };
  if (r.status !== 0) return { name: "Grok", error: grokFailureMessage(r, auth, platform) };
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
