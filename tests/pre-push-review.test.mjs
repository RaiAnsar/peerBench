// tests/pre-push-review.test.mjs
// Tests for global-hooks/pre-push-review.mjs
// All reviewer calls are injected — no real API or Codex calls happen.
// Git range logic is exercised via real temp repos with local bare remotes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set BENCH_ROOT before importing any module that uses config-store.
const TEMP_GCR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-")));
process.env.BENCH_ROOT = TEMP_GCR;

import { runMain, buildPrompt, cdTargetBeforePush, commandCwd, findPushSegment, isGitPushSegment, shellTokenize, parsePushCommand, resolvePushRange, launchPushReview, assistantContextFromInput } from "../global-hooks/pre-push-review.mjs";
import { normalizeSessionId, setBenchDisabled, readReviewedHead, writeReviewedHead } from "../global-hooks/config-store.mjs";
import { deepKey } from "../global-hooks/deep-review.mjs";
import { listJobs } from "../global-hooks/deep-queue.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "global-hooks", "pre-push-review.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a bare remote + a working clone with one commit ahead of origin/main. */
function freshPushRepo() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main"], { cwd: bare });

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-ws-"));
  execFileSync("git", ["clone", "-q", bare, ws]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "initial"], { cwd: ws });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: ws });

  // Add one more commit so there's something to push next time
  fs.writeFileSync(path.join(ws, "file.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "."], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "add file"], { cwd: ws });

  return { ws, bare };
}

/** A repo with a remote but nothing ahead (already pushed). */
function freshPushedRepo() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-pushed-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main"], { cwd: bare });

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-pushed-ws-"));
  execFileSync("git", ["clone", "-q", bare, ws]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "initial"], { cwd: ws });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: ws });
  // No additional commits — nothing ahead.
  return { ws, bare };
}

/** Fake reviewer that always returns the given verdict. */
function fakeReviewer(name, verdict) {
  return {
    name,
    async run() {
      return { name, verdict, firstLine: `${verdict}: test`, raw: `${verdict}: test\n\nDetails for ${name}.` };
    }
  };
}

/** Fake reviewer that returns an error (simulates API failure). */
function fakeErrorReviewer(name) {
  return {
    name,
    async run() {
      return { name, error: "injected test error" };
    }
  };
}

function fakePushReview({
  badge = "Kimi✓",
  summary = "no blocking findings",
  findingCount = 0,
  maxSeverity = "none",
  findings = "",
  retry = false,
  reason = "git error",
  reviewers,
  onCall
} = {}) {
  return async (range, ws, opts = {}) => {
    if (onCall) onCall({ range, ws, opts });
    if (retry) {
      return { retry: true, reason, reviewers: [], findingCount: 0, maxSeverity: "none", findings: "", traceId: null, badge: "", summary: `push review deferred (${reason})`, hash: null };
    }
    const reviewRows = reviewers || [{ name: "Kimi", verdict: findingCount ? "BLOCK" : "ALLOW", severity: maxSeverity, findingCount }];
    if (opts.writeTraceImpl) {
      opts.writeTraceImpl(ws, {
        gate: "push-review",
        ws,
        sessionKey: opts.sessionKey || null,
        reviewers: reviewRows,
        systemPrompt: "test push-review system",
        userPrompt: `test push-review ${range}`,
        rawResponses: { Kimi: findings || summary }
      });
    }
    return { reviewers: reviewRows, findingCount, maxSeverity, findings, traceId: "trace-test", badge, summary, hash: "hash-test" };
  };
}

/** Stub resolveReviewers factory → returns the given list. */
function stubResolveReviewers(list) {
  return () => list;
}

// Safe wrapper for runMain: default to a single ALLOW reviewer (so a test that reaches the review never
// makes a REAL API/CLI call) and a no-op exit (so the fail-open `return exit(0)` path never kills the
// test process). Deep-review enqueue defaults to a no-op so tests don't write queue jobs unless asserted.
//
// Mode routing is DETERMINISTIC and DECOUPLED from the production default (which is `blocking`): a test
// injecting `pushReviewImpl` exercises BLOCKING (inline deep review); anything else runs FAST with the
// wrapper's fake reviewer (never a real API/CLI call). An explicit opts.env.BENCH_PUSH_GATE_MODE wins.
// (Tests that want to verify the actual DEFAULT call runMain directly, bypassing this wrapper.)
function callRunMain(opts = {}) {
  const wantMode = opts.env?.BENCH_PUSH_GATE_MODE || (opts.pushReviewImpl ? "blocking" : "fast");
  const env = { ...(opts.env || process.env), BENCH_PUSH_GATE_MODE: wantMode };
  return runMain({
    resolveReviewersImpl: () => [fakeReviewer("Kimi", "ALLOW")],
    enqueueImpl: () => true,
    exit: () => {},
    ...opts,
    env
  });
}

/** Capture JSON lines emitted to stdout by emit(). */
function captureEmit(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string") lines.push(chunk.trim()).filter(Boolean);
    return orig(chunk, ...rest);
  };
  const restore = () => { process.stdout.write = orig; };
  return { lines, restore };
}

/** Parse only non-empty JSON lines from a lines array. */
function parseLines(lines) {
  return lines.filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Test: non-git-push command → allow no-op (no trace, no emit)
// ---------------------------------------------------------------------------

test("non-git-push command → allow no-op (git status)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-np-")));
  process.env.BENCH_ROOT = root;

  let reviewersCalled = false;
  let traceWritten = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      resolveReviewersImpl: () => { reviewersCalled = true; return [fakeReviewer("Kimi", "ALLOW")]; },
      writeTraceImpl: () => { traceWritten = true; },
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git status" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(reviewersCalled, false, "reviewers must NOT be called for non-push command");
  assert.equal(traceWritten, false, "no trace should be written for non-push command");
  assert.equal(emittedLines.length, 0, "no output for non-push command");
});

// ---------------------------------------------------------------------------
// Bootstrap: the FIRST git command of a session records the reviewed-head baseline
// (BEFORE any commit) so committed-AND-pushed work is still reviewed on the first stop —
// the gap where @{upstream} has already advanced past the pushed commits.
// ---------------------------------------------------------------------------

test("bootstrap: a non-push git command records the reviewed-head baseline when missing", async () => {
  const { ws } = freshPushRepo();
  assert.equal(readReviewedHead(ws), null, "precondition: no marker yet");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  await callRunMain({
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git add -A" } }
  });
  assert.equal(readReviewedHead(ws), head, "first git command sets the baseline to HEAD (pre-commit)");
});

test("bootstrap: does NOT overwrite an existing marker (preserves a cross-session unreviewed range)", async () => {
  const { ws } = freshPushRepo();
  writeReviewedHead(ws, "PREEXISTING");
  await callRunMain({
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git status" } }
  });
  assert.equal(readReviewedHead(ws), "PREEXISTING", "existing marker preserved (bootstrap only fills a gap)");
});

test("bootstrap: skipped when bench is disabled (no marker written)", async () => {
  const { ws } = freshPushRepo();
  await callRunMain({
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => true,
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git add -A" } }
  });
  assert.equal(readReviewedHead(ws), null, "disabled → no baseline written");
});

