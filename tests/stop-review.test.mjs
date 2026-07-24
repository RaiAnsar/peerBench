import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-stop-root-"));
process.env.BENCH_ROOT = ROOT;

import {
  MAX_STOP_EVIDENCE_BYTES,
  STOP_TIMEOUT_MS,
  buildPrompt,
  readReviewedWorktree,
  runMain,
  writeReviewedWorktree
} from "../global-hooks/stop-review.mjs";
import { setBenchDisabled } from "../global-hooks/config-store.mjs";

function freshRepo({ dirty = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench-stop-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "tracked.js"), "export const value = 0;\n");
  execFileSync("git", ["add", "tracked.js"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-qm", "initial"], { cwd: ws });
  if (dirty) fs.writeFileSync(path.join(ws, "tracked.js"), "export const value = 1;\n");
  return ws;
}

function emitter() {
  const payloads = [];
  return {
    payloads,
    hasEmitted: () => payloads.length > 0,
    emit(payload) { payloads.push(payload); return true; }
  };
}

function reviewer(verdict = "ALLOW", calls = []) {
  return {
    name: "mimo",
    reviewIdentity: { kind: "api", model: "fake-mimo" },
    async run(args) {
      calls.push(args);
      return {
        name: "MiMo",
        verdict,
        firstLine: `${verdict}: fake test verdict`,
        raw: `${verdict}: fake test verdict`
      };
    }
  };
}

test("clean worktree performs no reviewer or trace work", async () => {
  const ws = freshRepo({ dirty: false });
  let resolved = false;
  let traced = false;
  const out = emitter();
  await runMain({
    input: { cwd: ws },
    emitter: out,
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => { resolved = true; return [reviewer()]; },
    writeTraceImpl: () => { traced = true; }
  });
  assert.equal(resolved, false);
  assert.equal(traced, false);
  assert.deepEqual(out.payloads, []);
});

test("an unborn repository reviews the staged first commit", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench-stop-unborn-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "first.js"), "export const first = true;\n");
  execFileSync("git", ["add", "first.js"], { cwd: ws });
  const calls = [];

  await runMain({
    input: { cwd: ws },
    emitter: emitter(),
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [reviewer("ALLOW", calls)],
    writeTraceImpl: () => {}
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /<staged_diff>[\s\S]*\+export const first = true;/);
});

test("global disable marker causes Stop to do no work", async () => {
  const ws = freshRepo();
  setBenchDisabled(ws, true, { scope: "global", root: ROOT });
  let resolved = false;
  const out = emitter();
  try {
    await runMain({
      input: { cwd: ws },
      emitter: out,
      resolveReviewersImpl: () => { resolved = true; return [reviewer()]; },
      writeTraceImpl: () => { throw new Error("trace must not run"); }
    });
  } finally {
    setBenchDisabled(ws, false, { scope: "global", root: ROOT });
  }
  assert.equal(resolved, false);
  assert.deepEqual(out.payloads, []);
});

