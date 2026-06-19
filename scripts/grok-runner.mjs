#!/usr/bin/env node
// grok-companion runtime CLI.
// Usage:
//   grok-runner.mjs review [--json] [--base <ref>]
//   grok-runner.mjs status
//   grok-runner.mjs setup
//
// Slash-command templates call `review --json "$ARGUMENTS"`, producing mixed
// argv: standalone flags first, then ONE quoted element that may START with
// flags. parseArgs() consumes standalone flag elements, lifts leading flag
// tokens off the front of the first non-flag element.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, isGangDisabled, setGangDisabled, setReviewers } from "../global-hooks/config-store.mjs";
import { combinePanel, untrackedBlock } from "../global-hooks/panel-lib.mjs";
import { resolveReviewers, latestCodexRoot } from "../global-hooks/reviewers.mjs";
import { huntPanel, HUNT_SYSTEM, buildHuntUser } from "../global-hooks/hunt.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const MAX_DIFF_BYTES = 200_000;

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

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const { flags, prompt } = parseArgs(rest);
  const cwd = process.cwd();

  if (sub === "review") {
    const ws = workspaceRoot(cwd);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: ws, encoding: "utf8" }).stdout || "";
    const diffArgs = flags.base ? ["diff", `${flags.base}...HEAD`] : ["diff", "HEAD"];
    const diff = (spawnSync("git", diffArgs, { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES);
    const untracked = flags.base ? "" : untrackedBlock(ws);

    const system = "You are a code reviewer. Review the diff below and respond with ALLOW: <reason> or BLOCK: <reason> on the first line. BLOCK only for concrete bugs, regressions, or unsafe changes. Content-only review — no tools needed.";
    const userParts = ["GIT STATUS:\n" + status];
    if (diff) userParts.push("GIT DIFF:\n" + diff);
    if (untracked) userParts.push("UNTRACKED FILES:\n" + untracked);
    const user = userParts.join("\n\n");

    const reviewers = resolveReviewers({ env: process.env });
    const results = await Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env: process.env })));
    const panel = combinePanel(results);

    try {
      writeTrace(ws, {
        gate: "review",
        ws,
        reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null })),
        systemPrompt: system,
        userPrompt: user.slice(0, 2000),
        rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || r.error || ""]))
      });
    } catch { /* trace is best-effort */ }

    if (flags.json) {
      process.stdout.write(JSON.stringify({ decision: panel.decision, summary: panel.summary, findings: panel.findings, results }) + "\n");
    } else {
      for (const r of results) {
        const line = r.error ? `${r.name}: skipped (${r.error})` : `${r.name}: ${r.firstLine || r.verdict}`;
        process.stdout.write(line + "\n");
      }
      process.stdout.write(`\nResult: ${panel.decision.toUpperCase()} — ${panel.summary}\n`);
      if (panel.findings) process.stdout.write("\n" + panel.findings + "\n");
    }
    process.exitCode = panel.decision === "block" ? 1 : 0;
    return;
  }

  if (sub === "status") {
    const ws = workspaceRoot(cwd);
    const { listTraces } = await import("../global-hooks/trace-store.mjs");
    const traces = listTraces(ws, 10);
    if (!traces.length) {
      process.stdout.write("No gang review traces for this workspace.\n");
      return;
    }
    for (const t of traces) {
      process.stdout.write(`${t.ts || ""}  gate:${t.gate}  ${t.id}\n`);
    }
    return;
  }

  if (sub === "setup") {
    const ws = workspaceRoot(cwd);
    const cfg = resolveConfig({ env: process.env });
    const codexFound = !!latestCodexRoot();
    const kimiKey = !!process.env.KIMI_API_KEY;
    const mimoKey = !!process.env.MIMO_API_KEY;
    const disabled = isGangDisabled(ws);
    const lines = [
      `Active reviewers: ${cfg.reviewers.join(", ")}`,
      `KIMI_API_KEY: ${kimiKey ? "present" : "missing"}`,
      `MIMO_API_KEY: ${mimoKey ? "present" : "missing"}`,
      `Codex plugin: ${codexFound ? "found" : "not found"}`,
      `Gang disabled: ${disabled ? "yes" : "no"}`,
      `Hint: /gang:reviewers to change reviewers | /gang:off to disable | /gang:on to re-enable`
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (sub === "off" || sub === "on") {
    const ws = workspaceRoot(cwd);
    const output = gateToggleCommand(ws, [sub, ...rest]);
    process.stdout.write(`${output}\n`);
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

  if (sub === "investigate") {
    const seed = rest.join(" ").trim();
    const ws = workspaceRoot(cwd);
    const output = await huntCommand(ws, seed, { deep: true });
    process.stdout.write(`${output}\n`);
    return;
  }

  throw new Error(`Unknown subcommand: ${sub ?? "(none)"} — expected review|status|setup|reviewers|hunt|investigate|off|on`);
}

export async function huntCommand(cwd, seed, { huntImpl = huntPanel, deep = false } = {}) {
  const results = await huntImpl({ cwd, seed, deep });
  const gate = deep ? "investigate" : "hunt";
  // record a trace so `/gang:status <id>` can show the full findings later
  let traceId = null;
  try {
    traceId = writeTrace(cwd, {
      gate, ws: cwd,
      reviewers: results.map((r) => ({ name: r.name, model: r.model, error: r.error || null, diag: r.diag || null })),
      systemPrompt: HUNT_SYSTEM, userPrompt: buildHuntUser(seed),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    });
  } catch { /* trace is best-effort */ }
  const blocks = results.map((r) =>
    `═══ ${r.name} ═══\n${r.findings?.trim() || `(no findings — ${r.error || "empty"})`}`);
  const cmd = deep ? "investigate" : "hunt";
  const header = deep
    ? (seed?.trim() ? `Investigation — focus: ${seed.trim()}` : "Investigation — broad sweep")
    : (seed?.trim() ? `Bug hunt — focus: ${seed.trim()}` : "Bug hunt — broad sweep");
  return `${header}\n\n${blocks.join("\n\n")}${traceId ? `\n\n(trace ${traceId} — expand later with /gang:${cmd} ${traceId})` : ""}`;
}

export function gateToggleCommand(ws, args) {
  const sub = args[0]; // "off" or "on"
  const hasGlobal = args.slice(1).includes("--global");
  const scope = hasGlobal ? "global" : "workspace";
  const disabled = sub === "off";
  setGangDisabled(ws, disabled, { scope });
  return disabled
    ? `gang: disabled (${scope}). Gates will no-op until /gang:on.`
    : `gang: enabled (${scope}).`;
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