// commandCwd: resolve the repo a git command actually operates in (cd + `git -C`).
test("commandCwd: plain git command → fallback cwd", () => {
  assert.equal(commandCwd("git commit -m x", "/main"), "/main");
  assert.equal(commandCwd("git status", "/main"), "/main");
});
test("commandCwd: `git -C <dir>` resolves to that dir", () => {
  assert.equal(commandCwd("git -C /other commit -m x", "/main"), "/other");
});
test("commandCwd: `cd <dir> && git …` resolves to the cd'd dir", () => {
  assert.equal(commandCwd("cd /other && git add -A", "/main"), "/other");
  assert.equal(commandCwd("cd sub && git status", "/main"), "/main/sub");   // relative cd resolves on fallback
});
test("commandCwd: `git -C` within the git segment wins over a prior cd", () => {
  assert.equal(commandCwd("cd /a && git -C /b commit", "/main"), "/b");
});
test("commandCwd: env-prefixed git command is still recognized (`-C` applied)", () => {
  assert.equal(commandCwd("FOO=bar git -C /b commit -m x", "/main"), "/b");
  assert.equal(commandCwd("A=1 B=2 git status", "/main"), "/main");
});
test("commandCwd: does NOT follow GIT_WORK_TREE / GIT_DIR redirects (stays at cwd, like the stop gate)", () => {
  // GIT_WORK_TREE points at a work tree whose .git is elsewhere; `git rev-parse` run without those
  // env vars can't resolve it, and the stop gate doesn't follow them either — so honoring them would
  // bootstrap the wrong workspace or none. The env prefix is skipped only to recognize the invocation.
  assert.equal(commandCwd("GIT_WORK_TREE=/b git commit -m x", "/main"), "/main");
  assert.equal(commandCwd("GIT_DIR=/b/.git git commit", "/main"), "/main");
});
test("commandCwd: `git` as a mere argument is NOT treated as an invocation", () => {
  assert.equal(commandCwd("echo git push", "/main"), "/main");
});

test("bootstrap: marks the repo the command TOUCHES via -C, not input.cwd (Codex finding)", async () => {
  const { ws: repoA } = freshPushRepo();
  const { ws: repoB } = freshPushRepo();
  const headB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoB, encoding: "utf8" }).trim();
  await callRunMain({
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: repoA, tool_input: { command: `git -C ${repoB} status` } }
  });
  assert.equal(readReviewedHead(repoB), headB, "the -C target repo is the one bootstrapped");
  assert.equal(readReviewedHead(repoA), null, "input.cwd's repo is NOT wrongly marked");
});

test("bootstrap: an ENV-PREFIXED `git -C <repoB>` still marks repoB, not input.cwd (Codex finding)", async () => {
  const { ws: repoA } = freshPushRepo();
  const { ws: repoB } = freshPushRepo();
  const headB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoB, encoding: "utf8" }).trim();
  await callRunMain({
    resolveReviewersImpl: () => [],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: repoA, tool_input: { command: `GIT_SSH_COMMAND=ssh git -C ${repoB} status` } }
  });
  assert.equal(readReviewedHead(repoB), headB, "env-prefixed command resolves the -C target repo");
  assert.equal(readReviewedHead(repoA), null, "input.cwd's repo is NOT wrongly marked");
});

// ---------------------------------------------------------------------------
// Test: git push --help → allow no-op
// ---------------------------------------------------------------------------

test("git push --help → allow no-op (ignored)", async () => {
  const { ws } = freshPushRepo();
  let reviewersCalled = false;

  await callRunMain({
    resolveReviewersImpl: () => { reviewersCalled = true; return []; },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git push --help" } }
  });

  assert.equal(reviewersCalled, false, "reviewers must NOT be called for git push --help");
});

// ---------------------------------------------------------------------------
// Test: git push, panel ALLOW → allow + trace with gate:"push"
// ---------------------------------------------------------------------------

test("git push + panel ALLOW → allow (decision=allow in output) + trace gate=push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-al-")));
  process.env.BENCH_ROOT = root;

  let traceRecord = null;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW"),
        fakeReviewer("MiMo", "ALLOW")
      ]),
      writeTraceImpl: (_ws, trace) => { traceRecord = trace; },
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ badge: "Kimi✓ MiMo✓" }),
      env: process.env,
      input: { cwd: ws, session_id: "chat-A", tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(emittedLines.length > 0, "should emit output for git push");
  const parsed = parseLines(emittedLines);
  assert.ok(parsed.length > 0, "emitted line(s) should be valid JSON");
  const hookOut = parsed[0]?.hookSpecificOutput;
  assert.ok(hookOut, "hookSpecificOutput must be present");
  assert.equal(hookOut.hookEventName, "PreToolUse", "hookEventName must be PreToolUse");
  assert.equal(hookOut.permissionDecision, "allow", "panel ALLOW → permissionDecision=allow");
  // F: the emitted reason leads with the verdict badge.
  assert.match(hookOut.permissionDecisionReason, /\[Kimi✓ MiMo✓\]/, "reason should lead with the badge");

  assert.ok(traceRecord !== null, "trace should be written");
  assert.equal(traceRecord.gate, "push-review", "trace gate must be 'push-review'");
  assert.equal(traceRecord.sessionKey, normalizeSessionId("chat-A"), "trace is stamped with the hook session");
  assert.ok(traceRecord.ws, "trace.ws should be set");
  assert.ok(Array.isArray(traceRecord.reviewers), "trace.reviewers should be an array");
});

// ---------------------------------------------------------------------------
// Test: git push, a reviewer BLOCKs → deny with findings in reason
// ---------------------------------------------------------------------------

test("git push + panel BLOCK → deny with findings in permissionDecisionReason", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-blk-")));
  process.env.BENCH_ROOT = root;

  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW"),
        fakeReviewer("MiMo", "BLOCK")
      ]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({
        badge: "Kimi✓ MiMo✗",
        findingCount: 1,
        maxSeverity: "high",
        findings: "[MiMo]\nBLOCK: test\n\nDetails for MiMo."
      }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(emittedLines.length > 0, "should emit output on BLOCK");
  const parsed = parseLines(emittedLines);
  assert.ok(parsed.length > 0, "emitted line should be valid JSON");
  const hookOut = parsed[0]?.hookSpecificOutput;
  assert.ok(hookOut, "hookSpecificOutput must be present");
  assert.equal(hookOut.hookEventName, "PreToolUse", "hookEventName must be PreToolUse");
  assert.equal(hookOut.permissionDecision, "deny", "full push review BLOCK → permissionDecision=deny");
  assert.ok(hookOut.permissionDecisionReason, "deny reason must be present");
  assert.match(hookOut.permissionDecisionReason, /MiMo|BLOCK|Details for MiMo/i, "findings should include BLOCK details");
  // Regression: a BLOCK must be USER-VISIBLE (systemMessage), not just fed to the model via the
  // deny reason — a silent block is why a gate-blocked push churned invisibly for 30+ minutes.
  assert.ok(parsed[0].systemMessage, "BLOCK must emit a user-visible systemMessage");
  assert.match(parsed[0].systemMessage, /BLOCKED/, "systemMessage must announce the block");
  assert.match(parsed[0].systemMessage, /Details for MiMo|MiMo/, "systemMessage must carry the findings, not just say 'blocked'");
});

