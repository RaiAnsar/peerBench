#!/usr/bin/env node
// grok-companion runtime CLI.
// Usage:
//   grok-runner.mjs task [--json] [--write] [--effort E] [--max-turns N] <prompt…>
//   grok-runner.mjs review [--json] [--base <ref>]
//   grok-runner.mjs status
//   grok-runner.mjs setup
//
// Slash-command templates call `task --json "$ARGUMENTS"`, producing mixed
// argv: standalone flags first, then ONE quoted element that may START with
// flags and end with the verbatim prompt. parseArgs() consumes standalone
// flag elements, lifts leading flag tokens off the front of the first
// non-flag element, and keeps that element's remainder character-for-character
// as the prompt (no shell re-splitting — injection-safe).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGrok } from "./lib/grok-exec.mjs";
import { appendJob, loadState, resolveStateDir, saveState } from "./lib/grok-state.mjs";
import { resolveConfig, setReviewers } from "../global-hooks/config-store.mjs";
import { huntPanel, HUNT_SYSTEM, buildHuntUser } from "../global-hooks/hunt.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const MAX_DIFF_BYTES = 200_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES_EACH = 20_000;

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

const BOOL_FLAGS = new Set(["--json", "--write"]);
const VALUE_FLAGS = new Set(["--effort", "--max-turns", "--base"]);

export function parseArgs(argv) {
  const flags = { json: false, write: false, effort: "medium", maxTurns: null, base: null };
  const setBool = (t) => { flags[t === "--json" ? "json" : "write"] = true; };
  const setValue = (t, v) => {
    if (t === "--effort") flags.effort = v;
    if (t === "--max-turns") flags.maxTurns = Number(v);
    if (t === "--base") flags.base = v;
  };

  let prompt = "";
  for (let i = 0; i < argv.length; i++) {
    const el = argv[i];
    if (BOOL_FLAGS.has(el)) { setBool(el); continue; }
    if (VALUE_FLAGS.has(el) && i + 1 < argv.length) { setValue(el, argv[++i]); continue; }

    // First non-flag element: lift LEADING flag tokens off its front, then
    // keep the remainder verbatim (preserves quoting/spacing in the prompt).
    let rest = el;
    for (;;) {
      const m = rest.match(/^(\S+)(\s+|$)/);
      if (!m) break;
      const tok = m[1];
      if (BOOL_FLAGS.has(tok)) {
        setBool(tok);
        rest = rest.slice(m[0].length);
        continue;
      }
      if (VALUE_FLAGS.has(tok)) {
        rest = rest.slice(m[0].length);
        const mv = rest.match(/^(\S+)(\s+|$)/);
        if (mv) {
          setValue(tok, mv[1]);
          rest = rest.slice(mv[0].length);
        }
        continue;
      }
      break;
    }
    // Any further argv elements are part of the prompt too (unquoted usage).
    prompt = [rest, ...argv.slice(i + 1)].join(" ").trim();
    break;
  }
  return { flags, prompt };
}

