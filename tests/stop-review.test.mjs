// tests/stop-review.test.mjs
// Tests for global-hooks/stop-review.mjs.
// All reviewer calls are injected so NO real API or Codex call happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set BENCH_ROOT before importing any module that uses config-store.
const TEMP_GCR = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-"));
process.env.BENCH_ROOT = TEMP_GCR;

import { runMain, buildPrompt, resolveReviewBase, readReviewedHead, writeReviewedHead, readReviewedWorktree, captureGitSnapshot, reviewPromptChunks, acquireStopGateLock } from "../global-hooks/stop-review.mjs";
import { normalizeSessionId, setBenchDisabled, workspaceStateDir, wsKey } from "../global-hooks/config-store.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "global-hooks", "stop-review.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp git repo. withChange=true writes an untracked file so the
 *  diff/untracked check sees a change and does not early-return. */
function freshRepo({ withChange = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sr-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  if (withChange) {
    fs.writeFileSync(path.join(ws, "changed.js"), "export const x = 1;\n");
  }
  return ws;
}

/** Build a fake reviewer that always returns the given verdict. */
function fakeReviewer(name, verdict, firstLine) {
  return {
    name,
    async run() {
      return { name, verdict, firstLine: firstLine ?? `${verdict}: test`, raw: `${verdict}: test` };
    }
  };
}

/** Build a fake reviewer that always returns an error (simulates API failure). */
function fakeErrorReviewer(name) {
  return {
    name,
    async run() {
      return { name, error: "injected test error" };
    }
  };
}

/** Fake resolveReviewers factory that returns the given list of reviewer stubs. */
function stubResolveReviewers(reviewerList) {
  return () => reviewerList;
}

/** Capture stdout lines written by emit() in runMain. */
function captureEmit(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string") lines.push(chunk);
    return orig(chunk, ...rest);
  };
  const restore = () => { process.stdout.write = orig; };
  return { lines, restore };
}

// ---------------------------------------------------------------------------
// Test: no diff → no-op (exit 0, no trace written)
// ---------------------------------------------------------------------------

test("no diff → runMain returns early without trace or emit", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-nd-"));
  process.env.BENCH_ROOT = root;

  let traceWritten = false;
  const writeTraceImpl = () => { traceWritten = true; };
  let reviewersCalled = false;
  const resolveReviewersImpl = () => {
    reviewersCalled = true;
    return [fakeReviewer("Kimi", "ALLOW")];
  };

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl,
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(reviewersCalled, false, "reviewers should NOT be called on a no-diff turn");
  assert.equal(traceWritten, false, "no trace should be written on a no-diff turn");
  assert.equal(lines.length, 0, "no output should be emitted on a no-diff turn");
});

// ---------------------------------------------------------------------------
// Test: reviews regardless of the SHARED stop_hook_active flag (must not be
// starved when another Stop hook — e.g. the codex gate — is looping).
// ---------------------------------------------------------------------------

test("reviews even when stop_hook_active=true (decoupled from the shared Stop flag)", async () => {
  const ws = freshRepo({ withChange: true });
  let called = false;
  const resolveReviewersImpl = () => { called = true; return [fakeReviewer("Kimi", "ALLOW")]; };

  await runMain({
    resolveReviewersImpl,
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, stop_hook_active: true }
  });

  assert.equal(called, true, "must review even when stop_hook_active is set — the shared flag must not starve this gate");
});

// ---------------------------------------------------------------------------
// Test: own same-snapshot block cap → allows after 3, but changed code resets it
// ---------------------------------------------------------------------------

test("caps its own unchanged snapshot at 3 automatic block cycles", async () => {
  const ws = freshRepo({ withChange: true });
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: same bug", raw: "BLOCK: same bug" }; } };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, stop_hook_active: false },
    blockHandler: async () => {}
  };

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    await runMain(opts);
    await runMain(opts);
    await runMain(opts);   // same fourth snapshot is allowed without another reviewer call
    await runMain(opts);   // exhausted marker persists; fifth+ Stops never restart the panel
    await runMain(opts);
  } finally { restore(); }

  assert.equal(calls, 3, "the hard ceiling is exactly three reviewer blocks for one unchanged snapshot");
  assert.match(lines.join(""), /automatic review ceiling reached after 3 blocked repair cycles/, "the fourth Stop explains the anti-loop pause");
});

test("unresolved coverage wakes at most 3 times, then remains a persistent UNREVIEWED advisory", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-coverage-loop-"));
  process.env.BENCH_ROOT = root;
  const big = path.join(ws, "oversized.js");
  fs.writeFileSync(big, "export const base = 1;\n");
  gitC(ws, "add", "oversized.js");
  gitC(ws, "commit", "-qm", "add oversized fixture");
  const oversized = Array.from({ length: 18_000 }, (_, i) => `export const value${i} = ${i};\n`).join("");
  fs.writeFileSync(big, oversized);

  let reviewerResolutions = 0;
  let coverageBlocks = 0;
  const emitted = [];
  const opts = {
    resolveReviewersImpl: () => {
      reviewerResolutions += 1;
      throw new Error("coverage failures must not depend on reviewer resolution");
    },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, session_id: "coverage-loop" },
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    blockHandler: async ({ panel }) => {
      coverageBlocks += 1;
      assert.equal(panel.decision, "block");
      assert.match(panel.findings, /bounded review limit/);
    }
  };

  let reviewedHeadBeforeReset = "unset";
  let reviewedWorktreeBeforeReset = "unset";
  try {
    for (let attempt = 0; attempt < 5; attempt++) await runMain(opts);
    reviewedHeadBeforeReset = readReviewedHead(ws);
    reviewedWorktreeBeforeReset = readReviewedWorktree(ws, "coverage-loop");

    // A real snapshot transition clears the persistent coverage ceiling. Restoring the exact old
    // oversized bytes is then a fresh unreviewed edit and must wake again, not inherit the advisory.
    fs.writeFileSync(big, "export const base = 1;\n");
    await runMain(opts);
    fs.writeFileSync(big, oversized);
    await runMain(opts);
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(reviewerResolutions, 0, "incomplete evidence is handled before panel resolution and never mislabeled as a model review");
  assert.equal(coverageBlocks, 4, "three wakes occur, then a changed-away-and-restored snapshot gets one fresh wake");
  assert.equal(emitted.length, 2, "later unchanged Stops use a non-waking persistent advisory");
  for (const payload of emitted) assert.match(payload.systemMessage, /UNREVIEWED \/ coverage incomplete/);
  assert.equal(reviewedHeadBeforeReset, null, "the advisory never advances reviewed-head for unreviewed work");
  assert.equal(reviewedWorktreeBeforeReset, null, "the advisory never writes a reviewed-worktree marker");
});