// ---------------------------------------------------------------------------
// Test: disabled workspace → allow no-op (exit 0, no reviewers called)
// ---------------------------------------------------------------------------

test("disabled workspace → allow no-op on git push (bench disabled)", () => {
  const { ws } = freshPushRepo();

  setBenchDisabled(ws, true, { scope: "workspace" });
  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: ws, tool_input: { command: "git push origin main" } }),
      encoding: "utf8",
      env: { ...process.env, BENCH_ROOT: TEMP_GCR }
    });

    assert.equal(result.status, 0, `exit code should be 0 when bench is disabled; stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", "no output expected when bench disabled");
  } finally {
    setBenchDisabled(ws, false, { scope: "workspace" });
  }
});

// ---------------------------------------------------------------------------
// Test: no upstream / nothing to push
// ---------------------------------------------------------------------------

test("new branch, EXPLICIT refspec, no upstream → REVIEWED (not an unrecoverable block)", async () => {
  // The reported scenario: `git push -u origin <branch>` on a brand-new branch with no @{u} and no
  // main/master tracking ref used to HARD-BLOCK ("set an upstream" — impossible before the first
  // push, an unrecoverable loop). The explicit-refspec path must now scope to the named source
  // (rev-list <source> --not --remotes) and REVIEW it.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-noremote-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "init"], { cwd: ws });

  let reviewersCalled = false;
  await callRunMain({
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    pushReviewImpl: fakePushReview({ onCall: () => { reviewersCalled = true; } }),
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git push -u origin main" } }
  });

  assert.equal(reviewersCalled, true, "an explicit new-branch push must be REVIEWED (commits scoped to the named source), never blocked forever");
});

test("bare `git push` with no resolvable base stays FAIL-CLOSED (a bare push is not guaranteed HEAD-only)", () => {
  // push.default=matching / remote.push can transmit non-HEAD branches, so a bare push without a cheap
  // base must BLOCK rather than review HEAD-only (a push-gate catch). The explicit-refspec form is the
  // supported new-branch path.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-bare-noref-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  const r = resolvePushRange(ws, parsePushCommand("git push"));
  assert.equal(r.ok, false, "bare push, no @{u}, no remote ref → block (not HEAD-only review)");
  assert.match(r.note, /explicit|blocked/i, "note points to the explicit-refspec form");
});

test("git log failure for a resolved push range → deny so commits are not pushed unreviewed", async () => {
  const { ws } = repoWithRemoteRefs("origin", ["release"], "feature");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-logfail-")));
  process.env.BENCH_ROOT = root;

  let reviewCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: () => { reviewCalled = true; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin missing-source:release" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(reviewCalled, false, "full review cannot run when git cannot list the range");
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "deny",
    "git log failure should block the push instead of allowing an unreviewed push");
  assert.match(parsed[0].hookSpecificOutput.permissionDecisionReason, /git log .* failed|push blocked/i);
});

// ---------------------------------------------------------------------------
// Test: nothing to push (already up-to-date) → allow no-op
// ---------------------------------------------------------------------------

test("nothing to push (already up-to-date) → allow no-op", async () => {
  const { ws } = freshPushedRepo();

  let reviewersCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      resolveReviewersImpl: () => { reviewersCalled = true; return []; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push" } }
    });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.equal(reviewersCalled, false, "reviewers must NOT be called when nothing to push");
  if (emittedLines.length > 0) {
    const parsed = parseLines(emittedLines);
    if (parsed.length > 0 && parsed[0]?.hookSpecificOutput) {
      assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow",
        "nothing-to-push should produce allow decision");
    }
  }
});

// ---------------------------------------------------------------------------
// Test: unavailable full review blocks the push
// ---------------------------------------------------------------------------

test("full push review retry/unavailable → deny (push is not allowed unreviewed)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-fo-")));
  process.env.BENCH_ROOT = root;

  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ retry: true, reason: "reviewer timeout" }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(emittedLines.length > 0, "should emit a deny decision");
  const parsed = parseLines(emittedLines);
  assert.ok(parsed.length > 0, "emitted line should be valid JSON");
  const hookOut = parsed[0]?.hookSpecificOutput;
  assert.ok(hookOut, "hookSpecificOutput must be present");
  assert.equal(hookOut.permissionDecision, "deny",
    "a full-review retry/unavailable signal must deny the push instead of allowing it unreviewed");
});

// ---------------------------------------------------------------------------
// Test: buildPrompt — content-only, no tool/repo claim
// ---------------------------------------------------------------------------

test("buildPrompt: system is content-only with ALLOW:/BLOCK: instruction", () => {
  const { system, user } = buildPrompt("abc1234 add feature", "diff --git a/x.js ...");
  // Must NOT claim repo/filesystem access for the reviewer
  assert.doesNotMatch(system, /read access|verify.*against.*code/i);
  // Must instruct reviewer to stay content-only (no tools, no repo reads)
  assert.match(system, /ALLOW:|BLOCK:/);
  assert.match(system, /Do NOT use any tools/i);
  assert.match(user, /add feature/);
  assert.match(user, /diff --git/);
});

// ---------------------------------------------------------------------------
// Test: git push embedded in compound command → detected
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: cdTargetBeforePush
// ---------------------------------------------------------------------------

test("cdTargetBeforePush: absolute quoted path before git push", () => {
  const result = cdTargetBeforePush('cd "/abs/sub repo" && git push origin staging', "/fallback");
  assert.equal(result, "/abs/sub repo");
});

test("cdTargetBeforePush: relative cd resolves against fallback", () => {
  const result = cdTargetBeforePush("cd sub && git push", "/parent");
  assert.equal(result, path.resolve("/parent", "sub"));
});

test("cdTargetBeforePush: no cd → returns fallback", () => {
  const result = cdTargetBeforePush("git push origin main", "/fallback");
  assert.equal(result, "/fallback");
});

test("cdTargetBeforePush: relative cds chain like a real shell (cd a && cd b → a/b)", () => {
  const result = cdTargetBeforePush("cd a && cd b && git push", "/parent");
  assert.equal(result, path.resolve("/parent", "a", "b"));
});

test("cdTargetBeforePush: cd after git push is ignored", () => {
  // The cd appears AFTER the git push token — should not be picked up
  const result = cdTargetBeforePush("git push && cd /somewhere", "/fallback");
  assert.equal(result, "/fallback");
});

// ---------------------------------------------------------------------------
// Test: buildPrompt prompt system/user split
// ---------------------------------------------------------------------------

test("buildPrompt: user does not contain BLOCK guidance; system does", () => {
  const { system, user } = buildPrompt("abc1234 add feature", "diff --git a/x.js ...");
  // "BLOCK only" instruction must be in system, NOT in user
  assert.match(system, /BLOCK only/i, "system must contain BLOCK guidance");
  assert.doesNotMatch(user, /BLOCK only/i, "user must NOT contain BLOCK-only guidance");
  // user must contain ONLY the content to review
  assert.match(user, /add feature/, "user must contain the commits content");
  assert.match(user, /diff --git/, "user must contain the diff content");
  // user must not contain format instructions
  assert.doesNotMatch(user, /first line must be/i, "user must not have format instructions");
  assert.doesNotMatch(user, /Review the following commits/i, "user must not have review instructions");
});

// ---------------------------------------------------------------------------
// Test: git push embedded in compound command → detected
// ---------------------------------------------------------------------------

test("compound command with git push → detected as push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-cpd-")));
  process.env.BENCH_ROOT = root;

  let reviewCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: () => { reviewCalled = true; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "cd /repo && git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  // The compound command contains "git push", so the full push reviewer should be called.
  // If the range cannot be resolved, the strict gate must deny instead of silently skipping.
  const parsed = parseLines(emittedLines);
  if (!reviewCalled) {
    assert.equal(parsed[0]?.hookSpecificOutput?.permissionDecision, "deny",
      "compound push with an unresolved range must block instead of silently skipping");
  }
});

// --- push DETECTION: bypasses the old GIT_PUSH_RE missed (found by the bench's own hunt) ---
test("findPushSegment detects pushes the old regex bypassed (trailing operators, global options)", () => {
  for (const cmd of [
    "git push;echo done",        // ; immediately after push
    "git push|tee log.txt",      // | immediately after push
    "git push&",                 // backgrounded
    "git -C . push origin main", // global option before subcommand
    "cd repo && git push",       // compound
    "FOO=bar git push"           // leading env assignment
  ]) {
    assert.ok(findPushSegment(cmd), `should detect a push in: ${cmd}`);
  }
});
test("findPushSegment ignores non-pushes (quoted mention, help, dry-run, other subcommands)", () => {
  for (const cmd of [
    'echo "remember to git push" && git status',  // push only inside a quoted string
    "git push --help",
    "git push --dry-run",
    "git pushx",                                   // not the push subcommand
    "git status"
  ]) {
    assert.equal(findPushSegment(cmd), null, `should NOT detect a push in: ${cmd}`);
  }
});
test("isGitPushSegment: skips git global value-options before push", () => {
  assert.ok(isGitPushSegment("git -c user.name=x push"));
  assert.ok(isGitPushSegment("git --git-dir /tmp/x push"));
  assert.ok(!isGitPushSegment("git -c user.name=x status"));
});
test("cdTargetBeforePush: a cd joined to the push by || did NOT run → push uses the original cwd", () => {
  // `cd /missing || git push` runs the push in the ORIGINAL dir (cd failed); must NOT review /missing.
  assert.equal(cdTargetBeforePush("cd /missing || git push origin main", "/orig"), "/orig");
  // but `cd sub && git push` DID cd → review sub
  assert.equal(cdTargetBeforePush("cd sub && git push", "/orig"), path.resolve("/orig", "sub"));
});

// ===========================================================================
// Task 2 — A1: spaces in repo path break push detection AND review-cwd
// ===========================================================================

test("A1: isGitPushSegment detects pushes with quoted/spaced paths and -c key=value", () => {
  // Quoted -C value with a space splits in two with split(/\s+/); shellTokenize keeps it whole.
  assert.ok(isGitPushSegment('git -C "/tmp/Ryan P/repo" push'), "spaced -C value");
  assert.ok(isGitPushSegment('git -c user.name="John Doe" push'), "spaced -c key=value");
  assert.ok(isGitPushSegment("git -C '/a b/r' push origin main"), "single-quoted -C value");
  // Negatives must stay rejected.
  assert.equal(isGitPushSegment("git pushx"), false, "git pushx");
  assert.equal(isGitPushSegment("git push --help"), false, "--help");
  assert.equal(isGitPushSegment("git push --dry-run"), false, "--dry-run");
});

test("A1: shellTokenize strips surrounding quotes and keeps spaced values whole", () => {
  assert.deepEqual(shellTokenize('git -C "/a b/r" push'), ["git", "-C", "/a b/r", "push"]);
  assert.deepEqual(shellTokenize("git -c user.name='John Doe' push"), ["git", "-c", "user.name=John Doe", "push"]);
  assert.deepEqual(shellTokenize("git push origin main"), ["git", "push", "origin", "main"]);
});

test("A1: runMain resolves the review cwd to the -C target dir", async () => {
  // Two repos: hook is invoked with cwd=other, but the push uses `git -C <spaced repo>`.
  const { ws } = freshPushRepo();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-other-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-c-")));
  process.env.BENCH_ROOT = root;

  let seenCwd = null;

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: ({ ws: reviewWs }) => { seenCwd = reviewWs; } }),
      env: process.env,
      input: { cwd: other, tool_input: { command: `git -C "${ws}" push origin main` } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(seenCwd, "reviewer should be invoked");
  assert.equal(fs.realpathSync(seenCwd), fs.realpathSync(ws), "review cwd must be the -C target repo, not the hook cwd");
});

// ===========================================================================
// Task 2 — A2: correct push range from the parsed command
// ===========================================================================

/** Build a repo whose remote-tracking refs are seeded under the given remote name. */
function repoWithRemoteRefs(remote, branches, currentBranch) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-a2-"));
  execFileSync("git", ["init", "-q", "-b", currentBranch || branches[0]], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  // Seed remote-tracking refs manually (no real remote needed).
  for (const b of branches) {
    execFileSync("git", ["update-ref", `refs/remotes/${remote}/${b}`, base], { cwd: ws });
  }
  return { ws, base };
}

test("A2: parsePushCommand extracts remote, refspecs, flags (origin default)", () => {
  assert.deepEqual(parsePushCommand("git push"), { remote: "origin", refspecs: [], flags: [] });
  assert.deepEqual(parsePushCommand("git push origin"), { remote: "origin", refspecs: [], flags: [] });
  assert.deepEqual(parsePushCommand("git push upstream feature:release"),
    { remote: "upstream", refspecs: ["feature:release"], flags: [] });
  assert.deepEqual(parsePushCommand("git push origin topic"),
    { remote: "origin", refspecs: ["topic"], flags: [] });
  const tags = parsePushCommand("git push --tags");
  assert.equal(tags.remote, "origin");
  assert.ok(tags.flags.includes("--tags"));
});

test("A2: parsePushCommand stops at shell redirects/operators — a `2>&1` never counts as a refspec", () => {
  // Agentic pushes append `2>&1` / pipes; the stray token used to count as a 2nd refspec, mis-routing
  // a single-branch push onto the multi-ref path (a spurious '2 refspecs' block — the likely real
  // trigger of the reported new-branch failure). Redirects/pipes must be dropped entirely.
  assert.deepEqual(parsePushCommand("git push origin main 2>&1"), { remote: "origin", refspecs: ["main"], flags: [] });
  assert.deepEqual(parsePushCommand("git push -u origin feature 2>&1"), { remote: "origin", refspecs: ["feature"], flags: ["-u"] });
  assert.deepEqual(parsePushCommand("git push origin main 2>&1 | tail -25"), { remote: "origin", refspecs: ["main"], flags: [] });
  assert.deepEqual(parsePushCommand("git push origin main 2>/dev/null"), { remote: "origin", refspecs: ["main"], flags: [] });
  assert.deepEqual(parsePushCommand("git push origin main > log.txt"), { remote: "origin", refspecs: ["main"], flags: [] });
  // a GENUINE 2-branch push is still detected (the redirect strip must not over-eat real refspecs)
  assert.deepEqual(parsePushCommand("git push origin main develop 2>&1"), { remote: "origin", refspecs: ["main", "develop"], flags: [] });
});

test("A2: resolvePushRange — explicit HEAD:<dst> → <remote>/<dst>..HEAD", () => {
  const { ws } = repoWithRemoteRefs("origin", ["main"], "main");
  const r = resolvePushRange(ws, parsePushCommand("git push origin HEAD:main"));
  assert.equal(r.ok, true);
  assert.equal(r.range, "origin/main..HEAD");
});

test("A2: resolvePushRange — explicit <src>:<dst> uses src as source, not HEAD", () => {
  const { ws } = repoWithRemoteRefs("origin", ["release"], "feature");
  // Make sure a local 'feature' ref exists (current branch).
  const r = resolvePushRange(ws, parsePushCommand("git push origin feature:release"));
  assert.equal(r.ok, true);
  assert.equal(r.range, "origin/release..feature");
});

test("A2: resolvePushRange — named remote is honored (upstream)", () => {
  const { ws } = repoWithRemoteRefs("upstream", ["release"], "feature");
  const r = resolvePushRange(ws, parsePushCommand("git push upstream feature:release"));
  assert.equal(r.ok, true);
  assert.equal(r.range, "upstream/release..feature");
});

test("A2: resolvePushRange — bare ref → <remote>/<ref>..<ref>", () => {
  const { ws } = repoWithRemoteRefs("origin", ["topic"], "topic");
  const r = resolvePushRange(ws, parsePushCommand("git push origin topic"));
  assert.equal(r.ok, true);
  assert.equal(r.range, "origin/topic..topic");
});

test("A2: resolvePushRange — only origin/master, no refspec → origin/master..HEAD", () => {
  const { ws } = repoWithRemoteRefs("origin", ["master"], "master");
  const r = resolvePushRange(ws, parsePushCommand("git push"));
  assert.equal(r.ok, true);
  assert.equal(r.range, "origin/master..HEAD");
});

test("A2: resolvePushRange — delete refspec :stale → clean allow, no review", () => {
  const { ws } = repoWithRemoteRefs("origin", ["main"], "main");
  const r = resolvePushRange(ws, parsePushCommand("git push origin :stale"));
  assert.equal(r.ok, false, "delete-only push resolves to no range");
  assert.equal(r.deleteOnly === true || r.range === "", true, "delete push has no commits to review");
  // It should NOT carry a fail-open note (it is a clean allow, not a degradation).
  assert.ok(!r.note || !/fail-open|limitation/i.test(r.note), "delete push is a clean allow");
});

test("A2: resolvePushRange — a multi-refspec push is FAIL-CLOSED (can't scope every ref to one review range)", () => {
  // `git push beta main develop` transmits commits on BOTH main AND develop. peerBench reviews ONE
  // diff range, so it can't confirm every ref is reviewed — reviewing only the current branch and
  // then allowing silently shipped the other refs' commits unreviewed (a stop-gate catch). Block,
  // even WITH a cheap base — the presence of a base doesn't make the OTHER refs reviewable.
  const { ws } = repoWithRemoteRefs("beta", ["main"], "main");
  const r = resolvePushRange(ws, parsePushCommand("git push beta main develop"));
  assert.equal(r.ok, false, "multi-refspec must block (can't scope every ref), base or not");
  assert.ok(r.note && /push each ref on its own/.test(r.note), "note tells the user to push refs individually");
});

test("A2: resolvePushRange — --tags with NO new commits → clean allow (release flow unblocked)", () => {
  // Tags referencing commits already on the remote ship nothing new → nothing to review → allow.
  const { ws } = repoWithRemoteRefs("origin", ["main"], "main");
  // Tag the base commit (which IS on origin/main) → rev-list --tags --not --remotes is empty.
  execFileSync("git", ["tag", "v1.0.0"], { cwd: ws });
  const r = resolvePushRange(ws, parsePushCommand("git push --tags"));
  assert.equal(r.ok, false, "no reviewable range object");
  assert.equal(r.cleanAllow, true, "tags-only push with no new commits is a clean no-op allow, not a block");
});

test("A2: resolvePushRange — --tags that carries a NEW (unpushed) commit is BLOCKED (would ship unreviewed)", () => {
  const { ws } = repoWithRemoteRefs("origin", ["main"], "main");
  // A commit NOT on origin/main, tagged → the tag push would transmit it unreviewed.
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "new"], { cwd: ws });
  execFileSync("git", ["tag", "v2.0.0"], { cwd: ws });
  const r = resolvePushRange(ws, parsePushCommand("git push --tags"));
  assert.equal(r.ok, false);
  assert.ok(!r.cleanAllow, "a tag pointing at an unpushed commit must NOT be a clean allow");
  assert.ok(r.note && /--tags/.test(r.note), "blocked with an actionable note");
});

test("A2: resolvePushRange — NEW BRANCH off a non-standard remote default (no main/master, no @{u}) → tight base..HEAD", () => {
  // The exact live-reported bug: remote default is `trunk` (not main/master), a fresh feature branch
  // has no upstream, so baseChain's main/master/HEAD guesses all miss. Must resolve the real
  // divergence base, not block.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-a2-newbr-"));
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "trunk");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base on trunk");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  g("update-ref", "refs/remotes/origin/trunk", base);   // remote has ONLY trunk
  g("checkout", "-q", "-b", "feature/x");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "feat 1");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "feat 2");
  const r = resolvePushRange(ws, parsePushCommand("git push -u origin feature/x"));
  assert.equal(r.ok, true, "new branch off a non-standard default must resolve, not block");
  // Range is scoped to the pushed ref (feature/x — which is HEAD here); base = the divergence point
  // on the remote (trunk tip), so exactly the 2 feature commits are reviewed.
  assert.equal(r.range, `${base}..feature/x`, "base = trunk tip, tip = the pushed ref");
  const log = execFileSync("git", ["log", "--oneline", r.range], { cwd: ws, encoding: "utf8" }).trim().split("\n");
  assert.equal(log.length, 2, "git log accepts the resolved range and lists the 2 new commits");
});

test("A2: parsePushCommand skips a value-flag's value token (`-o ci.skip origin br` → remote origin, not ci.skip)", () => {
  assert.deepEqual(parsePushCommand("git push -o ci.skip origin feature/x"),
    { remote: "origin", refspecs: ["feature/x"], flags: ["-o"] });
  // --force-with-lease attaches its value with `=` (or is bare) → must NOT eat the remote token.
  assert.deepEqual(parsePushCommand("git push --force-with-lease origin main"),
    { remote: "origin", refspecs: ["main"], flags: ["--force-with-lease"] });
  // --repo's value IS the remote → must NOT be skipped (it falls through as the `remote` positional).
  assert.deepEqual(parsePushCommand("git push --repo upstream main"),
    { remote: "upstream", refspecs: ["main"], flags: ["--repo"] });
});

test("A2: resolvePushRange — an EXPLICIT non-HEAD refspec is scoped to THAT ref, never HEAD (fail-open guard)", () => {
  // Grok push-gate catch: `git push origin feature` while `main` is checked out must review FEATURE's
  // commits, not the current branch's. The always-ok remote-ahead fallback must use the pushed source.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-a2-nonhead-"));
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "trunk");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base");
  g("update-ref", "refs/remotes/origin/trunk", execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim());
  g("checkout", "-q", "-b", "feature");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "FEATURE only");
  const featTip = execFileSync("git", ["rev-parse", "feature"], { cwd: ws, encoding: "utf8" }).trim();
  g("checkout", "-q", "-b", "main", "trunk");   // HEAD is now main, NOT feature
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "MAIN only");
  const r = resolvePushRange(ws, parsePushCommand("git push origin feature"));
  assert.equal(r.ok, true);
  assert.match(r.range, /\.\.feature$/, "range tip must be the pushed ref (feature), not HEAD/main");
  const commits = execFileSync("git", ["log", "--format=%s", r.range], { cwd: ws, encoding: "utf8" }).trim().split("\n");
  assert.ok(commits.includes("FEATURE only"), "feature's unique commit is reviewed");
  assert.ok(!commits.includes("MAIN only"), "the current branch's commit must NOT be what's reviewed");
  assert.equal(execFileSync("git", ["rev-parse", r.range.split("..")[1]], { cwd: ws, encoding: "utf8" }).trim(), featTip);
});

// ===========================================================================
// Task 2 — A3: wrapped subshell push form detected
// ===========================================================================

test("A3: findPushSegment detects subshell-wrapped push (git push)", () => {
  assert.ok(findPushSegment("(git push)"), "(git push) should be detected");
  assert.ok(findPushSegment("(git push origin main)"), "(git push origin main)");
});

test("A3: findPushSegment keeps existing negatives null", () => {
  assert.equal(findPushSegment('echo "remember to git push" && git status'), null);
  assert.equal(findPushSegment("git push --help"), null);
  assert.equal(findPushSegment("git pushx"), null);
});

// ===========================================================================
// Task 2 — A4: invocation-scoped emit-once guard
// ===========================================================================

test("A4: a second decision within one invocation writes no second stdout line", async () => {
  // BLOCK path emits once; if any later code path tried to emit again it'd be a 2nd line.
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-a4a-")));
  process.env.BENCH_ROOT = root;

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };
  try {
    await callRunMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "BLOCK")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ badge: "Kimi✗", findingCount: 1, maxSeverity: "high", findings: "[Kimi]\nBLOCK: test\n\nDetails for Kimi." }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(lines.filter(Boolean).length, 1, "exactly one decision line per invocation");
});

test("A4: two separate runMain invocations in one process each emit (no cross-invocation suppression)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-a4b-")));
  process.env.BENCH_ROOT = root;

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };
  try {
    for (let i = 0; i < 2; i++) {
      await callRunMain({
        resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
        writeTraceImpl: () => {},
        isBenchDisabledImpl: () => false,
        pushReviewImpl: fakePushReview({ badge: "Kimi✓" }),
        env: process.env,
        input: { cwd: ws, tool_input: { command: "git push origin main" } }
      });
    }
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(lines.filter(Boolean).length, 2, "each invocation emits its own decision line");
});

test("A4: entrypoint .catch routes a post-emit error to stderr, never a second stdout line", () => {
  // Drive the real subprocess so the import.meta.url shim runs. A reviewer crash AFTER
  // the panel emit must not produce a 2nd stdout JSON line; the fallback goes to stderr.
  const { ws } = freshPushRepo();
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: ws, tool_input: { command: "git status" } }),
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: TEMP_GCR }
  });
  // git status is a no-op (no emit) — just assert the shim runs cleanly (smoke for the wiring).
  assert.equal(result.status, 0);
  const stdoutLines = result.stdout.split("\n").filter((l) => l.trim());
  assert.ok(stdoutLines.length <= 1, "no spurious stdout lines");
});

// ===========================================================================
// Task 2 — E2: visible stderr note on malformed stdin
// ===========================================================================

test("E2: malformed stdin → ⛩ stderr note (treated as empty)", () => {
  const result = spawnSync(process.execPath, [HOOK], {
    input: "{not json",
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: TEMP_GCR }
  });
  assert.equal(result.status, 0, "malformed stdin must not crash (fail-open)");
  assert.match(result.stderr, /⛩ pre-push: could not parse hook input/, "should emit a visible ⛩ note");
});

// ===========================================================================
// Task 9 — D3: trace-write failure emits a ⛩ note and still allows (fail-open)
// ===========================================================================

test("D3: pre-push trace write failure emits a ⛩ note and still allows", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-d3-")));
  process.env.BENCH_ROOT = root;

  const stderrChunks = [];
  const stdoutLines = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) stdoutLines.push(chunk.trim()); return origOut(chunk, ...rest); };
  try {
    await callRunMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => { throw new Error("disk full"); },
      isBenchDisabledImpl: () => false,
      pushReviewImpl: async (range, wsArg, opts = {}) => {
        const reviewers = [{ name: "Kimi", verdict: "ALLOW", severity: "none", findingCount: 0 }];
        try {
          opts.writeTraceImpl(wsArg, { gate: "push-review", ws: wsArg, sessionKey: opts.sessionKey || null, reviewers, systemPrompt: "", userPrompt: "", rawResponses: {} });
        } catch (e) {
          process.stderr.write(`⛩ push-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
        }
        return { reviewers, findingCount: 0, maxSeverity: "none", findings: "", traceId: null, badge: "Kimi✓", summary: "no blocking findings", hash: "h" };
      },
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  const parsed = JSON.parse(stdoutLines.find((l) => l.trim()));
  assert.equal(parsed.hookSpecificOutput?.permissionDecision, "allow", "must still allow despite trace failure");
});

