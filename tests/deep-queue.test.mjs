// tests/deep-queue.test.mjs — the crash-safe deep-review job queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dq-root-")));

import { enqueue, listJobs, listBlocked, claim, requeue, recoverOrphans, markBlocked, deleteJob, currentContentKey, GONE } from "../global-hooks/deep-queue.mjs";
import { deepKey } from "../global-hooks/deep-review.mjs";
import { normalizeSessionId, workspaceStateDir } from "../global-hooks/config-store.mjs";

function freshWs() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dq-ws-"))); }
const qdir = (ws) => path.join(workspaceStateDir(ws), "deep-queue");

const LARGE = 64 * 1024 + 5000;   // larger than the old review-prompt cap (no key cap exists now)

// Regression (stop gate + pre-push gate, 2026-06-22): the spec contentKey is keyed on the FULL file
// content, identically at enqueue and at the retire-check, so (a) a large UNCHANGED spec is not
// falsely seen as "changed" (no wrongful .blocked retire), and (b) a change ANYWHERE — including
// beyond any prompt cap — IS detected (no stale review deduped past a key cap).
test("large spec: currentContentKey == enqueue key for unchanged content (no false retire)", () => {
  const ws = freshWs();
  const file = path.join(ws, "big.md");
  const big = "x".repeat(LARGE);
  fs.writeFileSync(file, big);
  const enqKey = deepKey(file, big);   // how the plan-file gate keys it (full content)
  assert.equal(currentContentKey(ws, { kind: "spec", specPath: file, contentKey: enqKey }), enqKey,
    "recompute must equal the enqueue key for a large unchanged spec");
});

test("large spec: a change BEYOND the old prompt cap is still detected (no stale review)", () => {
  const ws = freshWs();
  const file = path.join(ws, "big.md");
  const head = "x".repeat(LARGE);
  fs.writeFileSync(file, head + "ORIGINAL_TAIL");
  const enqKey = deepKey(file, head + "ORIGINAL_TAIL");
  fs.writeFileSync(file, head + "EDITED_TAIL");   // only the tail (well past 64KB) changed
  assert.notEqual(currentContentKey(ws, { kind: "spec", specPath: file, contentKey: enqKey }), enqKey,
    "an edit beyond the prompt cap still changes the key (the key covers the full reviewed content)");
});

test("enqueue writes a <contentKey>.json job and dedupes by contentKey", () => {
  const ws = freshWs();
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "ck1" }), true);
  const jobs = listJobs(ws);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "spec");
  assert.equal(jobs[0].contentKey, "ck1");
  assert.equal(jobs[0]._jobKey, "ck1");
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "ck1" }), false, "same contentKey → deduped");
  assert.equal(listJobs(ws).length, 1);
});

test("session-stamped enqueue isolates same contentKey across same-workspace chats", () => {
  const ws = freshWs();
  const sessionA = normalizeSessionId("chat-A");
  const sessionB = normalizeSessionId("chat-B");
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "same-content" }, { sessionKey: sessionA }), true);
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "same-content" }, { sessionKey: sessionB }), true,
    "a second session's identical content is not deduped by the first session's job");
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "same-content" }, { sessionKey: sessionA }), false,
    "the same session still dedupes its own content");

  const aJobs = listJobs(ws, { sessionKey: sessionA });
  const bJobs = listJobs(ws, { sessionKey: sessionB });
  assert.equal(aJobs.length, 1);
  assert.equal(bJobs.length, 1);
  assert.equal(listJobs(ws).length, 2, "unfiltered list preserves legacy project-level visibility");
  assert.equal(aJobs[0].sessionKey, sessionA);
  assert.equal(bJobs[0].sessionKey, sessionB);
  assert.match(aJobs[0]._jobKey, new RegExp(`^${sessionA}--same-content$`));
  assert.match(bJobs[0]._jobKey, new RegExp(`^${sessionB}--same-content$`));
});