test("three blocked revisions cap automatic review even when every repair changes the snapshot", async () => {
  const ws = freshRepo({ withChange: true });
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }; } };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws },
    blockHandler: async () => {}
  };

  await runMain(opts);
  await runMain(opts);
  await runMain(opts);
  fs.appendFileSync(path.join(ws, "changed.js"), "export const fixed = 2;\n");
  const emitted = [];
  await runMain({ ...opts, emitter: { emit(payload) { emitted.push(payload); return true; } } });

  assert.equal(calls, 3, "changed revisions do not reset the hard task/session cycle ceiling");
  assert.match(emitted[0]?.systemMessage || "", /automatic review ceiling reached after 3 blocked repair cycles/);
});

test("BENCH_STOP_CYCLE_RESET explicitly starts a fresh review cycle", async () => {
  const ws = freshRepo({ withChange: true });
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }; } };
  const common = {
    resolveReviewersImpl: () => [reviewer], writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    input: { cwd: ws, session_id: "reset-test" }, blockHandler: async () => {}
  };
  await runMain({ ...common, env: process.env });
  fs.appendFileSync(path.join(ws, "changed.js"), "// repair 1\n");
  await runMain({ ...common, env: process.env });
  fs.appendFileSync(path.join(ws, "changed.js"), "// repair 2\n");
  await runMain({ ...common, env: process.env });
  fs.appendFileSync(path.join(ws, "changed.js"), "// repair 3\n");
  await runMain({ ...common, env: { ...process.env, BENCH_STOP_CYCLE_RESET: "1" } });
  assert.equal(calls, 4, "the explicit one-shot reset permits a fresh automatic review");
});

test("an exported BENCH_STOP_CYCLE_RESET nonce cannot disable the three-cycle ceiling", async () => {
  const ws = freshRepo({ withChange: true });
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }; } };
  const common = {
    resolveReviewersImpl: () => [reviewer], writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    input: { cwd: ws, session_id: "persistent-reset-test" }, blockHandler: async () => {},
    env: { ...process.env, BENCH_STOP_CYCLE_RESET: "persistent-a" }
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    fs.appendFileSync(path.join(ws, "changed.js"), `// persistent repair ${attempt}\n`);
    await runMain(common);
  }
  assert.equal(calls, 3, "the same inherited nonce resets once, then the hard ceiling applies");

  const changedNonce = { ...common, env: { ...process.env, BENCH_STOP_CYCLE_RESET: "persistent-b" } };
  fs.appendFileSync(path.join(ws, "changed.js"), "// explicitly reopen once\n");
  await runMain(changedNonce);
  assert.equal(calls, 4, "changing the nonce explicitly starts one fresh bounded cycle");
});

test("a clean transition resets the streak even if the exact old bytes are later restored", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-loop-clean-reset-"));
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }; } };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws },
    blockHandler: async () => {}
  };

  try {
    await runMain(opts);
    await runMain(opts);
    await runMain(opts);
    fs.unlinkSync(path.join(ws, "changed.js"));
    await runMain(opts);   // clean no-op observes and resets the old streak
    fs.writeFileSync(path.join(ws, "changed.js"), "export const x = 1;\n");
    await runMain(opts);
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 4, "restoring old bytes after a clean state is reviewed as a fresh edit cycle");
});

test("same-project stop-loop cap is session-scoped", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-session-loop-"));
  process.env.BENCH_ROOT = root;
  let callsB = 0;
  let callsA = 0;
  const blockerA = { name: "Kimi", async run() { callsA += 1; return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }; } };
  const { restore } = captureEmit(() => {});
  try {
    const optsA = {
      resolveReviewersImpl: () => [blockerA],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, session_id: "chat-A" },
      blockHandler: async () => {}
    };
    await runMain(optsA);
    await runMain(optsA);
    await runMain(optsA);
    await runMain({
      resolveReviewersImpl: () => [{ ...fakeReviewer("Kimi", "ALLOW"), async run() { callsB += 1; return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }; } }],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, session_id: "chat-B" }
    });
    await runMain(optsA);   // chat A is capped; chat B's review did not clear A's loop state
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(callsB, 1, "chat B must not inherit chat A's exhausted stop-loop counter");
  assert.equal(callsA, 3, "chat A still honors its own exhausted stop-loop counter");
});

test("six parallel same-session BLOCK hooks deliver exactly three wakes", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-parallel-blocks-"));
  process.env.BENCH_ROOT = root;
  let reviewerCalls = 0;
  let deliveredWakes = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      reviewerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: concurrent bug", raw: "BLOCK: concurrent bug" };
    }
  };
  const common = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, session_id: "parallel-blocks" },
    emitter: { emit() { return true; } },
    blockHandler: async () => { deliveredWakes += 1; }
  };

  try {
    await Promise.all(Array.from({ length: 6 }, () => runMain(common)));
    const marker = JSON.parse(fs.readFileSync(
      path.join(workspaceStateDir(ws), `stop-loop.${normalizeSessionId("parallel-blocks")}`),
      "utf8"
    ));
    assert.equal(marker.count, 3, "the durable counter and delivered wake count stay identical");
    assert.equal(fs.existsSync(path.join(workspaceStateDir(ws), "stop-review.lock")), false, "the transaction lock is released");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(reviewerCalls, 3, "only three BLOCK reviews are admitted across parallel processes");
  assert.equal(deliveredWakes, 3, "the hard ceiling applies to delivered wakes, not racy file writes");
});

test("six parallel Stop processes also exit 2 exactly three times", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-parallel-processes-"));
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-parallel-processes-"));
  const wrapper = path.join(wrapperDir, "block.mjs");
  fs.writeFileSync(wrapper, `
import { runMain } from ${JSON.stringify(path.join(ROOT, "global-hooks", "stop-review.mjs"))};
await runMain({
  resolveReviewersImpl: () => [{
    name: "Kimi",
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: process bug", raw: "BLOCK: process bug" };
    }
  }],
  writeTraceImpl: () => {},
  isBenchDisabledImpl: () => false,
  env: process.env,
  input: { cwd: ${JSON.stringify(ws)}, session_id: "parallel-processes" }
});
`);
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper], {
      env: { ...process.env, BENCH_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  const results = await Promise.all(Array.from({ length: 6 }, runChild));
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 0, 0, 2, 2, 2]);
  for (const result of results.filter((entry) => entry.status === 2)) assert.match(result.stderr, /process bug/);
  const marker = JSON.parse(fs.readFileSync(
    path.join(root, "state", wsKey(ws), `stop-loop.${normalizeSessionId("parallel-processes")}`),
    "utf8"
  ));
  assert.equal(marker.count, 3);
});

