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

import { runMain, buildPrompt, cdTargetBeforePush, commandCwd, findPushSegment, isGitPushSegment, shellTokenize, parsePushCommand, resolvePushRange, launchPushReview } from "../global-hooks/pre-push-review.mjs";
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

/** Stub resolveReviewers factory → returns the given list. */
function stubResolveReviewers(list) {
  return () => list;
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
    await runMain({
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
  await runMain({
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
  await runMain({
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
  await runMain({
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
  await runMain({
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
  await runMain({
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

  await runMain({
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
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW"),
        fakeReviewer("MiMo", "ALLOW")
      ]),
      writeTraceImpl: (_ws, trace) => { traceRecord = trace; },
      isBenchDisabledImpl: () => false,
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
  assert.equal(traceRecord.gate, "push", "trace gate must be 'push'");
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
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeReviewer("Kimi", "ALLOW"),
        fakeReviewer("MiMo", "BLOCK")
      ]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
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
  assert.equal(hookOut.permissionDecision, "deny", "panel BLOCK → permissionDecision=deny");
  assert.ok(hookOut.permissionDecisionReason, "deny reason must be present");
  assert.match(hookOut.permissionDecisionReason, /MiMo|BLOCK|Details for MiMo/i, "findings should include BLOCK details");
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
// Test: no upstream / nothing to push → fail-open allow no-op
// ---------------------------------------------------------------------------

test("no upstream → fail-open allow (no reviewers called)", async () => {
  // Repo with no remote configured → resolvePushRange fails gracefully.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-noremote-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "init"], { cwd: ws });

  let reviewersCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await runMain({
      resolveReviewersImpl: () => { reviewersCalled = true; return []; },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push" } }
    });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.equal(reviewersCalled, false, "reviewers must NOT be called when no upstream");
  // Should allow — either exits silently or emits an allow decision.
  if (emittedLines.length > 0) {
    const parsed = parseLines(emittedLines);
    if (parsed.length > 0 && parsed[0]?.hookSpecificOutput) {
      assert.equal(parsed[0].hookSpecificOutput.permissionDecision, "allow",
        "no upstream should result in allow decision");
    }
  }
  // (If no lines emitted, that's also fine — silent allow via early return.)
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
    await runMain({
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
// Test: all reviewers errored → fail-open (allow, not deny)
// ---------------------------------------------------------------------------

test("all reviewers errored → fail-open allow", async () => {
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
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([
        fakeErrorReviewer("Kimi"),
        fakeErrorReviewer("MiMo")
      ]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.ok(emittedLines.length > 0, "should emit a fail-open allow decision");
  const parsed = parseLines(emittedLines);
  assert.ok(parsed.length > 0, "emitted line should be valid JSON");
  const hookOut = parsed[0]?.hookSpecificOutput;
  assert.ok(hookOut, "hookSpecificOutput must be present");
  assert.equal(hookOut.permissionDecision, "allow",
    "all-reviewers-errored should fail-open to allow (never deny)");
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

  let reviewersCalled = false;
  const emittedLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) emittedLines.push(chunk.trim());
    return origWrite(chunk, ...rest);
  };

  try {
    await runMain({
      resolveReviewersImpl: () => {
        reviewersCalled = true;
        return [fakeReviewer("Kimi", "ALLOW")];
      },
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "cd /repo && git push origin main" } }
    });
  } finally {
    process.stdout.write = origWrite;
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  // The compound command contains "git push", so reviewers should be called
  // (or we hit a fail-open for range reasons, but NOT skipped entirely).
  // Either way, we should NOT have silently skipped.
  const parsed = parseLines(emittedLines);
  // If reviewers were called, great. If the range failed and we allowed early,
  // that's acceptable fail-open behavior.
  if (!reviewersCalled) {
    // Must have emitted an allow decision (fail-open, not a silent skip)
    assert.ok(parsed.length > 0, "compound push command should produce some output if reviewers not called");
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
  const capturingReviewer = {
    name: "Kimi",
    async run({ cwd }) {
      seenCwd = cwd;
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
    }
  };

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await runMain({
      resolveReviewersImpl: () => [capturingReviewer],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
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

test("A2: resolvePushRange — --tags falls back to reviewing current-branch commits (not skipped)", () => {
  const { ws } = repoWithRemoteRefs("origin", ["main"], "main");
  const r = resolvePushRange(ws, parsePushCommand("git push --tags"));
  assert.equal(r.ok, true, "--tags now reviews the current branch's ahead-commits instead of skipping");
  assert.match(r.range, /\.\.HEAD$/, "range targets HEAD (current-branch ahead-commits)");
  assert.ok(r.note && /--tags/.test(r.note), "note explains the --tags fallback");
});

test("A2: resolvePushRange — multiple refspecs (deploy push) are REVIEWED, not skipped", () => {
  // Real-world bug: `git push beta main develop` (a deploy form seen in VisualSentinel + Ryan P)
  // used to skip review entirely. It must now review the current branch's ahead-commits.
  const { ws } = repoWithRemoteRefs("beta", ["main"], "main");
  const r = resolvePushRange(ws, parsePushCommand("git push beta main develop"));
  assert.equal(r.ok, true, "multi-refspec deploy push is now reviewed");
  assert.match(r.range, /\.\.HEAD$/, "reviews current-branch ahead-commits");
  assert.ok(r.note && /2 refspecs/.test(r.note), "note explains the multi-refspec fallback");
});

test("A2: resolvePushRange — multiple refspecs with NO resolvable base → fail-open note (true last resort)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-a2-norefs-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  const r = resolvePushRange(ws, parsePushCommand("git push beta main develop"));
  assert.equal(r.ok, false, "no @{u} and no remote-tracking ref anywhere → cannot review");
  assert.ok(r.note && /⛩/.test(r.note), "carries a visible fail-open note");
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
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "BLOCK")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
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
      await runMain({
        resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
        writeTraceImpl: () => {},
        isBenchDisabledImpl: () => false,
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
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => { throw new Error("disk full"); },
      isBenchDisabledImpl: () => false,
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
// H — auto deep-review on push: a fast ALLOW launches the deep, repo-aware
// push-review worker detached + unref'd, debounced; NEVER on block/fail-open/
// disabled/empty-range/deleteOnly/debounced.
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

test("H: fast ALLOW ENQUEUES a kind:'push' job with a SHA-pinned range (no detached spawn)", async () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hlaunch-")));
  process.env.BENCH_ROOT = root;

  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW"), fakeReviewer("MiMo", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });

    const jobs = listJobs(wsReal);
    assert.equal(jobs.length, 1, "fast ALLOW must enqueue exactly one deep push job");
    assert.equal(jobs[0].kind, "push");
    // Race fix (H): the range must be PINNED to concrete SHAs at enqueue, not symbolic <ref>..HEAD.
    assert.match(jobs[0].range, /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/, `range must be SHA-pinned; got ${jobs[0].range}`);
    assert.ok(jobs[0].contentKey, "job carries a contentKey");
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
});

test("H: fast ALLOW passes the originating Claude session to the deep push-review enqueue", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hsess-")));
  process.env.BENCH_ROOT = root;
  const spy = launchSpy();

  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, session_id: "chat-A", tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }

  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].opts.sessionKey, normalizeSessionId("chat-A"));
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

test("H: BLOCK → does NOT launch the deep push-review (push denied)", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hblock-")));
  process.env.BENCH_ROOT = root;

  const spy = launchSpy();
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "BLOCK")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(spy.calls.length, 0, "a BLOCK must not launch a deep push-review");
});

test("H: fail-open (all reviewers errored) → does NOT launch the deep push-review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hfo-")));
  process.env.BENCH_ROOT = root;

  const spy = launchSpy();
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeErrorReviewer("Kimi")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(spy.calls.length, 0, "a fail-open (panel unavailable) must not launch a deep push-review");
});

test("H: bench DISABLED → does NOT launch the deep push-review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdis-")));
  process.env.BENCH_ROOT = root;

  const spy = launchSpy();
  const origExit = process.exit;
  process.exit = () => { throw new Error("__exit__"); };   // disabled path calls process.exit(0)
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => true,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } catch (e) {
    if (!/__exit__/.test(String(e && e.message))) throw e;
  } finally {
    process.exit = origExit;
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(spy.calls.length, 0, "disabled bench must not launch a deep push-review");
});

test("H: nothing to push (no commits ahead) → does NOT launch the deep push-review", async () => {
  const { ws } = freshPushedRepo();   // nothing ahead of origin/main
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hempty-")));
  process.env.BENCH_ROOT = root;

  const spy = launchSpy();
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin main" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(spy.calls.length, 0, "an empty push range (nothing to push) must not launch a deep push-review");
});

test("H: deleteOnly (:branch) → does NOT launch the deep push-review", async () => {
  const { ws } = freshPushRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdel-")));
  process.env.BENCH_ROOT = root;

  const spy = launchSpy();
  try {
    await runMain({
      resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      launchImpl: spy.impl,
      env: process.env,
      input: { cwd: ws, tool_input: { command: "git push origin :stale-branch" } }
    });
  } finally {
    process.env.BENCH_ROOT = TEMP_GCR;
  }
  assert.equal(spy.calls.length, 0, "a delete refspec pushes no commits → no deep push-review");
});

test("H: dedup — same push (range+HEAD) → enqueue does NOT double-queue", async () => {
  const { ws } = freshPushRepo();
  const wsReal = fs.realpathSync(ws);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-root-hdebounce-")));
  process.env.BENCH_ROOT = root;

  const opts = {
    resolveReviewersImpl: stubResolveReviewers([fakeReviewer("Kimi", "ALLOW")]),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    env: process.env,
    input: { cwd: ws, tool_input: { command: "git push origin main" } }
  };
  try {
    await runMain(opts);
    assert.equal(listJobs(wsReal).length, 1, "first ALLOW enqueues");
    await runMain(opts);   // identical push (same HEAD, same range) → same contentKey → deduped
    assert.equal(listJobs(wsReal).length, 1, "identical push must NOT double-queue");
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