test("session filter includes legacy unstamped jobs but excludes foreign stamped jobs", () => {
  const ws = freshWs();
  const sessionA = normalizeSessionId("chat-A");
  const sessionB = normalizeSessionId("chat-B");
  enqueue(ws, { kind: "spec", specPath: "/legacy.md", contentKey: "legacy" });
  enqueue(ws, { kind: "spec", specPath: "/a.md", contentKey: "owned" }, { sessionKey: sessionA });
  enqueue(ws, { kind: "spec", specPath: "/b.md", contentKey: "foreign" }, { sessionKey: sessionB });
  assert.deepEqual(listJobs(ws, { sessionKey: sessionA }).map((j) => j.contentKey).sort(), ["legacy", "owned"]);
});

test("enqueue dedupes against an existing .claimed or .blocked", () => {
  const ws = freshWs();
  enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k1" });
  claim(ws, "k1");
  assert.equal(enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k1" }), false, "in-progress (.claimed) not re-enqueued");
  const ws2 = freshWs();
  markBlocked(ws2, "k2", { kind: "spec", specPath: "/x/s.md", contentKey: "k2", findings: "x", firstBlockedTs: 1 });
  assert.equal(enqueue(ws2, { kind: "spec", specPath: "/x/s.md", contentKey: "k2" }), false, ".blocked not re-enqueued");
});

test("claim is atomic — a second claim of the same job returns null", () => {
  const ws = freshWs();
  enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k" });
  const first = claim(ws, "k");
  assert.ok(first && first.includes(".claimed."));
  assert.equal(claim(ws, "k"), null, "already claimed → null");
  assert.equal(listJobs(ws).length, 0, "claimed job no longer listed as .json");
});

test("requeue moves a .claimed back to .json", () => {
  const ws = freshWs();
  enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k" });
  const claimed = claim(ws, "k");
  requeue(ws, claimed);
  assert.equal(fs.existsSync(claimed), false);
  assert.equal(listJobs(ws).length, 1, "requeued back to .json");
});

test("recoverOrphans requeues a dead-pid claim", () => {
  const ws = freshWs();
  const dir = qdir(ws); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "k.claimed.999999"), JSON.stringify({ kind: "spec", specPath: "/x/s.md", contentKey: "k" }));
  assert.equal(recoverOrphans(ws, { now: Date.now() }), 1);
  assert.equal(listJobs(ws).length, 1, "orphan requeued to .json");
});

test("recoverOrphans requeues a stale-mtime claim even if the pid is alive", () => {
  const ws = freshWs();
  const dir = qdir(ws); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `k.claimed.${process.pid}`), JSON.stringify({ kind: "spec", contentKey: "k" }));
  assert.equal(recoverOrphans(ws, { now: Date.now() + 60 * 60 * 1000 }), 1, "future now → stale → requeued");
  assert.equal(listJobs(ws).length, 1);
});

test("markBlocked renames the claim to .blocked (durable) and removes the claim", () => {
  const ws = freshWs();
  enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k" });
  const claimed = claim(ws, "k");
  markBlocked(ws, "k", { kind: "spec", specPath: "/x/s.md", contentKey: "k", findings: "boom", firstBlockedTs: 5 }, { claimedPath: claimed });
  assert.equal(fs.existsSync(claimed), false, "claim removed");
  const blocked = listBlocked(ws);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].findings, "boom");
  assert.equal(blocked[0].firstBlockedTs, 5);
  assert.equal(blocked[0]._jobKey, "k");
});

test("deleteJob removes a file", () => {
  const ws = freshWs();
  enqueue(ws, { kind: "spec", specPath: "/x/s.md", contentKey: "k" });
  deleteJob(listJobs(ws)[0]._path);
  assert.equal(listJobs(ws).length, 0);
});

