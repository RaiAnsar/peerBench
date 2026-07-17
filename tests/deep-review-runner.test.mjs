// tests/deep-review-runner.test.mjs — the asyncRewake Stop runner that delivers deep-review findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "drr-root-")));

import {
  runMain, WAKE_WINDOW_MS, MAX_BATCH, MAX_REVIEW_ATTEMPTS, MAX_BLOCK_WAKES,
  MAX_RUNNER_FOLLOWUP_WAKES, RUNNER_FOLLOWUP_WINDOW_MS
} from "../global-hooks/deep-review-runner.mjs";
import { enqueue, listJobs, listBlocked, markBlocked } from "../global-hooks/deep-queue.mjs";
import { deepKey } from "../global-hooks/deep-review.mjs";
import { normalizeSessionId, workspaceStateDir } from "../global-hooks/config-store.mjs";

function freshWs() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "drr-ws-"))); }

async function runRunner(ws, overrides = {}) {
  let exit = null; const errs = []; const outs = [];
  await runMain({
    ws, input: { cwd: ws },
    isBenchDisabledImpl: () => false,
    now: Date.now(),
    exitImpl: (c) => { exit = c; },
    stderr: (s) => errs.push(s),
    stdout: (o) => outs.push(o),
    ...overrides
  });
  return { exit, err: errs.join(""), out: outs };
}

// a spec job backed by a real file (so currentContentKey resolves)
function planSpecJob(ws, content = "spec body") {
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, content);
  const contentKey = deepKey(file, content);
  enqueue(ws, { kind: "spec", specPath: file, contentKey });
  return { file, contentKey };
}

const CLEAN = async () => ({ maxSeverity: "none", findingCount: 0, findings: "" });

test("empty queue → exit 0, no output", async () => {
  const { exit, err, out } = await runRunner(freshWs());
  assert.equal(exit, 0); assert.equal(out.length, 0); assert.equal(err, "");
});

test("same-session concurrent runners are single-flight and cannot double-deliver a wake", async () => {
  const ws = freshWs();
  planSpecJob(ws, "concurrent body");
  let releaseReview;
  let enteredReview;
  const entered = new Promise((resolve) => { enteredReview = resolve; });
  const barrier = new Promise((resolve) => { releaseReview = resolve; });
  let calls = 0;
  const blocker = async () => {
    calls++;
    enteredReview();
    await barrier;
    return { maxSeverity: "high", findingCount: 1, findings: "BLOCK: concurrent finding" };
  };

  const firstPromise = runRunner(ws, { runSpecReviewImpl: blocker });
  await entered;
  const contending = await runRunner(ws, { runSpecReviewImpl: blocker });
  assert.equal(contending.exit, 0, "the owner drains the queue; a parallel Stop stays quiet");
  releaseReview();
  const first = await firstPromise;

  assert.equal(first.exit, 2);
  assert.equal(calls, 1, "only the lease owner can run the panel");
  assert.equal(listBlocked(ws).length, 1);
  assert.equal(listBlocked(ws)[0].wakeCount, 1, "one completed review produces exactly one delivered wake");
  const followup = JSON.parse(fs.readFileSync(path.join(workspaceStateDir(ws), "deep-runner-followup"), "utf8"));
  assert.equal(followup.count, 1, "the global wake ledger cannot lose a concurrent update");
});

test("same-session contention hands off a job enqueued after the owner's last empty read", async () => {
  const ws = freshWs();
  let ownerReachedEmpty;
  const ownerAtEmpty = new Promise((resolve) => { ownerReachedEmpty = resolve; });
  let releaseOwner;
  const ownerMayContinue = new Promise((resolve) => { releaseOwner = resolve; });
  let contentionPublished;
  const contentionWasPublished = new Promise((resolve) => { contentionPublished = resolve; });
  let ownerChecks = 0;
  let ownerCalls = 0;
  let contenderCalls = 0;

  const ownerPromise = runRunner(ws, {
    onQueueQuiescent: async () => {
      ownerChecks++;
      if (ownerChecks !== 1) return;
      ownerReachedEmpty();
      await ownerMayContinue;
    },
    runSpecReviewImpl: async () => { ownerCalls++; return CLEAN(); }
  });
  await ownerAtEmpty;

  // Reproduce the exact loss window: durable work appears only after the owner observed an empty
  // queue, then another Stop invocation finds the same-session lease occupied.
  planSpecJob(ws, "handoff body");
  const contenderPromise = runRunner(ws, {
    contentionWaitMs: 1_000,
    contentionPollMs: 1,
    onContentionRequest: () => { contentionPublished(); },
    runSpecReviewImpl: async () => { contenderCalls++; return CLEAN(); }
  });
  await contentionWasPublished;
  releaseOwner();

  const [owner, contender] = await Promise.all([ownerPromise, contenderPromise]);
  assert.equal(owner.exit, 0);
  assert.equal(contender.exit, 0);
  assert.equal(ownerCalls, 1, "the epoch change makes the owner re-drain before releasing its lease");
  assert.equal(contenderCalls, 0, "the bounded takeover sees an already-drained queue and cannot double-review");
  assert.ok(ownerChecks >= 2, "the owner performs a second quiescence check after the handoff request");
  assert.equal(listJobs(ws).length, 0, "the late queued job cannot be stranded without another natural Stop");
});

test("a dead deep-runner lease is recovered without losing queued work", async () => {
  const ws = freshWs();
  planSpecJob(ws, "dead owner body");
  const lock = path.join(workspaceStateDir(ws), "deep-runner-leases", "session-unscoped.lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ schema: 1, pid: 99_999_999, nonce: "dead", ts: Date.now() }));

  const result = await runRunner(ws, { runSpecReviewImpl: CLEAN });
  assert.equal(result.exit, 0);
  assert.equal(listJobs(ws).length, 0, "the replacement owner drains the durable job");
  assert.equal(fs.existsSync(lock), false, "the recovered lease is released after the run");
});

test("happy path: a CLEAN spec job → claim deleted, exit 0, no wake/advisory", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, out } = await runRunner(ws, { runSpecReviewImpl: CLEAN });
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 0, "clean job's claim deleted");
  assert.equal(listBlocked(ws).length, 0, "no .blocked");
  assert.equal(out.length, 0, "no output on a clean turn");
});

