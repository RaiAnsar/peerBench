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

import { reviewersCommand, setupStatus, statusCommand } from "../scripts/bench-runner.mjs";
import { resolveConfig } from "../global-hooks/config-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

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
  { event: "PreToolUse", matcher: "ExitPlanMode", file: "plan-review.mjs" },
  { event: "PostToolUse", matcher: "Write|Edit", file: "plan-file-review.mjs" },
  { event: "PreToolUse", matcher: "Bash", file: "pre-push-review.mjs" },
  { event: "Stop", matcher: undefined, file: "stop-review.mjs" }
];

function writeSettings(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-")), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test("D2b: setupStatus reports all four gates as missing when settings has no hooks", () => {
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
