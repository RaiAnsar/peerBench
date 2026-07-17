import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePushReview,
  nativePushIdentity,
  parsePrePushUpdates,
  resolveNativeUpdateRange,
  reviewNativePush
} from "../global-hooks/pre-push-lib.mjs";
import { runMain as runNativeHook } from "../global-hooks/git-pre-push-review.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}

function history(count = 5) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-native-push-"));
  run("git", ["init", "-q"], ws);
  run("git", ["config", "user.email", "test@example.com"], ws);
  run("git", ["config", "user.name", "Test"], ws);
  const shas = [];
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(ws, "value.txt"), `${i}\n`);
    run("git", ["add", "value.txt"], ws);
    run("git", ["commit", "-q", "-m", `c${i}`], ws);
    shas.push(run("git", ["rev-parse", "HEAD"], ws));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-native-state-"));
  fs.writeFileSync(path.join(root, "companion.json"), `${JSON.stringify({ reviewers: ["grok", "kimi"] })}\n`);
  return { ws, shas, root };
}

function update(localSha, remoteSha, localRef = "refs/heads/main", remoteRef = "refs/heads/main") {
  return { localRef, localSha, remoteRef, remoteSha };
}

const allowReview = () => ({
  reviewers: [
    { name: "Grok", verdict: "ALLOW", error: null, severity: "none" },
    { name: "Kimi", verdict: "ALLOW", error: null, severity: "none" }
  ],
  findingCount: 0, maxSeverity: "none", summary: "two reviewers clean", badge: "Grok✓ Kimi✓", traceId: "trace-allow"
});

const blockReview = () => ({
  reviewers: [
    { name: "Grok", verdict: "BLOCK", error: null, severity: "high" },
    { name: "Kimi", verdict: "ALLOW", error: null, severity: "none" }
  ],
  findingCount: 1, maxSeverity: "high", summary: "verified bug", findings: "[Grok]\nBLOCK: verified bug", badge: "Grok✗ Kimi✓", traceId: "trace-block"
});

test("parsePrePushUpdates accepts Git tuples, deletions, and SHA-256 object ids; rejects ambiguity", () => {
  const sha1 = "1".repeat(40), sha2 = "2".repeat(40), zero = "0".repeat(40);
  const parsed = parsePrePushUpdates([
    `refs/heads/main ${sha1} refs/heads/main ${sha2}`,
    `(delete) ${zero} refs/heads/old ${sha2}`,
    `refs/heads/sha256 ${"a".repeat(64)} refs/heads/sha256 ${"0".repeat(64)}`
  ].join("\n"));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].localRef, "(delete)");
  assert.throws(() => parsePrePushUpdates(`refs/heads/main ${sha1} only-three`), /expected 4 fields/);
  assert.throws(() => parsePrePushUpdates("refs/heads/main nope refs/heads/main nope"), /object id/);
});

test("exact existing update uses Git's remote/local object ids; deletions skip", () => {
  const { ws, shas } = history(2);
  const resolved = resolveNativeUpdateRange(ws, "origin", update(shas[1], shas[0]));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.range, `${shas[0]}..${shas[1]}`);
  const deleted = resolveNativeUpdateRange(ws, "origin", update("0".repeat(40), shas[0], "(delete)", "refs/heads/old"));
  assert.equal(deleted.skip, true);
});

test("new refs ask the repository for its object-format-specific empty tree", () => {
  const { ws, shas } = history(1);
  const dynamicEmptyTree = "f".repeat(64);
  const calls = [];
  const fakeGit = (args, cwd) => {
    calls.push(args);
    if (args[0] === "hash-object") return [dynamicEmptyTree, true];
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return [(r.stdout || "").trim(), r.status === 0];
  };
  const resolved = resolveNativeUpdateRange(ws, "origin", update(shas[0], "0".repeat(40)), { gitImpl: fakeGit });
  assert.equal(resolved.baseCommit, dynamicEmptyTree);
  assert.equal(resolved.range, `${dynamicEmptyTree}..${shas[0]}`);
  assert.ok(calls.some((args) => args.join(" ") === "hash-object -t tree --stdin"));
});

test("new-ref resolution fails closed when Git cannot provide the repository empty tree", () => {
  const { ws, shas } = history(1);
  const fakeGit = (args, cwd) => {
    if (args[0] === "hash-object") return ["", false];
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return [(r.stdout || "").trim(), r.status === 0];
  };
  const resolved = resolveNativeUpdateRange(ws, "origin", update(shas[0], "0".repeat(40)), { gitImpl: fakeGit });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /empty-tree object id/);
});