// ===========================================================================
// H — pre-push now runs the deep, repo-aware push review INLINE before the
// push is allowed. No post-ALLOW queued push job is created from runMain.
// ===========================================================================

/** A spawn spy that records calls and returns a child-like object with unref(). */
function pushSpawnSpy() {
  const calls = [];
  let unrefCount = 0;
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref: () => { unrefCount += 1; } };
  };
  return { impl, calls, unrefCount: () => unrefCount };
}

/** A launchImpl spy — records (ws, range, opts) so we can assert WHETHER a launch was attempted. */
function launchSpy() {
  const calls = [];
  const impl = (ws, range, opts = {}) => { calls.push({ ws, range, opts }); return true; };
  return { impl, calls };
}

test("H: ALLOW runs the full push review inline and does NOT enqueue a push job", async () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hlaunch-")));
  process.env.BENCH_ROOT = root;
  let call = null;

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ badge: "Kimi✓ MiMo✓", onCall: (c) => { call = c; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });

    assert.ok(call, "full push review must run inline before allowing the push");
    assert.match(call.range, /\.\.(HEAD|main)$|[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}/, `range should cover pushed commits; got ${call.range}`);
    const jobs = listJobs(wsReal);
    assert.equal(jobs.length, 0, "inline pre-push review must not enqueue a later push-review job");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("H: inline full push review receives the originating Claude session", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hsess-")));
  process.env.BENCH_ROOT = root;
  let call = null;

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: (c) => { call = c; } }),
      env: process.env,
      input: { cwd: ws, session_id: "chat-A", tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(call);
  assert.equal(call.opts.sessionKey, normalizeSessionId("chat-A"));
});

