#!/usr/bin/env node
// peerbench runtime CLI.
// Usage:
//   bench-runner.mjs review [--json] [--base <ref>]
//   bench-runner.mjs status
//   bench-runner.mjs setup
//
// Slash-command templates call `review --json "$ARGUMENTS"`, producing mixed
// argv: standalone flags first, then ONE quoted element that may START with
// flags. parseArgs() consumes standalone flag elements, lifts leading flag
// tokens off the front of the first non-flag element.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, isBenchDisabled, setBenchDisabled, setReviewers } from "../global-hooks/config-store.mjs";
import { combinePanel, untrackedBlock } from "../global-hooks/panel-lib.mjs";
import { resolveReviewers, latestCodexRoot } from "../global-hooks/reviewers.mjs";
import { huntPanel, HUNT_SYSTEM, buildHuntUser, DEBUG_SYSTEM, buildDebugUser } from "../global-hooks/hunt.mjs";
import { writeTrace, readTrace, listTraces } from "../global-hooks/trace-store.mjs";
import { runSpecReview } from "../global-hooks/spec-review-run.mjs";

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
    } catch (e) {
      // trace is best-effort — but say so on stderr instead of swallowing (D3); /bench:status needs it.
      process.stderr.write(`⛩ bench review: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
    }

    if (flags.json) {
      process.stdout.write(JSON.stringify({ decision: panel.decision, badge: panel.badge, summary: panel.summary, findings: panel.findings, results }) + "\n");
    } else {
      for (const r of results) {
        const line = r.error ? `${r.name}: skipped (${r.error})` : `${r.name}: ${r.firstLine || r.verdict}`;
        process.stdout.write(line + "\n");
      }
      process.stdout.write(`\nResult: ${panel.decision.toUpperCase()} [${panel.badge}] — ${panel.summary}\n`);
      if (panel.findings) process.stdout.write("\n" + panel.findings + "\n");
    }
    process.exitCode = panel.decision === "block" ? 1 : 0;
    return;
  }

  if (sub === "status") {
    const ws = workspaceRoot(cwd);
    statusCommand(ws, rest);
    return;
  }

  if (sub === "setup") {
    const ws = workspaceRoot(cwd);
    const cfg = resolveConfig({ env: process.env });
    const codexFound = !!latestCodexRoot();
    const kimiKey = !!process.env.KIMI_API_KEY;
    const mimoKey = !!process.env.MIMO_API_KEY;
    const disabled = isBenchDisabled(ws);
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
    const lines = [
      `Active reviewers: ${cfg.reviewers.join(", ")}`,
      `KIMI_API_KEY: ${kimiKey ? "present" : "missing"}`,
      `MIMO_API_KEY: ${mimoKey ? "present" : "missing"}`,
      `Codex plugin: ${codexFound ? "found" : "not found"}`,
      `Bench disabled: ${disabled ? "yes" : "no"}`,
      setupStatus(settingsPath),
      `Hint: /bench:reviewers to change reviewers | /bench:off to disable | /bench:on to re-enable`
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

  if (sub === "spec-review") {
    // Usage: spec-review <abs-path> --ws <abs-ws>
    // Detached deep pass launched by the plan-file gate (G2). Resolves the SAME
    // workspaceStateDir as the hook by taking --ws explicitly. Never throws to the
    // caller (it's detached + unref'd) — failures are noted on stderr only.
    let filePath = null, ws = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--ws" && i + 1 < rest.length) { ws = rest[++i]; continue; }
      if (!filePath) filePath = rest[i];
    }
    if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exitCode = 1; return; }
    if (!ws) ws = workspaceRoot(path.dirname(filePath));
    try {
      await runSpecReview(filePath, ws);
    } catch (e) {
      process.stderr.write(`⛩ spec-review: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return;
  }

  if (sub === "debug") {
    const seed = rest.join(" ").trim();
    if (!seed) {
      process.stdout.write("Describe the failure to debug — e.g. `/bench:debug TypeError: cart is undefined at checkout when the cart is empty`\n");
      return;
    }
    const ws = workspaceRoot(cwd);
    const output = await huntCommand(ws, seed, { mode: "debug" });
    process.stdout.write(`${output}\n`);
    return;
  }

  throw new Error(`Unknown subcommand: ${sub ?? "(none)"} — expected review|status|setup|reviewers|hunt|investigate|debug|spec-review|off|on`);
}

