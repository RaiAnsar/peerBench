// tests/bench-runner.test.mjs
// C3 (reviewers bad-name → stdout Error + exit 1), D2b (setup gate-registration status),
// D4 (status <id> expands a trace) for scripts/bench-runner.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate BENCH_ROOT before importing so trace/config writes never touch real data.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-root-"));

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewersCommand, setupStatus, codexSetupStatus, codexPromptStatus, statusCommand, huntCommand, gradeCommand } from "../scripts/bench-runner.mjs";
import { resolveConfig, workspaceStateDir } from "../global-hooks/config-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/bench-runner.mjs", import.meta.url));

// Build an isolated git workspace with a committed change and a config that
// selects a single reviewer (kimi) with NO api key → deterministic fail-open.
function reviewSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-review-root-"));
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi"] }));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "br-review-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: ws });
  spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "a.txt"), "v1\n");
  spawnSync("git", ["add", "-A"], { cwd: ws });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "a.txt"), "v2 changed\n");
  const env = { ...process.env, BENCH_ROOT: root };
  delete env.KIMI_API_KEY; delete env.MIMO_API_KEY; delete env.GLM_API_KEY;
  return { ws, env };
}

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "br-ws-"));
}

// Capture process.stdout.write for the duration of fn().
function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk, ...a) => { out += chunk; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

// ── C3: /bench:reviewers <bad> must surface an error to stdout + exit 1 ───────
test("C3: reviewersCommand(bogus) → stdout Error, exitCode 1, list unchanged", () => {
  const before = resolveConfig().reviewers.slice();
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = captureStdout(() => reviewersCommand(["bogusname"]));
  assert.match(out, /Error:/);
  assert.equal(process.exitCode, 1);
  const after = resolveConfig().reviewers;
  assert.deepEqual(after, before, "reviewer list must be unchanged after a bad set");
  process.exitCode = prevExit;
});

test("C3: reviewersCommand(valid) still sets without error", () => {
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = captureStdout(() => reviewersCommand(["kimi"]));
  assert.doesNotMatch(out, /Error:/);
  assert.match(out, /Reviewers set to/i);
  assert.notEqual(process.exitCode, 1);
  process.exitCode = prevExit;
});

// ── D4: /bench:status <id> expands a stored trace ────────────────────────────
test("D4: statusCommand(ws, [id]) prints the trace's reviewers + prompts", () => {
  const ws = freshWs();
  const id = writeTrace(ws, {
    gate: "review", ws,
    reviewers: [{ name: "kimi", verdict: "ALLOW" }, { name: "mimo", verdict: "BLOCK" }],
    systemPrompt: "SYS-PROMPT-MARKER",
    userPrompt: "USER-PROMPT-MARKER",
    rawResponses: { kimi: "ALLOW: looks fine", mimo: "BLOCK: nope" }
  });
  const out = captureStdout(() => statusCommand(ws, [id]));
  assert.match(out, /kimi/);
  assert.match(out, /mimo/);
  assert.match(out, /SYS-PROMPT-MARKER/);
  assert.match(out, /USER-PROMPT-MARKER/);
  assert.match(out, /ALLOW: looks fine/);
});

test("D4: statusCommand(ws, [unknownId]) → friendly not found", () => {
  const ws = freshWs();
  const out = captureStdout(() => statusCommand(ws, ["does-not-exist"]));
  assert.match(out, /not found/i);
});

test("D4: statusCommand(ws, []) lists traces (no id → list mode)", () => {
  const ws = freshWs();
  writeTrace(ws, { gate: "hunt", ws, reviewers: [{ name: "kimi", verdict: "ALLOW" }] });
  const out = captureStdout(() => statusCommand(ws, []));
  assert.match(out, /gate:hunt/);
});

// ── D2b: setup reports per-gate registration in ~/.claude/settings.json ──────
const GATES = [
  { event: "SessionStart", matcher: undefined, file: "native-session-start.mjs" },
  { event: "PreToolUse", matcher: "ExitPlanMode", file: "plan-review.mjs" },
  { event: "PostToolUse", matcher: "Write|Edit", file: "plan-file-review.mjs" },
  { event: "PreToolUse", matcher: "Bash", file: "pre-push-review.mjs" },
  { event: "Stop", matcher: undefined, file: "stop-review.mjs" },
  { event: "Stop", matcher: undefined, file: "deep-review-runner.mjs" }
];

function writeSettings(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-")), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test("D2b: setupStatus reports every automatic hook registration as missing when settings has no hooks", () => {
  const p = writeSettings({ hooks: {} });
  const out = setupStatus(p);
  for (const g of GATES) {
    assert.match(out, new RegExp(g.file), `should mention ${g.file}`);
  }
  // None registered → each should read as missing / not registered.
  assert.match(out, /missing|not registered|absent/i);
});