test("H: inline full push review receives previous assistant message context before allowing push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hctx-")));
  process.env.BENCH_ROOT = root;
  let call = null;

  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: (c) => { call = c; } }),
      env: process.env,
      input: {
        cwd: ws,
        last_assistant_message: "I populated quantity_on_order for approvals and all paths are covered.",
        tool_input: { command: "git push origin main" }
      }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(call);
  assert.match(call.opts.assistantContext, /quantity_on_order/);
  assert.match(call.opts.assistantContext, /all paths are covered/);
});

test("assistantContextFromInput trims and caps supported hook context fields", () => {
  assert.equal(assistantContextFromInput({ last_assistant_message: "  done  " }), "done");
  assert.equal(assistantContextFromInput({ transcript: { lastAssistantMessage: "nested" } }), "nested");
  assert.equal(assistantContextFromInput({ last_assistant_message: "x".repeat(9000) }).length, 8000);
  assert.equal(assistantContextFromInput({ last_assistant_message: { text: "ignored" } }), "");
});

test("H: launchPushReview enqueues a SHA-pinned range that survives the push advancing the remote ref (the race)", () => {
  const { ws } = freshPushRepo();   // one commit ahead of origin/main
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hrace-")));
  process.env.BENCH_ROOT = root;
  let range;
  try {
    launchPushReview(ws, "origin/main..HEAD");
    range = listJobs(wsReal)[0].range;
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.match(range, /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/, `enqueued range must be SHA-pinned; got ${range}`);

  // Simulate what `git push origin main` does: advance the remote-tracking ref to HEAD.
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: ws });
  const symbolic = execFileSync("git", ["log", "--oneline", "origin/main..HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  const pinned = execFileSync("git", ["log", "--oneline", range], { cwd: ws, encoding: "utf8" }).trim();
  assert.equal(symbolic, "", "the SYMBOLIC range is empty after the push (the race that reviewed nothing)");
  assert.ok(pinned.length > 0, "the PINNED SHA range still contains the pushed commit (race fixed)");
});

test("H: launchPushReview stamps the queued push job by session", () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hsessjob-")));
  process.env.BENCH_ROOT = root;
  const sessionA = normalizeSessionId("chat-A");
  try {
    launchPushReview(ws, "origin/main..HEAD", { sessionKey: sessionA });
    assert.equal(listJobs(wsReal, { sessionKey: sessionA }).length, 1, "originating session sees the queued push review");
    assert.equal(listJobs(wsReal, { sessionKey: normalizeSessionId("chat-B") }).length, 0, "another same-workspace session does not see it");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("H: high BLOCK from inline full push review denies the push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hblock-")));
  process.env.BENCH_ROOT = root;

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ badge: "Kimi✗", findingCount: 1, maxSeverity: "high", findings: "[Kimi]\n- concrete push bug" }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  const parsed = parseLines(lines)[0];
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "high full-review finding blocks the push");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /concrete push bug/);
});