test("session isolation: runner claims only this chat's queued jobs in the same workspace", async () => {
  const ws = freshWs();
  const fileA = path.join(ws, "a.md");
  const fileB = path.join(ws, "b.md");
  fs.writeFileSync(fileA, "body A");
  fs.writeFileSync(fileB, "body B");
  const sessionA = normalizeSessionId("chat-A");
  const sessionB = normalizeSessionId("chat-B");
  enqueue(ws, { kind: "spec", specPath: fileA, contentKey: deepKey(fileA, "body A") }, { sessionKey: sessionA });
  enqueue(ws, { kind: "spec", specPath: fileB, contentKey: deepKey(fileB, "body B") }, { sessionKey: sessionB });

  const reviewed = [];
  const { exit } = await runRunner(ws, {
    input: { cwd: ws, session_id: "chat-B" },
    runSpecReviewImpl: async (filePath) => {
      reviewed.push(path.basename(filePath));
      return { maxSeverity: "none", findingCount: 0, findings: "" };
    }
  });
  assert.equal(exit, 0);
  assert.deepEqual(reviewed, ["b.md"], "chat B must not claim chat A's queued job");
  assert.equal(listJobs(ws, { sessionKey: sessionA }).length, 1, "chat A's job remains queued for chat A");
  assert.equal(listJobs(ws, { sessionKey: sessionB }).length, 0, "chat B's own job was processed");
});

test("session isolation honors the injected env when hook input has no session id", async () => {
  const ws = freshWs();
  const fileA = path.join(ws, "env-a.md");
  const fileB = path.join(ws, "env-b.md");
  fs.writeFileSync(fileA, "body A");
  fs.writeFileSync(fileB, "body B");
  const sessionA = normalizeSessionId("chat-A");
  const sessionB = normalizeSessionId("chat-B");
  enqueue(ws, { kind: "spec", specPath: fileA, contentKey: deepKey(fileA, "body A") }, { sessionKey: sessionA });
  enqueue(ws, { kind: "spec", specPath: fileB, contentKey: deepKey(fileB, "body B") }, { sessionKey: sessionB });

  const reviewed = [];
  const { exit } = await runRunner(ws, {
    input: { cwd: ws },
    env: { BENCH_SESSION_ID: "chat-B" },
    runSpecReviewImpl: async (filePath, _ws, options) => {
      reviewed.push(path.basename(filePath));
      assert.equal(options.env.BENCH_SESSION_ID, "chat-B", "the same injected env reaches the review implementation");
      return { maxSeverity: "none", findingCount: 0, findings: "" };
    }
  });
  assert.equal(exit, 0);
  assert.deepEqual(reviewed, ["env-b.md"], "the env-owned session must not claim another chat's queued work");
  assert.equal(listJobs(ws, { sessionKey: sessionA }).length, 1);
  assert.equal(listJobs(ws, { sessionKey: sessionB }).length, 0);
});

test("session isolation: runner re-delivers only this chat's blocked findings", async () => {
  const ws = freshWs();
  const fileA = path.join(ws, "a.md");
  fs.writeFileSync(fileA, "body A");
  const contentKey = deepKey(fileA, "body A");
  const sessionA = normalizeSessionId("chat-A");
  markBlocked(ws, `${sessionA}--${contentKey}`, {
    kind: "spec", specPath: fileA, contentKey, sessionKey: sessionA,
    findings: "- chat A finding", firstBlockedTs: Date.now()
  });

  const bRun = await runRunner(ws, { input: { cwd: ws, session_id: "chat-B" } });
  assert.equal(bRun.exit, 0, "chat B must not be woken for chat A's durable block");
  assert.doesNotMatch(bRun.err, /chat A finding/);
  assert.equal(listBlocked(ws, { sessionKey: sessionA }).length, 1, "chat A block remains durable");

  const aRun = await runRunner(ws, { input: { cwd: ws, session_id: "chat-A" } });
  assert.equal(aRun.exit, 2, "chat A is still woken for its own block");
  assert.match(aRun.err, /chat A finding/);
});

test("BLOCK: a HIGH spec job → .blocked persisted + exit 2 with findings", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, err } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ maxSeverity: "high", findingCount: 2, findings: "[MiMo]\n- null deref" })
  });
  assert.equal(exit, 2, "HIGH block → exit 2 (wakes even idle)");
  assert.match(err, /null deref/, "findings written to stderr");
  assert.equal(listBlocked(ws).length, 1, ".blocked persisted (durable)");
  assert.equal(listJobs(ws).length, 0, "no leftover .json/.claimed");
});

test("CRASH-SAFETY: a pre-existing .blocked (content unchanged) is RE-DELIVERED (exit 2) and NOT deleted first", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "spec body");
  const contentKey = deepKey(file, "spec body");
  markBlocked(ws, contentKey, { kind: "spec", specPath: file, contentKey, findings: "[MiMo]\n- prior block", firstBlockedTs: Date.now() });
  const { exit, err } = await runRunner(ws);   // nothing queued; just the .blocked from a "crashed" prior run
  assert.equal(exit, 2, "unchanged .blocked within window → re-delivered");
  assert.match(err, /prior block/, "re-delivers the stored findings");
  assert.equal(listBlocked(ws).length, 1, ".blocked NOT deleted before/at delivery (no loss window)");
});

