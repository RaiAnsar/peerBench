// tests/deep-queue.test.mjs — the crash-safe deep-review job queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dq-root-")));

import { enqueue, listJobs, listBlocked, claim, requeue, recoverOrphans, markBlocked, deleteJob, currentContentKey } from "../global-hooks/deep-queue.mjs";
import { deepKey, specContentKey, SPEC_KEY_BYTES } from "../global-hooks/deep-review.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

function freshWs() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dq-ws-"))); }
const qdir = (ws) => path.join(workspaceStateDir(ws), "deep-queue");

// Regression (stop gate, 2026-06-22): a spec LARGER than the key cap must NOT be falsely seen as
// "changed" at the retire-check — else its .blocked HIGH block is wrongly retired (deleted). The
// enqueue key (specContentKey on full content) and currentContentKey's recompute must be identical.
test("large spec (> SPEC_KEY_BYTES): currentContentKey == enqueue key for unchanged content (no false retire)", () => {
  const ws = freshWs();
  const file = path.join(ws, "big.md");
  const big = "x".repeat(SPEC_KEY_BYTES + 5000);   // beyond the cap
  fs.writeFileSync(file, big);
  const enqKey = specContentKey(file, big);                 // how the plan-file gate keys it (full → capped inside)
  const cur = currentContentKey(ws, { kind: "spec", specPath: file, contentKey: enqKey });
  assert.equal(cur, enqKey, "recompute must equal the enqueue key for a large unchanged spec");
  // and a change WITHIN the cap is still detected (real retire still works)
  fs.writeFileSync(file, "y".repeat(SPEC_KEY_BYTES + 5000));
  assert.notEqual(currentContentKey(ws, { kind: "spec", specPath: file, contentKey: enqKey }), enqKey, "a real content change is still detected");
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

test("currentContentKey: spec re-reads the file; push uses HEAD; missing file → null", () => {
  const ws = freshWs();
  const file = path.join(ws, "s.md");
  fs.writeFileSync(file, "v1");
  const job = { kind: "spec", specPath: file };
  assert.equal(currentContentKey(ws, job), deepKey(file, "v1"));
  fs.writeFileSync(file, "v2");
  assert.equal(currentContentKey(ws, job), deepKey(file, "v2"), "reflects new content (change detection)");
  assert.equal(currentContentKey(ws, { kind: "spec", specPath: "/no/such/file.md" }), null, "missing file → null");
  assert.equal(currentContentKey(ws, { kind: "push", range: "a..b" }, { gitImpl: () => ["HEADSHA", true] }), deepKey("push:a..b", "HEADSHA"));
  assert.equal(currentContentKey(ws, { kind: "push", range: "a..b" }, { gitImpl: () => ["", false] }), null, "git fail → null");
});