function loadPrompt(name, vars = {}) {
  let text = fs.readFileSync(path.join(ROOT, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}

function untrackedBlock(ws) {
  let names = [];
  try {
    names = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ws, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    return "";
  }
  const parts = [];
  for (const name of names.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const body = fs.readFileSync(path.join(ws, name), "utf8").slice(0, MAX_UNTRACKED_BYTES_EACH);
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

function newJobId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(payload, flags) {
  process.stdout.write(flags.json ? `${JSON.stringify(payload)}\n` : `${payload.rawOutput || payload.error || ""}\n`);
}

async function recordedRun({ title, prompt, mode, flags, cwd }) {
  const ws = workspaceRoot(cwd);
  const job = { id: newJobId(), title, status: "running", workspaceRoot: ws, createdAt: new Date().toISOString() };
  appendJob(ws, job, {});
  const res = await runGrok({ mode, prompt, cwd: ws, effort: flags.effort, maxTurns: flags.maxTurns ?? undefined }, {});
  const done = {
    ...job,
    status: res.status === 0 ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    result: { rawOutput: res.rawOutput, sessionId: res.sessionId, error: res.error ?? null }
  };
  appendJob(ws, done, {});
  return { status: res.status, rawOutput: res.rawOutput, sessionId: res.sessionId, error: res.error ?? null };
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const { flags, prompt } = parseArgs(rest);
  const cwd = process.cwd();

  if (sub === "task") {
    if (!prompt) throw new Error("task requires a prompt");
    const payload = await recordedRun({ title: "Grok Task", prompt, mode: flags.write ? "write" : "review", flags, cwd });
    emit(payload, flags);
    process.exitCode = payload.status === 0 ? 0 : 1;
    return;
  }

  if (sub === "review") {
    const ws = workspaceRoot(cwd);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: ws, encoding: "utf8" }).stdout || "";
    const diffArgs = flags.base ? ["diff", `${flags.base}...HEAD`] : ["diff", "HEAD"];
    const diff = (spawnSync("git", diffArgs, { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES);
    const reviewPrompt = loadPrompt("review", {
      GIT_STATUS: status,
      GIT_DIFF: diff,
      UNTRACKED: flags.base ? "" : untrackedBlock(ws)
    });
    const payload = await recordedRun({ title: "Grok Review", prompt: reviewPrompt, mode: "review", flags, cwd });
    emit(payload, flags);
    process.exitCode = payload.status === 0 ? 0 : 1;
    return;
  }

  if (sub === "status") {
    const ws = workspaceRoot(cwd);
    const state = loadState(ws, {});
    if (!state.jobs.length) {
      process.stdout.write("No grok-companion jobs recorded for this workspace.\n");
      return;
    }
    for (const job of state.jobs.slice(-10).reverse()) {
      const first = String(job.result?.rawOutput ?? "").split("\n")[0].slice(0, 80);
      process.stdout.write(`${job.createdAt}  ${job.title}  ${job.status}  ${first}\n`);
    }
    return;
  }

  if (sub === "setup") {
    const bin = process.env.GROK_BIN || "grok";
    const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (version.status !== 0) {
      process.stdout.write("GROK NOT AVAILABLE: `grok --version` failed. Install Grok Build CLI and ensure it is on PATH.\n");
      process.exitCode = 1;
      return;
    }
    const ws = workspaceRoot(cwd);
    process.stdout.write(`grok binary: OK (${version.stdout.trim()})\nstate dir: ${resolveStateDir(ws, {})}\nsandbox profile: ${process.env.GROK_SANDBOX_PROFILE || "(unset — permission-mode/deny-list/mutation-check enforce read-only)"}\npanel (stops): ${loadState(ws, {}).config.panelStops ? "ON" : "off (v2 feature)"}\n`);
    return;
  }

  if (sub === "panel") {
    const ws = workspaceRoot(cwd);
    const mode = prompt.trim().toLowerCase();
    if (mode === "on" || mode === "off") {
      const state = loadState(ws, {});
      state.config.panelStops = mode === "on";
      saveState(ws, state, {});
      process.stdout.write(
        mode === "on"
          ? `Grok stop-gate panel: ON for this workspace.\nGrok now reviews every code-editing turn alongside Codex (takes effect next turn end).\n`
          : `Grok stop-gate panel: off for this workspace.\nThe Codex stop gate (if enabled) is unaffected.\n`
      );
      return;
    }
    const on = loadState(ws, {}).config.panelStops;
    process.stdout.write(`Grok stop-gate panel is ${on ? "ON" : "off"} for this workspace.\nToggle with \`/grok:panel on\` or \`/grok:panel off\`.\n`);
    return;
  }

  if (sub === "reviewers") {
    return reviewersCommand(rest);
  }

  if (sub === "hunt") {
    const seed = rest.join(" ").trim();
    const ws = workspaceRoot(cwd);
    const output = await huntCommand(ws, seed);
    process.stdout.write(`${output}\n`);
    return;
  }

  throw new Error(`Unknown subcommand: ${sub ?? "(none)"} — expected task|review|status|setup|panel|reviewers|hunt`);
}

export async function huntCommand(cwd, seed, { huntImpl = huntPanel } = {}) {
  const results = await huntImpl({ cwd, seed });
  // record a trace so `/gang:status <id>` can show the full findings later
  let traceId = null;
  try {
    traceId = writeTrace(cwd, {
      gate: "hunt", ws: cwd,
      reviewers: results.map((r) => ({ name: r.name, model: r.model, error: r.error || null })),
      systemPrompt: HUNT_SYSTEM, userPrompt: buildHuntUser(seed),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    });
  } catch { /* trace is best-effort */ }
  const blocks = results.map((r) =>
    `═══ ${r.name} ═══\n${r.findings?.trim() || `(no findings — ${r.error || "empty"})`}`);
  const header = seed?.trim() ? `Bug hunt — focus: ${seed.trim()}` : "Bug hunt — broad sweep";
  return `${header}\n\n${blocks.join("\n\n")}${traceId ? `\n\n(trace ${traceId} — expand later with /gang:status ${traceId})` : ""}`;
}

export function reviewersCommand(args) {
  const names = args.flatMap((a) => a.trim().split(/\s+/)).filter(Boolean);
  if (!names.length) {
    const current = resolveConfig().reviewers;
    process.stdout.write(`Current reviewers: ${current.join(", ")}\n`);
    return;
  }
  const saved = setReviewers(names);
  process.stdout.write(`Reviewers set to: ${saved.join(", ")}\nTakes effect on the next gate run.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