test("real SHA-256 repositories use their own empty tree for new refs", (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-native-sha256-"));
  const initialized = spawnSync("git", ["init", "--object-format=sha256", "-q"], { cwd: ws, encoding: "utf8" });
  if (initialized.status !== 0) {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  run("git", ["config", "user.email", "test@example.com"], ws);
  run("git", ["config", "user.name", "Test"], ws);
  fs.writeFileSync(path.join(ws, "value.txt"), "sha256\n");
  run("git", ["add", "value.txt"], ws);
  run("git", ["commit", "-q", "-m", "sha256 root"], ws);
  const head = run("git", ["rev-parse", "HEAD"], ws);
  const empty = run("git", ["hash-object", "-t", "tree", "--stdin"], ws);
  const resolved = resolveNativeUpdateRange(ws, "origin", update(head, "0".repeat(64)));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.baseCommit, empty);
  assert.equal(empty.length, 64);
  assert.equal(run("git", ["log", "--format=%H", resolved.range], ws), head);
});

test("remoteSha=0 never trusts a stale tracking ref or upstream as the remote base", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  run("git", ["update-ref", "refs/remotes/origin/topic", shas[0]], ws);
  const currentBranch = run("git", ["branch", "--show-current"], ws);
  run("git", ["config", `branch.${currentBranch}.remote`, "origin"], ws);
  run("git", ["config", `branch.${currentBranch}.merge`, "refs/heads/topic"], ws);
  const pushed = update(shas[1], "0".repeat(40), "refs/heads/main", "refs/heads/topic");
  const resolved = resolveNativeUpdateRange(ws, "origin", pushed);
  const empty = run("git", ["hash-object", "-t", "tree", "--stdin"], ws);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.baseCommit, empty);
  assert.notEqual(resolved.baseCommit, shas[0]);

  let calls = 0;
  const result = await reviewNativePush({
    cwd: ws, remoteName: "origin", remoteUrl: "file:///brand-new-remote",
    updates: [pushed], env: {},
    runPushReviewImpl: async (range, reviewWs, reviewOptions) => {
      calls++;
      assert.equal(range, `${empty}..${shas[1]}`);
      assert.equal(reviewWs, ws);
      assert.equal(reviewOptions.targetCommit, shas[1]);
      assert.equal(reviewOptions.baseCommit, empty);
      return allowReview();
    }
  });
  assert.equal(result.decision, "allow");
  assert.equal(calls, 1, "a stale tracking ref must not turn a new-ref push into a false clean skip");
});

test("annotated tags are recursively peeled: blob targets skip, indeterminate targets fail closed", () => {
  const { ws } = history(1);
  const blobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: ws, encoding: "utf8", input: "release metadata\n"
  });
  assert.equal(blobResult.status, 0, blobResult.stderr);
  const blob = blobResult.stdout.trim();
  const tagBody = [
    `object ${blob}`,
    "type blob",
    "tag metadata-v1",
    "tagger Test <test@example.com> 1 +0000",
    "",
    "metadata tag",
    ""
  ].join("\n");
  const tagResult = spawnSync("git", ["mktag"], { cwd: ws, encoding: "utf8", input: tagBody });
  assert.equal(tagResult.status, 0, tagResult.stderr);
  const tag = tagResult.stdout.trim();
  const resolved = resolveNativeUpdateRange(ws, "origin", update(tag, "0".repeat(40), "refs/tags/metadata-v1", "refs/tags/metadata-v1"));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.skip, true);
  assert.match(resolved.reason, /non-commit blob/);

  const indeterminateTag = "a".repeat(40);
  const fakeGit = (args) => {
    if (args[0] === "cat-file" && args[2] === indeterminateTag) return ["tag", true];
    return ["", false];
  };
  const failed = resolveNativeUpdateRange(ws, "origin", update(indeterminateTag, "0".repeat(40), "refs/tags/bad", "refs/tags/bad"), { gitImpl: fakeGit });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /cannot peel annotated tag/);
});

test("strict evaluation requires quorum and a Codex verdict whenever Codex is configured", () => {
  const one = { ...allowReview(), reviewers: [allowReview().reviewers[0]] };
  assert.equal(evaluatePushReview(one, ["grok", "kimi"], {}).decision, "unavailable");
  const noCodex = allowReview();
  assert.match(evaluatePushReview(noCodex, ["codex", "grok", "kimi"], {}).reason, /Codex verdict missing/);
  const withCodex = { ...allowReview(), reviewers: [
    { name: "Codex", verdict: "ALLOW", error: null, severity: "none" },
    { name: "Grok", verdict: "ALLOW", error: null, severity: "none" }
  ] };
  assert.equal(evaluatePushReview(withCodex, ["codex", "grok"], {}).decision, "allow");
});

