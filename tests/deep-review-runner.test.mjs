// tests/deep-review-runner.test.mjs — the asyncRewake Stop runner that delivers deep-review findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "drr-root-")));

import { runMain, WAKE_WINDOW_MS, MAX_BATCH, MAX_REVIEW_ATTEMPTS } from "../global-hooks/deep-review-runner.mjs";
import { enqueue, listJobs, listBlocked, markBlocked } from "../global-hooks/deep-queue.mjs";
import { deepKey } from "../global-hooks/deep-review.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

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

test("happy path: a CLEAN spec job → claim deleted, exit 0, no wake/advisory", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, out } = await runRunner(ws, { runSpecReviewImpl: CLEAN });
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 0, "clean job's claim deleted");
  assert.equal(listBlocked(ws).length, 0, "no .blocked");
  assert.equal(out.length, 0, "no output on a clean turn");
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

test("TRANSIENT-SAFE: when the current content key can't be determined (null), a .blocked is KEPT + re-delivered, never deleted", async () => {
  // null = couldn't determine (transient `git rev-parse` failure for a push job, or an unreadable
  // spec) — NOT a confirmed content change. Deleting on null would lose a completed HIGH block on a
  // transient error (the bug the wake-runner itself caught). Exercised here via a spec whose file is
  // gone → currentContentKey returns null (same code path the push-git-failure hits).
  const ws = freshWs();
  const file = path.join(ws, "gone.md");
  fs.writeFileSync(file, "spec body");
  const ck = deepKey(file, "spec body");
  markBlocked(ws, ck, { kind: "spec", specPath: file, contentKey: ck, findings: "[MiMo]\n- a real block", firstBlockedTs: Date.now() });
  fs.rmSync(file);   // → currentContentKey null (uncertain), must NOT be treated as a content change
  const { exit, err } = await runRunner(ws);
  assert.equal(exit, 2, "uncertain current key → keep + re-deliver (exit 2), never silently retire");
  assert.match(err, /a real block/, "the durable block is re-delivered");
  assert.equal(listBlocked(ws).length, 1, ".blocked KEPT (not deleted on uncertainty — no loss on transient failure)");
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

test("SURPLUS DRAIN: > MAX_BATCH queued → MAX_BATCH run + CONTINUATION-WAKE (exit 2) so surplus can't strand while idle", async () => {
  const ws = freshWs();
  const N = MAX_BATCH + 1;
  for (let n = 1; n <= N; n++) {
    const f = path.join(ws, `s${n}.md`); fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  let runCount = 0;
  const { exit, err } = await runRunner(ws, { runSpecReviewImpl: async () => { runCount++; return { maxSeverity: "none", findingCount: 0, findings: "" }; } });
  assert.equal(runCount, MAX_BATCH, "exactly MAX_BATCH jobs run concurrently this invocation");
  assert.equal(exit, 2, "unclaimed surplus → continuation-wake (exit 2) forces a next Stop to drain it");
  assert.match(err, /more queued/i, "the continuation note explains why");
  assert.equal(listJobs(ws).length, N - MAX_BATCH, "surplus left as .json for the next (woken) Stop");
});

test("SURPLUS DRAIN: a second invocation drains the leftover → exit 0", async () => {
  const ws = freshWs();
  const N = MAX_BATCH + 1;
  for (let n = 1; n <= N; n++) {
    const f = path.join(ws, `s${n}.md`); fs.writeFileSync(f, `body ${n}`);
    enqueue(ws, { kind: "spec", specPath: f, contentKey: deepKey(f, `body ${n}`) });
  }
  const CLEAN_NONE = async () => ({ maxSeverity: "none", findingCount: 0, findings: "" });
  await runRunner(ws, { runSpecReviewImpl: CLEAN_NONE });        // first: MAX_BATCH run, continuation-wake
  const { exit } = await runRunner(ws, { runSpecReviewImpl: CLEAN_NONE });  // second: drains the leftover
  assert.equal(exit, 0, "queue fully drained → no more continuation-wake");
  assert.equal(listJobs(ws).length, 0, "all jobs processed across the two (woken) invocations");
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

test("RESILIENCE: a review that throws requeues its job (.json), runner exits 0", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit, err } = await runRunner(ws, { runSpecReviewImpl: async () => { throw new Error("reviewer down"); } });
  assert.equal(exit, 0, "a throwing review must not crash the runner");
  assert.equal(listJobs(ws).length, 1, "job requeued to .json (never dropped)");
  assert.match(err, /requeued/i);
});

test("RETRY SIGNAL: a review returning {retry:true} (e.g. git error) REQUEUES the job, never deletes it", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  const { exit } = await runRunner(ws, {
    runSpecReviewImpl: async () => ({ retry: true, reason: "git error", maxSeverity: "none", findingCount: 0, findings: "" })
  });
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 1, "retry signal → requeued as .json (the never-lose guarantee), NOT treated as clean+deleted");
  assert.equal(listBlocked(ws).length, 0);
});

test("RETRY CAP: a queued job that keeps failing is dropped after MAX_REVIEW_ATTEMPTS (no infinite retry; loses no finding)", async () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md"); fs.writeFileSync(file, "body");
  const ck = deepKey(file, "body");
  const dir = path.join(workspaceStateDir(ws), "deep-queue"); fs.mkdirSync(dir, { recursive: true });
  // pre-set attempts at the cap-1 so this failing run hits the cap
  fs.writeFileSync(path.join(dir, `${ck}.json`), JSON.stringify({ kind: "spec", specPath: file, contentKey: ck, attempts: MAX_REVIEW_ATTEMPTS - 1 }));
  const { exit, err } = await runRunner(ws, { runSpecReviewImpl: async () => { throw new Error("still down"); } });
  assert.equal(exit, 0);
  assert.equal(listJobs(ws).length, 0, "dropped after the cap — a never-completed review (no finding), safe to drop");
  assert.match(err, /giving up/i);
});

test("bench disabled → exit 0 without touching the queue", async () => {
  const ws = freshWs();
  planSpecJob(ws);
  let ran = false;
  const { exit } = await runRunner(ws, { isBenchDisabledImpl: () => true, runSpecReviewImpl: async () => { ran = true; return {}; } });
  assert.equal(exit, 0); assert.equal(ran, false);
  assert.equal(listJobs(ws).length, 1, "queue untouched when disabled");
});
