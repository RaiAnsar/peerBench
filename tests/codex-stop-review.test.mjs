import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "csr-root-"));
process.env.BENCH_ROOT = TEMP_ROOT;

import { createCodexEmitter, runCodexStop, shouldSkipCodexStop } from "../global-hooks/codex-stop-review.mjs";

function freshRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "csr-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "changed.js"), "export const changed = true;\n");
  return ws;
}

function captureEmitter() {
  let stdout = "";
  let stderr = "";
  return {
    emitter: createCodexEmitter({
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } }
    }),
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

test("shouldSkipCodexStop skips nested/reviewer Codex, not direct Codex", () => {
  assert.equal(shouldSkipCodexStop({}), false);
  assert.equal(shouldSkipCodexStop({ BENCH_SUPPRESS_HOOKS: "1" }), true);
  assert.equal(shouldSkipCodexStop({ PEERBENCH_SUPPRESS_HOOKS: "true" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_COMPANION_SESSION_ID: "claude-session" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_HOME: "/Users/me/.codex-headless" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_HOME: "/Users/me/.codex" }), false);
});

test("runCodexStop no-ops when suppression is set", async () => {
  const ws = freshRepo();
  const cap = captureEmitter();
  let called = false;
  await runCodexStop({
    input: { cwd: ws, session_id: "codex-session" },
    env: { ...process.env, BENCH_SUPPRESS_HOOKS: "1" },
    emitter: cap.emitter,
    resolveReviewersImpl: () => { called = true; return []; }
  });
  assert.equal(called, false);
  assert.equal(cap.stdout, "");
  assert.equal(cap.stderr, "");
});

test("runCodexStop emits Codex block JSON and omits Codex reviewer from the panel", async () => {
  const ws = freshRepo();
  const cap = captureEmitter();
  await runCodexStop({
    input: { cwd: ws, session_id: "codex-session", last_assistant_message: "changed code" },
    env: process.env,
    emitter: cap.emitter,
    resolveReviewersImpl: () => [
      { name: "Codex", async run() { throw new Error("must not be called"); } },
      { name: "Kimi", async run({ system }) {
        assert.match(system, /Codex turn/);
        return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: real bug", raw: "BLOCK: real bug\n\nDetails" };
      } }
    ],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });
  const payload = JSON.parse(cap.stdout.trim());
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Kimi/);
  assert.match(payload.reason, /real bug/);
  assert.equal(cap.stderr, "");
});

test("runCodexStop surfaces ALLOW reviews as Stop JSON systemMessage", async () => {
  const ws = freshRepo();
  const cap = captureEmitter();
  await runCodexStop({
    input: { cwd: ws, session_id: "codex-session", last_assistant_message: "changed code" },
    env: process.env,
    emitter: cap.emitter,
    resolveReviewersImpl: () => [
      { name: "Codex", async run() { throw new Error("must not be called"); } },
      { name: "Kimi", async run() {
        return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean" };
      } }
    ],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });
  const payload = JSON.parse(cap.stdout.trim());
  assert.match(payload.systemMessage, /bench stop: ALLOW/);
  assert.match(payload.systemMessage, /Kimi/);
  assert.equal(cap.stderr, "");
});
