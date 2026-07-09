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
import { resolveConfig, isBenchDisabled, setBenchDisabled, setReviewers, sessionKeyFromInput, displayName } from "../global-hooks/config-store.mjs";
import { combinePanel, untrackedBlock, grokSpawnSpec, grokText } from "../global-hooks/panel-lib.mjs";
import { resolveReviewers, latestCodexRoot } from "../global-hooks/reviewers.mjs";
import { huntPanel, HUNT_SYSTEM, buildHuntUser, DEBUG_SYSTEM, buildDebugUser } from "../global-hooks/hunt.mjs";
import { writeTrace, readTrace, listTraces } from "../global-hooks/trace-store.mjs";
import { listBlocked } from "../global-hooks/deep-queue.mjs";
import { runSpecReview, runPushReview } from "../global-hooks/spec-review-run.mjs";
import { shouldRewake } from "../global-hooks/deep-review.mjs";
import { recordGrade, computeScorecard, renderScorecard } from "../global-hooks/scorecard-store.mjs";
import { disableLegacyCodexStopGateForWorkspace, disableLegacyCodexStopGateStates, enableLegacyCodexStopGateForWorkspace, enableLegacyCodexStopGateStates } from "../global-hooks/legacy-codex-gate.mjs";

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

function readJson(pathname) {
  try { return JSON.parse(fs.readFileSync(pathname, "utf8")); }
  catch { return null; }
}

function isEntrypoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    return fileURLToPath(metaUrl) === path.resolve(argv1);
  }
}

function latestClaudeBenchPluginHooksPath({
  home = os.homedir(),
  pluginId = "bench@aiwithrai"
} = {}) {
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(installedPath);
  const entries = Array.isArray(installed?.plugins?.[pluginId]) ? installed.plugins[pluginId] : [];
  const scoped = entries.filter((entry) => entry.scope === "user" || entry.scope === "local" || entry.scope === "project");
  const latest = (scoped.length ? scoped : entries).at(-1);
  return latest?.installPath ? path.join(latest.installPath, "hooks", "hooks.json") : null;
}