test("a concurrent BLOCK invalidates an earlier delayed ALLOW and cannot be de-duplicated away", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-allow-block-race-"));
  process.env.BENCH_ROOT = root;
  let releaseAllow;
  let announceAllow;
  const allowRelease = new Promise((resolve) => { releaseAllow = resolve; });
  const allowEntered = new Promise((resolve) => { announceAllow = resolve; });
  let blockCalls = 0;
  let followupCalls = 0;
  let followupMustSkip = false;
  const followupReviewer = {
    name: "Kimi",
    async run() {
      if (followupMustSkip) throw new Error("exact follow-up ALLOW should de-duplicate");
      followupCalls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: fixed", raw: "ALLOW: fixed" };
    }
  };
  const common = {
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, session_id: "allow-block-race" },
    emitter: { emit() { return true; } }
  };

  try {
    const delayedAllow = runMain({
      ...common,
      resolveReviewersImpl: () => [{
        name: "Kimi",
        async run() {
          announceAllow();
          await allowRelease;
          return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: stale", raw: "ALLOW: stale" };
        }
      }]
    });
    await allowEntered;
    const concurrentBlock = runMain({
      ...common,
      resolveReviewersImpl: () => [{
        name: "Kimi",
        async run() {
          blockCalls += 1;
          return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: authoritative", raw: "BLOCK: authoritative" };
        }
      }],
      blockHandler: async () => {}
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(blockCalls, 0, "the second snapshot cannot review or commit while the first transaction is open");
    releaseAllow();
    await Promise.all([delayedAllow, concurrentBlock]);

    assert.equal(blockCalls, 1);
    assert.equal(readReviewedWorktree(ws, "allow-block-race"), null, "BLOCK invalidates the exact ALLOW marker");

    await runMain({
      ...common,
      resolveReviewersImpl: () => [followupReviewer]
    });
    followupMustSkip = true;
    await runMain({
      ...common,
      resolveReviewersImpl: () => [followupReviewer]
    });
  } finally {
    releaseAllow?.();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(followupCalls, 1, "the unresolved BLOCK forces one later review before an exact ALLOW can be cached");
});

test("Stop transaction lock reclaims dead and stale owners", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-lock-recovery-"));
  process.env.BENCH_ROOT = root;
  const lockDir = path.join(workspaceStateDir(ws), "stop-review.lock");
  const makeLock = (owner) => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`);
  };

  try {
    makeLock({ schema: 1, pid: 99_999_999, token: "dead-owner", startedAt: Date.now(), heartbeatAt: Date.now() });
    const releaseDead = await acquireStopGateLock(ws, { pollMs: 1 });
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).token, "dead-owner");
    releaseDead();

    makeLock({ schema: 1, pid: process.pid, token: "stale-owner", startedAt: 100, heartbeatAt: 100 });
    const releaseStale = await acquireStopGateLock(ws, { staleMs: 10, pollMs: 1, now: () => 1_000 });
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).token, "stale-owner");
    releaseStale();
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("a mid-acquire orphan reclaim never yields two holders of the same gate", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-lock-toctou-"));
  process.env.BENCH_ROOT = root;
  const lockDir = path.join(workspaceStateDir(ws), "stop-review.lock");
  const instanceOf = (dir) => {
    const st = fs.statSync(dir);
    return `${st.ino}:${st.birthtimeMs}`;
  };
  const createdByAcquirer = new Set();
  const origMkdir = fs.mkdirSync;
  const origWrite = fs.writeFileSync;
  let reclaimed = false;
  let simulating = false;
  fs.mkdirSync = (target, options) => {
    const result = origMkdir.call(fs, target, options);
    if (!simulating && String(target) === lockDir) createdByAcquirer.add(instanceOf(lockDir));
    return result;
  };
  fs.writeFileSync = (file, ...args) => {
    if (!reclaimed && !simulating && String(file).startsWith(`${lockDir}${path.sep}`)) {
      // The acquirer stalled past the orphan grace between its mkdir and this first owner write
      // (SIGSTOP/laptop sleep): a waiter reclaims the ownerless dir and republishes its own lock
      // at the same path before the stalled write lands.
      reclaimed = true;
      simulating = true;
      try {
        const quarantine = `${lockDir}.reclaim-sim`;
        fs.renameSync(lockDir, quarantine);
        fs.rmSync(quarantine, { recursive: true, force: true });
        fs.mkdirSync(lockDir, { mode: 0o700 });
        origWrite.call(fs, path.join(lockDir, "owner.json"),
          `${JSON.stringify({ schema: 1, pid: 99_999_999, token: "waiter", startedAt: Date.now(), heartbeatAt: Date.now() })}\n`);
      } finally {
        simulating = false;
      }
    }
    return origWrite.call(fs, file, ...args);
  };

  try {
    const release = await acquireStopGateLock(ws, { pollMs: 1 });
    assert.equal(reclaimed, true, "the simulated orphan reclaim actually fired mid-acquire");
    const heldInstance = instanceOf(lockDir);
    release();
    assert.ok(
      createdByAcquirer.has(heldInstance),
      "the resolved acquisition must hold a lock dir it created, never the reclaimed-and-republished one"
    );
  } finally {
    fs.mkdirSync = origMkdir;
    fs.writeFileSync = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

// ---------------------------------------------------------------------------
// Test: disabled workspace → no-op (exit 0)
// ---------------------------------------------------------------------------

test("disabled workspace → runMain exits 0 without calling reviewers", async () => {
  const ws = freshRepo({ withChange: true });

  // setBenchDisabled for workspace scope writes to workspaceStateDir(ws) which
  // uses sharedRoot() → BENCH_ROOT env. We write with TEMP_GCR active
  // (it was set at module load time) so the subprocess must also see TEMP_GCR.
  setBenchDisabled(ws, true, { scope: "workspace" });

  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: ws }),
      encoding: "utf8",
      env: { ...process.env, BENCH_ROOT: TEMP_GCR }
    });

    assert.equal(result.status, 0, "exit code should be 0 when bench is disabled");
    assert.equal(result.stdout.trim(), "", "no output expected when bench disabled");
    assert.equal(result.stderr.trim(), "", "no stderr expected when bench disabled");
  } finally {
    // Re-enable so this ws doesn't affect other tests sharing TEMP_GCR.
    setBenchDisabled(ws, false, { scope: "workspace" });
  }
});

// ---------------------------------------------------------------------------
// Test: all ALLOW → systemMessage emitted, exit 0, trace with gate:"stop"
// ---------------------------------------------------------------------------

test("all ALLOW → systemMessage with ALLOW, trace gate=stop, exit 0", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-al-"));
  process.env.BENCH_ROOT = root;

  let traceRecord = null;
  const writeTraceImpl = (_ws, trace) => { traceRecord = trace; };

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW", "ALLOW: looks fine"),
        fakeReviewer("MiMo", "ALLOW", "ALLOW: no issues")
      ]),
      writeTraceImpl,
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, session_id: "chat-A", last_assistant_message: "wrote some code" }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(lines.length > 0, "should emit at least one line");
  const parsed = JSON.parse(lines[0]);
  assert.ok(typeof parsed.systemMessage === "string", "systemMessage should be a string");
  assert.match(parsed.systemMessage, /bench stop.*ALLOW/i, "systemMessage should mention bench stop and ALLOW");

  assert.ok(traceRecord !== null, "trace should be written");
  assert.equal(traceRecord.gate, "stop", "trace gate should be 'stop'");
  assert.equal(traceRecord.sessionKey, normalizeSessionId("chat-A"), "trace is stamped with the hook session");
  assert.ok(traceRecord.ws, "trace should include ws");
  assert.ok(Array.isArray(traceRecord.reviewers), "trace.reviewers should be an array");
});

test("dirty ALLOW snapshot is reviewed once, then skipped until the worktree changes", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-dirty-once-"));
  process.env.BENCH_ROOT = root;

  let calls = 0;
  let traces = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => { traces += 1; },
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "wrote code" }
  };

  let marker = null;
  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    await runMain(opts);
    marker = readReviewedWorktree(ws);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 1, "the identical dirty snapshot must not be re-reviewed on the next Stop");
  assert.equal(traces, 1, "the identical dirty snapshot must not write a second trace");
  assert.equal(lines.length, 1, "only the first review should emit an ALLOW message");
  assert.ok(marker, "ALLOW should persist a reviewed-worktree fingerprint");
});

test("unchanged committed+dirty ALLOW snapshot is not reviewed again after reviewed-head advances", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-commit-dirty-once-"));
  process.env.BENCH_ROOT = root;
  const initial = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, initial);
  fs.writeFileSync(path.join(ws, "feature.js"), "export const committed = 1;\n");
  gitC(ws, "add", "feature.js");
  gitC(ws, "commit", "-qm", "feat: committed slice");
  fs.appendFileSync(path.join(ws, "feature.js"), "export const stillDirty = 2;\n");
  const head = gitC(ws, "rev-parse", "HEAD").trim();

  let calls = 0;
  let traces = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => { traces += 1; },
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "committed then kept editing" }
  };

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    assert.equal(readReviewedHead(ws), head, "first ALLOW advances the committed baseline");
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 1, "the unchanged dirty remainder is not re-reviewed just because the committed section disappeared");
  assert.equal(traces, 1, "the duplicate Stop writes no second trace");
  assert.equal(lines.length, 1, "only the first Stop emits ALLOW");
});

test("codex-only/no-eligible Stop panel advances the committed baseline once", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-no-eligible-once-"));
  process.env.BENCH_ROOT = root;
  const initial = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, initial);
  fs.writeFileSync(path.join(ws, "committed.js"), "export const committed = true;\n");
  gitC(ws, "add", "committed.js");
  gitC(ws, "commit", "-qm", "feat: committed slice");
  const head = gitC(ws, "rev-parse", "HEAD").trim();

  const opts = {
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => { throw new Error("no trace should be written without an eligible reviewer"); },
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, session_id: "codex-only" }
  };
  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    assert.equal(readReviewedHead(ws), head, "the explicit no-eligible-reviewer policy advances reviewed-head");
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(lines.length, 1, "later Stops do not repeat the same no-reviewer status for an already-seen commit");
  assert.match(lines[0], /no non-Codex reviewers configured/);
});

test("untracked continuation chunks review changed content in the 21st file", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-untracked-full-id-"));
  process.env.BENCH_ROOT = root;
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(ws, `${String(i).padStart(2, "0")}-filler.txt`), `filler-${i}`);
  const omitted = path.join(ws, "zz-omitted-large.txt");
  fs.writeFileSync(omitted, `${"Z".repeat(25_000)}TAIL-A`);

  let calls = 0;
  const prompts = [];
  const reviewer = {
    name: "Kimi",
    async run({ user }) {
      calls += 1;
      prompts.push(user);
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "untracked batch" }
  };

  const { restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    fs.writeFileSync(omitted, `${"Z".repeat(25_000)}TAIL-B`);
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 6, "each snapshot gets two bounded chunk calls plus one bounded synthesis call");
  assert.match(prompts[1], /TAIL-A/, "the initially omitted tail is actually reviewed in the first continuation");
  assert.match(prompts[2], /TAIL-A/, "the first synthesis call receives the continuation evidence in one coherent context");
  assert.match(prompts[4], /TAIL-B/, "the changed tail is actually reviewed in the second continuation");
  assert.match(prompts[5], /TAIL-B/, "the second synthesis call receives the changed continuation evidence");
  assert.notEqual(prompts[4], prompts[1], "a hidden-byte change changes reviewer evidence, not only a local fingerprint");
});

test("a BLOCK in any bounded continuation chunk wins after all chunks are inspected", async () => {
  const seen = [];
  const [result] = await reviewPromptChunks([{
    name: "Kimi",
    async run({ user }) {
      seen.push(user);
      return user.includes("late bug")
        ? { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: late bug", raw: "BLOCK: late bug\n- concrete" }
        : { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: first clean", raw: "ALLOW: first clean" };
    }
  }], [
    { system: "review", user: "first chunk" },
    { system: "review", user: "second chunk has late bug" },
    { system: "review", user: "third chunk" }
  ], { cwd: process.cwd(), env: process.env });

  assert.equal(seen.length, 4, "all three chunks plus exactly one bounded synthesis call run");
  assert.equal(result.verdict, "BLOCK");
  assert.match(result.raw, /review chunk 2\/3[\s\S]*late bug/);
  assert.match(result.raw, /review chunk 3\/3/, "later sibling chunks remain included in the combined evidence");
  assert.match(result.raw, /cross-chunk synthesis/, "the final synthesis result is preserved in the combined evidence");
});

test("one bounded synthesis call can discover a relationship split across stateless chunk calls", async () => {
  const calls = [];
  const [result] = await reviewPromptChunks([{
    name: "Kimi",
    async run({ system, user }) {
      calls.push({ system, user });
      if (system.includes("final synthesis pass")) {
        const related = user.includes("TRACKED_API_CHANGE") && user.includes("UNTRACKED_CALLSITE");
        return related
          ? { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: callsite violates changed API", raw: "BLOCK: callsite violates changed API" }
          : { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: no relationship visible", raw: "ALLOW: no relationship visible" };
      }
      // These are deliberately stateless calls: neither individual chunk can see both sides.
      assert.equal(user.includes("TRACKED_API_CHANGE") && user.includes("UNTRACKED_CALLSITE"), false);
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: chunk locally clean", raw: "ALLOW: chunk locally clean" };
    }
  }], [
    buildPrompt("M api.js", "TRACKED_API_CHANGE", "", "", "", "", { chunkIndex: 0, chunkCount: 2 }),
    buildPrompt("?? caller.js", "", "UNTRACKED_CALLSITE", "", "", "", { chunkIndex: 1, chunkCount: 2 })
  ], { cwd: process.cwd(), env: process.env });

  assert.equal(calls.length, 3, "two bounded chunk calls get exactly one synthesis call, never an unbounded loop");
  assert.match(calls[2].user, /TRACKED_API_CHANGE/);
  assert.match(calls[2].user, /UNTRACKED_CALLSITE/);
  assert.ok(Buffer.byteLength(calls[2].user) <= 120_000, "synthesis evidence stays within its hard byte budget");
  assert.equal(result.verdict, "BLOCK", "the cross-chunk defect is no longer falsely combined as ALLOW");
});

test("dirty ALLOW de-duplication is session-scoped", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-session-dedupe-"));
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const common = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env
  };

  const { restore } = captureEmit(() => {});
  try {
    await runMain({ ...common, input: { cwd: ws, session_id: "chat-A" } });
    await runMain({ ...common, input: { cwd: ws, session_id: "chat-B" } });
    await runMain({ ...common, input: { cwd: ws, session_id: "chat-A" } });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 2, "chat B gets its own review while chat A still reuses only chat A's ALLOW");
});

test("dirty ALLOW snapshot is reviewed again after the worktree content changes", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-dirty-change-"));
  process.env.BENCH_ROOT = root;

  let calls = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "wrote code" }
  };

  const { restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    fs.appendFileSync(path.join(ws, "changed.js"), "export const y = 2;\n");
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 2, "a changed dirty snapshot must trigger a fresh review");
});

test("dirty ALLOW snapshot is reviewed again when the reviewer panel changes", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-dirty-reviewers-"));
  process.env.BENCH_ROOT = root;

  let kimiCalls = 0;
  let glmCalls = 0;
  const kimi = {
    name: "Kimi",
    async run() {
      kimiCalls += 1;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  const glm = {
    name: "GLM",
    async run() {
      glmCalls += 1;
      return { name: "GLM", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };
  let reviewerList = [kimi];
  const opts = {
    resolveReviewersImpl: () => reviewerList,
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "wrote code" }
  };

  const { restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    reviewerList = [kimi, glm];
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(kimiCalls, 2, "the existing reviewer should run again when the panel changes");
  assert.equal(glmCalls, 1, "the newly-added reviewer must review the already-dirty snapshot");
});

test("dirty ALLOW cache invalidates when the same reviewer name changes model or endpoint", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-dirty-policy-"));
  process.env.BENCH_ROOT = root;
  let oldCalls = 0;
  let newCalls = 0;
  const oldReviewer = {
    name: "Kimi", reviewIdentity: { kind: "api", model: "kimi-old", baseURL: "https://old.example/v1" },
    async run() { oldCalls += 1; return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: old", raw: "ALLOW: old" }; }
  };
  const newReviewer = {
    name: "Kimi", reviewIdentity: { kind: "api", model: "kimi-new", baseURL: "https://new.example/v1" },
    async run() { newCalls += 1; return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: new", raw: "ALLOW: new" }; }
  };
  let current = oldReviewer;
  const opts = {
    resolveReviewersImpl: () => [current], writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    env: process.env, input: { cwd: ws, session_id: "policy-change" }
  };
  const { restore } = captureEmit(() => {});
  try {
    await runMain(opts);
    current = newReviewer;
    await runMain(opts);
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1, "same-name model/endpoint change must not reuse the old ALLOW");
});

test("dirty BLOCK snapshot is not marked reviewed and repeats until fixed", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-dirty-block-"));
  process.env.BENCH_ROOT = root;

  let calls = 0;
  const reviewer = {
    name: "Kimi",
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: real bug", raw: "BLOCK: real bug" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, last_assistant_message: "wrote code" },
    blockHandler: async () => {}
  };

  let marker = "unset";
  try {
    await runMain(opts);
    await runMain(opts);
    marker = readReviewedWorktree(ws);
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(calls, 2, "BLOCK must not suppress future reviews of the same unsafe snapshot");
  assert.equal(marker, null, "BLOCK must not write a reviewed-worktree fingerprint");
});

// ---------------------------------------------------------------------------
// F: stop-gate ALLOW systemMessage leads with the verdict badge (Codex excluded)
// ---------------------------------------------------------------------------

test("F: stop ALLOW systemMessage leads with the badge, omitting Codex", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-badge-"));
  process.env.BENCH_ROOT = root;

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW", "ALLOW: looks fine"),
        fakeReviewer("MiMo", "ALLOW", "ALLOW: no issues"),
        fakeReviewer("GLM", "ALLOW", "ALLOW: clean")
      ]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, last_assistant_message: "wrote some code" }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  const parsed = JSON.parse(lines[0]);
  assert.match(parsed.systemMessage, /\[Kimi✓ MiMo✓ GLM✓\]/, "systemMessage should lead with the badge");
  assert.doesNotMatch(parsed.systemMessage, /Codex/, "stop badge must not mention Codex");
});

// ---------------------------------------------------------------------------
// Test: BLOCK → exit code 2, findings on stderr
// ---------------------------------------------------------------------------

test("BLOCK → subprocess exits with code 2 and findings on stderr", () => {
  const ws = freshRepo({ withChange: true });

  // We need a subprocess that imports stop-review.mjs and calls runMain with
  // a fake reviewer returning BLOCK. Write a small wrapper script.
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-blk-"));
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-blk-root-"));
  const wrapperScript = path.join(wrapperDir, "block-wrapper.mjs");
  const hookPath = path.join(ROOT, "global-hooks", "stop-review.mjs");

  fs.writeFileSync(wrapperScript, `
import { runMain } from ${JSON.stringify(hookPath)};
const fakeReviewer = {
  name: "Kimi",
  async run() {
    return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: introduced a bug", raw: "BLOCK: introduced a bug\\n\\nThe function at line 5 has an off-by-one error." };
  }
};
await runMain({
  resolveReviewersImpl: () => [fakeReviewer],
  writeTraceImpl: () => {},
  isBenchDisabledImpl: () => false,
  env: process.env,
  input: { cwd: ${JSON.stringify(ws)}, last_assistant_message: "wrote some code" }
});
`);

  const result = spawnSync(process.execPath, [wrapperScript], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: wrapperRoot }
  });

  assert.equal(result.status, 2, `expected exit code 2 on BLOCK, got ${result.status}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /BLOCK|block|introduced a bug/i, "findings should appear on stderr");
  assert.equal(result.stdout.trim(), "", "no stdout on BLOCK (asyncRewake uses stderr)");
});

