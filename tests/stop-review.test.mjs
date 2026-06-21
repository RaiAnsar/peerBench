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

import { runMain, buildPrompt, surfaceDeepResult, resolveReviewBase, readReviewedHead, writeReviewedHead } from "../global-hooks/stop-review.mjs";
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

// ---------------------------------------------------------------------------
// Task 10 — G5: surface a completed deep-result at the next stop (disable-first)
// ---------------------------------------------------------------------------

import { writeDeepResult, readLatestDeepResult, contentHash } from "../global-hooks/deep-review.mjs";

/** A deep-result file representing a low-severity completed pass for `ws`. */
function plantDeepResult(ws, { hash = contentHash("spec body"), badge = "Kimi✓ MiMo✓", summary = "no major issues", traceId = "trace-xyz", findingCount = 0, maxSeverity = "none", reviewers = [{ name: "Kimi", verdict: "ALLOW" }] } = {}) {
  return writeDeepResult(ws, { hash, badge, summary, traceId, findingCount, maxSeverity, reviewers });
}

test("G5: completed deep-result is surfaced + deleted at stop, even with NO diff (enabled)", async () => {
  const ws = freshRepo({ withChange: false });   // no diff this turn
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-g5-"));
  process.env.BENCH_ROOT = root;

  const file = plantDeepResult(ws, { traceId: "tid-1", summary: "spec looks fine", badge: "Kimi✓ MiMo✓" });

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  const surfaced = lines.map((l) => { try { return JSON.parse(l).systemMessage; } catch { return ""; } }).join("\n");
  assert.match(surfaced, /deep spec review/i, "must surface the deep spec review note even with no diff");
  assert.match(surfaced, /Kimi✓ MiMo✓/, "must include the badge");
  assert.match(surfaced, /spec looks fine/, "must include the summary");
  assert.match(surfaced, /tid-1/, "must include the trace id");
  assert.equal(fs.existsSync(file), false, "deep-result must be deleted after surfacing");
});

test("G5: completed deep-result is surfaced even when loop-capped", async () => {
  const ws = freshRepo({ withChange: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-g5cap-"));
  process.env.BENCH_ROOT = root;
  // Force the loop cap so a normal review would not run.
  fs.mkdirSync(workspaceStateDir(ws), { recursive: true });
  fs.writeFileSync(path.join(workspaceStateDir(ws), "stop-loop"), JSON.stringify({ count: 4, ts: Date.now() }));

  const file = plantDeepResult(ws, { traceId: "tid-cap", summary: "capped surface" });

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "BLOCK")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, stop_hook_active: false }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  const surfaced = lines.map((l) => { try { return JSON.parse(l).systemMessage; } catch { return ""; } }).join("\n");
  assert.match(surfaced, /deep spec review/i, "must surface even when loop-capped (before the loop-cap return)");
  assert.equal(fs.existsSync(file), false, "deep-result deleted after surfacing");
});

test("G5: bench DISABLED → deep-result is NOT surfaced (disable checked first)", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-g5dis-"));
  process.env.BENCH_ROOT = root;

  const file = plantDeepResult(ws, { traceId: "tid-dis" });

  const { lines, restore } = captureEmit(() => {});
  let exited = false;
  const origExit = process.exit;
  process.exit = () => { exited = true; throw new Error("__exit__"); };   // disabled path calls process.exit(0)
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => true,
      env: process.env,
      input: { cwd: ws }
    });
  } catch (e) {
    if (!/__exit__/.test(String(e && e.message))) throw e;
  } finally {
    process.exit = origExit;
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(exited, true, "disabled path must take the normal disabled exit");
  const surfaced = lines.map((l) => { try { return JSON.parse(l).systemMessage; } catch { return ""; } }).join("\n");
  assert.doesNotMatch(surfaced, /deep spec review/i, "must NOT surface a deep result when bench is disabled");
  assert.ok(fs.existsSync(file), "deep-result must remain (not consumed) when disabled");
});