test("BLOCK WAKE CEILING: one unchanged completed block wakes at most 3 times, then stays advisory", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const first = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: persistent" })
  });
  assert.equal(first.exit, 2, "initial persist+delivery is wake 1");
  assert.equal(listBlocked(ws)[0].wakeCount, 1);

  const exits = [];
  for (let i = 0; i < MAX_BLOCK_WAKES + 1; i++) exits.push((await runRunner(ws)).exit);
  assert.deepEqual(exits, [2, 2, 0, 0], "only wakes 2 and 3 repeat; later Stops are non-waking advisories");
  const [blocked] = listBlocked(ws);
  assert.equal(blocked.wakeCount, MAX_BLOCK_WAKES, "the durable counter stops exactly at the ceiling");
  assert.equal(blocked.findings, "BLOCK: persistent", "the completed finding remains durable");
});

test("NO COUNTER / time downgrade: a .blocked older than WAKE_WINDOW → advisory (exit 0), file KEPT", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "spec body");
  const contentKey = deepKey(file, "spec body");
  const now = Date.now();
  markBlocked(ws, contentKey, { kind: "spec", specPath: file, contentKey, findings: "- aging block", firstBlockedTs: now - WAKE_WINDOW_MS - 1000 });
  const { exit, out } = await runRunner(ws, { now });
  assert.equal(exit, 0, "past WAKE_WINDOW → no exit-2 wake");
  assert.equal(out.length, 1, "surfaced as a stdout advisory");
  assert.match(out[0].systemMessage || "", /aging block/);
  assert.equal(listBlocked(ws).length, 1, "file KEPT (never deleted by elapsed time — only content-change retires it)");
});

test("TRANSIENT-SAFE: an UNCERTAIN key (present but unreadable → null) KEEPS + re-delivers the block, never deletes", async () => {
  // null = couldn't determine (transient: a failed `git rev-parse` for a push job, or a present-but-
  // unreadable spec) — NOT a confirmed change. Deleting on null would lose a completed HIGH block on
  // a transient error (the bug the wake-runner itself caught). Exercised via a DIRECTORY at specPath:
  // it EXISTS (so not GONE) but readFileSync throws → currentContentKey returns null.
  const ws = freshWs();
  const target = path.join(ws, "unreadable");
  fs.mkdirSync(target);
  const ck = "ck-transient";
  markBlocked(ws, ck, { kind: "spec", specPath: target, contentKey: ck, findings: "[MiMo]\n- a real block", firstBlockedTs: Date.now() });
  const { exit, err } = await runRunner(ws);
  assert.equal(exit, 2, "uncertain (null) → keep + re-deliver (exit 2), never silently retire on a transient error");
  assert.match(err, /a real block/, "the durable block is re-delivered");
  assert.equal(listBlocked(ws).length, 1, ".blocked KEPT (not deleted on uncertainty)");
});

test("GONE retire: a DELETED spec file → block retired (deleted), NOT re-woken forever", async () => {
  const ws = freshWs();
  const file = path.join(ws, "deleted.md");
  fs.writeFileSync(file, "spec body");
  const ck = deepKey(file, "spec body");
  markBlocked(ws, ck, { kind: "spec", specPath: file, contentKey: ck, findings: "- stale block for a gone spec", firstBlockedTs: Date.now() });
  fs.rmSync(file);   // spec deleted → definitively gone → block is moot → must retire (not re-wake)
  const { exit, err } = await runRunner(ws);
  assert.equal(exit, 0, "gone target → retire, no re-wake");
  assert.equal(listBlocked(ws).length, 0, ".blocked retired — a deleted spec must not re-wake stale blocks forever");
  assert.doesNotMatch(err, /stale block/, "not re-delivered");
});

test("CONTENT-CHANGE retirement: a .blocked whose content changed → deleted, NOT re-delivered", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "OLD");
  const oldKey = deepKey(file, "OLD");
  markBlocked(ws, oldKey, { kind: "spec", specPath: file, contentKey: oldKey, findings: "- stale finding", firstBlockedTs: Date.now() });
  fs.writeFileSync(file, "NEW — agent addressed it");   // content changed
  const { exit, err } = await runRunner(ws);
  assert.equal(exit, 0, "addressed → no wake");
  assert.equal(listBlocked(ws).length, 0, ".blocked retired (deleted) on content-change");
  assert.doesNotMatch(err, /stale finding/, "not re-delivered");
});