test("D2b: setupStatus reports a correctly-registered gate as present", () => {
  const p = writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/.claude/hooks/stop-review.mjs"' }] }]
    }
  });
  const out = setupStatus(p);
  // The stop-review line should indicate it's registered.
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /registered|present|ok|✓/i);
});

test("D2b: setupStatus reports plugin-managed hooks as registered", () => {
  const settingsPath = writeSettings({ hooks: {} });
  const pluginHooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-plugin-hooks-")), "hooks.json");
  fs.writeFileSync(pluginHooksPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/global-hooks/stop-review.mjs"' }] }]
    }
  }));
  const out = setupStatus(settingsPath, { pluginHooksPath });
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /registered \(plugin\)/i);
});

test("D2b: setupStatus flags plugin + settings duplicate hooks as active duplicates", () => {
  const settingsPath = writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/.claude/hooks/stop-review.mjs"' }] }]
    }
  });
  const pluginHooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-plugin-dupe-")), "hooks.json");
  fs.writeFileSync(pluginHooksPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/global-hooks/stop-review.mjs"' }] }]
    }
  }));
  const out = setupStatus(settingsPath, { pluginHooksPath });
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /duplicate/i);
  assert.match(stopLine, /plugin \+ settings/i);
});

test("D2b: a stop hook trapped in a matcher-scoped block reports as misregistered", () => {
  const p = writeSettings({
    hooks: {
      Stop: [{ matcher: "SomeTool", hooks: [{ type: "command", command: 'node "/x/.claude/hooks/stop-review.mjs"' }] }]
    }
  });
  const out = setupStatus(p);
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /misregistered|wrong|missing|not registered/i);
});

test("D2b: unreadable/malformed settings → 'unable to check' (no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-bad-"));
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, "{ this is not json");
  let out;
  assert.doesNotThrow(() => { out = setupStatus(p); });
  assert.match(out, /unable to check/i);
});

test("D2b: missing settings file → 'unable to check' (no crash)", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-none-")), "nope.json");
  let out;
  assert.doesNotThrow(() => { out = setupStatus(p); });
  assert.match(out, /unable to check/i);
});

test("D2b: codexSetupStatus reports the direct-Codex stop wrapper", () => {
  const p = writeSettings({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "/x/.codex/hooks/native-session-start.mjs"' }] }],
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/.codex/hooks/codex-stop-review.mjs"' }] }]
    }
  });
  const out = codexSetupStatus(p);
  const sessionLine = out.split("\n").find((line) => line.includes("native-session-start.mjs"));
  assert.match(sessionLine || "", /registered/i);
  assert.match(out, /codex-stop-review\.mjs/);
  assert.match(out, /registered/i);
});

test("D2b: codexSetupStatus reports plugin-managed direct-Codex stop wrapper", () => {
  const settingsPath = writeSettings({ hooks: {} });
  const pluginHooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-codex-plugin-hooks-")), "hooks.json");
  fs.writeFileSync(pluginHooksPath, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/global-hooks/native-session-start.mjs"' }] }],
      Stop: [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/global-hooks/codex-stop-review.mjs"' }] }]
    }
  }));
  const out = codexSetupStatus(settingsPath, { pluginHooksPath });
  const sessionLine = out.split("\n").find((line) => line.includes("native-session-start.mjs"));
  assert.match(sessionLine || "", /registered \(plugin\)/i);
  assert.match(out, /codex-stop-review\.mjs/);
  assert.match(out, /registered \(plugin\)/i);
});

test("D2b: codexSetupStatus flags plugin + settings duplicate hooks as active duplicates", () => {
  const settingsPath = writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/.codex/hooks/codex-stop-review.mjs"' }] }]
    }
  });
  const pluginHooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-codex-plugin-dupe-")), "hooks.json");
  fs.writeFileSync(pluginHooksPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/global-hooks/codex-stop-review.mjs"' }] }]
    }
  }));
  const out = codexSetupStatus(settingsPath, { pluginHooksPath });
  assert.match(out, /duplicate/i);
  assert.match(out, /plugin\/~\/\.codex\/hooks\.json/i);
});

test("D2b: codexSetupStatus flags matcher-scoped wrapper as misregistered", () => {
  const p = writeSettings({
    hooks: {
      Stop: [{ matcher: "SomeTool", hooks: [{ type: "command", command: 'node "/x/.codex/hooks/codex-stop-review.mjs"' }] }]
    }
  });
  const out = codexSetupStatus(p);
  assert.match(out, /misregistered|wrong/i);
});