test("G5: content-hash mismatch → surfaced with a 'stale' note", async () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-g5stale-"));
  process.env.BENCH_ROOT = root;
  // Write a spec file whose CURRENT content differs from the deep-result hash.
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "s.md"), "# current content\n");

  const file = plantDeepResult(ws, { hash: contentHash("OLD DIFFERENT CONTENT"), specPath: path.join(specDir, "s.md"), traceId: "tid-stale", summary: "old summary" });
  // ensure the result records which spec it reviewed so the gate can re-hash it
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.specPath = path.join(specDir, "s.md");
  fs.writeFileSync(file, JSON.stringify(rec));

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  const surfaced = lines.map((l) => { try { return JSON.parse(l).systemMessage; } catch { return ""; } }).join("\n");
  assert.match(surfaced, /deep spec review/i, "stale result is still surfaced");
  assert.match(surfaced, /stale/i, "must note the result may be stale on a hash mismatch");
  assert.equal(fs.existsSync(file), false, "stale deep-result is deleted too");
});

test("G5: high-severity deep findings → REWAKE (exit 2) with findings on stderr", () => {
  // Subprocess: plant a high-severity deep-result, then run the hook on a no-diff repo.
  const ws = freshRepo({ withChange: false });
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-g5rewake-root-"));
  // Plant the deep-result under the SUBPROCESS's BENCH_ROOT.
  const prevRoot = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = wrapperRoot;
  let file;
  try {
    file = writeDeepResult(ws, { hash: contentHash("x"), badge: "Kimi✗", summary: "critical design flaw", traceId: "tid-rewake", findingCount: 2, maxSeverity: "critical", reviewers: [{ name: "Kimi", verdict: "BLOCK" }] });
  } finally {
    process.env.BENCH_ROOT = prevRoot;
  }

  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: ws }),
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: wrapperRoot }
  });

  assert.equal(result.status, 2, `high-severity deep findings must rewake (exit 2); stderr=${result.stderr} stdout=${result.stdout}`);
  assert.match(result.stderr, /deep spec review|critical design flaw/i, "rewake findings on stderr");
});

// ---------------------------------------------------------------------------
// FIX 2 — a null / non-object deep-result must not wedge the stop gate:
// surfaceDeepResult returns null without throwing (readLatestDeepResult drops it).
// ---------------------------------------------------------------------------