test("SURPLUS DRAIN: > MAX_BATCH queued → all clean jobs drain in one invocation with no continuation-wake", async () => {
  const ws = freshWs();
  const N = MAX_BATCH + 1;
  for (let n = 1; n <= N; n++) {
    const f = path.join(ws, `s${n}.md`); fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  let runCount = 0;
  const { exit, err } = await runRunner(ws, { runSpecReviewImpl: async () => { runCount++; return { maxSeverity: "none", findingCount: 0, findings: "" }; } });
  assert.equal(runCount, N, "surplus drains in later bounded batches during this invocation");
  assert.equal(exit, 0, "all-clean surplus must not create a no-action rewake");
  assert.doesNotMatch(err, /more queued/i, "no continuation note");
  assert.equal(listJobs(ws).length, 0, "all jobs processed without needing a second Stop");
});

test("SURPLUS DRAIN: a block in a later batch still drains all in-budget jobs before one wake", async () => {
  const ws = freshWs();
  const N = MAX_BATCH * 2 + 1;
  for (let n = 1; n <= N; n++) {
    const f = path.join(ws, `s${n}.md`); fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  let runCount = 0;
  const { exit, err } = await runRunner(ws, {
    runSpecReviewImpl: async () => {
      runCount++;
      if (runCount === MAX_BATCH + 1) return { maxSeverity: "high", findingCount: 1, findings: "- later block" };
      return { maxSeverity: "none", findingCount: 0, findings: "" };
    }
  });
  assert.equal(exit, 2, "a block found in a later batch still wakes");
  assert.match(err, /later block/);
  assert.equal(listBlocked(ws).length, 1, "blocking job persisted");
  assert.equal(runCount, N, "later eligible jobs are reviewed in this same pass, never drip-fed");
  assert.equal(listJobs(ws).length, 0, "all in-budget jobs were processed before the consolidated wake");
});

test("CONSOLIDATION: blockers and unavailable jobs from one batch share one wake", async () => {
  const ws = freshWs();
  for (const name of ["a.md", "b.md"]) {
    const file = path.join(ws, name);
    fs.writeFileSync(file, name);
    enqueue(ws, { kind: "spec", specPath: file, contentKey: deepKey(file, name) });
  }
  const { exit, err } = await runRunner(ws, {
    runSpecReviewImpl: async (file) => path.basename(file) === "a.md"
      ? { maxSeverity: "high", findingCount: 1, findings: "BLOCK: a is broken" }
      : { retry: true, reason: "provider down", reviewers: [] }
  });
  assert.equal(exit, 2);
  assert.match(err, /Blocking findings \(1\)[\s\S]*a is broken/);
  assert.match(err, /Unavailable reviews \(1\)[\s\S]*b\.md[\s\S]*provider down/);
  assert.equal(listBlocked(ws).length, 1);
  assert.equal(listJobs(ws).length, 1, "only the unavailable job remains queued for its bounded retry");
});

test("N ≤ MAX_BATCH all-clean → exit 0, no continuation-wake", async () => {
  const ws = freshWs();
  for (let n = 1; n <= MAX_BATCH; n++) {
    const f = path.join(ws, `s${n}.md`); fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  const { exit } = await runRunner(ws, { runSpecReviewImpl: async () => ({ maxSeverity: "none", findingCount: 0, findings: "" }) });
  assert.equal(exit, 0, "no surplus → clean exit 0 (agent may idle, nothing stranded)");
  assert.equal(listJobs(ws).length, 0);
});

test("ORPHAN RECOVERY: a dead-pid .claimed is requeued then processed", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md"); fs.writeFileSync(file, "body");
  const ck = deepKey(file, "body");
  const dir = path.join(workspaceStateDir(ws), "deep-queue"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ck}.claimed.999999`), JSON.stringify({ kind: "spec", specPath: file, contentKey: ck }));
  let ran = false;
  const { exit } = await runRunner(ws, { runSpecReviewImpl: async () => { ran = true; return { maxSeverity: "none", findingCount: 0, findings: "" }; } });
  assert.equal(ran, true, "orphan recovered → claimed → run");
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 0);
});

test("RESILIENCE: a review that throws requeues its job and forces a bounded follow-up Stop", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, err } = await runRunner(ws, { runSpecReviewImpl: async () => { throw new Error("reviewer down"); } });
  assert.equal(exit, 2, "requeued work must force the next Stop instead of becoming stranded while idle");
  assert.equal(listJobs(ws).length, 1, "job requeued to .json (never dropped)");
  assert.match(err, /requeued/i);
  assert.match(err, /next Stop retries/i);
});

test("RETRY SIGNAL: a review returning {retry:true} (e.g. git error) REQUEUES the job, never deletes it", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ retry: true, reason: "git error", maxSeverity: "none", findingCount: 0, findings: "" })
  });
  assert.equal(exit, 2, "retryable work forces a follow-up Stop");
  assert.equal(listJobs(ws).length, 1, "retry signal → requeued as .json (the never-lose guarantee), NOT treated as clean+deleted");
  assert.equal(listBlocked(ws).length, 0);
});

test("NO VERDICT DEFENSE: an all-error deep result is requeued, never deleted as clean", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, err } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({
      reviewers: [
        { name: "Kimi", verdict: null, error: "timeout" },
        { name: "Grok", verdict: null, error: "auth" }
      ],
      maxSeverity: "none", findingCount: 0, findings: ""
    })
  });
  assert.equal(exit, 2);
  assert.equal(listJobs(ws).length, 1, "all-error result remains queued for retry");
  assert.equal(listBlocked(ws).length, 0);
  assert.match(err, /no reviewer verdicts/);
});

test("RETRY CAP: repeated failure stops waking but persists a durable unreviewed advisory", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md"); fs.writeFileSync(file, "body");
  const ck = deepKey(file, "body");
  const dir = path.join(workspaceStateDir(ws), "deep-queue"); fs.mkdirSync(dir, { recursive: true });
  // pre-set attempts at the cap-1 so this failing run hits the cap
  fs.writeFileSync(path.join(dir, `${ck}.json`), JSON.stringify({ kind: "spec", specPath: file, contentKey: ck, attempts: MAX_REVIEW_ATTEMPTS - 1 }));
  const { exit, err, out } = await runRunner(ws, { runSpecReviewImpl: async () => { throw new Error("still down"); } });
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 0, "the active retry job is retired at the cap");
  const [failed] = listBlocked(ws);
  assert.ok(failed, "retry exhaustion is durably recorded instead of silently deleted");
  assert.equal(failed.advisoryOnly, true);
  assert.equal(failed.reviewStatus, "unavailable");
  assert.match(failed.findings, /UNREVIEWED after 3 attempts/);
  assert.match(err, /durable unreviewed advisory/i);
  assert.match(out[0]?.systemMessage || "", /UNREVIEWED after 3 attempts/);

  let reran = false;
  const second = await runRunner(ws, { runSpecReviewImpl: async () => { reran = true; return CLEAN(); } });
  assert.equal(second.exit, 0, "the durable warning does not restart the asyncRewake loop");
  assert.equal(reran, false, "unchanged exhausted work is not automatically retried forever");
  assert.match(second.out[0]?.systemMessage || "", /UNREVIEWED after 3 attempts/, "the warning remains visible");

  fs.writeFileSync(file, "changed target");
  const third = await runRunner(ws);
  assert.equal(third.exit, 0);
  assert.equal(listBlocked(ws).length, 0, "changing the target retires the stale unreviewed advisory");
});

test("bench disabled → exit 0 without touching the queue", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  let ran = false;
  const { exit } = await runRunner(ws, { isBenchDisabledImpl: () => true, runSpecReviewImpl: async () => { ran = true; return {}; } });
  assert.equal(exit, 0); assert.equal(ran, false);
  assert.equal(listJobs(ws).length, 1, "queue untouched when disabled");
});

// ── merge jobs (SHA-pinned ranges from the pre-merge gate) ─────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { currentContentKey } from "../global-hooks/deep-queue.mjs";

function gitWs() {
  const ws = freshWs();
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base");
  return { ws, g };
}

test("MERGE job: routes through the PUSH review machinery and stamps its durable block key at BLOCK time", async () => {
  const { ws, g } = gitWs();
  // Enqueue exactly as the pre-merge gate does: SHA-pinned range, key seeded pre-merge (stale by review time).
  const enqueueKey = deepKey("merge:A..B", "refsha-at-enqueue");
  enqueue(ws, { kind: "merge", range: "A..B", contentKey: enqueueKey });
  let reviewedRange = null;
  const { exit } = await runRunner(ws, {
    runPushReviewImpl: async (range) => { reviewedRange = range; return { maxSeverity: "high", findingCount: 1, findings: "BLOCK: bad" }; },
    runSpecReviewImpl: async () => { throw new Error("merge job must NOT run the spec review"); }
  });
  assert.equal(exit, 2, "high merge block wakes");
  assert.equal(reviewedRange, "A..B", "merge reviews its pinned range via the push machinery");
  const [blocked] = listBlocked(ws);
  assert.ok(blocked, "durable .blocked persisted");
  // Stamped at BLOCK time (post-merge HEAD), NOT the stale enqueue key — the merge itself moved HEAD
  // between enqueue and review, so the enqueue key would read as "changed" and retire the block at
  // the very next Stop (a push-gate catch).
  assert.notEqual(blocked.contentKey, enqueueKey, "enqueue-time key must not be the durable identity");
  assert.equal(blocked.contentKey, currentContentKey(ws, blocked), "block key matches the recompute → survives the next Stop");

  // Next Stop with HEAD unchanged: the block survives (re-delivered), not retired.
  const second = await runRunner(ws, { runPushReviewImpl: async () => { throw new Error("no re-review"); } });
  assert.equal(second.exit, 2, "unaddressed merge block re-wakes");
  assert.equal(listBlocked(ws).length, 1, "block survives while unaddressed");

  // The fix commit lands (HEAD moves) → the block retires at the following Stop.
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "fix: address findings");
  const third = await runRunner(ws, {});
  assert.equal(third.exit, 0);
  assert.equal(listBlocked(ws).length, 0, "addressed (HEAD moved) → retired");
});

test("DRAIN DEADLINE: surplus that can't fit the runner budget is deferred + exit 2 (never stranded waiting on a Stop)", async () => {
  const ws = freshWs();
  for (let n = 0; n < MAX_BATCH + 2; n++) {
    const f = path.join(ws, `d${n}.md`);
    fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  let runCount = 0;
  const { exit, err } = await runRunner(ws, {
    runSpecReviewImpl: async () => { runCount++; return { maxSeverity: "none", findingCount: 0, findings: "" }; },
    // Budgets that no second batch can fit: worst-case review (1s) + margin > 1ms runner budget.
    env: { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" }
  });
  assert.equal(runCount, MAX_BATCH, "only the first batch runs — a second would be killed mid-claim by the hook timeout");
  assert.equal(exit, 2, "deferred surplus forces the next Stop instead of waiting on one that may never come");
  assert.match(err, /deferred \(runner budget exhausted\)/);
  assert.equal(listJobs(ws).length, 2, "deferred jobs remain QUEUED (unclaimed) for the forced next Stop");
});

test("DRAIN DEADLINE CEILING: a long slow queue forces at most 3 automatic continuation Stops", async () => {
  const ws = freshWs();
  const total = (MAX_RUNNER_FOLLOWUP_WAKES + 2) * MAX_BATCH + 1;
  for (let n = 0; n < total; n++) {
    const file = path.join(ws, `slow-${n}.md`);
    fs.writeFileSync(file, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: file, contentKey: deepKey(file, `body ${n}`) });
  }
  const env = { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" };
  const exits = [];
  let cappedMessage = "";
  for (let n = 0; n < MAX_RUNNER_FOLLOWUP_WAKES + 2; n++) {
    const result = await runRunner(ws, { env, runSpecReviewImpl: CLEAN });
    exits.push(result.exit);
    cappedMessage += result.out.map((entry) => entry.systemMessage || "").join("\n");
  }
  assert.deepEqual(exits, [2, 2, 2, 0, 0], "only three deadline continuations are automatic; natural Stops still make bounded progress");
  assert.match(cappedMessage, /automatic wake ceiling exhausted at 3\/3/);
  assert.ok(listJobs(ws).length > 0, "remaining work stays durably queued instead of being dropped");

  const finalNatural = await runRunner(ws, { env, runSpecReviewImpl: CLEAN });
  assert.equal(finalNatural.exit, 0);
  assert.equal(listJobs(ws).length, 0, "a later natural Stop finishes the durable remainder without restarting a wake loop");
});

test("GLOBAL DEEP CEILING: new blockers in successive slow batches still cause at most 3 automatic Stops", async () => {
  const ws = freshWs();
  const total = (MAX_RUNNER_FOLLOWUP_WAKES + 2) * MAX_BATCH + 1;
  for (let n = 0; n < total; n++) {
    const file = path.join(ws, `slow-block-${n}.md`);
    fs.writeFileSync(file, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: file, contentKey: deepKey(file, `body ${n}`) });
  }
  const env = { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" };
  const BLOCK = async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: batch finding" });
  const exits = [];
  let advisoryText = "";
  for (let n = 0; n < MAX_RUNNER_FOLLOWUP_WAKES + 2; n++) {
    const result = await runRunner(ws, { env, runSpecReviewImpl: BLOCK });
    exits.push(result.exit);
    advisoryText += result.out.map((entry) => entry.systemMessage || "").join("\n");
  }
  assert.deepEqual(exits, [2, 2, 2, 0, 0], "fresh blockers cannot bypass the task/session wake ceiling");
  assert.match(advisoryText, /automatic wake ceiling exhausted at 3\/3/);
  assert.ok(listBlocked(ws).length > 0, "suppressed findings remain durable rather than being discarded");
});

test("GLOBAL DEEP CEILING: TTL expiry cannot reopen the cycle while durable queued work remains", async () => {
  const ws = freshWs();
  const total = (MAX_RUNNER_FOLLOWUP_WAKES + 3) * MAX_BATCH + 1;
  for (let n = 0; n < total; n++) {
    const file = path.join(ws, `ttl-${n}.md`);
    fs.writeFileSync(file, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: file, contentKey: deepKey(file, `body ${n}`) });
  }
  const env = { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" };
  const base = Date.now();
  const exits = [];
  for (let n = 0; n < MAX_RUNNER_FOLLOWUP_WAKES; n++) {
    exits.push((await runRunner(ws, { env, now: base, clock: () => base, runSpecReviewImpl: CLEAN })).exit);
  }
  assert.deepEqual(exits, [2, 2, 2]);
  const queuedAtCeiling = listJobs(ws).length;
  assert.ok(queuedAtCeiling > MAX_BATCH, "enough unchanged durable work remains to request continuation");

  const afterTtl = base + RUNNER_FOLLOWUP_WINDOW_MS + 1;
  const expiredRun = await runRunner(ws, { env, now: afterTtl, clock: () => afterTtl, runSpecReviewImpl: CLEAN });
  assert.equal(expiredRun.exit, 0, "elapsed wall time alone cannot authorize a fourth automatic Stop");
  assert.ok(listJobs(ws).length > 0, "the capped invocation still makes bounded progress without dropping the remainder");
  assert.match(expiredRun.out[0]?.systemMessage || "", /automatic wake ceiling exhausted at 3\/3/);
});

test("GLOBAL DEEP CEILING: a persistent reset env value is consumed once; changing its nonce resets once", async () => {
  const ws = freshWs();
  const runsPerCappedCycle = MAX_RUNNER_FOLLOWUP_WAKES + 2;
  const totalRuns = MAX_RUNNER_FOLLOWUP_WAKES + (2 * runsPerCappedCycle);
  const total = totalRuns * MAX_BATCH + 1;
  for (let n = 0; n < total; n++) {
    const file = path.join(ws, `reset-${n}.md`);
    fs.writeFileSync(file, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: file, contentKey: deepKey(file, `body ${n}`) });
  }
  const baseEnv = { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" };
  const initialExits = [];
  for (let n = 0; n < MAX_RUNNER_FOLLOWUP_WAKES; n++) {
    initialExits.push((await runRunner(ws, { env: baseEnv, runSpecReviewImpl: CLEAN })).exit);
  }
  assert.deepEqual(initialExits, [2, 2, 2], "the ordinary cycle first reaches its ceiling");

  const inheritedEnv = { ...baseEnv, BENCH_DEEP_CYCLE_RESET: "manual-retry-1" };
  const exits = [];
  for (let n = 0; n < runsPerCappedCycle; n++) {
    exits.push((await runRunner(ws, { env: inheritedEnv, runSpecReviewImpl: CLEAN })).exit);
  }
  assert.deepEqual(exits, [2, 2, 2, 0, 0], "one reset nonce grants one bounded cycle, even when inherited by every Stop");
  assert.ok(listJobs(ws).length > MAX_BATCH, "durable work remains so a deliberate fresh reset is observable");

  const changedEnv = { ...baseEnv, BENCH_DEEP_CYCLE_RESET: "manual-retry-2" };
  const changedExits = [];
  for (let n = 0; n < runsPerCappedCycle; n++) {
    changedExits.push((await runRunner(ws, { env: changedEnv, runSpecReviewImpl: CLEAN })).exit);
  }
  assert.deepEqual(changedExits, [2, 2, 2, 0, 0], "a changed nonce authorizes exactly one more bounded cycle, never an unbounded reset");
  assert.equal(listJobs(ws).length, 1, "all unprocessed work remains durable after both capped reset cycles");
});

test("MERGE block: a transient git failure at BLOCK time never retires the block (unstamped → self-heal)", async () => {
  // NON-git ws → the block-time recompute fails exactly like a transient `git rev-parse` blip.
  const ws = freshWs();
  enqueue(ws, { kind: "merge", range: "A..B", contentKey: deepKey("merge:A..B", "refsha-at-enqueue") });
  const first = await runRunner(ws, {
    runPushReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: bad" })
  });
  assert.equal(first.exit, 2);
  let [blocked] = listBlocked(ws);
  assert.equal(blocked.contentKey, null, "failed recompute persists UNSTAMPED — never the stale enqueue key");

  // Next Stop, git still broken: unstamped block survives and re-delivers (never retired on uncertainty).
  const second = await runRunner(ws, {});
  assert.equal(second.exit, 2, "unstamped block re-wakes");
  assert.equal(listBlocked(ws).length, 1, "survives while git is unavailable");

  // git heals with a tip that PREDATES the block (backdated committer time = HEAD hasn't moved since
  // block time) → the block self-heals: stamped with current HEAD as the baseline, NOT retired.
  const g = (...a) => execFileSync("git", a, { cwd: ws, env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z" } });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "post-merge head");
  const third = await runRunner(ws, {});
  assert.equal(third.exit, 2, "still delivered — healing is not retiring");
  [blocked] = listBlocked(ws);
  assert.equal(blocked.contentKey, currentContentKey(ws, blocked), "self-healed: stamped at the first successful recompute");
  assert.match(blocked.findings || "", /BLOCK: bad/, "payload survives the heal rewrite");

  // From here, normal addressed-retirement: the fix commit moves HEAD → retired.
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "fix"], { cwd: ws });
  const fourth = await runRunner(ws, {});
  assert.equal(fourth.exit, 0);
  assert.equal(listBlocked(ws).length, 0, "addressed (HEAD moved) → retired");
});

test("MERGE block: a fix committed while UNSTAMPED retires at heal — never adopts the fix as its baseline (gate catch)", async () => {
  const ws = freshWs();   // non-git → block persists unstamped
  enqueue(ws, { kind: "merge", range: "A..B", contentKey: deepKey("merge:A..B", "refsha-at-enqueue") });
  // Block a minute in the past (clock drives firstBlockedTs at markBlocked time) so the fix commit
  // below is unambiguously NEWER than the delivery.
  const first = await runRunner(ws, {
    clock: () => Date.now() - 60_000,
    runPushReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: bad" })
  });
  assert.equal(first.exit, 2);
  assert.equal(listBlocked(ws)[0].contentKey, null, "unstamped");

  // The agent (woken by the block) lands the fix while git recovery + a fresh commit both happen
  // before the next heal attempt. Stamping NOW would adopt the fix as baseline and re-wake forever.
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "fix: address findings");
  const second = await runRunner(ws, {});
  assert.equal(second.exit, 0, "no re-wake — the post-block commit IS the addressed signal");
  assert.equal(listBlocked(ws).length, 0, "retired at heal: tip is newer than firstBlockedTs");
});

test("MERGE block: a FUTURE-dated but UNMOVED HEAD never retires an unstamped block (reflog, not commit metadata)", async () => {
  // The %ct trap: fast-forwarding onto a clock-skewed remote commit gives HEAD a FUTURE committer
  // date while the local reflog entry (the actual movement record) is honest local time. Simulate
  // with plumbing: commit-tree forges the future commit metadata; the reset that moves HEAD onto it
  // runs WITHOUT date overrides, so its reflog entry is local-now (pre-block).
  const ws = freshWs();
  const g = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base");
  const futureSha = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "future-dated tip"],
    { cwd: ws, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "@32472144000 +0000", GIT_AUTHOR_DATE: "@32472144000 +0000", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" } }).trim();
  g("reset", "-q", "--hard", futureSha);
  assert.ok(Number(g("log", "-1", "--format=%ct", "HEAD").trim()) * 1000 > Date.now(), "precondition: tip commit metadata is future-dated");

  // Block AFTER the ff, with the block-time stamp failing (simulated via a doomed recompute is not
  // injectable here — instead enqueue and force the unstamped path by breaking rev-parse... simplest
  // honest route: block in a ws whose queue entry points at this repo but whose stamp failed is not
  // constructible without a git outage, so persist the unstamped block directly, as the runner does).
  const contentKey = deepKey("merge:A..B", "refsha-at-enqueue");
  enqueue(ws, { kind: "merge", range: "A..B", contentKey });
  const jobKey = listJobs(ws)[0]._jobKey;
  const claimed = (await import("../global-hooks/deep-queue.mjs")).claim(ws, jobKey);
  markBlocked(ws, jobKey, { kind: "merge", range: "A..B", contentKey: null, findings: "BLOCK: bad", traceId: null, firstBlockedTs: Date.now() }, { claimedPath: claimed });
  assert.equal(listBlocked(ws)[0].contentKey, null, "precondition: unstamped");

  // Heal: HEAD has NOT moved since before the block (reflog's newest entry = the pre-block reset).
  // Commit-metadata reasoning would read the future %ct as "commit landed after the block" → retire
  // → HIGH finding lost. The reflog says: same SHA → stamp it as baseline, keep delivering.
  const heal = await runRunner(ws, {});
  assert.equal(heal.exit, 2, "unmoved HEAD → block kept + delivered");
  const [blocked] = listBlocked(ws);
  assert.ok(blocked, "NOT retired — commit dates are metadata, not movement");
  assert.equal(blocked.contentKey, currentContentKey(ws, blocked), "stamped with the true (unmoved) baseline");

  // And the normal ending: a real fix commit moves HEAD → retired.
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "fix");
  const after = await runRunner(ws, {});
  assert.equal(after.exit, 0);
  assert.equal(listBlocked(ws).length, 0);
});

test("firstBlockedTs is stamped when the block PERSISTS (markBlocked), not at invocation start", async () => {
  // The review can run ~10 min after runMain's `now` snapshot; a commit landed DURING it predates
  // delivery, so pinning firstBlockedTs to invocation start would let the unstamped-heal misread
  // that commit as 'addressed' and discard a HIGH block (a push-gate catch).
  const ws = freshWs();
  planSpecJob(ws);
  const before = Date.now();
  await runRunner(ws, {
    now: 12345,   // ancient invocation-start snapshot — must NOT become the block's timestamp
    runSpecReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: bad" })
  });
  const [blocked] = listBlocked(ws);
  assert.ok(blocked.firstBlockedTs >= before, `stamped at persist time (got ${blocked.firstBlockedTs}, invocation now=12345)`);
});


// ── audited regressions: spec review-time stamp (D1), wake-window message (D2), budget clamp (D3) ──

test("SPEC block: the durable key is the REVIEWED content (res.hash), not the stale enqueue key", async () => {
  // Save v1 → ALLOW+enqueue; edit to v2 BEFORE the runner reviews: runSpecReview reads the file at
  // review time and returns hash = deepKey(filePath, v2) — the same formula currentContentKey
  // recomputes. Keying the block on the v1 enqueue key makes the next Stop read the reviewed v2 as
  // "changed" and retire a HIGH block that nothing addressed (live-verified audit finding).
  const ws = freshWs();
  const { file, contentKey } = planSpecJob(ws, "spec v1");
  fs.writeFileSync(file, "spec v2");   // edited after enqueue, before the review runs
  const reviewedHash = deepKey(file, "spec v2");
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: v2 finding", hash: reviewedHash })
  });
  assert.equal(exit, 2);
  const [blocked] = listBlocked(ws);
  assert.equal(blocked.contentKey, reviewedHash, "the block is keyed on what the review actually covered");
  assert.notEqual(blocked.contentKey, contentKey, "the superseded v1 enqueue key is not the durable identity");

  // Next Stop, spec untouched since the review: nothing changed AFTER the review → keep + re-deliver.
  const second = await runRunner(ws, { runSpecReviewImpl: async () => { throw new Error("no re-review"); } });
  assert.equal(second.exit, 2, "unchanged since the review → re-delivered, never retired as 'changed'");
  assert.equal(listBlocked(ws).length, 1, "the durable HIGH block survives");
});

test("SPEC block: a review result without a hash falls back to the enqueue-time key", async () => {
  const ws = freshWs();
  const { contentKey } = planSpecJob(ws, "spec body");
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ maxSeverity: "high", findingCount: 1, findings: "BLOCK: no hash field" })
  });
  assert.equal(exit, 2);
  assert.equal(listBlocked(ws)[0].contentKey, contentKey, "absent res.hash → enqueue key (legacy/alternate review impls)");
});

test("WAKE WINDOW expiry is reported as window expiry, not as wake-count exhaustion", async () => {
  const now = Date.now();
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "spec body");
  const contentKey = deepKey(file, "spec body");
  markBlocked(ws, contentKey, { kind: "spec", specPath: file, contentKey, findings: "- window block", wakeCount: 1, firstBlockedTs: now - WAKE_WINDOW_MS - 1000 });
  const { exit, out } = await runRunner(ws, { now });
  assert.equal(exit, 0);
  const msg = out[0]?.systemMessage || "";
  assert.match(msg, /wake window expired after 1\/3 deliveries/, "one delivery + expired window is NOT 'wakes exhausted at 1/3'");
  assert.doesNotMatch(msg, /wakes exhausted/);

  // Count exhaustion inside the window keeps the existing message.
  const ws2 = freshWs();
  const file2 = path.join(ws2, "s.md");
  fs.writeFileSync(file2, "spec body");
  const key2 = deepKey(file2, "spec body");
  markBlocked(ws2, key2, { kind: "spec", specPath: file2, contentKey: key2, findings: "- count block", wakeCount: MAX_BLOCK_WAKES, firstBlockedTs: now });
  const second = await runRunner(ws2, { now });
  assert.equal(second.exit, 0);
  assert.match(second.out[0]?.systemMessage || "", new RegExp(`wakes exhausted at ${MAX_BLOCK_WAKES}/${MAX_BLOCK_WAKES}`));
});

test("DRAIN DEADLINE: a NEGATIVE review budget env is clamped to the default (no unbounded batch start)", async () => {
  const ws = freshWs();
  for (let n = 0; n < MAX_BATCH + 1; n++) {
    const f = path.join(ws, `neg-${n}.md`);
    fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  let runCount = 0;
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: async () => { runCount++; return { maxSeverity: "none", findingCount: 0, findings: "" }; },
    env: { BENCH_DEEP_REVIEW_BUDGET_MS: "-600000", BENCH_DEEP_RUNNER_BUDGET_MS: "1" }
  });
  // Number("-600000") || default keeps the negative: the worst-case batch math goes NEGATIVE, so a
  // second batch "fits" a 1ms runner budget — the hook would be killed mid-claim by the real timeout.
  assert.equal(runCount, MAX_BATCH, "only the first batch runs — the surplus cannot fit the runner budget");
  assert.equal(exit, 2, "the deferred surplus forces the next Stop");
  assert.equal(listJobs(ws).length, 1, "the surplus job stays durably queued");
});

test("DRAIN DEADLINE: a NEGATIVE runner budget env is clamped to the default (surplus still drains)", async () => {
  const ws = freshWs();
  for (let n = 0; n < MAX_BATCH + 1; n++) {
    const f = path.join(ws, `negr-${n}.md`);
    fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: CLEAN,
    env: { BENCH_DEEP_REVIEW_BUDGET_MS: "1000", BENCH_DEEP_RUNNER_BUDGET_MS: "-600000" }
  });
  assert.equal(exit, 0, "the default runner budget fits every batch — a negative env must not force deferral");
  assert.equal(listJobs(ws).length, 0, "the whole surplus drains in one invocation");
});


test("LEGACY block: a peer session's in-flight delivery suppresses the duplicate wake (compare-and-rewrite)", async () => {
  // Legacy (session-less) blocks are listed by EVERY session's runner while the runner lease is
  // per-session: without a conditional persist, both sessions read wakeCount N, persist N+1, and
  // BOTH deliver — a later pass then exceeds MAX_BLOCK_WAKES. The wake-lock marks the peer's
  // in-flight compare-and-rewrite; this runner must defer, not double-deliver.
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "spec body");
  const contentKey = deepKey(file, "spec body");
  markBlocked(ws, contentKey, { kind: "spec", specPath: file, contentKey, findings: "- legacy block", firstBlockedTs: Date.now(), wakeCount: 1 });
  fs.mkdirSync(path.join(workspaceStateDir(ws), "deep-queue", `${contentKey}.blocked.wake-lock`), { recursive: true });
  const { exit, err } = await runRunner(ws, { input: { cwd: ws, session_id: "chat-B" } });
  assert.equal(exit, 0, "the peer owns this delivery — a duplicate wake spends two deliveries for one counted wake");
  assert.doesNotMatch(err, /legacy block/);
  assert.equal(listBlocked(ws)[0].wakeCount, 1, "the counter is not double-incremented");
});