test("D2b: codexPromptStatus reports installed prompt commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-codex-prompts-"));
  for (const name of [
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
  ]) {
    fs.writeFileSync(path.join(dir, name), `node "/x/scripts/bench-runner.mjs" ${name}\n`);
  }
  assert.match(codexPromptStatus(dir), /10 registered/);
  fs.writeFileSync(path.join(dir, "bench-hunt.md"), "{{BENCH_RUNNER}}\n");
  assert.match(codexPromptStatus(dir), /MISSING.*bench-hunt\.md/);
});

test("setup installs the authoritative native pre-push hook in the current workspace", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "br-setup-native-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-setup-native-home-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const env = {
    ...process.env,
    HOME: home,
    BENCH_ROOT: path.join(home, "bench-root"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude")
  };
  const result = spawnSync(process.execPath, [RUNNER, "setup"], { cwd: ws, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const hook = fs.readFileSync(path.join(ws, ".git", "hooks", "pre-push"), "utf8");
  assert.match(hook, /peerBench managed native pre-push dispatcher/);
  assert.match(result.stdout, /Git native pre-push: installed \(authoritative exact-ref gate; refreshed\)/);
});

// ── F: review output leads with the verdict badge ───────────────────────────
test("F: bench-runner review human output leads with the badge", () => {
  const { ws, env } = reviewSandbox();
  const res = spawnSync(process.execPath, [RUNNER, "review"], { cwd: ws, env, encoding: "utf8" });
  const resultLine = res.stdout.split("\n").find((l) => l.startsWith("Result:"));
  assert.ok(resultLine, `must have a Result line; got: ${res.stdout}`);
  assert.match(resultLine, /\[Kimi!\]/, `Result line should lead with the badge; got: ${resultLine}`);
});

test("F: bench-runner review --json includes the badge", () => {
  const { ws, env } = reviewSandbox();
  const res = spawnSync(process.execPath, [RUNNER, "review", "--json"], { cwd: ws, env, encoding: "utf8" });
  const obj = JSON.parse(res.stdout.trim().split("\n").pop());
  assert.equal(obj.badge, "Kimi!", `--json must include badge; got: ${JSON.stringify(obj)}`);
});

// ── Task 9 — D3: trace-write failures emit a ⛩ note and still produce output ──

test("D3: huntCommand trace-write failure emits a ⛩ note and still returns findings", async () => {
  const ws = freshWs();
  const stderrChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  let out;
  try {
    out = await huntCommand(ws, "some symptom", {
      huntImpl: async () => [{ name: "Kimi", findings: "found a bug at x:1" }],
      writeTraceImpl: () => { throw new Error("disk full"); }
    });
  } finally {
    process.stderr.write = origErr;
  }
  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  assert.match(out, /found a bug at x:1/, "must still return the findings despite the trace failure");
});

test("D3: review trace-write failure emits a ⛩ note and still allows (subprocess)", () => {
  const { ws, env } = reviewSandbox();
  // Force writeTrace to throw inside the subprocess: plant a FILE where the
  // traces/ directory should be so mkdirSync(recursive) throws EEXIST.
  const stateDir = workspaceStateDir(ws);   // computed with this process's BENCH_ROOT...
  // ...but the subprocess uses env.BENCH_ROOT (from reviewSandbox). Recompute under that root.
  const prevRoot = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = env.BENCH_ROOT;
  let subStateDir;
  try { subStateDir = workspaceStateDir(ws); } finally { process.env.BENCH_ROOT = prevRoot; }
  fs.mkdirSync(subStateDir, { recursive: true });
  fs.writeFileSync(path.join(subStateDir, "traces"), "i am a file, not a dir");

  const res = spawnSync(process.execPath, [RUNNER, "review"], { cwd: ws, env, encoding: "utf8" });
  assert.match(res.stderr, /⛩ .*trace write failed/i, `expected a ⛩ trace-write-failed note on stderr; got: ${res.stderr}`);
  const resultLine = res.stdout.split("\n").find((l) => l.startsWith("Result:"));
  assert.ok(resultLine, `review must still produce a Result line; got stdout=${res.stdout}`);
});

// ── grade subcommand: parse `<traceId> Reviewer:grade [...] --note --ws` ──────
test("gradeCommand parses pairs + note via the recordImpl seam", () => {
  const calls = [];
  const out = captureStdout(() =>
    gradeCommand(["1782-abc", "MiMo:tp", "Kimi:fp", "--note", "leaked token caught"], { recordImpl: (e) => calls.push(e) })
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => `${c.reviewer}:${c.grade}`), ["MiMo:tp", "Kimi:fp"]);
  assert.equal(calls[0].traceId, "1782-abc");
  assert.equal(calls[0].note, "leaked token caught");
  assert.match(out, /Graded 1782-abc/);
});

