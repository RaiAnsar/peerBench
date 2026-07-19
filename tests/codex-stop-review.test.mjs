import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stop-root-"));

import { createCodexEmitter, runCodexStop, shouldSkipCodexStop } from "../global-hooks/codex-stop-review.mjs";
import { MAX_STOP_EVIDENCE_BYTES, STOP_TIMEOUT_MS } from "../global-hooks/stop-review.mjs";

function freshRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stop-ws-"));
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
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } }
    }),
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    "CODEX_HOME",
    "CODEX_COMPANION_SESSION_ID",
    "BENCH_SUPPRESS_HOOKS",
    "PEERBENCH_SUPPRESS_HOOKS"
  ]) delete env[key];
  return env;
}

test("Codex Stop uses the bounded lightweight contract", () => {
  assert.equal(STOP_TIMEOUT_MS, 15_000);
  assert.equal(MAX_STOP_EVIDENCE_BYTES, 64 * 1024);
});

test("shouldSkipCodexStop skips nested reviewer sessions, not direct Codex", () => {
  assert.equal(shouldSkipCodexStop({}), false);
  assert.equal(shouldSkipCodexStop({ BENCH_SUPPRESS_HOOKS: "1" }), true);
  assert.equal(shouldSkipCodexStop({ PEERBENCH_SUPPRESS_HOOKS: "true" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_COMPANION_SESSION_ID: "nested" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_HOME: "/tmp/.codex-headless" }), true);
  assert.equal(shouldSkipCodexStop({ CODEX_HOME: "/tmp/.codex" }), false);
});

test("runCodexStop no-ops before resolving reviewers when suppressed", async () => {
  const cap = captureEmitter();
  let resolved = false;
  await runCodexStop({
    input: { cwd: freshRepo(), session_id: "codex-session" },
    env: { ...process.env, BENCH_SUPPRESS_HOOKS: "1" },
    emitter: cap.emitter,
    resolveReviewersImpl: () => {
      resolved = true;
      return [];
    }
  });

  assert.equal(resolved, false);
  assert.equal(cap.stdout, "");
  assert.equal(cap.stderr, "");
});

test("runCodexStop honors the global disable before resolving reviewers", async () => {
  const cap = captureEmitter();
  let resolved = false;
  await runCodexStop({
    input: { cwd: freshRepo(), session_id: "codex-session" },
    env: cleanEnv(),
    emitter: cap.emitter,
    isBenchDisabledImpl: () => true,
    resolveReviewersImpl: () => {
      resolved = true;
      return [];
    }
  });

  assert.equal(resolved, false);
  assert.equal(cap.stdout, "");
});

test("runCodexStop selects only MiMo and passes a 15 second timeout", async () => {
  const ws = freshRepo();
  const cap = captureEmitter();
  let requestedReviewers;
  let runArgs;
  await runCodexStop({
    input: { cwd: ws, session_id: "codex-session", last_assistant_message: "changed code" },
    env: cleanEnv(),
    emitter: cap.emitter,
    resolveReviewersImpl: (options) => {
      requestedReviewers = options.reviewers;
      return [{
        name: "mimo",
        reviewIdentity: { kind: "api", model: "mimo-v2.5-pro" },
        async run(args) {
          runArgs = args;
          return {
            name: "MiMo",
            verdict: "BLOCK",
            firstLine: "BLOCK: concrete regression",
            raw: "BLOCK: concrete regression"
          };
        }
      }];
    },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });

  assert.deepEqual(requestedReviewers, ["mimo"]);
  assert.equal(runArgs.timeoutMs, 15_000);
  assert.match(runArgs.system, /using only the supplied evidence/i);
  assert.match(runArgs.system, /Do not use tools/i);

  const payload = JSON.parse(cap.stdout.trim());
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /stop advisory/i);
  assert.match(payload.systemMessage, /MiMo/);
  assert.match(payload.systemMessage, /concrete regression/);
  assert.match(payload.systemMessage, /does not block/i);
  assert.equal(cap.stderr, "");
});

test("MiMo ALLOW is silent and never emits a blocking payload", async () => {
  const cap = captureEmitter();
  await runCodexStop({
    input: { cwd: freshRepo(), session_id: "codex-session" },
    env: cleanEnv(),
    emitter: cap.emitter,
    resolveReviewersImpl: () => [{
      name: "mimo",
      reviewIdentity: { kind: "api", model: "mimo-v2.5-pro" },
      async run() {
        return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean" };
      }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });

  assert.equal(cap.stdout, "");
  assert.equal(cap.stderr, "");
});

test("MiMo failure is advisory UNREVIEWED output, never a block", async () => {
  const cap = captureEmitter();
  await runCodexStop({
    input: { cwd: freshRepo(), session_id: "codex-session" },
    env: cleanEnv(),
    emitter: cap.emitter,
    resolveReviewersImpl: () => [{
      name: "mimo",
      reviewIdentity: { kind: "api", model: "mimo-v2.5-pro" },
      async run() { return { name: "MiMo", error: "timeout" }; }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });

  const payload = JSON.parse(cap.stdout.trim());
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /UNREVIEWED/i);
  assert.match(payload.systemMessage, /turn allowed/i);
});

test("evidence above 64 KiB skips MiMo and remains advisory", async () => {
  const ws = freshRepo();
  // untrackedBlock includes at most 8 KiB per file; nine files put the supplied
  // evidence over 64 KiB without relying on a provider or a giant subprocess buffer.
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(path.join(ws, `large-${i}.txt`), `${String(i).repeat(8_000)}\n`);
  }
  const cap = captureEmitter();
  let resolved = false;
  await runCodexStop({
    input: { cwd: ws, session_id: "codex-session" },
    env: cleanEnv(),
    emitter: cap.emitter,
    resolveReviewersImpl: () => {
      resolved = true;
      return [];
    },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false
  });

  assert.equal(resolved, true, "reviewer identity is resolved for the dedupe fingerprint");
  const payload = JSON.parse(cap.stdout.trim());
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /UNREVIEWED/i);
  assert.match(payload.systemMessage, /limit 65536/i);
});