// ---------------------------------------------------------------------------
// Test: all reviewers errored → fail-open, systemMessage, exit 0
// ---------------------------------------------------------------------------

test("all reviewers error → fail-open systemMessage, no exit 2", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-fo-"));
  process.env.BENCH_ROOT = root;

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeErrorReviewer("Kimi"),
        fakeErrorReviewer("MiMo")
      ]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(lines.length > 0, "should emit a fail-open message");
  const parsed = JSON.parse(lines[0]);
  assert.ok(typeof parsed.systemMessage === "string", "systemMessage should be a string");
  assert.match(parsed.systemMessage, /bench stop.*review failed.*turn allowed/i, "should indicate fail-open");
});

// ---------------------------------------------------------------------------
// Test: buildPrompt — content-only, no tool or repo claim
// ---------------------------------------------------------------------------

test("buildPrompt: system is content-only with ALLOW:/BLOCK: instruction", () => {
  const { system, user } = buildPrompt("M changed.js", "diff --git ...", "", "did some work");
  // Must instruct reviewer to stay content-only (no repo reads, no tools).
  assert.doesNotMatch(system, /read access|verify.*against.*code/i);
  assert.match(system, /ALLOW:|BLOCK:/);
  assert.match(system, /Do NOT use any tools/i);
  assert.match(system, /never use.*tail message to skip non-empty/i);
  assert.match(user, /changed\.js|git_status/i);
  assert.match(user, /did some work/);
});