test("gradeCommand with no args → usage + exit 1", () => {
  const prev = process.exitCode;
  const out = captureStdout(() => gradeCommand([], { recordImpl: () => { throw new Error("should not record"); } }));
  assert.match(out, /Usage: grade/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prev;
});

test("gradeCommand surfaces a bad grade error but keeps the good ones", () => {
  const prev = process.exitCode;
  const calls = [];
  const out = captureStdout(() =>
    gradeCommand(["t1", "MiMo:tp", "Kimi:bogus"], {
      recordImpl: (e) => { if (e.grade === "bogus") throw new Error("grade must be one of tp|fp|miss"); calls.push(e); }
    })
  );
  assert.equal(calls.length, 1, "the valid grade still records");
  assert.match(out, /Error grading 'Kimi:bogus'/);
  process.exitCode = prev;
});

// ── health: live-probe plumbing (stubbed transports — no network) ──────────────
test("healthCommand probes active reviewers and fails on an active failure", async () => {
  const { healthCommand } = await import("../scripts/bench-runner.mjs");
  const cfg = {
    reviewers: ["codex", "mimo"],
    providers: { mimo: { apiKey: "k", baseURL: "https://x/v1", model: "mimo-v2.5-pro", headers: {} } }
  };
  const okFetch = async () => ({ ok: true, status: 200, text: async () => "" });
  const okCodex = () => ({ status: 0, stdout: "model: gpt-5.6-sol\nreasoning effort: xhigh\nOK", stderr: "" });
  const healthy = await healthCommand({ cfg, fetchImpl: okFetch, codexImpl: okCodex });
  assert.equal(healthy.ok, true);
  assert.match(healthy.text, /✓ Codex/);
  assert.match(healthy.text, /gpt-5\.6-sol @ xhigh/);
  assert.match(healthy.text, /✓ MiMo/);

  const failFetch = async () => ({ ok: false, status: 429, text: async () => '{"error":"overloaded"}' });
  const sick = await healthCommand({ cfg, fetchImpl: failFetch, codexImpl: okCodex });
  assert.equal(sick.ok, false, "an active API reviewer failing must fail health");
  assert.match(sick.text, /✗ MiMo.*HTTP 429/);
});

test("healthCommand --all probes keyed-but-inactive providers without failing overall health", async () => {
  const { healthCommand } = await import("../scripts/bench-runner.mjs");
  const cfg = {
    reviewers: ["mimo"],
    providers: {
      mimo: { apiKey: "k", baseURL: "https://x/v1", model: "m", headers: {} },
      qwen: { apiKey: "qk", baseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", headers: {} }
    }
  };
  const fetchImpl = async (url) => url.includes("aliyuncs")
    ? { ok: false, status: 401, text: async () => "bad key" }
    : { ok: true, status: 200, text: async () => "" };
  const r = await healthCommand({ all: true, cfg, fetchImpl, codexImpl: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.match(r.text, /✗ Qwen.*keyed.*HTTP 401/, "inactive keyed provider is probed and reported");
  assert.equal(r.ok, true, "an INACTIVE provider failing must not fail overall health");
});

test("healthCommand probes grok via the CLI (stub), reporting plan-billed health", async () => {
  const { healthCommand } = await import("../scripts/bench-runner.mjs");
  const cfg = { reviewers: ["grok"], providers: {} };
  const r = await healthCommand({ cfg, grokImpl: () => ({ status: 0, stdout: "OK", stderr: "" }) });
  assert.equal(r.ok, true);
  assert.match(r.text, /✓ Grok.*grok CLI \(plan\)/);
  const sick = await healthCommand({ cfg, grokImpl: () => ({ status: 1, stdout: "", stderr: "not logged in" }) });
  assert.equal(sick.ok, false);
  assert.match(sick.text, /✗ Grok.*not logged in/);
});

test("healthCommand redacts the submitted key and sk-* tokens from provider error bodies", async () => {
  const { healthCommand } = await import("../scripts/bench-runner.mjs");
  const cfg = {
    reviewers: ["kimi"],
    providers: { kimi: { apiKey: "kimi-secret-9f8e7d6c5b", baseURL: "https://x/v1", model: "m", headers: {} } }
  };
  // The provider reflects the submitted key back, plus an sk-*-shaped token of its own.
  const echoFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"Invalid API key: kimi-secret-9f8e7d6c5b; upstream key sk-a1b2c3d4e5f6 rejected"}'
  });
  const r = await healthCommand({ cfg, fetchImpl: echoFetch });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.text, /kimi-secret-9f8e7d6c5b/, "the configured key must not leak into health output");
  assert.doesNotMatch(r.text, /sk-a1b2c3d4e5f6/, "sk-*-shaped tokens must be masked");
  assert.match(r.text, /✗ Kimi.*HTTP 401/);
});
