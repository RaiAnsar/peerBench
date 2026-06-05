#!/usr/bin/env node
// Stop hook: when grok-companion's panelStops is ON for this workspace, run a
// Grok review of the previous turn's code changes — in parallel with the Codex
// stop gate (Claude Code runs Stop hooks concurrently). Instant no-op unless
// panelStops is on. Content-only (no-tools) prompt; fails OPEN.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { runGrok } from "./lib/grok-exec.mjs";
import { loadState } from "./lib/grok-state.mjs";

const MAX_DIFF_BYTES = 200_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES_EACH = 20_000;

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function untrackedBlock(ws) {
  let names = [];
  try {
    names = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: ws, encoding: "utf8" })
      .split("\0").filter(Boolean);
  } catch {
    return "";
  }
  const parts = [];
  for (const name of names.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const body = fs.readFileSync(`${ws}/${name}`, "utf8").slice(0, MAX_UNTRACKED_BYTES_EACH);
      parts.push(`--- NEW UNTRACKED FILE: ${name} ---\n${body}`);
    } catch {
      parts.push(`--- NEW UNTRACKED FILE (unreadable/binary): ${name} ---`);
    }
  }
  if (names.length > MAX_UNTRACKED_FILES) {
    parts.push(`(… ${names.length - MAX_UNTRACKED_FILES} more untracked files omitted)`);
  }
  return parts.join("\n\n");
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const input = readInput();
  if (input.stop_hook_active) {
    return; // avoid block loops: a prior stop-hook block is already in flight
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);

  let state;
  try {
    state = loadState(ws, {});
  } catch {
    return;
  }
  if (!state.config.panelStops) {
    return; // off by default — instant no-op
  }

  const status = git(["status", "--short", "--untracked-files=all"], ws);
  const diff = git(["diff", "HEAD"], ws).slice(0, MAX_DIFF_BYTES);
  const untracked = untrackedBlock(ws);
  if (!diff.trim() && !untracked.trim()) {
    return; // no code changes this turn (status/report-only) — nothing to review
  }

  const lastMsg = String(input.last_assistant_message ?? "").slice(0, 4000);
  const prompt = [
    "You are reviewing based ONLY on the content provided in this message. Do NOT use any tools or explore the filesystem. Your reply must begin with ALLOW: or BLOCK: on the first line.",
    "",
    "Review the code changes from the previous Claude turn (git diff + untracked files below).",
    "BLOCK only if there is a concrete bug, regression, or unsafe change that should be fixed before the session ends. Otherwise ALLOW.",
    "",
    "PREVIOUS ASSISTANT MESSAGE (context):",
    lastMsg,
    "",
    "GIT STATUS:",
    status,
    "",
    "GIT DIFF:",
    diff,
    "",
    "UNTRACKED FILES:",
    untracked
  ].join("\n");

  let res;
  try {
    res = await runGrok({ mode: "review", prompt, cwd: ws }, {});
  } catch (error) {
    emit({ systemMessage: `⚡ Grok stop gate: review failed (${error instanceof Error ? error.message : String(error)}); turn allowed.` });
    return; // fail open
  }

  if (res.status !== 0) {
    emit({ systemMessage: `⚡ Grok stop gate: review FAILED (turn allowed) — ${String(res.error || "").slice(0, 160)}` });
    return; // fail open
  }

  const firstLine = String(res.rawOutput).split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("BLOCK:")) {
    emit({
      decision: "block",
      reason: `⚡ Grok stop-gate review found issues before ending the session:\n\n${res.rawOutput}\n\nAddress these, then continue.`
    });
    return;
  }
  emit({ systemMessage: `⚡ Grok stop gate: ALLOW${firstLine.startsWith("ALLOW:") ? ` — ${firstLine.slice(6).trim().slice(0, 140)}` : ""}` });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
});