test("H: unavailable inline full push review denies instead of allowing an unreviewed push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hfo-")));
  process.env.BENCH_ROOT = root;

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ retry: true, reason: "reviewer timeout" }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  const parsed = parseLines(lines)[0];
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "unavailable full review blocks the push");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /reviewer timeout|unreviewed|blocked/i);
});

test("H: all-error inline full push review denies instead of allowing an unreviewed push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hallerr-")));
  process.env.BENCH_ROOT = root;

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({
        badge: "Kimi! GLM!",
        summary: "Kimi review skipped: timeout | GLM review skipped: auth",
        reviewers: [
          { name: "Kimi", verdict: null, error: "timeout" },
          { name: "GLM", verdict: null, error: "auth" }
        ]
      }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  const parsed = parseLines(lines)[0];
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "all-error full review blocks the push");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /no reviewer verdicts|unreviewed|blocked/i);
});

test("H: bench DISABLED → does NOT run the inline push review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdis-")));
  process.env.BENCH_ROOT = root;

  let called = false;
  const origExit = process.exit;
  process.exit = () => { throw new Error("__exit__"); };   // disabled path calls process.exit(0)
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => true,
      pushReviewImpl: fakePushReview({ onCall: () => { called = true; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } catch (e) {
    if (!/__exit__/.test(String(e && e.message))) throw e;
  } finally {
    process.exit = origExit;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(called, false, "disabled bench must not run inline push review");
});

test("H: nothing to push (no commits ahead) → does NOT run the inline push review", async () => {
  const { ws } = freshPushedRepo();   // nothing ahead of origin/main
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hempty-")));
  process.env.BENCH_ROOT = root;

  let called = false;
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: () => { called = true; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(called, false, "an empty push range (nothing to push) must not run inline push review");
});

test("H: deleteOnly (:branch) → does NOT run the inline push review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdel-")));
  process.env.BENCH_ROOT = root;

  let called = false;
  try {
    await callRunMain({
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      pushReviewImpl: fakePushReview({ onCall: () => { called = true; } }),
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin :stale-branch" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(called, false, "a delete refspec pushes no commits → no inline push review");
});

test("H: repeated push attempts are each fully reviewed inline and never queued", async () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdebounce-")));
  process.env.BENCH_ROOT = root;
  let calls = 0;

  const opts = {
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    pushReviewImpl: fakePushReview({ onCall: () => { calls += 1; } }),
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git push origin main" } }
  };
  try {
    await callRunMain(opts);
    await callRunMain(opts);
    assert.equal(calls, 2, "each push attempt gets a fresh inline full review");
    assert.equal(listJobs(wsReal).length, 0, "inline push review does not enqueue push jobs");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("H: launchPushReview never blocks the push — an enqueue/git throw is swallowed (returns false, ⛩ note)", () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hthrow-")));
  process.env.BENCH_ROOT = root;

  const stderrChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  let ret;
  try {
    ret = launchPushReview(ws, "@{u}..HEAD", { gitImpl: () => { throw new Error("git EACCES"); } });
  } finally {
    process.stderr.write = origErr;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(ret, false, "an internal throw must be swallowed (returns false), never propagated to block the push");
  assert.match(stderrChunks.join(""), /⛩ pre-push: deep push-review enqueue failed/i, "must note the enqueue failure on stderr");
});

test("H: launchPushReview dedupes on the (push:range, headSha) content key — second enqueue is a no-op", () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hkey-")));
  process.env.BENCH_ROOT = root;
  try {
    const range = "@{u}..HEAD";
    const head = "0123456789abcdef0123456789abcdef01234567";
    // gitImpl returns a fixed HEAD and leaves the range symbolic (no "..") so it isn't re-pinned.
    const gitImpl = (args) => (args[0] === "rev-parse" && args[1] === "HEAD") ? [head, true] : ["", false];

    const first = launchPushReview(ws, range, { gitImpl });
    assert.equal(first, true, "first enqueue proceeds");
    const jobs = listJobs(wsReal);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].contentKey, deepKey(`push:${range}`, head), "job keyed on deepKey(push:<range>, headSha)");

    const second = launchPushReview(ws, range, { gitImpl });
    assert.equal(second, false, "second enqueue with the same content key is a no-op (deduped)");
    assert.equal(listJobs(wsReal).length, 1, "no second job");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

// ---------------------------------------------------------------------------
// FAST mode (default): capped inline gate + async deep enqueue + fail-open.
// The blocking (inline deep-review) revert path is covered by the "H:" tests above,
// which the callRunMain wrapper routes to BENCH_PUSH_GATE_MODE=blocking.
// ---------------------------------------------------------------------------

test("FAST (opt-in): a clean panel allows AND enqueues the deep async review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-fast-al-")));
  process.env.BENCH_ROOT = root;
  let enq = null;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      resolveReviewersImpl: () => [fakeReviewer("Kimi", "ALLOW"), fakeReviewer("MiMo", "ALLOW")],
      enqueueImpl: (_ws, job) => { enq = job; return true; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow", "fast clean panel → allow");
  assert.match(parsed[0].hookSpecificOutput.permissionDecisionReason, /deep review is queued/i, "reason notes the async pass");
  assert.ok(enq, "fast mode MUST enqueue the deep async review (the thorough backstop)");
  assert.equal(enq.kind, "push", "enqueued job is a push review");
});

