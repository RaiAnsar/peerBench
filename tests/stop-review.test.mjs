// tests/stop-review.test.mjs
// Tests for global-hooks/stop-review.mjs.
// All reviewer calls are injected so NO real API or Codex call happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set BENCH_ROOT before importing any module that uses config-store.
const TEMP_GCR = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-"));
process.env.BENCH_ROOT = TEMP_GCR;

import { runMain, buildPrompt } from "../global-hooks/stop-review.mjs";
import { setBenchDisabled, workspaceStateDir } from "../global-hooks/config-store.mjs";

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
// Test: own consecutive-block cap → allows without reviewing after MAX_STOP_LOOPS
// ---------------------------------------------------------------------------

test("caps its own consecutive blocks → allows without reviewing once the cap is hit", async () => {
  const ws = freshRepo({ withChange: true });
  fs.mkdirSync(workspaceStateDir(ws), { recursive: true });
  fs.writeFileSync(path.join(workspaceStateDir(ws), "stop-loop"), JSON.stringify({ count: 4, ts: Date.now() }));

  let called = false;
  const resolveReviewersImpl = () => { called = true; return [fakeReviewer("Kimi", "BLOCK")]; };

  await runMain({
    resolveReviewersImpl,
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, stop_hook_active: false }
  });

  assert.equal(called, false, "after MAX_STOP_LOOPS consecutive blocks the gate allows without reviewing (loop broken)");
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
      input: { cwd: ws, last_assistant_message: "wrote some code" }
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
  assert.ok(traceRecord.ws, "trace should include ws");
  assert.ok(Array.isArray(traceRecord.reviewers), "trace.reviewers should be an array");
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
  assert.match(user, /changed\.js|git_status/i);
  assert.match(user, /did some work/);
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