test("currentContentKey: spec re-reads the file; DELETED spec → GONE; push uses HEAD; git fail → null", () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "v1");
  const job = { kind: "spec", specPath: file };
  assert.equal(currentContentKey(ws, job), deepKey(file, "v1"));
  fs.writeFileSync(file, "v2");
  assert.equal(currentContentKey(ws, job), deepKey(file, "v2"), "reflects new content (change detection)");
  assert.equal(currentContentKey(ws, { kind: "spec", specPath: "/no/such/file.md" }), GONE, "deleted/absent spec → GONE (definitive → retire)");
  assert.equal(currentContentKey(ws, { kind: "push", range: "a..b" }, { gitImpl: () => ["HEADSHA", true] }), deepKey("push:a..b", "HEADSHA"));
  assert.equal(currentContentKey(ws, { kind: "push", range: "a..b" }, { gitImpl: () => ["", false] }), null, "git fail → null (transient → keep)");
  // merge recomputes with its OWN kind prefix — recomputing every range job as `push:` made durable
  // MERGE blocks always look "changed" and retire at the next Stop (a push-gate catch).
  assert.equal(currentContentKey(ws, { kind: "merge", range: "a..b" }, { gitImpl: () => ["HEADSHA", true] }), deepKey("merge:a..b", "HEADSHA"));
  assert.notEqual(currentContentKey(ws, { kind: "merge", range: "a..b" }, { gitImpl: () => ["HEADSHA", true] }),
    currentContentKey(ws, { kind: "push", range: "a..b" }, { gitImpl: () => ["HEADSHA", true] }), "merge and push identities never collide");
  assert.equal(currentContentKey(ws, { kind: "merge", range: "a..b" }, { gitImpl: () => ["", false] }), null, "git fail → null (transient → keep)");
});

test("recoverOrphans: a stale .claimed whose .blocked already exists is DROPPED, not requeued (markBlocked crash window)", () => {
  const ws = freshWs();
  const dir = qdir(ws); fs.mkdirSync(dir, { recursive: true });
  // Simulate the crash window: markBlocked wrote .blocked but didn't delete the claim before crashing.
  fs.writeFileSync(path.join(dir, "ck.blocked"), JSON.stringify({ kind: "spec", contentKey: "ck", findings: "x" }));
  fs.writeFileSync(path.join(dir, "ck.claimed.999999"), JSON.stringify({ kind: "spec", contentKey: "ck" }));
  recoverOrphans(ws, { now: Date.now() });
  assert.equal(fs.existsSync(path.join(dir, "ck.claimed.999999")), false, "leftover claim dropped (block already persisted)");
  assert.equal(listJobs(ws).length, 0, "NOT requeued as .json → no duplicate review");
  assert.equal(listBlocked(ws).length, 1, "the durable .blocked is untouched");
});


// ── compare-and-rewrite wake-count persist (legacy cross-session lost update) ─────────────────────
// A legacy (session-less) .blocked is listed by EVERY session's runner, but the runner lease is
// per-session: two sessions can each read wakeCount N, both persist N+1, and BOTH deliver — two
// deliveries spent, one counted, and a later pass exceeds MAX_BLOCK_WAKES. markBlocked with
// expectedWakeCount refuses a persist based on a stale read; the runner must not deliver on refusal.

test("markBlocked compare-and-rewrite: a persist based on a STALE wakeCount read is refused", () => {
  const ws = freshWs();
  const payload = (wakeCount) => ({ kind: "spec", specPath: "/x/s.md", contentKey: "k", findings: "x", firstBlockedTs: 5, wakeCount });
  markBlocked(ws, "k", payload(1));   // legacy block at wakeCount 1, listed by two concurrent session runners
  const first = markBlocked(ws, "k", payload(2), { expectedWakeCount: 1 });
  assert.ok(first, "the persist matching the stored count lands");
  const stale = markBlocked(ws, "k", payload(2), { expectedWakeCount: 1 });
  assert.equal(stale, null, "the peer already moved the counter — a second N→N+1 persist is a lost update (both would deliver)");
  assert.equal(listBlocked(ws)[0].wakeCount, 2, "exactly one delivery is counted");
});