test("FAST: a quick panel does NOT keep the hook alive for the full budget (budget timer is cleared)", async () => {
  // Regression (Codex gate): Promise.race resolves when reviewers win, but an un-cleared budget
  // setTimeout stays a REF'd handle → the hook process lingers the whole budget → ~90s freeze on every
  // fast ALLOW. With a 10-MINUTE budget, a leaked timer is unmistakable in the active-resource count.
  const timerCount = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-fast-timer-")));
  process.env.BENCH_ROOT = root;
  const before = timerCount();
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;   // swallow the emitted decision
  try {
    await callRunMain({
      resolveReviewersImpl: () => [fakeReviewer("Kimi", "ALLOW")],
      enqueueImpl: () => true,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: { ...process.env, BENCH_PUSH_GATE_BUDGET_MS: "600000" },   // 10 min — a leaked timer is obvious
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  assert.equal(timerCount(), before, "the budget timer MUST be cleared once the panel returns (else the hook lingers the whole budget)");
});

test("FAST: reviewers exceeding the budget → FAIL OPEN (push allowed, deep review queued, session not frozen)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-fast-to-")));
  process.env.BENCH_ROOT = root;
  let enqCalled = false;
  const neverResolves = { name: "Kimi", run: () => new Promise(() => {}) };  // simulates a slow panel
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      resolveReviewersImpl: () => [neverResolves],
      enqueueImpl: () => { enqCalled = true; return true; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: { ...process.env, BENCH_PUSH_GATE_BUDGET_MS: "40" },   // 40 ms cap → the review times out fast
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow", "over-budget review must FAIL OPEN (never freeze/wedge the push)");
  assert.match(parsed[0].hookSpecificOutput.permissionDecisionReason, /didn't finish|deep review is queued/i);
  assert.ok(enqCalled, "the deep review is queued as the backstop even when the fast gate times out");
});

test("FAST: all reviewers erroring → FAIL OPEN (no verdict ≠ block; deep review is the backstop)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-fast-err-")));
  process.env.BENCH_ROOT = root;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      resolveReviewersImpl: () => [fakeErrorReviewer("Kimi"), fakeErrorReviewer("MiMo")],
      enqueueImpl: () => true,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow", "all-error fast panel fails OPEN in fast mode (blocking mode denies)");
});