test("quorum counts unique configured reviewers only", () => {
  const duplicate = { ...allowReview(), reviewers: [
    { name: "Kimi", verdict: "ALLOW", error: null },
    { name: "Kimi", verdict: "ALLOW", error: null }
  ] };
  assert.match(evaluatePushReview(duplicate, ["kimi", "glm"], {}).reason, /1\/2 verdicts/);
  const outsider = { ...allowReview(), reviewers: [
    { name: "Kimi", verdict: "ALLOW", error: null },
    { name: "Grok", verdict: "ALLOW", error: null }
  ] };
  assert.match(evaluatePushReview(outsider, ["kimi", "glm"], {}).reason, /1\/2 verdicts/);
  const exact = { ...allowReview(), reviewers: [
    { name: "Kimi", verdict: "ALLOW", error: null },
    { name: "GLM", verdict: "ALLOW", error: null }
  ] };
  assert.equal(evaluatePushReview(exact, ["kimi", "glm"], {}).decision, "allow");
});

test("a configured quorum above the panel size clamps to all configured reviewers", () => {
  const env = { BENCH_PUSH_REVIEW_QUORUM: "4" };
  assert.equal(evaluatePushReview(allowReview(), ["grok", "kimi"], env).decision, "allow",
    "quorum=4 on a two-reviewer panel must require all reviewers, not block every push forever");
  const oneValid = { ...allowReview(), reviewers: [allowReview().reviewers[0]] };
  assert.equal(evaluatePushReview(oneValid, ["grok", "kimi"], env).decision, "unavailable",
    "the clamped quorum still requires the whole configured panel");
});

test("an over-large configured quorum no longer permanently blocks the native push gate", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const result = await reviewNativePush({
    cwd: ws, remoteName: "origin", remoteUrl: "file:///quorum-clamp",
    updates: [update(shas[1], shas[0])],
    env: { BENCH_PUSH_REVIEW_QUORUM: "4" },
    runPushReviewImpl: async () => { calls++; return allowReview(); }
  });
  assert.equal(result.decision, "allow");
  assert.equal(calls, 1);
});

test("an explicit valid BLOCK is strict even when the reviewer labels it medium severity", () => {
  const review = {
    reviewers: [
      { name: "Grok", verdict: "BLOCK", error: null, severity: "medium" },
      { name: "Kimi", verdict: "ALLOW", error: null, severity: "none" }
    ],
    findingCount: 1,
    maxSeverity: "medium",
    findings: "[Grok]\nBLOCK: concrete regression"
  };
  const result = evaluatePushReview(review, ["grok", "kimi"], {});
  assert.equal(result.decision, "block");
  assert.match(result.findings, /concrete regression/);
});

test("whole-push identity is canonical across Git tuple order", () => {
  const a = update("1".repeat(40), "2".repeat(40), "refs/heads/a", "refs/heads/a");
  const b = update("3".repeat(40), "4".repeat(40), "refs/heads/b", "refs/heads/b");
  const common = { remoteName: "origin", remoteUrl: "file:///remote", reviewers: ["kimi", "grok"], policy: { quorum: 2 } };
  assert.equal(
    nativePushIdentity({ ...common, updates: [a, b] }),
    nativePushIdentity({ ...common, updates: [b, a] })
  );
});

test("whole-push identity canonicalizes nested policy object key order", () => {
  const pushed = update("1".repeat(40), "2".repeat(40), "refs/heads/a", "refs/heads/a");
  const common = { remoteName: "origin", remoteUrl: "file:///remote", updates: [pushed] };
  assert.equal(
    nativePushIdentity({
      ...common,
      policy: { configuredReviewers: [{ name: "kimi", headers: { b: "2", a: "1" } }] }
    }),
    nativePushIdentity({
      ...common,
      policy: { configuredReviewers: [{ headers: { a: "1", b: "2" }, name: "kimi" }] }
    })
  );
});