test("FIX 2: a null deep-result file → surfaceDeepResult returns null without throwing", () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-fix2-"));
  process.env.BENCH_ROOT = root;
  try {
    const dir = workspaceStateDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "deep-result-nulltest.json");
    fs.writeFileSync(file, "null");
    const emitted = [];
    const res = surfaceDeepResult(ws, { emit: (o) => emitted.push(o) });
    assert.equal(res, null, "null deep-result must surface as null (no TypeError on result.specPath)");
    assert.equal(emitted.length, 0, "nothing should be emitted for a corrupt null result");
    assert.equal(fs.existsSync(file), false, "the null result file must be dropped so it never wedges the gate");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

// ---------------------------------------------------------------------------
// H — surfaceDeepResult is label-aware: a kind:"push" result (NO specPath) surfaces
// as "deep push review", skips the file-based stale check (no false 'stale' note), and
// a high-severity push result rewakes.
// ---------------------------------------------------------------------------

test("H: surfaceDeepResult surfaces a kind:'push' result with the 'deep push review' label and NO stale note", () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-hpush-"));
  process.env.BENCH_ROOT = root;
  try {
    const file = writeDeepResult(ws, {
      hash: contentHash("push:@{u}..HEAD deadbeef"), kind: "push", range: "@{u}..HEAD",
      badge: "Kimi✓ MiMo✓", summary: "no blocking findings", traceId: "tid-push",
      findingCount: 0, maxSeverity: "none", reviewers: [{ name: "Kimi", verdict: "ALLOW" }]
    });
    const emitted = [];
    const res = surfaceDeepResult(ws, { emit: (o) => emitted.push(o) });
    assert.equal(res.kind, "surfaced", "push result must surface");
    assert.equal(emitted.length, 1, "exactly one note emitted");
    const msg = emitted[0].systemMessage;
    assert.match(msg, /deep push review/i, "must use the 'deep push review' label, not 'spec'");
    assert.doesNotMatch(msg, /deep spec review/i, "must NOT use the spec label for a push result");
    assert.doesNotMatch(msg, /stale/i, "a push result has no specPath → the file-based stale check is skipped (no false stale note)");
    assert.match(msg, /tid-push/, "must include the trace id");
    assert.equal(fs.existsSync(file), false, "consumed push deep-result is deleted");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("H: a high-severity kind:'push' deep-result returns rewake", () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-hpushrw-"));
  process.env.BENCH_ROOT = root;
  try {
    const file = writeDeepResult(ws, {
      hash: contentHash("push:rw"), kind: "push", range: "@{u}..HEAD",
      badge: "Kimi✗", summary: "2 finding(s), max severity high", traceId: "tid-push-rw",
      findingCount: 2, maxSeverity: "high", reviewers: [{ name: "Kimi", verdict: "BLOCK" }]
    });
    const emitted = [];
    const res = surfaceDeepResult(ws, { emit: (o) => emitted.push(o) });
    assert.equal(res.kind, "rewake", "a high-severity push result must rewake (exit 2 at the stop gate)");
    assert.match(res.text, /deep push review/i, "rewake text uses the push label");
    assert.equal(emitted.length, 0, "rewake path does not emit on stdout (it goes to stderr + exit 2)");
    assert.equal(fs.existsSync(file), false, "consumed push deep-result is deleted on rewake too");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

// ---------------------------------------------------------------------------
// FIX 3 — surfaced summary is length-capped (no unbounded output).
// ---------------------------------------------------------------------------

test("FIX 3: oversized summary → surfaced line is bounded (or the file is dropped)", () => {
  const ws = freshRepo({ withChange: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-fix3-"));
  process.env.BENCH_ROOT = root;
  try {
    // A modest result whose summary is large but the FILE stays under the 256KB read cap,
    // so it is read and surfaced — the EMITTED line must be bounded by the .slice(0,220).
    const dir = workspaceStateDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    const big = "Z".repeat(5000);
    writeDeepResult(ws, { hash: contentHash("x"), badge: "Kimi✓", summary: big, traceId: "tid-big", findingCount: 0, maxSeverity: "none", reviewers: [] });
    const emitted = [];
    const res = surfaceDeepResult(ws, { emit: (o) => emitted.push(o) });
    if (res) {
      // surfaced → the emitted systemMessage line must be bounded
      assert.equal(emitted.length, 1, "exactly one note emitted");
      assert.ok(emitted[0].systemMessage.length <= 320, `surfaced line must be bounded; got ${emitted[0].systemMessage.length}`);
    } else {
      // dropped as oversized is also acceptable
      assert.equal(emitted.length, 0);
    }
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

// ---------------------------------------------------------------------------
// FIX 5 — invocation-scoped emit-once: a turn with BOTH a completed deep-result
// AND a real diff emits EXACTLY ONE systemMessage on stdout (the surfaced note
// wins); two separate runMain invocations in one process each emit (no module-level
// suppression).
// ---------------------------------------------------------------------------

test("FIX 5: deep-result + real diff → exactly ONE stdout systemMessage (surfaced wins)", async () => {
  const ws = freshRepo({ withChange: true });   // real diff this turn
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-root-fix5-"));
  process.env.BENCH_ROOT = root;

  writeDeepResult(ws, { hash: contentHash("x"), badge: "Kimi✓ MiMo✓", summary: "deep ok", traceId: "tid-once", findingCount: 0, maxSeverity: "none", reviewers: [] });

  const { lines, restore } = captureEmit(() => {});
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW"), fakeReviewer("MiMo", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, last_assistant_message: "wrote code" }
    });
  } finally {
    restore();
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  const sysLines = lines.filter((l) => { try { return !!JSON.parse(l).systemMessage; } catch { return false; } });
  assert.equal(sysLines.length, 1, `exactly one systemMessage line on stdout (surfaced wins); got ${sysLines.length}: ${lines.join(" | ")}`);
  assert.match(JSON.parse(sysLines[0]).systemMessage, /deep spec review/i, "the surfaced deep note must win the single stdout slot");
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

test("GAP FIX: a genuine no-op turn keeps the baseline current (sets marker to HEAD) and skips", async () => {
  const ws = freshRepo({ withChange: false });   // clean tree, no marker
  const head = gitC(ws, "rev-parse", "HEAD").trim();
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
  assert.equal(readReviewedHead(ws), head, "baseline marker established at HEAD for the next committing turn");
});