test("markBlocked compare-and-rewrite: a retired (missing/corrupt) block is refused, never resurrected", () => {
  const ws = freshWs();
  assert.equal(markBlocked(ws, "gone", { kind: "spec", contentKey: "gone", findings: "x", wakeCount: 2 }, { expectedWakeCount: 1 }), null,
    "retired between the runner's list and its persist → the write must not recreate it");
  assert.equal(listBlocked(ws).length, 0, "no record was resurrected");
  markBlocked(ws, "k", { kind: "spec", specPath: "/x/s.md", contentKey: "k", findings: "x", firstBlockedTs: 5, wakeCount: 1 });
  fs.writeFileSync(path.join(qdir(ws), "k.blocked"), "not json");
  assert.equal(markBlocked(ws, "k", { kind: "spec", specPath: "/x/s.md", contentKey: "k", findings: "x", firstBlockedTs: 5, wakeCount: 2 }, { expectedWakeCount: 1 }), null,
    "corrupt since the list → refuse (uncertainty shortens the loop, never extends it)");
});

test("markBlocked compare-and-rewrite: a live peer wake-lock defers; a crashed peer's lock is recovered", () => {
  const ws = freshWs();
  const payload = (wakeCount) => ({ kind: "spec", specPath: "/x/s.md", contentKey: "k", findings: "x", firstBlockedTs: 5, wakeCount });
  markBlocked(ws, "k", payload(1));
  const lock = path.join(qdir(ws), "k.blocked.wake-lock");
  fs.mkdirSync(lock);   // a peer session is mid-delivery (holding its compare-and-rewrite)
  assert.equal(markBlocked(ws, "k", payload(2), { expectedWakeCount: 1 }), null, "a fresh peer lock owns the in-flight delivery");
  assert.equal(listBlocked(ws)[0].wakeCount, 1, "the peer's in-flight persist is not overwritten");

  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);   // the holder crashed — the lock is older than the stale threshold
  const recovered = markBlocked(ws, "k", payload(2), { expectedWakeCount: 1 });
  assert.ok(recovered, "a crashed peer's lock must not veto a durable finding forever");
  assert.equal(listBlocked(ws)[0].wakeCount, 2);
  assert.equal(fs.existsSync(lock), false, "the lock is released after the persist");
});

test("enqueue supersedes still-queued older revisions of the same spec path (across sessions)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dq-supersede-"));
  assert.equal(enqueue(ws, { kind: "spec", specPath: "plans/a.md", contentKey: "rev1" }, { sessionKey: "chat-old" }), true);
  assert.equal(enqueue(ws, { kind: "spec", specPath: "plans/a.md", contentKey: "rev2" }, { sessionKey: "chat-new" }), true);
  const jobs = listJobs(ws);
  assert.equal(jobs.length, 1, "only the newest revision stays queued");
  assert.equal(jobs[0].contentKey, "rev2");
  // A different spec path is never touched.
  assert.equal(enqueue(ws, { kind: "spec", specPath: "plans/b.md", contentKey: "rev9" }, { sessionKey: "chat-new" }), true);
  assert.equal(listJobs(ws).length, 2);
});
test("supersede leaves claimed and blocked entries of the same path untouched", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dq-supersede-claimed-"));
  enqueue(ws, { kind: "spec", specPath: "plans/a.md", contentKey: "rev1" }, { sessionKey: "chat-x" });
  const key = listJobs(ws)[0]._jobKey;
  const claimed = claim(ws, key);
  assert.ok(claimed, "claimed the rev1 job");
  enqueue(ws, { kind: "spec", specPath: "plans/a.md", contentKey: "rev2" }, { sessionKey: "chat-x" });
  assert.ok(fs.existsSync(claimed), "in-flight claim survives a supersede");
  assert.equal(listJobs(ws).length, 1);
});