const HUNT_MODES = {
  hunt:        { deep: false, system: HUNT_SYSTEM,  buildUser: buildHuntUser,  header: (s) => s ? `Bug hunt — focus: ${s}` : "Bug hunt — broad sweep" },
  investigate: { deep: true,  system: HUNT_SYSTEM,  buildUser: buildHuntUser,  header: (s) => s ? `Investigation — focus: ${s}` : "Investigation — broad sweep" },
  debug:       { deep: false, system: DEBUG_SYSTEM, buildUser: buildDebugUser, header: (s) => `Debug — ${s || "(no failure described)"}` },
};
export async function huntCommand(cwd, seed, { huntImpl = huntPanel, writeTraceImpl = writeTrace, deep = false, mode } = {}) {
  const key = mode || (deep ? "investigate" : "hunt");           // back-compat: deep:true → investigate
  const m = HUNT_MODES[key] || HUNT_MODES.hunt;
  const results = await huntImpl({ cwd, seed, deep: m.deep, system: m.system, user: m.buildUser(seed) });
  // record a trace so `/bench:status <id>` can show the full findings later
  let traceId = null;
  try {
    traceId = writeTraceImpl(cwd, {
      gate: key, ws: cwd,
      reviewers: results.map((r) => ({ name: r.name, model: r.model, error: r.error || null, diag: r.diag || null })),
      systemPrompt: m.system, userPrompt: m.buildUser(seed),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    });
  } catch (e) {
    // trace is best-effort — but say so on stderr instead of swallowing (D3); /bench:status needs it.
    process.stderr.write(`⛩ bench ${key}: trace write failed (${e instanceof Error ? e.message : String(e)}); findings still returned.\n`);
  }
  const blocks = results.map((r) =>
    `═══ ${r.name} ═══\n${r.findings?.trim() || `(no findings — ${r.error || "empty"})`}`);
  const header = m.header(seed?.trim() || "");
  return `${header}\n\n${blocks.join("\n\n")}${traceId ? `\n\n(trace ${traceId} — expand later with /bench:${key} ${traceId})` : ""}`;
}

// G1/G4 — deep spec/plan review against the real repo. The implementation now lives in
// the deploy-safe SIBLING worker global-hooks/spec-review-run.mjs (FIX 1: scripts/ is never
// deployed, so the hook could not reach a scripts/ runner in a real install). This is kept
// as an alias so the `spec-review` subcommand and existing tests keep working.
export const specReviewCommand = runSpecReview;

export function gateToggleCommand(ws, args, { root } = {}) {
  const sub = args[0]; // "off" or "on"
  const hasGlobal = args.slice(1).includes("--global");
  const scope = hasGlobal ? "global" : "workspace";
  const disabled = sub === "off";
  // ALWAYS act on the selected scope's marker first (never early-return before this).
  setBenchDisabled(ws, disabled, { scope, root });
  if (disabled) {
    return `bench: disabled (${scope}). Gates will no-op until /bench:on.`;
  }
  // Re-enable: derive the message from a fresh read so we never claim "enabled"
  // while the OTHER scope's marker is still disabling the gates.
  const stillDisabled = isBenchDisabled(ws, { root });
  if (!stillDisabled) return `bench: enabled (${scope}).`;
  // The cleared scope didn't fully re-enable — name the remaining source honestly.
  if (scope === "workspace") {
    return `bench: workspace re-enabled, but STILL DISABLED GLOBALLY — run /bench:on --global to fully re-enable.`;
  }
  return `bench: global re-enabled, but STILL DISABLED in this WORKSPACE — run /bench:on to fully re-enable.`;
}