test("reviewer configuration order does not invalidate an exact cached decision", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const common = {
    cwd: ws,
    remoteName: "policy-order",
    remoteUrl: "file:///policy-order",
    updates: [update(shas[1], shas[0])],
    env: {},
    runPushReviewImpl: async () => { calls++; return allowReview(); }
  };
  const first = await reviewNativePush({ ...common, now: 100_000 });
  fs.writeFileSync(path.join(root, "companion.json"), `${JSON.stringify({ reviewers: ["kimi", "grok"] })}\n`);
  const second = await reviewNativePush({ ...common, now: 100_001 });
  assert.equal(first.decision, "allow");
  assert.equal(second.decision, "allow");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("local source-ref spelling cannot reset the same remote target's three-cycle ceiling", async () => {
  const { ws, shas, root } = history(5);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const invoke = (index, source, remoteName = "origin") => reviewNativePush({
    cwd: ws,
    remoteName,
    remoteUrl: "file:///one-canonical-remote",
    updates: [update(shas[index], shas[0], `refs/heads/${source}`, "refs/heads/main")],
    env: {},
    now: 110_000 + index,
    runPushReviewImpl: async () => { calls++; return blockReview(); }
  });
  assert.equal((await invoke(1, "source-a")).cycle, 1);
  assert.equal((await invoke(2, "source-b")).cycle, 2);
  assert.equal((await invoke(3, "source-c", "alias-for-origin")).cycle, 3, "same URL shares the same remote identity");
  const held = await invoke(4, "source-d");
  assert.equal(held.kind, "cycle-ceiling");
  assert.equal(calls, 3);
});

test("four concurrent distinct blocks atomically consume only three remote-scope slots", async () => {
  const { ws, shas, root } = history(5);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const results = await Promise.all([1, 2, 3, 4].map((index) => reviewNativePush({
    cwd: ws,
    remoteName: "concurrent-blocks",
    remoteUrl: "file:///concurrent-blocks",
    updates: [update(shas[index], shas[0], `refs/heads/source-${index}`, "refs/heads/main")],
    env: {},
    now: 120_000 + index,
    runPushReviewImpl: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return blockReview();
    }
  })));
  assert.equal(calls, 3);
  assert.deepEqual(results.filter((r) => r.cycle).map((r) => r.cycle).sort(), [1, 2, 3]);
  assert.equal(results.filter((r) => r.kind === "cycle-ceiling").length, 1);
});

test("a delayed concurrent ALLOW cannot overwrite an exact cached BLOCK", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let startBlock;
  const blockStarted = new Promise((resolve) => { startBlock = resolve; });
  let finishBlock;
  const blockMayFinish = new Promise((resolve) => { finishBlock = resolve; });
  let allowCalls = 0;
  const common = {
    cwd: ws,
    remoteName: "block-dominates",
    remoteUrl: "file:///block-dominates",
    updates: [update(shas[1], shas[0])],
    env: {},
    now: 130_000
  };
  const firstPromise = reviewNativePush({
    ...common,
    runPushReviewImpl: async () => {
      startBlock();
      await blockMayFinish;
      return blockReview();
    }
  });
  await blockStarted;
  const secondPromise = reviewNativePush({
    ...common,
    now: 130_001,
    runPushReviewImpl: async () => { allowCalls++; return allowReview(); }
  });
  finishBlock();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.decision, "block");
  assert.equal(second.decision, "block");
  assert.equal(second.cached, true);
  assert.equal(allowCalls, 0);
});

test("a crash-left native push lease with a dead owner is recovered immediately", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  const remoteUrl = "file:///dead-owner-lock";
  const lockId = createHash("sha256").update(remoteUrl).digest("hex");
  const lock = path.join(workspaceStateDir(ws), "native-push-locks", `${lockId}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: 999_999_999, nonce: "dead", createdAt: Date.now() })}\n`);
  let calls = 0;
  const started = Date.now();
  const result = await reviewNativePush({
    cwd: ws,
    remoteName: "origin",
    remoteUrl,
    updates: [update(shas[1], shas[0])],
    env: {},
    runPushReviewImpl: async () => { calls++; return allowReview(); }
  });
  assert.equal(result.decision, "allow");
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1_000, "dead owner recovery must not wait for the contention timeout");
  assert.equal(fs.existsSync(lock), false, "the recovered lease is released normally");
});

test("a live native push lease fails closed with a prompt, explicit contention error", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  const remoteUrl = "file:///live-owner-lock";
  const lockId = createHash("sha256").update(remoteUrl).digest("hex");
  const lock = path.join(workspaceStateDir(ws), "native-push-locks", `${lockId}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce: "live", createdAt: Date.now() })}\n`);
  const started = Date.now();
  await assert.rejects(
    () => reviewNativePush({
      cwd: ws,
      remoteName: "origin",
      remoteUrl,
      updates: [update(shas[1], shas[0])],
      env: {},
      nativeLockWaitMs: 25,
      runPushReviewImpl: async () => allowReview()
    }),
    /another native push review is active.*retry after it finishes/
  );
  assert.ok(Date.now() - started < 500);
  fs.rmSync(lock, { recursive: true, force: true });
});

