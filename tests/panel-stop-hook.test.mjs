import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "scripts", "panel-stop-hook.mjs");
const RUNNER = path.join(ROOT, "scripts", "grok-runner.mjs");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function freshRepo({ withChange = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ph-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  if (withChange) fs.writeFileSync(path.join(ws, "changed.js"), "export const x = 1;\n");
  return ws;
}

function envFor(dataRoot, extra = {}) {
  return { ...process.env, GROK_BIN: path.join(FIXTURES, "fake-grok"), CLAUDE_PLUGIN_DATA: dataRoot, FAKE_GROK_LOG: path.join(dataRoot, "argv.log"), ...extra };
}

function runHook(input, env) {
  return execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", cwd: input.cwd, env });
}

function panelOn(ws, env) {
  execFileSync(process.execPath, [RUNNER, "panel", "on"], { encoding: "utf8", cwd: ws, env });
}

test("stop hook is an instant no-op when panelStops is off (default)", () => {
  const ws = freshRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  const out = runHook({ cwd: ws }, envFor(dataRoot));
  assert.equal(out.trim(), "");
  assert.ok(!fs.existsSync(path.join(dataRoot, "argv.log"))); // grok never invoked
});

test("stop hook reviews + ALLOWs when panelStops on, with no-tools preamble", () => {
  const ws = freshRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  const env = envFor(dataRoot);
  panelOn(ws, env);
  const out = runHook({ cwd: ws, last_assistant_message: "did some work" }, env);
  assert.match(out, /Grok stop gate: ALLOW/);
  assert.match(fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8"), /Do NOT use any tools/);
});

test("stop hook emits decision:block when grok returns BLOCK", () => {
  const ws = freshRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  const env = envFor(dataRoot, { FAKE_GROK_REPLY: JSON.stringify({ text: "BLOCK: introduced bug", stopReason: "EndTurn", sessionId: "s" }) });
  panelOn(ws, env);
  const obj = JSON.parse(runHook({ cwd: ws }, env));
  assert.equal(obj.decision, "block");
  assert.match(obj.reason, /BLOCK: introduced bug/);
});

test("stop hook no-ops on a no-change turn even when on", () => {
  const ws = freshRepo({ withChange: false });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  const env = envFor(dataRoot);
  panelOn(ws, env);
  const out = runHook({ cwd: ws }, env);
  assert.equal(out.trim(), "");
});

test("stop hook respects stop_hook_active (no re-block loop)", () => {
  const ws = freshRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
  const env = envFor(dataRoot, { FAKE_GROK_REPLY: JSON.stringify({ text: "BLOCK: x", stopReason: "EndTurn", sessionId: "s" }) });
  panelOn(ws, env);
  const out = runHook({ cwd: ws, stop_hook_active: true }, env);
  assert.equal(out.trim(), ""); // already active -> allow, no second block
});