test("buildPrompt: diffs appear before the assistant-message context", () => {
  const { user } = buildPrompt(
    "M changed.js",
    "diff --git a/changed.js b/changed.js\n+export const changed = true;",
    "",
    "Final status only: done",
    "",
    "diff --git a/committed.js b/committed.js\n+export const committed = true;"
  );
  assert.ok(
    user.indexOf("<git_status>") < user.indexOf("<previous_assistant_message_context>"),
    "status and diffs must be primary, before the conversational tail"
  );
  assert.ok(
    user.indexOf("<committed_diff>") < user.indexOf("<previous_assistant_message_context>"),
    "committed diff must not be buried after the previous assistant message"
  );
  assert.match(user, /committed\.js/);
  assert.match(user, /changed\.js/);
});

// ---------------------------------------------------------------------------
// Task 7 — E1: staged-only change in a fresh repo (no commits) is reviewed,
// and a normal repo's staged hunk is NOT duplicated in the diff block.
// ---------------------------------------------------------------------------

/** Fresh repo with NO commits (unborn HEAD). Stage `staged.js`, no untracked. */
function freshRepoNoCommits() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sr-unborn-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "staged.js"), "export const fresh = 1;\n");
  execFileSync("git", ["add", "staged.js"], { cwd: ws });
  return ws;
}