test("an old native push lease with a LIVE owner is never reclaimed by age alone", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  const remoteUrl = "file:///old-live-owner-lock";
  const lockId = createHash("sha256").update(remoteUrl).digest("hex");
  const lock = path.join(workspaceStateDir(ws), "native-push-locks", `${lockId}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce: "old-live", createdAt: Date.now() - 60 * 60 * 1000 })}\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let calls = 0;
  await assert.rejects(
    () => reviewNativePush({
      cwd: ws,
      remoteName: "origin",
      remoteUrl,
      updates: [update(shas[1], shas[0])],
      env: {},
      nativeLockWaitMs: 50,
      runPushReviewImpl: async () => { calls++; return allowReview(); }
    }),
    /another native push review is active.*retry after it finishes/
  );
  assert.equal(calls, 0, "a live owner's long multi-range review must not be evicted by the age ceiling");
  assert.equal(fs.existsSync(lock), true, "the live owner's lease survives");
  fs.rmSync(lock, { recursive: true, force: true });
});

test("a released native push lease never removes a replacement owner's lock", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  const remoteUrl = "file:///release-nonce";
  const lockId = createHash("sha256").update(remoteUrl).digest("hex");
  const lock = path.join(workspaceStateDir(ws), "native-push-locks", `${lockId}.lock`);
  let reviewStarted;
  const started = new Promise((resolve) => { reviewStarted = resolve; });
  let finishReview;
  const reviewMayFinish = new Promise((resolve) => { finishReview = resolve; });
  const first = reviewNativePush({
    cwd: ws,
    remoteName: "origin",
    remoteUrl,
    updates: [update(shas[1], shas[0])],
    env: {},
    runPushReviewImpl: async () => { reviewStarted(); await reviewMayFinish; return allowReview(); }
  });
  await started;
  // The lease is legitimately replaced while the first review is still finishing (e.g. its owner
  // looked dead to a contender): the evicted owner's release must not delete the NEW owner's lock.
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce: "replacement-owner", createdAt: Date.now() })}\n`);
  finishReview();
  const result = await first;
  assert.equal(result.decision, "allow");
  assert.equal(fs.existsSync(lock), true, "the evicted owner's release leaves the replacement lease in place");
  fs.rmSync(lock, { recursive: true, force: true });
});

test("an exact deterministic evidence-coverage block is cached instead of retrying forever", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const common = {
    cwd: ws,
    remoteName: "coverage-block",
    remoteUrl: "file:///coverage-block",
    updates: [update(shas[1], shas[0])],
    env: {},
    runPushReviewImpl: async () => {
      calls++;
      return {
        coverageBlocked: true,
        findingCount: 1,
        maxSeverity: "high",
        findings: "evidence exceeds exhaustive limit",
        summary: "coverage blocked"
      };
    }
  };
  const first = await reviewNativePush({ ...common, now: 140_000 });
  const second = await reviewNativePush({ ...common, now: 140_001 });
  assert.equal(first.decision, "block");
  assert.equal(first.cycle, 1);
  assert.equal(second.decision, "block");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("a blocker cannot hide an unavailable reviewer in the same panel", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const incompleteBlock = {
    ...blockReview(),
    reviewers: [
      { name: "Grok", verdict: "BLOCK", error: null, severity: "high" },
      { name: "Kimi", verdict: null, error: "provider timeout", severity: "none" }
    ]
  };
  const common = {
    cwd: ws, remoteName: "same-panel-outage", remoteUrl: "file:///same-panel-outage",
    updates: [update(shas[1], shas[0])], env: {}
  };
  const first = await reviewNativePush({
    ...common, now: 20_000,
    runPushReviewImpl: async () => { calls++; return incompleteBlock; }
  });
  assert.equal(first.decision, "block");
  assert.equal(first.partialUnavailable, true);
  assert.match(first.findings, /verified bug/);
  assert.match(first.findings, /review quorum not met/);
  assert.match(first.findings, /kimi: provider timeout/i);

  const second = await reviewNativePush({
    ...common, now: 20_001,
    runPushReviewImpl: async () => { calls++; return allowReview(); }
  });
  assert.equal(second.decision, "allow");
  assert.equal(second.cached, undefined, "an incomplete blocking panel must not be cached as complete");
  assert.equal(calls, 2);
});

test("identical multi-ref ranges run once and unchanged completed ranges survive a sibling change", async () => {
  const { ws, shas, root } = history(4);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const review = async () => { calls++; return allowReview(); };
  const first = await reviewNativePush({
    cwd: ws, remoteName: "multi-dedupe", remoteUrl: "file:///multi-dedupe", env: {}, now: 30_000,
    updates: [
      update(shas[2], shas[0], "refs/heads/a", "refs/heads/a"),
      update(shas[2], shas[0], "refs/heads/b", "refs/heads/b")
    ],
    runPushReviewImpl: review
  });
  assert.equal(first.decision, "allow");
  assert.equal(calls, 1, "identical ranges in one transaction must be reviewed once");

  const second = await reviewNativePush({
    cwd: ws, remoteName: "multi-dedupe", remoteUrl: "file:///multi-dedupe", env: {}, now: 30_001,
    updates: [
      update(shas[2], shas[0], "refs/heads/a", "refs/heads/a"),
      update(shas[3], shas[1], "refs/heads/b", "refs/heads/b")
    ],
    runPushReviewImpl: review
  });
  assert.equal(second.decision, "allow");
  assert.equal(second.rangeCacheHits, 1);
  assert.equal(calls, 2, "only the changed sibling range should rerun reviewers");
});