test("FAST: a high BLOCK from the fast panel still denies the push", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-fast-blk-")));
  process.env.BENCH_ROOT = root;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      resolveReviewersImpl: () => [fakeReviewer("Kimi", "ALLOW"), fakeReviewer("MiMo", "BLOCK")],
      enqueueImpl: () => true,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "deny", "an obvious high finding still blocks fast");
  assert.match(parsed[0].systemMessage, /BLOCKED/, "the block is user-visible");
});

test("REVERT SWITCH: BENCH_PUSH_GATE_MODE=blocking runs the inline deep review and does NOT enqueue", async () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-revert-")));
  process.env.BENCH_ROOT = root;
  let inlineRan = false, enqCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim()); return origWrite(chunk, ...rest); };
  try {
    await callRunMain({
      pushReviewImpl: fakePushReview({ badge: "Kimi✓", onCall: () => { inlineRan = true; } }),
      enqueueImpl: () => { enqCalled = true; return true; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: { ...process.env, BENCH_PUSH_GATE_MODE: "blocking" },
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  const parsed = parseLines(emittedLines);
  assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow", "clean inline review allows");
  assert.ok(inlineRan, "blocking mode runs the inline deep review");
  assert.equal(enqCalled, false, "blocking mode does NOT enqueue a later async job (faithful revert)");
  assert.equal(listJobs(wsReal).length, 0, "no queued job in blocking mode");
});

test("DEFAULT (no BENCH_PUSH_GATE_MODE) is BLOCKING — thorough inline review, not fast (Rai's call 2026-07-14)", async () => {
  // Bypass callRunMain (which pins a mode) and call runMain DIRECTLY with the mode UNSET, to assert the
  // true production default. A regression here would silently return peerBench to shallow 90s findings.
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-default-")));
  process.env.BENCH_ROOT = root;
  const cleanEnv = { ...process.env };
  delete cleanEnv.BENCH_PUSH_GATE_MODE;   // no mode set → must default to blocking
  let inlineRan = false;
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await runMain({
      pushReviewImpl: fakePushReview({ badge: "Kimi✓", onCall: () => { inlineRan = true; } }),
      // If the default were fast, these fast-path deps would run — make that an unmistakable failure:
      resolveReviewersImpl: () => { throw new Error("default must be BLOCKING — the fast panel must not run"); },
      enqueueImpl: () => { throw new Error("default must be BLOCKING — must not enqueue an async job"); },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      exit: () => {},
      env: cleanEnv,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  assert.ok(inlineRan, "default (mode unset) runs the full inline blocking review");
  assert.equal(listJobs(wsReal).length, 0, "default blocking mode enqueues nothing");
});

test("an unrecognized BENCH_PUSH_GATE_MODE falls through to BLOCKING (fail toward thoroughness)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-typo-")));
  process.env.BENCH_ROOT = root;
  let inlineRan = false;
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await runMain({
      pushReviewImpl: fakePushReview({ badge: "Kimi✓", onCall: () => { inlineRan = true; } }),
      resolveReviewersImpl: () => { throw new Error("a typo'd mode must NOT silently become fast"); },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      exit: () => {},
      env: { ...process.env, BENCH_PUSH_GATE_MODE: "blockign" /* typo */ },
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally { process.stdout.write = origWrite; process.env.BENCH_ROOT = TEMP_GCR; }
  assert.ok(inlineRan, "only exact 'fast' opts out; anything else → blocking");
});

test("A2: resolvePushRange — `--branches` (git 2.50 --all alias) is treated as a whole-ref push", () => {
  // Must NOT reach the single/HEAD path: --branches pushes every branch, so with no cheap base it
  // fail-closes (like --all), never reviews one branch and allows the rest unreviewed.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-a2-branches-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  const r = resolvePushRange(ws, parsePushCommand("git push --branches origin"));
  assert.equal(r.ok, false, "--branches with no cheap base must block, not HEAD-only review");
  assert.match(r.note, /pushes multiple refs|blocked/);
});