test("E1: fresh repo (no commits), staged-only change → reviewed with staged content", async () => {
  const ws = freshRepoNoCommits();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-e1-"));
  process.env.BENCH_ROOT = root;

  let called = false;
  let seenUser = "";
  const resolveReviewersImpl = () => [{
    name: "Kimi",
    async run({ user }) {
      called = true;
      seenUser = user;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  }];

  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, last_assistant_message: "staged a new file" }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(called, true, "reviewer must be called for a staged-only fresh-repo change");
  assert.match(seenUser, /staged\.js|fresh = 1/, "reviewed content must include the staged change");
});

test("E1: normal repo with a staged modification → diff block does NOT duplicate the staged hunk", () => {
  // Build a repo with a commit, then stage a modification. `git diff HEAD` already
  // shows the staged change; we must NOT also append `git diff --cached` (would dup it).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sr-dup-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "f.js"), "export const a = 1;\n");
  execFileSync("git", ["add", "f.js"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  // Stage a modification with a unique marker line.
  fs.writeFileSync(path.join(ws, "f.js"), "export const a = 1;\nexport const UNIQUE_STAGED_MARKER = 2;\n");
  execFileSync("git", ["add", "f.js"], { cwd: ws });

  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-dup-wrap-"));
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-dup-root-"));
  const wrapperScript = path.join(wrapperDir, "dup-wrapper.mjs");
  fs.writeFileSync(wrapperScript, `
import { runMain } from ${JSON.stringify(HOOK)};
const fakeReviewer = {
  name: "Kimi",
  async run({ user }) {
    process.stdout.write(JSON.stringify({ user }) + "\\n");
    return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
  }
};
await runMain({
  resolveReviewersImpl: () => [fakeReviewer],
  writeTraceImpl: () => {},
  isBenchDisabledImpl: () => false,
  env: process.env,
  input: { cwd: ${JSON.stringify(ws)}, last_assistant_message: "staged a mod" }
});
`);

  const result = spawnSync(process.execPath, [wrapperScript], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: wrapperRoot }
  });

  assert.equal(result.status, 0, `wrapper should exit 0; stderr: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").find((l) => l.includes("UNIQUE_STAGED_MARKER"));
  assert.ok(line, `reviewed content should include the staged marker; got: ${result.stdout}`);
  const { user } = JSON.parse(line);
  const occurrences = user.split("UNIQUE_STAGED_MARKER").length - 1;
  assert.equal(occurrences, 1, `staged hunk must appear exactly once (no duplication), saw ${occurrences}`);
});

test("streamed tracked snapshot cannot mistake a >64MiB diff for clean", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-large-diff-"));
  process.env.BENCH_ROOT = root;
  const big = path.join(ws, "large.txt");
  fs.writeFileSync(big, "base\n");
  gitC(ws, "add", "large.txt");
  gitC(ws, "commit", "-qm", "add base file");
  fs.writeFileSync(big, Buffer.alloc(66 * 1024 * 1024, 0x41));

  try {
    const snapshot = await captureGitSnapshot(["diff", "HEAD"], ws, { maxPromptBytes: 1024 });
    assert.equal(snapshot.ok, true, "streaming succeeds where the old 64MiB execFile maxBuffer threw");
    assert.ok(snapshot.totalBytes > 64 * 1024 * 1024, "the full diff was consumed into the identity hash");
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(snapshot.text) <= 1024, "only a bounded prefix is retained");

    let reviewerCalls = 0;
    let blockedPanel = null;
    await runMain({
      input: { cwd: ws, session_id: "large-diff" },
      env: process.env,
      isBenchDisabledImpl: () => false,
      resolveReviewersImpl: () => [{
        name: "Kimi",
        async run() { reviewerCalls += 1; return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }; }
      }],
      writeTraceImpl: () => {},
      blockHandler: async ({ panel }) => { blockedPanel = panel; }
    });
    assert.equal(reviewerCalls, 0, "incomplete bounded evidence is not sent to a model and mislabeled clean");
    assert.equal(blockedPanel?.decision, "block", "oversized evidence fails closed visibly");
    assert.match(blockedPanel?.findings || "", /above the 200000-byte bounded review limit/);
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("captureGitSnapshot kills a wedged git and fails the snapshot instead of hanging the gate", async () => {
  const ws = freshRepo({ withChange: false });
  // A git that never emits and never exits stands in for a dead NFS/sshfs mount.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-wedged-git-"));
  fs.writeFileSync(path.join(shimDir, "git"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });
  fs.chmodSync(path.join(shimDir, "git"), 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${origPath ?? ""}`;
  const startedAt = Date.now();
  try {
    const snapshot = await captureGitSnapshot(["status", "--short"], ws, { timeoutMs: 150 });
    assert.equal(snapshot.ok, false, "a wedged git must surface as a failed snapshot, not a hang");
    assert.match(snapshot.error, /timed out/, "the failure names the timeout");
    assert.ok(Date.now() - startedAt < 5_000, "the capture returns promptly once the kill timer fires");
  } finally {
    process.env.PATH = origPath;
  }
});

// ---------------------------------------------------------------------------
// Task 7 — E2: visible stderr note on malformed stdin (mirrors pre-push E2)
// ---------------------------------------------------------------------------

test("E2: malformed stdin → ⛩ stderr note (treated as empty)", () => {
  // Run in a clean temp dir as cwd so the fallback (process.cwd()) has no diff.
  const cleanWs = fs.mkdtempSync(path.join(os.tmpdir(), "sr-e2-cwd-"));
  const result = spawnSync(process.execPath, [HOOK], {
    input: "{not json",
    encoding: "utf8",
    cwd: cleanWs,
    env: { ...process.env, BENCH_ROOT: TEMP_GCR }
  });
  assert.equal(result.status, 0, "malformed stdin must not crash (fail-open)");
  assert.match(result.stderr, /⛩ bench stop: could not parse hook input/, "should emit a visible ⛩ note");
});

// ---------------------------------------------------------------------------
// Task 9 — D3: trace-write failure emits a ⛩ note and still allows (fail-open)
// ---------------------------------------------------------------------------

test("D3: stop trace write failure emits a ⛩ note and still allows", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-d3-"));
  process.env.BENCH_ROOT = root;

  const stderrChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW", "ALLOW: ok")]),
      writeTraceImpl: () => { throw new Error("disk full"); },
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, last_assistant_message: "wrote code" }
    });
  } finally {
    restore();
    process.stderr.write = origErr;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  assert.ok(lines.length > 0, "must still emit the ALLOW systemMessage despite trace failure");
  const parsed = JSON.parse(lines[0]);
  assert.match(parsed.systemMessage, /ALLOW/i, "still allows");
});


