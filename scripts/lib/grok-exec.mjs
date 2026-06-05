import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Grok mirrors Claude Code tool naming (its --help references Claude Code
// flags). Verified against `grok inspect` during implementation — adjust this
// list there if names differ; --permission-mode plan is the primary guard
// and carries enforcement even if a name here is wrong.
export const READONLY_DENY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

const TIMEOUT_MS = 13 * 60 * 1000;

// env.GROK_SANDBOX_PROFILE: optional sandbox profile name (spec: applied when
// discoverable). Set it in ~/.claude/settings.json env once a valid profile
// name for the installed grok version is known; unset = flag omitted and the
// permission-mode/deny-list/mutation-check layers carry enforcement.
export function buildGrokArgs({ mode, prompt, cwd, effort = "medium", maxTurns }, env = process.env) {
  const args = ["-p", prompt, "--output-format", "json", "--cwd", cwd, "--effort", effort];
  if (mode === "review") {
    args.push(
      "--permission-mode", "plan",
      "--disallowed-tools", READONLY_DENY_TOOLS.join(","),
      "--no-subagents",
      "--disable-web-search",
      "--max-turns", String(maxTurns ?? 8)
    );
    if (env.GROK_SANDBOX_PROFILE) {
      args.push("--sandbox", env.GROK_SANDBOX_PROFILE);
    }
  } else {
    args.push("--max-turns", String(maxTurns ?? 40));
  }
  return args;
}

// CONTENT-level workspace fingerprint for the mutation check. Status alone is
// not enough: a file that is dirty before the review stays "M" in porcelain
// output even if its content changes again during the review. So the
// fingerprint hashes: porcelain status + full `git diff HEAD` (tracked
// changes, staged+unstaged) + the content of every untracked file. Non-git
// dirs return null (check skipped; other enforcement layers still apply).
export function workspaceFingerprint(cwd) {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      diff = ""; // repo with no commits: nothing tracked; untracked hashing below covers it
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

export function runGrok(request, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const bin = env.GROK_BIN || "grok";
  const args = buildGrokArgs(request, env);
  const preFingerprint = request.mode === "review" ? workspaceFingerprint(request.cwd) : null;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: request.cwd, env });
    } catch (error) {
      finish({ status: 127, rawOutput: "", sessionId: null, error: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ status: 124, rawOutput: "", sessionId: null, error: "grok timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ status: 127, rawOutput: "", sessionId: null, error: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (request.mode === "review" && preFingerprint !== null) {
        const post = workspaceFingerprint(request.cwd);
        if (post !== null && post !== preFingerprint) {
          finish({ status: 1, rawOutput: "", sessionId: null, error: "grok mutated the workspace during a read-only review — result discarded" });
          return;
        }
      }
      if (code !== 0) {
        finish({ status: code ?? 1, rawOutput: "", sessionId: null, error: stderr.trim().slice(0, 400) || `grok exited ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        finish({ status: 0, rawOutput: String(parsed.text ?? "").trim(), sessionId: parsed.sessionId ?? null });
      } catch {
        finish({ status: 1, rawOutput: "", sessionId: null, error: "grok returned non-JSON output" });
      }
    });
  });
}