export function reviewersCommand(args) {
  const names = args.flatMap((a) => a.trim().split(/\s+/)).filter(Boolean);
  if (!names.length) {
    const current = resolveConfig().reviewers;
    process.stdout.write(`Current reviewers: ${current.join(", ")}\n`);
    return;
  }
  let saved;
  try {
    saved = setReviewers(names);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${msg}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Reviewers set to: ${saved.join(", ")}\nTakes effect on the next gate run.\n`);
}

// The four gates, keyed by event + matcher + hook file (mirror deploy-global-hooks.mjs).
// matcher === undefined means the Stop hook MUST live in a matcher-less block.
const SETUP_GATES = [
  { event: "PreToolUse", matcher: "ExitPlanMode", file: "plan-review.mjs" },
  { event: "PostToolUse", matcher: "Write|Edit", file: "plan-file-review.mjs" },
  { event: "PreToolUse", matcher: "Bash", file: "pre-push-review.mjs" },
  { event: "Stop", matcher: undefined, file: "stop-review.mjs" }
];

// Inspect a settings.json and report each gate's registration honestly.
// Unreadable/malformed/missing → "unable to check" + fail-open (no crash).
export function setupStatus(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return `Gate registration: unable to check (${settingsPath} unreadable or malformed).`;
  }
  const hooks = (settings && settings.hooks) || {};
  const lines = ["Gate registration (~/.claude/settings.json):"];
  for (const g of SETUP_GATES) {
    const blocks = Array.isArray(hooks[g.event]) ? hooks[g.event] : [];
    const has = (block) =>
      Array.isArray(block.hooks) &&
      block.hooks.some((h) => String((h && h.command) || "").includes(g.file));
    const correct = blocks.some((b) =>
      has(b) && (g.matcher === undefined ? !b.matcher : b.matcher === g.matcher));
    const elsewhere = blocks.some((b) => has(b));
    const label = g.matcher === undefined ? `${g.event}(matcher-less)` : `${g.event}/${g.matcher}`;
    let state;
    if (correct) state = "registered";
    else if (elsewhere) state = "MISREGISTERED (wrong matcher block)";
    else state = "MISSING (not registered)";
    lines.push(`  ${label} → ${g.file}: ${state}`);
  }
  return lines.join("\n");
}

// `/bench:status` — no id lists recent traces; `/bench:status <id>` expands one.
export function statusCommand(ws, rest = []) {
  const id = (rest || []).find((a) => a && !a.startsWith("-"));
  if (id) {
    const t = readTrace(ws, id);
    if (!t) {
      process.stdout.write(`Trace ${id} not found for this workspace.\n`);
      return;
    }
    const lines = [`Trace ${t.id}  gate:${t.gate}  ${t.ts || ""}`, ""];
    lines.push("Reviewers:");
    for (const r of t.reviewers || []) {
      const verdict = r.verdict || (r.error ? `err(${r.error})` : "?");
      lines.push(`  ${r.name}${r.model ? ` (${r.model})` : ""}: ${verdict}`);
    }
    if (t.systemPrompt) lines.push("", "System prompt:", t.systemPrompt);
    if (t.userPrompt) lines.push("", "User prompt:", t.userPrompt);
    const responses = Object.entries(t.rawResponses || {});
    if (responses.length) {
      lines.push("", "Responses:");
      for (const [name, body] of responses) lines.push(`═══ ${name} ═══`, body);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  const traces = listTraces(ws, 10);
  if (!traces.length) {
    process.stdout.write("No bench review traces for this workspace.\n");
    return;
  }
  for (const t of traces) {
    process.stdout.write(`${t.ts || ""}  gate:${t.gate}  ${t.id}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