test("partial multi-ref outages retry only the unavailable range", async () => {
  const { ws, shas, root } = history(4);
  process.env.BENCH_ROOT = root;
  const rangeA = `${shas[0]}..${shas[2]}`;
  const rangeB = `${shas[1]}..${shas[3]}`;
  const calls = [];
  let rangeBAttempts = 0;
  const review = async (range) => {
    calls.push(range);
    if (range === rangeB && ++rangeBAttempts === 1) return { retry: true, reason: "provider outage", reviewers: [] };
    return allowReview();
  };
  const common = {
    cwd: ws, remoteName: "multi-partial", remoteUrl: "file:///multi-partial", env: {},
    updates: [
      update(shas[2], shas[0], "refs/heads/a", "refs/heads/a"),
      update(shas[3], shas[1], "refs/heads/b", "refs/heads/b")
    ],
    runPushReviewImpl: review
  };
  const first = await reviewNativePush({ ...common, now: 40_000 });
  assert.equal(first.decision, "unavailable");
  assert.deepEqual(calls.sort(), [rangeA, rangeB].sort());

  calls.length = 0;
  const second = await reviewNativePush({ ...common, now: 40_001 });
  assert.equal(second.decision, "allow");
  assert.equal(second.rangeCacheHits, 1);
  assert.deepEqual(calls, [rangeB], "the completed range must be reused while only the outage retries");
});

test("non-fast-forward rewinds are reviewed even when remote..local has no commits", async () => {
  const { ws, shas, root } = history(3);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const result = await reviewNativePush({
    cwd: ws, remoteName: "origin", updates: [update(shas[0], shas[2])], env: {},
    runPushReviewImpl: async () => { calls++; return blockReview(); }
  });
  assert.equal(calls, 1);
  assert.equal(result.decision, "block");
});

test("exact-update ALLOW and BLOCK results are cached; unchanged retries never rerun reviewers", async () => {
  const { ws, shas, root } = history(3);
  process.env.BENCH_ROOT = root;
  let allows = 0;
  const opts = {
    cwd: ws, remoteName: "origin", remoteUrl: "file:///remote",
    updates: [update(shas[1], shas[0])], env: {}, now: 1000,
    runPushReviewImpl: async () => { allows++; return allowReview(); }
  };
  const first = await reviewNativePush(opts);
  const second = await reviewNativePush({ ...opts, now: 1001 });
  assert.equal(first.decision, "allow");
  assert.equal(second.cached, true);
  assert.equal(allows, 1);

  let blocks = 0;
  const blockedOpts = { ...opts, updates: [update(shas[2], shas[0])], now: 2000,
    runPushReviewImpl: async () => { blocks++; return blockReview(); } };
  const blocked = await reviewNativePush(blockedOpts);
  const replay = await reviewNativePush({ ...blockedOpts, now: 2001 });
  assert.equal(blocked.decision, "block");
  assert.equal(replay.cached, true);
  assert.equal(blocks, 1);
});

test("cache identity includes quorum/Codex policy and an explicit refresh reruns an exact update", async () => {
  const { ws, shas, root } = history(2);
  fs.writeFileSync(path.join(root, "companion.json"), `${JSON.stringify({ reviewers: ["codex", "grok"] })}\n`);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const common = {
    cwd: ws, remoteName: "origin", updates: [update(shas[1], shas[0])], now: 5000,
    runPushReviewImpl: async () => { calls++; return { ...allowReview(), reviewers: [allowReview().reviewers[0]] }; }
  };
  const permissive = await reviewNativePush({ ...common, env: { BENCH_PUSH_REVIEW_QUORUM: "1", BENCH_PUSH_REQUIRE_CODEX: "0" } });
  assert.equal(permissive.decision, "allow");
  const strict = await reviewNativePush({ ...common, now: 5001, env: { BENCH_PUSH_REVIEW_QUORUM: "1" } });
  assert.equal(strict.decision, "unavailable");
  assert.equal(calls, 2, "a stricter policy must not reuse a permissive cached ALLOW");

  fs.writeFileSync(path.join(root, "companion.json"), `${JSON.stringify({ reviewers: ["grok", "kimi"] })}\n`);
  let refreshCalls = 0;
  const exact = {
    cwd: ws, remoteName: "refresh", updates: [update(shas[1], shas[0])], now: 6000, env: {},
    runPushReviewImpl: async () => { refreshCalls++; return refreshCalls === 1 ? blockReview() : allowReview(); }
  };
  assert.equal((await reviewNativePush(exact)).decision, "block");
  const refreshed = await reviewNativePush({ ...exact, now: 6001, env: { BENCH_PUSH_REVIEW_REFRESH: "1" } });
  assert.equal(refreshed.decision, "allow");
  assert.equal(refreshCalls, 2);
});