test("FIX 5: two separate runMain invocations in one process each emit (no module-level suppression)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-fix5b-"));
  process.env.BENCH_ROOT = root;

  const run = async () => {
    const ws = freshRepo({ withChange: true });
    const { lines, restore } = captureEmit(() => {});
    try {
      await runMain({
        resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
        writeTraceImpl: () => {},
        isBenchDisabledImpl: () => false,
        env: process.env,
        input: { cwd: ws, last_assistant_message: "wrote code" }
      });
    } finally {
      restore();
    }
    return lines.filter((l) => { try { return !!JSON.parse(l).systemMessage; } catch { return false; } });
  };

  try {
    const first = await run();
    const second = await run();
    assert.equal(first.length, 1, "first invocation emits its ALLOW note");
    assert.equal(second.length, 1, "second invocation also emits — emit-once must be per-invocation, not module-level");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("buildPrompt: user does not contain BLOCK guidance; system does", () => {
  const { system, user } = buildPrompt("M changed.js", "diff --git ...", "new-file.js contents", "did some work");
  // "BLOCK only" instruction must be in system, NOT in user
  assert.match(system, /BLOCK only/i, "system must contain BLOCK guidance");
  assert.doesNotMatch(user, /BLOCK only/i, "user must NOT contain BLOCK-only guidance");
  // user must contain ONLY the content to review
  assert.match(user, /did some work/, "user must contain last_assistant_message");
  assert.match(user, /changed\.js/, "user must contain git status");
  assert.match(user, /diff --git/, "user must contain diff");
  assert.match(user, /new-file\.js/, "user must contain untracked file content");
  // user must not contain format instructions
  assert.doesNotMatch(user, /first line must be/i, "user must not have format instructions");
  assert.doesNotMatch(user, /Review the code changes/i, "user must not have review instructions");
});

// ===========================================================================
// GAP FIX: review changes COMMITTED since the last review, not just the working
// tree. A session that commits (50 things) leaves `git diff HEAD` empty → the
// old gate skipped and the committed work escaped review entirely (VisualSentinel).
// ===========================================================================

function gitC(ws, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: ws, encoding: "utf8" });
}

test("resolveReviewBase: marker that is an ancestor of HEAD → diff since the marker", () => {
  const ws = freshRepo({ withChange: false });
  writeReviewedHead(ws, "MARK");
  const fakeGit = (args) => (args[0] === "merge-base" && args[1] === "MARK" ? "MARK\n" : "");
  assert.equal(resolveReviewBase(ws, "HEADSHA", fakeGit), "MARK");
});

test("resolveReviewBase: marker == HEAD → returns HEAD (only the working tree is reviewed)", () => {
  const ws = freshRepo({ withChange: false });
  writeReviewedHead(ws, "SAME");
  assert.equal(resolveReviewBase(ws, "SAME", () => "boom"), "SAME");
});

test("resolveReviewBase: no marker but an upstream exists → merge-base with upstream (unpushed commits)", () => {
  const ws = freshRepo({ withChange: false });   // no marker written
  const fakeGit = (args) => {
    if (args[0] === "rev-parse" && args.includes("@{upstream}")) return "UP\n";
    if (args[0] === "merge-base" && args[1] === "UP") return "UP\n";
    return "";
  };
  assert.equal(resolveReviewBase(ws, "HEADSHA", fakeGit), "UP");
});

