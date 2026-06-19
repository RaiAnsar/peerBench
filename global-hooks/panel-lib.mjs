// Shared logic for the Codex+Kimi+MiMo panel gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the peerbench
// repo — self-contained on purpose: no repo imports).
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function parseVerdict(rawOutput) {
  const raw = String(rawOutput ?? "").trim();
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("ALLOW:")) return { verdict: "ALLOW", firstLine, raw };
  if (firstLine.startsWith("BLOCK:")) return { verdict: "BLOCK", firstLine, raw };
  return { verdict: null, firstLine, raw };
}

// CONTENT-level workspace fingerprint (status alone misses content changes to
// files that were already dirty before the review — exactly the state the
// plan-file gate runs in). Hashes porcelain status + full `git diff HEAD` +
// every untracked file's content. Non-git dirs return null (check skipped).
export function workspaceFingerprint(cwd) {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      diff = ""; // repo with no commits: diff HEAD fails — staged diff + untracked hashing below cover content
    }
    // Staged content: in a fresh repo (no HEAD) `git diff HEAD` is empty, so staged file CONTENT
    // would otherwise be invisible to the fingerprint (porcelain shows only "A name"). `git diff
    // --cached` captures it (vs the empty tree in a fresh repo). Found by the bench's own hunt.
    let staged = "";
    try {
      staged = execFileSync("git", ["diff", "--cached"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      staged = "";
    }
    const h = createHash("sha256").update(status).update(" ").update(diff).update(" ").update(staged);
    // NUL-separated enum handles spaces/newlines in names; hashing CONTENT is
    // what catches a PRE-EXISTING untracked file rewritten during review (its
    // porcelain "?? name" line is unchanged in that case).
    let untracked = [];
    try {
      untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
      }).split("\0").filter(Boolean).sort();
    } catch {
      untracked = [];
    }
    for (const name of untracked) {
      h.update(" ").update(name).update(" ");
      try {
        h.update(fs.readFileSync(path.join(cwd, name)));
      } catch {
        h.update("unreadable");
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
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

export function combinePanel(results) {
  const sides = Array.isArray(results) ? results : [results];
  const errors = sides.filter((s) => s && s.error);
  const verdicts = sides.filter((s) => s && !s.error);
  const skipNotes = errors.map((s) => `${s.name} review skipped: ${s.error}`);
  if (verdicts.length === 0) return { decision: "fail-open", summary: skipNotes.join(" | "), findings: "", skipNotes };
  const blockers = verdicts.filter((s) => s.verdict === "BLOCK");
  if (blockers.length > 0) return { decision: "block", summary: blockers.map((s) => `${s.name}: ${s.firstLine}`).join(" | "),
    findings: blockers.map((s) => `[${s.name}]\n${s.raw}`).join("\n\n"), skipNotes };
  const summary = verdicts.map((s) => `${s.name}: ${s.firstLine.slice("ALLOW:".length).trim().slice(0, 100)}`).concat(skipNotes).join(" · ");
  return { decision: "allow", summary, findings: "", skipNotes };
}