test("a failed forced refresh cannot resurrect the stale cached ALLOW", async () => {
  const { ws, shas, root } = history(2);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const common = {
    cwd: ws, remoteName: "origin", updates: [update(shas[1], shas[0])], now: 6500,
    runPushReviewImpl: async () => {
      calls++;
      if (calls === 1) return allowReview();
      return { retry: true, reason: "provider outage", reviewers: [] };
    }
  };
  assert.equal((await reviewNativePush({ ...common, env: {} })).decision, "allow");
  assert.equal((await reviewNativePush({ ...common, now: 6501, env: { BENCH_PUSH_REVIEW_REFRESH: "1" } })).decision, "unavailable");
  const ordinaryRetry = await reviewNativePush({ ...common, now: 6502, env: {} });
  assert.equal(ordinaryRetry.decision, "unavailable");
  assert.equal(ordinaryRetry.cached, undefined);
  assert.equal(calls, 3);
});

test("a cached clean transition clears an old three-block cycle", async () => {
  const { ws, shas, root } = history(6);
  process.env.BENCH_ROOT = root;
  const call = (local, decision, now) => reviewNativePush({
    cwd: ws, remoteName: "origin", updates: [update(local, shas[0])], env: {}, now,
    runPushReviewImpl: async () => decision === "allow" ? allowReview() : blockReview()
  });
  const cleanIdentity = await call(shas[1], "allow", 7000);
  assert.equal(cleanIdentity.decision, "allow");
  for (let i = 2; i <= 4; i++) assert.equal((await call(shas[i], "block", 7000 + i)).decision, "block");
  const cachedClean = await call(shas[1], "block", 7010);
  assert.equal(cachedClean.decision, "allow");
  assert.equal(cachedClean.cached, true);
  const afterClean = await call(shas[5], "allow", 7011);
  assert.equal(afterClean.decision, "allow");
  assert.notEqual(afterClean.kind, "cycle-ceiling");
});

test("three distinct blocked revisions trigger a consolidated hold instead of an endless fourth review", async () => {
  const { ws, shas, root } = history(5);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  for (let i = 1; i <= 3; i++) {
    const result = await reviewNativePush({
      cwd: ws, remoteName: "origin", updates: [update(shas[i], shas[0])], env: { BENCH_PUSH_MAX_BLOCK_CYCLES: "99" }, now: 10_000 + i,
      runPushReviewImpl: async () => { calls++; return blockReview(); }
    });
    assert.equal(result.decision, "block");
    assert.equal(result.cycle, i);
  }
  const held = await reviewNativePush({
    cwd: ws, remoteName: "origin", updates: [update(shas[4], shas[0])], env: { BENCH_PUSH_MAX_BLOCK_CYCLES: "99" }, now: 10_010,
    runPushReviewImpl: async () => { calls++; return allowReview(); }
  });
  assert.equal(held.kind, "cycle-ceiling");
  assert.match(held.findings, /Cycle 1:/);
  assert.match(held.findings, /BENCH_PUSH_CYCLE_RESET nonce/);
  assert.equal(calls, 3, "no fourth automatic reviewer run");
});

test("native push ceiling survives time and an exported reset value is consumed once", async () => {
  const { ws, shas, root } = history(8);
  process.env.BENCH_ROOT = root;
  let calls = 0;
  const invoke = (index, env, now, verdict = "block") => reviewNativePush({
    cwd: ws,
    remoteName: "origin",
    updates: [update(shas[index], shas[0])],
    env,
    now,
    cycleWindowMs: 10,
    runPushReviewImpl: async () => {
      calls++;
      return verdict === "allow" ? allowReview() : blockReview();
    }
  });

  for (let index = 1; index <= 3; index++) assert.equal((await invoke(index, {}, index)).cycle, index);
  const muchLater = await invoke(4, {}, 365 * 24 * 60 * 60 * 1000);
  assert.equal(muchLater.kind, "cycle-ceiling", "time alone must never reopen unresolved automatic review");
  assert.equal(calls, 3);

  const exportedReset = { BENCH_PUSH_CYCLE_RESET: "push-reset-a" };
  assert.equal((await invoke(4, exportedReset, 40_000)).cycle, 1);
  assert.equal((await invoke(5, exportedReset, 40_001)).cycle, 2);
  assert.equal((await invoke(6, exportedReset, 40_002)).cycle, 3);
  const heldAgain = await invoke(7, exportedReset, 40_003);
  assert.equal(heldAgain.kind, "cycle-ceiling");
  assert.equal(calls, 6, "a persistent reset nonce cannot erase the counter every push");

  const explicitlyReopened = await invoke(7, { BENCH_PUSH_CYCLE_RESET: "push-reset-b" }, 40_004, "allow");
  assert.equal(explicitlyReopened.decision, "allow", "a changed nonce starts one fresh bounded cycle");
  assert.equal(calls, 7);
});