function latestCodexBenchPluginHooksPath({
  home = os.homedir(),
  marketplaceName = "aiwithrai",
  pluginName = "bench"
} = {}) {
  const cacheDir = path.join(home, ".codex", "plugins", "cache", marketplaceName, pluginName);
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const pluginRoot = path.join(cacheDir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(pluginRoot).mtimeMs; } catch {}
        return { pluginRoot, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const manifest = readJson(path.join(entry.pluginRoot, ".codex-plugin", "plugin.json"));
    const hooks = manifest?.hooks;
    const hooksPath = typeof hooks === "string" && hooks.startsWith("./")
      ? path.join(entry.pluginRoot, hooks)
      : path.join(entry.pluginRoot, "hooks", "hooks.json");
    if (fs.existsSync(hooksPath)) return hooksPath;
  }
  return null;
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
    const sessionKey = sessionKeyFromInput({}, process.env);

    // `/bench:review <range>` (e.g. origin/main..staging) → DEEP, repo-aware review of a committed
    // ref-range with the REAL diff embedded — the thing /bench:hunt structurally cannot do (hunt has no
    // diff, so reviewers scrape reflog and bail). Reuses the push-review path: git log+diff → repo-aware
    // panel (reviewers may read the repo to verify) → push-review trace. Plain `/bench:review` (no range)
    // keeps the fast content-only worktree review below.
    const rangeArg = rest.find((r) => !r.startsWith("--") && /\.\.\.?/.test(r));
    if (rangeArg) {
      try {
        const result = await runPushReview(rangeArg, ws, { sessionKey });
        if (result.retry) {
          const msg = `git couldn't read range ${rangeArg} — check it (e.g. origin/main..HEAD, or fetch first).`;
          process.stdout.write(flags.json ? JSON.stringify({ range: rangeArg, error: msg }) + "\n" : `⛩ review ${rangeArg}: ${msg}\n`);
          process.exitCode = 1; return;
        }
        const blocking = shouldRewake({ maxSeverity: result.maxSeverity, findingCount: result.findingCount });
        if (flags.json) {
          process.stdout.write(JSON.stringify({ range: rangeArg, decision: blocking ? "block" : "allow", badge: result.badge, summary: result.summary, findings: result.findings, traceId: result.traceId, reviewers: result.reviewers }) + "\n");
        } else {
          const head = `⛩ review ${rangeArg} [${result.badge || "?"}] — ${result.summary}${result.traceId ? ` (trace ${result.traceId} · /bench:show ${result.traceId})` : ""}`;
          process.stdout.write(`${head}${result.findings ? `\n\n${result.findings}` : ""}\n`);
        }
        process.exitCode = blocking ? 1 : 0;
      } catch (e) {
        process.stderr.write(`⛩ review ${rangeArg}: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: ws, encoding: "utf8" }).stdout || "";
    const committed = flags.base
      ? (spawnSync("git", ["diff", `${flags.base}...HEAD`], { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES)
      : "";
    const diff = (spawnSync("git", ["diff", "HEAD"], { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES);
    const staged = diff.trim() ? "" : (spawnSync("git", ["diff", "--cached"], { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES);
    const untracked = untrackedBlock(ws);

    const system = "You are a code reviewer. Review the diff below and respond with ALLOW: <reason> or BLOCK: <reason> on the first line. BLOCK only for concrete bugs, regressions, or unsafe changes. Content-only review — no tools needed.";
    const userParts = ["GIT STATUS:\n" + status];
    if (committed) userParts.push("COMMITTED RANGE DIFF:\n" + committed);
    if (diff) userParts.push("WORKTREE DIFF:\n" + diff);
    if (staged) userParts.push("STAGED DIFF:\n" + staged);
    if (untracked) userParts.push("UNTRACKED FILES:\n" + untracked);
    const user = userParts.join("\n\n");

    const reviewers = resolveReviewers({ env: process.env });
    const results = await Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env: process.env })));
    const panel = combinePanel(results);

    try {
      writeTrace(ws, {
        gate: "review",
        ws,
        sessionKey,
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

  // `health [--all]` — LIVE-ping every active reviewer (real 1-token API call per provider, real
  // codex exec in the gate home) so "is the panel actually working" is one command, not vibes.
  // --all checks every keyed provider (active or not) — e.g. verify a new key before activating it.
  if (sub === "health") {
    const out = await healthCommand({ all: rest.includes("--all") });
    process.stdout.write(`${out.text}\n`);
    process.exitCode = out.ok ? 0 : 1;
    return;
  }

  if (sub === "setup") {
    const ws = workspaceRoot(cwd);
    const cfg = resolveConfig({ env: process.env });
    const codexFound = !!latestCodexRoot();
    const disabled = isBenchDisabled(ws);
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
    const codexHooksPath = path.join(os.homedir(), ".codex", "hooks.json");
    const codexPromptsDir = path.join(os.homedir(), ".codex", "prompts");
    // Report key status for the ACTIVE reviewers only, sourced the way the gates read them
    // (resolveConfig merges env + companion.json/.keys). Hardcoded KIMI/MIMO env checks were
    // misleading after the registry change — they named a disabled model and hid GLM/Qwen.
    const keyLines = cfg.reviewers
      .filter((name) => name !== "codex")
      .map((name) => {
        const p = cfg.providers[name];
        return `  ${name}: ${p?.apiKey ? "key present" : "key MISSING"} (model ${p?.model || "?"})`;
      });
    const lines = [
      `Active reviewers: ${cfg.reviewers.join(", ")}`,
      `Codex plugin: ${codexFound ? "found" : "not found"}`,
      ...keyLines,
      `Bench disabled: ${disabled ? "yes" : "no"}`,
      setupStatus(settingsPath, { pluginHooksPath: latestClaudeBenchPluginHooksPath() }),
      codexSetupStatus(codexHooksPath, { pluginHooksPath: latestCodexBenchPluginHooksPath() }),
      codexPromptStatus(codexPromptsDir),
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

  if (sub === "scorecard") {
    process.stdout.write(`${renderScorecard(computeScorecard())}\n`);
    return;
  }

  if (sub === "grade") {
    // Usage: grade <traceId> <Reviewer>:<tp|fp|miss> [<Reviewer>:<...> ...] [--note "..."] [--ws <ws>]
    return gradeCommand(rest);
  }

  // `show [<traceId>]` — print the full per-reviewer findings for a trace (defaults to the most recent
  // block). This is the retrieval safety net: every deep-review block message stamps its traceId, so
  // findings are always one command away instead of a manual dig through the state dir.
  if (sub === "show") {
    const ws = workspaceRoot(cwd);
    let id = rest[0];
    if (!id) {
      const b = listBlocked(ws).filter((x) => x.traceId).sort((a, c) => (Number(c.firstBlockedTs) || 0) - (Number(a.firstBlockedTs) || 0))[0];
      id = b?.traceId;
    }
    if (!id) { process.stdout.write("usage: show <traceId>  (the id is printed in the block message)\n"); process.exitCode = 1; return; }
    const t = readTrace(ws, id);
    if (!t) { process.stdout.write(`Trace ${id} not found in this workspace.\n`); process.exitCode = 1; return; }
    const head = (t.reviewers || []).map((r) => `${r.name}${r.verdict ? ":" + r.verdict : ""}${r.severity && r.severity !== "none" ? "/" + r.severity : ""}`).join(", ");
    process.stdout.write(`⛩ ${t.gate || "review"} — trace ${id}${head ? ` (${head})` : ""}\n`);
    const rr = t.rawResponses || {};
    const names = Object.keys(rr);
    if (!names.length) { process.stdout.write("(no per-reviewer findings recorded in this trace)\n"); return; }
    for (const name of names) process.stdout.write(`\n═══ ${name} ═══\n${String(rr[name]).trim()}\n`);
    return;
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
    // Manual deep spec-review. Resolves the SAME workspaceStateDir as the hook by taking --ws
    // explicitly. Prints the returned result so the manual path isn't silent.
    let filePath = null, ws = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--ws" && i + 1 < rest.length) { ws = rest[++i]; continue; }
      if (!filePath) filePath = rest[i];
    }
    if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exitCode = 1; return; }
    if (!ws) ws = workspaceRoot(path.dirname(filePath));
    try {
      const result = await runSpecReview(filePath, ws);
      const head = `⛩ spec-review [${result.badge || "?"}] — ${result.summary}${result.traceId ? ` (trace ${result.traceId})` : ""}`;
      process.stdout.write(`${head}${result.findings ? `\n\n${result.findings}` : ""}\n`);
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

  throw new Error(`Unknown subcommand: ${sub ?? "(none)"} — expected review|status|show|setup|health|reviewers|scorecard|grade|hunt|investigate|debug|spec-review|off|on`);
}

// LIVE health probe. API providers get a real 1-token chat completion (any 2xx = healthy — proves
// key + endpoint + model id + our request shape in one shot); codex gets a real `codex exec` in the
// GATE home (CODEX_HOME=~/.codex-headless) because `codex login status` lies (reports logged-in on a
// revoked refresh token — seen live). Slow-ish on purpose: honest checks only.
const HEALTH_API_TIMEOUT_MS = 30_000;
const HEALTH_CODEX_TIMEOUT_MS = 180_000;
export async function healthCommand({ all = false, env = process.env, fetchImpl, codexImpl, grokImpl, cfg: cfgOverride } = {}) {
  const cfg = cfgOverride || resolveConfig({ env });
  const doFetch = fetchImpl || globalThis.fetch;
  const names = all
    ? [...new Set([...cfg.reviewers, ...Object.keys(cfg.providers).filter((n) => cfg.providers[n]?.apiKey)])]
    : cfg.reviewers;

  const probeApi = async (name) => {
    const p = cfg.providers[name];
    if (!p?.apiKey) return { name, display: displayName(name), ok: false, note: "no api key (.keys + load-keys.mjs)" };
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), HEALTH_API_TIMEOUT_MS);
      const r = await doFetch(`${p.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}`, ...p.headers },
        body: JSON.stringify({ model: p.model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16, stream: false }),
        signal: ac.signal
      }).finally(() => clearTimeout(timer));
      const ms = Date.now() - t0;
      if (r.ok) return { name, display: displayName(name), ok: true, note: `${p.model} · ${ms}ms` };
      const body = (await r.text().catch(() => "")).slice(0, 120);
      return { name, display: displayName(name), ok: false, note: `HTTP ${r.status} in ${ms}ms — ${body}` };
    } catch (e) {
      const kind = e?.name === "AbortError" ? `timeout >${HEALTH_API_TIMEOUT_MS / 1000}s` : String(e?.message || e).slice(0, 100);
      return { name, display: displayName(name), ok: false, note: kind };
    }
  };

  const probeCodex = async () => {
    const run = codexImpl || (() => {
      const home = path.join(os.homedir(), ".codex-headless");
      return spawnSync("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "Reply with exactly: OK"], {
        env: { ...env, CODEX_HOME: home }, encoding: "utf8", timeout: HEALTH_CODEX_TIMEOUT_MS
      });
    });
    const t0 = Date.now();
    const r = run();
    const ms = Date.now() - t0;
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    const model = (out.match(/^model:\s*(\S+)/m) || [])[1];
    const effort = (out.match(/^reasoning effort:\s*(\S+)/m) || [])[1];
    // Success = it actually ANSWERED. Exit code + ERROR lines both lie: codex exec exits 0 on an API
    // 400 (ERROR line, no answer), and prints non-fatal ERROR telemetry (models_manager refresh
    // timeout) on runs that answer fine. The probe prompt demands "OK", so require it in stdout.
    const answered = /(^|\n)OK\s*(\n|$)/.test(r.stdout || "");
    if (r.status === 0 && answered) return { name: "codex", display: "Codex", ok: true, note: `${model || "?"} @ ${effort || "?"} · ${(ms / 1000).toFixed(0)}s` };
    const errLines = out.match(/ERROR.*$/gm) || [];
    const err = errLines.at(-1) || out.trim().split("\n").at(-1) || "failed";
    return { name: "codex", display: "Codex", ok: false, note: `${model ? `${model} @ ${effort} — ` : ""}${String(err).slice(0, 140)}` };
  };

  const probeGrok = async () => {
    // Same safety contract as production reviews (GROK_ARGS: plan mode, verbatim, no memory/subagents/
    // web) + suppressed hooks — a probe outside it could write to the workspace while claiming "(plan)".
    const run = grokImpl || (() => {
      // Same containment as real reviews: Seatbelt profile + a per-run private TMPDIR.
      let tmpDir = null;
      try { tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "grok-bench-"))); } catch { /* no tmp grant */ }
      const spec = grokSpawnSpec("Reply with exactly: OK", { ...(tmpDir ? { tmpDir } : {}) });
      try {
        return spawnSync(spec.cmd, spec.args, {
          env: { ...env, BENCH_SUPPRESS_HOOKS: env.BENCH_SUPPRESS_HOOKS || "1", ...(tmpDir ? { TMPDIR: tmpDir } : {}) }, encoding: "utf8", timeout: HEALTH_CODEX_TIMEOUT_MS
        });
      } finally { if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    });
    const t0 = Date.now();
    const r = run();
    const ms = Date.now() - t0;
    if (r.error?.code === "ENOENT") return { name: "grok", display: "Grok", ok: false, note: "grok CLI not found (curl -fsSL https://x.ai/cli/install.sh | bash)" };
    if (r.status === 0 && /OK/.test(grokText(r.stdout))) return { name: "grok", display: "Grok", ok: true, note: `grok CLI (plan) · ${(ms / 1000).toFixed(1)}s` };
    return { name: "grok", display: "Grok", ok: false, note: `${(r.stderr || r.stdout || "failed").trim().slice(0, 140)}` };
  };

  const results = await Promise.all(names.map((n) => (n === "codex" ? probeCodex() : n === "grok" ? probeGrok() : probeApi(n))));
  const active = new Set(cfg.reviewers);
  const lines = results.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.display.padEnd(8)} ${active.has(r.name) ? "active " : "keyed  "} ${r.note}`);
  const ok = results.filter((r) => active.has(r.name)).every((r) => r.ok);
  return {
    ok,
    results,
    text: `⛩ bench health — live probes (${all ? "all keyed" : "active panel"}):\n${lines.join("\n")}\n${ok ? "All active reviewers healthy." : "ACTIVE reviewer failing — the panel will skip/fail-open on it."}`
  };
}

const HUNT_MODES = {
  hunt:        { deep: false, system: HUNT_SYSTEM,  buildUser: buildHuntUser,  header: (s) => s ? `Bug hunt — focus: ${s}` : "Bug hunt — broad sweep" },
  investigate: { deep: true,  system: HUNT_SYSTEM,  buildUser: buildHuntUser,  header: (s) => s ? `Investigation — focus: ${s}` : "Investigation — broad sweep" },
  debug:       { deep: false, system: DEBUG_SYSTEM, buildUser: buildDebugUser, header: (s) => `Debug — ${s || "(no failure described)"}` },
};
export async function huntCommand(cwd, seed, { huntImpl = huntPanel, writeTraceImpl = writeTrace, deep = false, mode, env = process.env } = {}) {
  const key = mode || (deep ? "investigate" : "hunt");           // back-compat: deep:true → investigate
  const m = HUNT_MODES[key] || HUNT_MODES.hunt;
  const sessionKey = sessionKeyFromInput({}, env);
  const results = await huntImpl({ cwd, seed, deep: m.deep, system: m.system, user: m.buildUser(seed), env });
  // record a trace so `/bench:status <id>` can show the full findings later
  let traceId = null;
  try {
    traceId = writeTraceImpl(cwd, {
      gate: key, ws: cwd,
      sessionKey,
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

export function gateToggleCommand(ws, args, {
  root,
  env = process.env,
  disableLegacyCodexWorkspaceImpl = disableLegacyCodexStopGateForWorkspace,
  disableLegacyCodexGlobalImpl = disableLegacyCodexStopGateStates,
  enableLegacyCodexWorkspaceImpl = enableLegacyCodexStopGateForWorkspace,
  enableLegacyCodexGlobalImpl = enableLegacyCodexStopGateStates
} = {}) {
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
  // By DEFAULT peerBench COEXISTS with the Codex stop gate — both review every turn (Codex is A-grade;
  // silently killing it on bench:on was a real downgrade). Only explicit single-gate mode
  // (BENCH_SINGLE_GATE=1) makes peerBench the sole reviewer by disabling the Codex gate.
  const singleGate = env.BENCH_SINGLE_GATE === "1" || env.BENCH_SINGLE_GATE === "true";
  let legacyNote;
  if (singleGate) {
    const legacy = scope === "global"
      ? disableLegacyCodexGlobalImpl()
      : disableLegacyCodexWorkspaceImpl(ws);
    const legacyChanged = typeof legacy?.changed === "number" ? legacy.changed > 0 : Boolean(legacy?.changed);
    legacyNote = legacyChanged ? " Legacy Codex gate disabled." : "";
  } else {
    // Keep-both must actively RESTORE a gate that single-gate mode (or the pre-fix disable) turned
    // off — merely skipping the disable left such workspaces silently Codex-less (caught by Grok).
    const restored = scope === "global"
      ? enableLegacyCodexGlobalImpl()
      : enableLegacyCodexWorkspaceImpl(ws);
    const n = typeof restored?.changed === "number" ? restored.changed : (restored?.changed ? 1 : 0);
    legacyNote = n > 0
      ? ` Codex gate RESTORED (${n} workspace${n === 1 ? "" : "s"}) — runs alongside peerBench.`
      : " Codex gate kept — runs alongside peerBench.";
  }
  if (!stillDisabled) return `bench: enabled (${scope}).${legacyNote}`;
  // The cleared scope didn't fully re-enable — name the remaining source honestly.
  if (scope === "workspace") {
    return `bench: workspace re-enabled, but STILL DISABLED GLOBALLY — run /bench:on --global to fully re-enable.${legacyNote}`;
  }
  return `bench: global re-enabled, but STILL DISABLED in this WORKSPACE — run /bench:on to fully re-enable.${legacyNote}`;
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

// `bench grade <traceId> <Reviewer>:<tp|fp|miss> [...] [--note "..."] [--ws <ws>]`
// Claude calls this after VERIFYING a panel's findings (the judgment layer). Cross-project:
// it writes to the shared scorecard regardless of which repo it's invoked from.
export function gradeCommand(args, { recordImpl = recordGrade } = {}) {
  let note = "", ws = null;
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--note" && i + 1 < args.length) { note = args[++i]; continue; }
    if (args[i] === "--ws" && i + 1 < args.length) { ws = args[++i]; continue; }
    positionals.push(args[i]);
  }
  const traceId = positionals.shift();
  const pairs = positionals.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  if (!traceId || !pairs.length) {
    process.stdout.write("Usage: grade <traceId> <Reviewer>:<tp|fp|miss> [...] [--note \"why\"] [--ws <ws>]\n");
    process.exitCode = 1;
    return;
  }
  const recorded = [];
  for (const pair of pairs) {
    const i = pair.lastIndexOf(":");
    if (i < 0) { process.stdout.write(`Skipped '${pair}' (expected Reviewer:grade)\n`); continue; }
    const reviewer = pair.slice(0, i), grade = pair.slice(i + 1);
    try {
      recordImpl({ traceId, reviewer, grade, note, ws });
      recorded.push(`${reviewer}:${grade}`);
    } catch (err) {
      process.stdout.write(`Error grading '${pair}': ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }
  if (recorded.length) process.stdout.write(`Graded ${traceId}: ${recorded.join(", ")}${note ? ` — ${note}` : ""}\n`);
}

// The four gates, keyed by event + matcher + hook file (mirror deploy-global-hooks.mjs).
// matcher === undefined means the Stop hook MUST live in a matcher-less block.
const SETUP_GATES = [
  { event: "PreToolUse", matcher: "ExitPlanMode", file: "plan-review.mjs" },
  { event: "PostToolUse", matcher: "Write|Edit", file: "plan-file-review.mjs" },
  { event: "PreToolUse", matcher: "Bash", file: "pre-push-review.mjs" },
  { event: "Stop", matcher: undefined, file: "stop-review.mjs" },
  { event: "Stop", matcher: undefined, file: "deep-review-runner.mjs" }
];

const CODEX_PROMPTS = [
  "bench-debug.md",
  "bench-hunt.md",
  "bench-investigate.md",
  "bench-off.md",
  "bench-on.md",
  "bench-review.md",
  "bench-reviewers.md",
  "bench-scorecard.md",
  "bench-setup.md",
  "bench-status.md"
];

// Inspect a settings.json and report each gate's registration honestly.
// Unreadable/malformed/missing → "unable to check" + fail-open (no crash).
export function setupStatus(settingsPath, { pluginHooksPath = null } = {}) {
  const settings = readJson(settingsPath);
  const pluginSettings = pluginHooksPath ? readJson(pluginHooksPath) : null;
  if (!settings && !pluginSettings) {
    return `Gate registration: unable to check (${settingsPath} unreadable or malformed; no installed bench@aiwithrai hooks found).`;
  }
  const hooks = settings?.hooks || {};
  const pluginHooks = pluginSettings?.hooks || {};
  const lines = ["Gate registration (Claude plugin/settings):"];
  for (const g of SETUP_GATES) {
    const settingsBlocks = Array.isArray(hooks[g.event]) ? hooks[g.event] : [];
    const pluginBlocks = Array.isArray(pluginHooks[g.event]) ? pluginHooks[g.event] : [];
    const has = (block) =>
      Array.isArray(block.hooks) &&
      block.hooks.some((h) => String((h && h.command) || "").includes(g.file));
    const correctSettings = settingsBlocks.some((b) =>
      has(b) && (g.matcher === undefined ? !b.matcher : b.matcher === g.matcher));
    const correctPlugin = pluginBlocks.some((b) =>
      has(b) && (g.matcher === undefined ? !b.matcher : b.matcher === g.matcher));
    const elsewhere = [...settingsBlocks, ...pluginBlocks].some((b) => has(b));
    const label = g.matcher === undefined ? `${g.event}(matcher-less)` : `${g.event}/${g.matcher}`;
    let state;
    if (correctPlugin && correctSettings) state = "DUPLICATE (plugin + settings both active)";
    else if (correctPlugin) state = "registered (plugin)";
    else if (correctSettings) state = "registered (settings)";
    else if (elsewhere) state = "MISREGISTERED (wrong matcher block)";
    else state = "MISSING (not registered)";
    lines.push(`  ${label} → ${g.file}: ${state}`);
  }
  return lines.join("\n");
}

export function codexSetupStatus(hooksPath, { pluginHooksPath = null } = {}) {
  const settings = readJson(hooksPath);
  const pluginSettings = pluginHooksPath ? readJson(pluginHooksPath) : null;
  if (!settings && !pluginSettings) {
    return `Codex gate registration: unable to check (${hooksPath} unreadable or malformed; no installed bench@aiwithrai Codex hooks found).`;
  }
  const settingsBlocks = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : [];
  const pluginBlocks = Array.isArray(pluginSettings?.hooks?.Stop) ? pluginSettings.hooks.Stop : [];
  const has = (block) =>
    Array.isArray(block.hooks) &&
    block.hooks.some((h) => String((h && h.command) || "").includes("codex-stop-review.mjs"));
  const correctSettings = settingsBlocks.some((b) => has(b) && !b.matcher);
  const correctPlugin = pluginBlocks.some((b) => has(b) && !b.matcher);
  const elsewhere = [...settingsBlocks, ...pluginBlocks].some((b) => has(b));
  let state;
  if (correctPlugin && correctSettings) state = "DUPLICATE (plugin + settings both active)";
  else if (correctPlugin) state = "registered (plugin)";
  else if (correctSettings) state = "registered (settings)";
  else if (elsewhere) state = "MISREGISTERED (wrong matcher block)";
  else state = "MISSING (not registered)";
  return `Codex gate registration (plugin/~/.codex/hooks.json): Stop(matcher-less) → codex-stop-review.mjs: ${state}`;
}

export function codexPromptStatus(promptsDir) {
  const missing = [];
  for (const f of CODEX_PROMPTS) {
    try {
      const text = fs.readFileSync(path.join(promptsDir, f), "utf8");
      if (!text.includes("bench-runner.mjs") || text.includes("{{BENCH_RUNNER}}")) missing.push(f);
    } catch {
      missing.push(f);
    }
  }
  if (!missing.length) {
    return `Codex manual prompts (~/.codex/prompts): ${CODEX_PROMPTS.length} registered (/prompts:bench-hunt, /prompts:bench-investigate, /prompts:bench-on, ...)`;
  }
  return `Codex manual prompts (~/.codex/prompts): MISSING ${missing.join(", ")}`;
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

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