test("Stop explicitly resolves only MiMo and passes a 15-second timeout", async () => {
  const ws = freshRepo();
  const calls = [];
  let resolverArgs;
  let trace;
  await runMain({
    input: { cwd: ws, session_id: "fake-session" },
    emitter: emitter(),
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: (args) => { resolverArgs = args; return [reviewer("ALLOW", calls)]; },
    writeTraceImpl: (_workspace, value) => { trace = value; },
    env: { MIMO_API_KEY: "fake-key" }
  });
  assert.deepEqual(resolverArgs.reviewers, ["mimo"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, STOP_TIMEOUT_MS);
  assert.equal(STOP_TIMEOUT_MS, 15_000);
  assert.equal(calls[0].cooldownScope, `stop:${fs.realpathSync(ws)}`);
  assert.equal(trace.gate, "stop");
  assert.equal(trace.reviewers[0].verdict, "ALLOW");
});

test("BLOCK is advisory, returns normally, and the identical snapshot is not reviewed again", async () => {
  const ws = freshRepo();
  const calls = [];
  const out = emitter();
  const options = {
    input: { cwd: ws, last_assistant_message: "made a change" },
    emitter: out,
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [reviewer("BLOCK", calls)],
    writeTraceImpl: () => {}
  };
  const first = await runMain(options);
  const marker = readReviewedWorktree(ws);
  const second = await runMain(options);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(calls.length, 1, "a BLOCK must still mark identical evidence as reviewed");
  assert.ok(marker);
  assert.equal(out.payloads.length, 1);
  assert.match(out.payloads[0].systemMessage, /advisory/i);
  assert.match(out.payloads[0].systemMessage, /does not block the turn/i);
});

test("changing bytes after an advisory triggers one fresh review", async () => {
  const ws = freshRepo();
  const calls = [];
  const options = {
    input: { cwd: ws },
    emitter: emitter(),
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [reviewer("BLOCK", calls)],
    writeTraceImpl: () => {}
  };
  await runMain(options);
  fs.appendFileSync(path.join(ws, "tracked.js"), "export const other = 2;\n");
  await runMain(options);
  assert.equal(calls.length, 2);
});

test("evidence above 64 KiB calls no reviewer and is deduped", async () => {
  const ws = freshRepo({ dirty: false });
  fs.writeFileSync(path.join(ws, "tracked.js"), `export const huge = "${"x".repeat(70 * 1024)}";\n`);
  let calls = 0;
  const out = emitter();
  const options = {
    input: { cwd: ws },
    emitter: out,
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [{
      name: "mimo",
      reviewIdentity: { kind: "api", model: "fake-mimo" },
      async run() { calls += 1; return { name: "MiMo", verdict: "ALLOW" }; }
    }],
    writeTraceImpl: () => {}
  };
  await runMain(options);
  await runMain(options);
  assert.equal(MAX_STOP_EVIDENCE_BYTES, 64 * 1024);
  assert.equal(calls, 0);
  assert.equal(out.payloads.length, 1);
  assert.match(out.payloads[0].systemMessage, /UNREVIEWED/);
  assert.match(out.payloads[0].systemMessage, /65536/);
});

test("missing MiMo is advisory and the snapshot is deduped", async () => {
  const ws = freshRepo();
  const out = emitter();
  let resolves = 0;
  const options = {
    input: { cwd: ws },
    emitter: out,
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => { resolves += 1; return []; },
    writeTraceImpl: () => {}
  };
  await runMain(options);
  await runMain(options);
  assert.equal(resolves, 2, "resolution happens before identity-aware dedupe when no reviewer exists");
  assert.equal(out.payloads.length, 1);
  assert.match(out.payloads[0].systemMessage, /MiMo is not configured/);
  assert.match(out.payloads[0].systemMessage, /turn allowed/);
});

test("reviewer errors fail open but leave the snapshot eligible for a later retry", async () => {
  const ws = freshRepo();
  let calls = 0;
  const out = emitter();
  const fake = {
    name: "mimo",
    reviewIdentity: { kind: "api", model: "fake-mimo" },
    async run() { calls += 1; return { name: "MiMo", error: "rate: HTTP 429", errorKind: "rate" }; }
  };
  const options = {
    input: { cwd: ws },
    emitter: out,
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [fake],
    writeTraceImpl: () => {}
  };
  await runMain(options);
  await runMain(options);
  assert.equal(calls, 2);
  assert.equal(out.payloads.length, 2);
  assert.match(out.payloads[0].systemMessage, /UNREVIEWED/);
  assert.match(out.payloads[0].systemMessage, /turn allowed/);
});

test("Stop suppresses repeated cooldown noise only until the cooldown expires", async () => {
  const ws = freshRepo();
  let calls = 0;
  const retryAfter = Date.now() + 60_000;
  const fake = {
    name: "mimo",
    reviewIdentity: { kind: "api", model: "fake-mimo" },
    async run() {
      calls += 1;
      return {
        name: "MiMo",
        error: "timed out on this run",
        errorKind: "timeout",
        cooldownUntil: retryAfter
      };
    }
  };
  const options = {
    input: { cwd: ws },
    emitter: emitter(),
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [fake],
    writeTraceImpl: () => {}
  };

  await runMain(options);
  const fingerprint = readReviewedWorktree(ws);
  await runMain({ ...options, emitter: emitter() });
  assert.equal(calls, 1, "the active cooldown marker suppresses duplicate Stop noise");

  writeReviewedWorktree(ws, fingerprint, { retryAfter: Date.now() - 1 });
  await runMain({ ...options, emitter: emitter() });
  assert.equal(calls, 2, "the unchanged snapshot is retried after the cooldown marker expires");
});

test("buildPrompt is content-only, bounded in context, and contains both diff sections", () => {
  const prompt = buildPrompt(
    " M tracked.js",
    "diff --git a/tracked.js b/tracked.js",
    "",
    "a".repeat(2_000),
    "staged diff",
    "",
    { agentName: "Claude" }
  );
  assert.match(prompt.system, /Review the uncommitted changes from this Claude turn/);
  assert.match(prompt.system, /Do not use tools/);
  assert.match(prompt.system, /ALLOW: <reason>/);
  assert.match(prompt.user, /<worktree_diff>/);
  assert.match(prompt.user, /<staged_diff>/);
  assert.ok(prompt.user.indexOf("<worktree_diff>") < prompt.user.indexOf("<assistant_context>"));
  assert.doesNotMatch(prompt.user, /a{1001}/);
});

test("trace failures are non-critical and never turn an ALLOW into a block", async () => {
  const ws = freshRepo();
  await assert.doesNotReject(runMain({
    input: { cwd: ws },
    emitter: emitter(),
    isBenchDisabledImpl: () => false,
    resolveReviewersImpl: () => [reviewer("ALLOW")],
    writeTraceImpl: () => { throw new Error("fake disk failure"); }
  }));
});
