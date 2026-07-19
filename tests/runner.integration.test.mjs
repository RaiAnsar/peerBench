import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "runner-integration-root-"));

import { huntCommand, parseArgs } from "../scripts/bench-runner.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "scripts", "bench-runner.mjs");

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  return ws;
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "runner-home-"));
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/fake/stop-review.mjs"' }] }]
    }
  }));
  fs.writeFileSync(path.join(codex, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/fake/codex-stop-review.mjs"' }] }]
    }
  }));
  return home;
}

function run(args, {
  ws = freshWs(),
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-data-")),
  home = fakeHome(),
  envExtra = {}
} = {}) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const companion = path.join(dataRoot, "companion.json");
  if (!fs.existsSync(companion)) {
    // Stale names must not be resurrected by setup/config reads.
    fs.writeFileSync(companion, JSON.stringify({
      reviewers: ["codex", "kimi", "glm", "grok", "mimo"]
    }));
  }
  const output = execFileSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    cwd: ws,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      BENCH_ROOT: dataRoot,
      MIMO_API_KEY: "fake-test-key",
      ...envExtra
    }
  });
  return { output, dataRoot, home, ws };
}

test("parseArgs consumes standalone and quoted --base forms", () => {
  assert.equal(parseArgs(["--base", "main"]).flags.base, "main");
  assert.equal(parseArgs(["--base main"]).flags.base, "main");
});

test("setup reports the lightweight Grok + MiMo panel and one Claude Stop hook", () => {
  const { output } = run(["setup"]);
  assert.match(output, /Active reviewers: grok, mimo/);
  assert.match(output, /grok: local CLI \(no API key\)/i);
  assert.match(output, /mimo: key present.*mimo-v2\.5-pro/i);
  assert.match(output, /Bench disabled: no/i);
  assert.doesNotMatch(output, /Codex plugin:/i);
  assert.doesNotMatch(output, /Kimi|GLM|Qwen|MiniMax/);

  const claudeStopLines = output.split("\n").filter((line) => /→ stop-review\.mjs:/.test(line));
  assert.equal(claudeStopLines.length, 1);
  assert.match(claudeStopLines[0], /registered/i);
  assert.doesNotMatch(output, /plan-review|plan-file-review|pre-push-review|deep-review-runner/);
});

test("CLI plain off/on is workspace-local and --global is the kill switch", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-global-toggle-"));
  const home = fakeHome();
  const wsA = freshWs();
  const wsB = freshWs();

  assert.match(run(["off"], { ws: wsA, dataRoot, home }).output, /disabled.*workspace/i);
  assert.match(run(["setup"], { ws: wsA, dataRoot, home }).output, /Bench disabled: yes/i);
  assert.match(run(["setup"], { ws: wsB, dataRoot, home }).output, /Bench disabled: no/i);
  assert.match(run(["on"], { ws: wsA, dataRoot, home }).output, /enabled.*workspace/i);

  assert.match(run(["off", "--global"], { ws: wsA, dataRoot, home }).output, /disabled.*global/i);
  assert.match(run(["setup"], { ws: wsB, dataRoot, home }).output, /Bench disabled: yes/i);
  assert.match(run(["on", "--global"], { ws: wsB, dataRoot, home }).output, /enabled.*global/i);
  assert.match(run(["setup"], { ws: wsA, dataRoot, home }).output, /Bench disabled: no/i);
});

test("status reports no traces in an isolated workspace", () => {
  assert.match(run(["status"]).output, /No bench review traces/);
});

test("huntCommand formats only injected Grok + MiMo findings", async () => {
  const output = await huntCommand(freshWs(), "a monitor never alerted", {
    huntImpl: async () => [
      { name: "Grok", findings: "bug at alert.ts:10", model: "grok-build" },
      { name: "MiMo", findings: "", error: "timeout", model: "mimo-v2.5-pro" }
    ]
  });

  assert.match(output, /focus: a monitor never alerted/);
  assert.match(output, /═══ Grok ═══/);
  assert.match(output, /alert\.ts:10/);
  assert.match(output, /═══ MiMo ═══/);
  assert.match(output, /no findings — timeout/);
  assert.doesNotMatch(output, /Codex|Kimi|GLM|Qwen|MiniMax/);
});

test("investigate mode records its gate and session using fakes", async () => {
  const { listTraces, readTrace } = await import("../global-hooks/trace-store.mjs");
  const { normalizeSessionId } = await import("../global-hooks/config-store.mjs");
  const ws = freshWs();
  const output = await huntCommand(ws, "why escalation failed", {
    deep: true,
    env: { BENCH_SESSION_ID: "manual-chat-A" },
    huntImpl: async () => [
      { name: "Grok", findings: "deep finding", model: "grok-build" },
      { name: "MiMo", findings: "second finding", model: "mimo-v2.5-pro" }
    ]
  });

  assert.match(output, /Investigation — focus: why escalation failed/);
  const [latest] = listTraces(ws, 1);
  const trace = readTrace(ws, latest.id);
  assert.equal(trace.gate, "investigate");
  assert.equal(trace.sessionKey, normalizeSessionId("manual-chat-A"));
});

test("debug mode uses the debug prompt and records its gate", async () => {
  const { DEBUG_SYSTEM } = await import("../global-hooks/hunt.mjs");
  const { listTraces } = await import("../global-hooks/trace-store.mjs");
  const ws = freshWs();
  let captured;
  const output = await huntCommand(ws, "TypeError at checkout", {
    mode: "debug",
    huntImpl: async (args) => {
      captured = args;
      return [{ name: "MiMo", findings: "ROOT CAUSE: cart.js:1", model: "mimo-v2.5-pro" }];
    }
  });

  assert.equal(captured.system, DEBUG_SYSTEM);
  assert.match(captured.user, /Debug this specific failure/);
  assert.equal(captured.deep, false);
  assert.match(output, /Debug — TypeError at checkout/);
  assert.equal(listTraces(ws, 1)[0].gate, "debug");
});

test("huntCommand persists fake reviewer diagnostics", async () => {
  const { listTraces, readTrace } = await import("../global-hooks/trace-store.mjs");
  const ws = freshWs();
  await huntCommand(ws, "x", {
    huntImpl: async () => [
      { name: "Grok", findings: "x", model: "grok-build", diag: { steps: 2, filesRead: ["a.ts"], toolBytes: 100 } },
      { name: "MiMo", findings: "", error: "timeout", model: "mimo-v2.5-pro", diag: { steps: 1, lastReqBytes: 200 } }
    ]
  });

  const trace = readTrace(ws, listTraces(ws, 1)[0].id);
  assert.equal(trace.reviewers.find((reviewer) => reviewer.name === "Grok").diag.steps, 2);
  assert.equal(trace.reviewers.find((reviewer) => reviewer.name === "MiMo").diag.lastReqBytes, 200);
});