test("resolveReviewBase: no marker, no upstream → HEAD (working tree only, safe default)", () => {
  const ws = freshRepo({ withChange: false });
  assert.equal(resolveReviewBase(ws, "HEADSHA", () => ""), "HEADSHA");
});

test("resolveReviewBase: a stale/orphaned marker (not an ancestor) falls back, never diffs garbage", () => {
  const ws = freshRepo({ withChange: false });
  writeReviewedHead(ws, "ORPHAN");
  const fakeGit = (args) => {
    if (args[0] === "merge-base" && args[1] === "ORPHAN") return "SOMETHINGELSE\n"; // mb != ORPHAN → not ancestor
    return "";  // no upstream
  };
  assert.equal(resolveReviewBase(ws, "HEADSHA", fakeGit), "HEADSHA");
});

test("GAP FIX: a turn that COMMITTED its work (clean working tree) is still reviewed", async () => {
  const ws = freshRepo({ withChange: false });
  const initial = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, initial);                 // initial commit already reviewed
  // Commit a change — working tree ends CLEAN (the exact gap: nothing in `git diff HEAD`).
  fs.writeFileSync(path.join(ws, "feature.js"), "export const danger = eval('1 + 1');\n");
  gitC(ws, "add", "-A");
  gitC(ws, "commit", "-qm", "feat: committed work");
  assert.equal(gitC(ws, "status", "--short").trim(), "", "precondition: working tree is clean");

  const seen = {};
  const recording = { name: "Kimi", async run({ user }) { seen.user = user; seen.called = true; return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }; } };
  let trace = null;
  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: () => [recording],
      writeTraceImpl: (_ws, t) => { trace = t; },
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally { restore(); }

  assert.equal(seen.called, true, "the committed-but-clean-tree turn MUST be reviewed (the gap)");
  assert.match(seen.user, /feature\.js/, "the committed diff is included in the review prompt");
  assert.match(seen.user, /<committed_diff>/, "committed changes are surfaced in their own section");
  assert.ok(trace, "a trace is written for the reviewed committed work");
});

test("GAP FIX: the marker ADVANCES to HEAD on a clean ALLOW (no re-review next turn)", async () => {
  const ws = freshRepo({ withChange: false });
  const initial = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, initial);
  fs.writeFileSync(path.join(ws, "f.js"), "export const y = 2;\n");
  gitC(ws, "add", "-A");
  gitC(ws, "commit", "-qm", "feat");
  const head = gitC(ws, "rev-parse", "HEAD").trim();

  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: () => [fakeReviewer("Kimi", "ALLOW")],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally { restore(); }

  assert.equal(readReviewedHead(ws), head, "marker advanced to HEAD after a clean ALLOW");
});

test("GAP FIX: the marker does NOT advance on fail-open (range is re-reviewed until clean)", async () => {
  const ws = freshRepo({ withChange: false });
  const initial = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, initial);
  fs.writeFileSync(path.join(ws, "g.js"), "export const z = 3;\n");
  gitC(ws, "add", "-A");
  gitC(ws, "commit", "-qm", "feat");

  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: () => [fakeErrorReviewer("Kimi")],   // all error → fail-open
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally { restore(); }

  assert.equal(readReviewedHead(ws), initial, "marker stays put on fail-open so the range is re-reviewed");
});

test("GAP FIX: a genuine no-op turn keeps an existing baseline current and skips", async () => {
  const ws = freshRepo({ withChange: false });   // clean tree
  const head = gitC(ws, "rev-parse", "HEAD").trim();
  writeReviewedHead(ws, "ORPHANED-BASELINE");    // e.g. a rebase orphaned the marker
  let called = false;
  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: () => { called = true; return [fakeReviewer("Kimi", "ALLOW")]; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally { restore(); }
  assert.equal(called, false, "no changes → no review");
  assert.equal(readReviewedHead(ws), head, "an existing baseline is refreshed to HEAD for the next committing turn");
});

test("a clean committing turn with no baseline and no upstream does not certify unreviewed commits", async () => {
  const ws = freshRepo({ withChange: false });   // upstream-less repo, no reviewed-head marker
  // The /bench:on mid-session repro: the first observed turn COMMITS its work (clean tree), so
  // resolveReviewBase falls back to HEAD and the snapshot has no reviewable evidence at all.
  fs.writeFileSync(path.join(ws, "feature.js"), "export const committed = 1;\n");
  gitC(ws, "add", "-A");
  gitC(ws, "commit", "-qm", "feat: committed with bench freshly enabled");
  let called = false;
  const { restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: () => { called = true; return [fakeReviewer("Kimi", "ALLOW")]; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally { restore(); }
  assert.equal(called, false, "base == HEAD means this clean snapshot contains no reviewable evidence");
  assert.equal(readReviewedHead(ws), null, "the no-op path must not certify commits no reviewer ever saw");
});

test("session-total budget: ALLOW/clean transitions reset the streak but never refund the total; the 9th block latches advisory-only", async () => {
  const ws = freshRepo({ withChange: true });
  let verdict = "BLOCK";
  let calls = 0;
  const reviewer = { name: "Kimi", async run() { calls += 1; return verdict === "BLOCK"
    ? { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug" }
    : { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: fixed", raw: "ALLOW: fixed" }; } };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, session_id: "total-budget" },
    blockHandler: async () => {}
  };

  // Streaks of 2 blocks, each "healed" by an ALLOW on a changed revision BEFORE the streak
  // ceiling latches — the exact alternation that used to run for 8 hours (every ALLOW refunded
  // the streak, so the wakes never ended). Budget: 9 total blocks, then advisory-only.
  for (let streak = 0; streak < 4; streak++) {
    verdict = "BLOCK";
    for (let i = 0; i < 2; i++) {
      fs.appendFileSync(path.join(ws, "changed.js"), `export const s${streak}i${i} = 1;\n`);
      await runMain(opts);
    }
    verdict = "ALLOW";
    fs.appendFileSync(path.join(ws, "changed.js"), `export const heal${streak} = 1;\n`);
    await runMain(opts);   // ALLOW resets the streak — but must not refund the total
  }
  verdict = "BLOCK";       // 9th total block
  fs.appendFileSync(path.join(ws, "changed.js"), "export const ninth = 1;\n");
  await runMain(opts);
  const beforeExhausted = calls;
  verdict = "BLOCK";
  const emitted = [];
  fs.appendFileSync(path.join(ws, "changed.js"), "export const again = 1;\n");
  await runMain({ ...opts, emitter: { emit(payload) { emitted.push(payload); return true; } } });
  assert.equal(calls, beforeExhausted, "after 9 total blocks the panel must not run again this session");
  assert.match(emitted[0]?.systemMessage || "", /session-total automatic review budget exhausted/);
});
