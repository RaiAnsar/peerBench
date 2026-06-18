// Shared logic for the dual Codex+Grok plan gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the grok-companion
// repo — self-contained on purpose: no repo imports). Gate-side Grok runs are
// STATELESS: no job records, env stripped of codex plugin vars, full
// read-only enforcement stack + content-level workspace mutation check.
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

export function grokGateEnv(base) {
  const env = { ...base };
  delete env.CLAUDE_PLUGIN_DATA;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_COMPANION_")) delete env[key];
  }
  return env;
}

// Read-only enforcement stack (spec contract): permission-mode plan +
// deny-list + optional --sandbox when a profile name is configured.
export function buildGrokGateArgs(env) {
  const args = [
    "--output-format", "json",
    "--permission-mode", "plan",
    "--disallowed-tools", "Write,Edit,MultiEdit,NotebookEdit,Bash",
    "--no-subagents",
    "--disable-web-search",
    "--max-turns", "8"
  ];
  // NOTE: no --effort — the grok-build model rejects reasoningEffort (400).
  if (env.GROK_SANDBOX_PROFILE) {
    args.push("--sandbox", env.GROK_SANDBOX_PROFILE);
  }
  return args;
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

function spawnCollect(cmd, args, { cwd, env, timeoutMs }) {
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

// Grok-specific: grok returns EMPTY text when a review prompt invites it to
// explore the repo (it burns turns on tools instead of answering). The gate
// prompt is shared with Codex (which SHOULD explore), so we prepend this
// directive only on grok's side: review from the provided content, no tools.
const GROK_REVIEW_PREAMBLE =
  "You are reviewing based ONLY on the content provided in this message. " +
  "Do NOT use any tools and do NOT explore the filesystem — base your verdict " +
  "solely on the text below. Your reply must begin with ALLOW: or BLOCK: on the first line.";

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

// Grok side: stateless gate run, stripped env, read-only stack, mutation check.
export async function runGrokReview({ prompt, cwd, env }) {
  const gateEnv = grokGateEnv(env);
  const bin = gateEnv.GROK_BIN || "grok";
  const pre = workspaceFingerprint(cwd);
  const grokPrompt = `${GROK_REVIEW_PREAMBLE}\n\n${prompt}`;
  const r = await spawnCollect(bin, ["-p", grokPrompt, "--cwd", cwd, ...buildGrokGateArgs(gateEnv)], {
    cwd,
    env: gateEnv,
    timeoutMs: TIMEOUT_MS
  });
  if (pre !== null) {
    const post = workspaceFingerprint(cwd);
    if (post !== null && post !== pre) {
      return { name: "Grok", error: "grok mutated the workspace during a read-only review — result discarded" };
    }
  }
  if (r.status === 127) return { name: "Grok", error: "grok not on PATH" };
  if (r.status !== 0) return { name: "Grok", error: (r.stderr || "grok failed").trim().slice(0, 300) };
  try {
    const raw = String(JSON.parse(r.stdout)?.text ?? "").trim();
    const v = parseVerdict(raw);
    if (!v.verdict) return { name: "Grok", error: "unexpected reviewer output" };
    return { name: "Grok", ...v };
  } catch {
    return { name: "Grok", error: "grok returned non-JSON output" };
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