test("native hook fails closed on malformed input/unavailable review and exits cleanly on allow", async () => {
  const { ws, shas } = history(2);
  const tuple = `refs/heads/main ${shas[1]} refs/heads/main ${shas[0]}\n`;
  const invoke = async (input, result) => {
    let code = null, err = "";
    await runNativeHook({ cwd: ws, remoteName: "origin", input, env: {}, isBenchDisabledImpl: () => false,
      reviewImpl: async () => result, stderr: (s) => { err += s; }, exit: (c) => { code = c; } });
    return { code, err };
  };
  assert.equal((await invoke(tuple, { decision: "allow", summary: "clean" })).code, 0);
  const unavailable = await invoke(tuple, { decision: "unavailable", reason: "1/2 verdicts" });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.err, /degraded one-reviewer result/);
  assert.equal((await invoke("broken\n", { decision: "allow" })).code, 1);
});

test("native hook suppresses Codex self-review for a direct Codex push", async () => {
  const { ws, shas } = history(2);
  const tuple = `refs/heads/main ${shas[1]} refs/heads/main ${shas[0]}\n`;
  let seenEnv = null;
  let code = null;
  await runNativeHook({
    cwd: ws,
    remoteName: "origin",
    input: tuple,
    env: { CODEX_THREAD_ID: "thread-123" },
    isBenchDisabledImpl: () => false,
    reviewImpl: async ({ env }) => {
      seenEnv = env;
      return { decision: "allow", summary: "clean" };
    },
    stderr: () => {},
    exit: (value) => { code = value; }
  });
  assert.equal(code, 0);
  assert.equal(seenEnv.BENCH_SUPPRESS_CODEX_REVIEWER, "1");
  assert.equal(seenEnv.CODEX_THREAD_ID, "thread-123");
});

test("pushPolicyDoomedByCooldowns: required Codex on quota cooldown fails fast with an honest message", async () => {
  const { pushPolicyDoomedByCooldowns } = await import("../global-hooks/pre-push-lib.mjs");
  const { recordReviewerCooldown, clearReviewerCooldowns } = await import("../global-hooks/config-store.mjs");
  clearReviewerCooldowns();
  const t0 = Date.now();
  recordReviewerCooldown("codex", "quota", "usage limit reached", { now: t0 });
  const reason = pushPolicyDoomedByCooldowns(["codex", "grok", "kimi"], { quorum: 2, requireCodex: true }, { now: t0 + 1000 });
  assert.match(reason, /codex: out of quota\/credits/);
  assert.match(reason, /BENCH_NATIVE_PUSH_BYPASS/);
  // Without the Codex requirement, two healthy reviewers still meet quorum → no fast-fail.
  assert.equal(pushPolicyDoomedByCooldowns(["codex", "grok", "kimi"], { quorum: 2, requireCodex: false }, { now: t0 + 1000 }), null);
  clearReviewerCooldowns();
});
test("pushPolicyDoomedByCooldowns: quorum unreachable through cooldowns fails fast; healthy panel passes", async () => {
  const { pushPolicyDoomedByCooldowns } = await import("../global-hooks/pre-push-lib.mjs");
  const { recordReviewerCooldown, clearReviewerCooldowns } = await import("../global-hooks/config-store.mjs");
  clearReviewerCooldowns();
  const t0 = Date.now();
  assert.equal(pushPolicyDoomedByCooldowns(["grok", "kimi"], { quorum: 2, requireCodex: false }, { now: t0 }), null, "no cooldowns → run the panel");
  recordReviewerCooldown("kimi", "quota", "HTTP 429", { now: t0 });
  const reason = pushPolicyDoomedByCooldowns(["grok", "kimi"], { quorum: 2, requireCodex: false }, { now: t0 + 1000 });
  assert.match(reason, /kimi: out of quota\/credits/);
  clearReviewerCooldowns();
});
