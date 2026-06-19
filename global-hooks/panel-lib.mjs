// Shared logic for the Codex+Kimi+MiMo panel gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the grok-companion
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
      diff = ""; // repo with no commits: untracked hashing below covers content
    }
    const h = createHash("sha256").update(status).update(" ").update(diff);
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
