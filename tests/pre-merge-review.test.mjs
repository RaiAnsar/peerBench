import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

// Small budget so the timeout test is fast; block/allow stubs resolve immediately and beat it.
process.env.BENCH_MERGE_GATE_BUDGET_MS = "300";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pmg-root-"));

import { parseMergeSegment, findMergeSegment, runMain } from "../global-hooks/pre-merge-review.mjs";

// ── detection ──────────────────────────────────────────────────────────────
test("findMergeSegment detects a real git merge and its ref", () => {
  assert.deepEqual(findMergeSegment("git merge staging")?.refs, ["staging"]);
  assert.deepEqual(findMergeSegment("git merge origin/main")?.refs, ["origin/main"]);
  assert.deepEqual(findMergeSegment("cd repo && git merge feature")?.refs, ["feature"]);
  assert.deepEqual(findMergeSegment("FOO=1 git merge x")?.refs, ["x"]);
  assert.deepEqual(findMergeSegment("git -C /r merge y")?.refs, ["y"]);
  assert.deepEqual(findMergeSegment("git merge --no-ff release")?.refs, ["release"]);
});

test("parseMergeSegment skips value-flag values so refs[0] is the branch, not the -m message", () => {
  assert.deepEqual(parseMergeSegment('git merge -m "wip merge" staging')?.refs, ["staging"]);
  assert.deepEqual(parseMergeSegment("git merge --no-ff -m msg -s recursive staging")?.refs, ["staging"]);
});

test("findMergeSegment ignores --abort/--continue/--quit and non-merge git commands", () => {
  assert.equal(findMergeSegment("git merge --abort"), null);
  assert.equal(findMergeSegment("git merge --continue"), null);
  assert.equal(findMergeSegment("git merge --quit"), null);
  assert.equal(findMergeSegment("git status"), null);
  assert.equal(findMergeSegment("git commit -m 'merge stuff'"), null);
});

// ── runMain on a real repo ───────────────────────────────────────────────────
function repoWithIncoming() {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pmg-ws-")));
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base");
  g("checkout", "-q", "-b", "staging");
  fs.writeFileSync(path.join(ws, "f.js"), "export const x = 1;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat: add x");
  g("checkout", "-q", "main");
  return ws;
}
function capture() {
  let out = "";
  return { emitter: { hasEmitted: () => !!out, emit: (p) => { if (!out) out = JSON.stringify(p); return true; } }, get payload() { return out ? JSON.parse(out) : null; } };
}
const stubReviewer = (verdict, raw) => ({ name: "MiMo", async run() { return { name: "MiMo", verdict, firstLine: raw.split("\n")[0], raw }; } });

test("runMain: merge INTO a protected branch with a high BLOCK → deny + user-visible systemMessage", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let enqueued = null;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [stubReviewer("BLOCK", "BLOCK: null deref\nSEVERITY: high\n- f.js:1 crashes")],
    enqueueImpl: (_ws, job) => { enqueued = job; return true; },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: cap.emitter,
    exit: () => {}
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(cap.payload.systemMessage, /bench merge BLOCKED/);
  assert.match(cap.payload.systemMessage, /staging → main/);
  assert.ok(enqueued && enqueued.range === "HEAD..staging", "a deep async review is enqueued for the incoming range");
});

test("runMain: merge while on a NON-protected branch is not gated (reviewers never called)", async () => {
  const ws = repoWithIncoming();
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: ws });   // current branch = feature (not protected)
  const cap = capture();
  let called = false;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge main" } },
    resolveReviewersImpl: () => { called = true; return []; },
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(called, false, "a merge into a non-protected branch must not run the panel");
  assert.equal(cap.payload, null, "no decision emitted (silent allow)");
});

test("runMain: a hung reviewer → FAIL OPEN (allow) within the budget, never a hang", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let exited = false;
  const hung = { name: "MiMo", run: () => new Promise(() => {}) };   // never resolves
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [hung],
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => { exited = true; }
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "allow", "a hung review must fail OPEN, not block");
  assert.match(cap.payload.systemMessage, /timed out/);
  assert.equal(exited, true, "the timeout path exits so it never lingers on the dangling promise");
});

test("runMain: nothing to merge (already up to date) → quiet allow, no review", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let called = false;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge main" } },   // HEAD..main is empty (we're on main)
    resolveReviewersImpl: () => { called = true; return []; },
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(called, false);
  assert.match(cap.payload.hookSpecificOutput.permissionDecisionReason, /nothing to merge/);
});
