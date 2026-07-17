// global-hooks/deep-queue.mjs
// Durable, crash-safe job queue for the deep reviews. The synchronous gates (plan-file, pre-push)
// ENQUEUE jobs here; the asyncRewake Stop runner (deep-review-runner.mjs) claims, runs, and delivers
// them. State moves by ATOMIC RENAME so a crash at any window leaves a recoverable file:
//
//   <jobKey>.json            queued
//   <jobKey>.claimed.<pid>   a runner is reviewing it
//   <jobKey>.blocked         review found a HIGH block, or retry exhaustion left the target visibly
//                            unreviewed (DURABLE; advisoryOnly distinguishes the latter)
//
// jobKey == contentKey (a hash): deepKey(specPath,content) for spec, deepKey(`push:<range>`,headSha)
// for push. Completed blocks carry a bounded wakeCount, but remain durable and are retired ONLY on
// content-change; exhausting automatic delivery downgrades them to a visible non-waking advisory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeSessionId, workspaceStateDir, ensurePrivateDir, writePrivateFileAtomic } from "./config-store.mjs";
import { deepKey } from "./deep-review.mjs";

const queueDir = (ws) => path.join(workspaceStateDir(ws), "deep-queue");
const TMP = (f) => `${f}.tmp.${process.pid}`;
const jobKeyFor = (contentKey, sessionKey = null) => sessionKey ? `${sessionKey}--${contentKey}` : contentKey;
const belongsToSession = (job, sessionKey = null) => !sessionKey || !job.sessionKey || job.sessionKey === sessionKey;

// Local git helper (deploy-parity: global-hooks only). Returns [out, ok].
function gitDefault(args, cwd) {
  try { return [execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim(), true]; }
  catch { return ["", false]; }
}

function readJob(file, jobKeySuffix) {
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!job || typeof job !== "object" || Array.isArray(job)) return null;
    job._path = file;
    job._jobKey = path.basename(file).replace(jobKeySuffix, "");
    return job;
  } catch { return null; }
}

// Write <contentKey>.json IFF no state file for this jobKey already exists (.json/.claimed.*/.blocked).
// Returns true if newly enqueued, false if deduped (already known). Atomic.
export function enqueue(ws, { kind, specPath = null, range = null, contentKey, sessionKey: jobSessionKey = null }, { now = Date.now(), sessionKey = null } = {}) {
  if (!contentKey) throw new Error("enqueue: contentKey required");
  const ownerSessionKey = normalizeSessionId(sessionKey ?? jobSessionKey);
  const jobKey = jobKeyFor(contentKey, ownerSessionKey);
  const dir = queueDir(ws);
  // Jobs name spec paths and push ranges: keep the whole state path owner-only, like the
  // rest of the state layer.
  ensurePrivateDir(workspaceStateDir(ws));
  let existing = [];
  try {
    existing = fs.readdirSync(dir).filter((f) =>
      f === `${jobKey}.json` || f === `${jobKey}.blocked` || f.startsWith(`${jobKey}.claimed.`));
  } catch { /* dir just created */ }
  if (existing.length) return false;
  // SUPERSEDE: a newer revision of the same spec target replaces any still-QUEUED older revision —
  // across sessions, because the file's current bytes are global truth (claimed/blocked entries are
  // untouched: one is in flight, the other is a delivered finding). Without this, every save of an
  // actively-edited plan/spec accumulated one more queued deep job per revision, so the runner
  // always had stale work and kept waking sessions to review dead bytes.
  if (kind === "spec" && specPath) {
    let stale = [];
    try {
      stale = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp."))
        .map((f) => readJob(path.join(dir, f), /\.json$/))
        .filter((job) => job && job.kind === "spec" && job.specPath === specPath && job.contentKey !== contentKey);
    } catch { /* dir just created */ }
    for (const job of stale) {
      try { fs.rmSync(job._path, { force: true }); } catch { /* claimed meanwhile — the runner owns it now */ }
    }
  }
  const file = path.join(dir, `${jobKey}.json`);
  writePrivateFileAtomic(file, `${JSON.stringify({ kind, specPath, range, contentKey, sessionKey: ownerSessionKey || undefined, ts: now }, null, 2)}\n`);
  return true;
}

export function listJobs(ws, { sessionKey = null } = {}) {
  const expectedSessionKey = normalizeSessionId(sessionKey);
  const dir = queueDir(ws);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp.")); } catch { return []; }
  return files.map((f) => readJob(path.join(dir, f), /\.json$/)).filter((job) => job && belongsToSession(job, expectedSessionKey));
}

export function listBlocked(ws, { sessionKey = null } = {}) {
  const expectedSessionKey = normalizeSessionId(sessionKey);
  const dir = queueDir(ws);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".blocked") && !f.includes(".tmp.")); } catch { return []; }
  return files.map((f) => readJob(path.join(dir, f), /\.blocked$/)).filter((job) => job && belongsToSession(job, expectedSessionKey));
}

// Atomically claim <jobKey>.json → <jobKey>.claimed.<pid>. Returns the claimed path, or null if
// another runner already took it (rename of a missing file throws → null).
export function claim(ws, jobKey, { pid = process.pid } = {}) {
  const from = path.join(queueDir(ws), `${jobKey}.json`);
  const to = path.join(queueDir(ws), `${jobKey}.claimed.${pid}`);
  try { fs.renameSync(from, to); return to; } catch { return null; }
}

// Requeue a claimed file back to <jobKey>.json (orphan recovery — a crash, NOT a review failure;
// preserves the file as-is, no attempt accounting).
export function requeue(ws, claimedPath) {
  try {
    const base = path.basename(claimedPath).replace(/\.claimed\.\d+$/, "");
    const to = path.join(queueDir(ws), `${base}.json`);
    fs.renameSync(claimedPath, to);
    return to;
  } catch { return null; }
}

// Requeue a claimed job for RETRY after a transient review/git error, recording a bumped `attempts`
// count. Counting here is SAFE (unlike a delivered `.blocked`): a queued job carries NO completed
// finding, so the runner dropping it after a retry cap loses no review RESULT — it only stops
// retrying a review that never finished. Atomic: write the fresh `.json` then drop the claim.
export function requeueForRetry(ws, claimedPath, job, attempts, { now = Date.now() } = {}) {
  const dir = queueDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const ownerSessionKey = normalizeSessionId(job.sessionKey);
  const jobKey = job._jobKey || jobKeyFor(job.contentKey, ownerSessionKey);
  const file = path.join(dir, `${jobKey}.json`);
  const tmp = TMP(file);
  fs.writeFileSync(tmp, `${JSON.stringify({ kind: job.kind, specPath: job.specPath ?? null, range: job.range ?? null, contentKey: job.contentKey, sessionKey: ownerSessionKey || undefined, ts: job.ts ?? now, attempts }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  try { fs.rmSync(claimedPath, { force: true }); } catch { /* best-effort */ }
  return attempts;
}

// Requeue stale claims: pid is dead OR mtime older than staleMs (> the runner timeout). Self-heals
// a killed/timed-out runner so its in-flight job is retried next Stop instead of lost.
export function recoverOrphans(ws, { now = Date.now(), staleMs = 25 * 60 * 1000 } = {}) {
  const dir = queueDir(ws);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => /\.claimed\.\d+$/.test(f) && !f.includes(".tmp.")); } catch { return 0; }
  let recovered = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const jobKey = f.replace(/\.claimed\.\d+$/, "");
    // If a `.blocked` for this jobKey already exists, the block was persisted but the claim wasn't
    // yet removed (crash in markBlocked's narrow write-.blocked → delete-claim window). The block is
    // durable; drop the leftover claim instead of requeuing it → no duplicate review of a done job.
    if (fs.existsSync(path.join(dir, `${jobKey}.blocked`))) { try { fs.rmSync(full, { force: true }); } catch { /* noop */ } continue; }
    const pid = Number(f.match(/\.claimed\.(\d+)$/)?.[1]);
    let dead = true;
    if (pid) { try { process.kill(pid, 0); dead = false; } catch (e) { dead = e && e.code !== "EPERM"; } }  // EPERM = alive, not ours
    let stale = false;
    try { stale = now - fs.statSync(full).mtimeMs > staleMs; } catch { stale = true; }
    if (dead || stale) { if (requeue(ws, full)) recovered++; }
  }
  return recovered;
}

const BLOCK_WAKE_LOCK_STALE_MS = 60 * 1000;  // the CAS critical section is three file ops; older ⇒ the holder crashed

// mkdir mutex (the runner-lease primitive) serializing a wake-count compare-and-rewrite ACROSS
// sessions: the runner lease is per-session, but a legacy session-less .blocked is listed by every
// session's runner. Returns a release function, or null when a LIVE peer holds it (the peer owns the
// in-flight delivery — deferring shortens the loop, never extends it). A stale lock is a crashed
// holder's and is recovered.
function acquireBlockWakeLock(dir, jobKey, now = Date.now()) {
  const lock = path.join(dir, `${jobKey}.blocked.wake-lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* recovered by a contender */ } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = true;
      try { stale = now - fs.statSync(lock).mtimeMs > BLOCK_WAKE_LOCK_STALE_MS; } catch { stale = true; }
      if (!stale) return null;
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* a contender recovered it first */ }
    }
  }
  return null;
}

// Persist a BLOCK result durably (rename claim → <jobKey>.blocked) BEFORE any wake, then drop the
// claim. payload: { kind, specPath?, range?, contentKey, findings, firstBlockedTs }.
// With expectedWakeCount this is a COMPARE-AND-REWRITE of the stored wakeCount under the wake-lock:
// the persist lands only when the stored count still equals what the caller based its delivery on
// (a legacy session-less block is visible to every session's runner, so two sessions could
// otherwise read N, both persist N+1, and both deliver — pushing an unchanged target past its wake
// ceiling). Returns null — the caller must NOT deliver that duplicate wake — on a count mismatch,
// a retired/corrupt record, or a live peer's lock.
export function markBlocked(ws, jobKey, payload, { claimedPath, expectedWakeCount } = {}) {
  const dir = queueDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, `${jobKey}.blocked`);
  if (expectedWakeCount !== undefined) {
    const release = acquireBlockWakeLock(dir, jobKey);
    if (!release) return null;
    try {
      let stored = null;
      try { stored = JSON.parse(fs.readFileSync(to, "utf8")); } catch { stored = null; }
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;   // retired/corrupt since the caller's list
      const storedWakeCount = Number.isInteger(Number(stored.wakeCount)) && Number(stored.wakeCount) >= 0
        ? Number(stored.wakeCount)
        : null;
      if (storedWakeCount !== expectedWakeCount) return null;
      const tmp = TMP(to);
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      fs.renameSync(tmp, to);
      return to;
    } finally {
      release();
    }
  }
  const tmp = TMP(to);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, to);
  if (claimedPath) { try { fs.rmSync(claimedPath, { force: true }); } catch { /* best-effort */ } }
  return to;
}

export function deleteJob(p) { try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ } }

// Sentinel: the job's target is DEFINITIVELY gone (a deleted spec file) → the block is moot and the
// caller should RETIRE it. Distinct from `null`, which means "couldn't determine — transient error"
// (the caller KEEPS the block on null so a transient failure never loses a completed finding).
export const GONE = "__deep_target_gone__";

// Recompute a job's CURRENT content key, to detect content-change (a retirement signal for a .blocked
// job). spec → deepKey(specPath, currentFileContent); push → deepKey(`push:<range>`, currentHEAD).
// Returns GONE when the target is definitively absent (deleted spec → retire), or null when it can't
// be determined (transient: an unreadable-but-present spec, or a failed `git rev-parse` → KEEP).
export function currentContentKey(ws, job, {
  gitImpl = gitDefault,
  readImpl = (p) => fs.readFileSync(p, "utf8"),
  existsImpl = (p) => fs.existsSync(p)
} = {}) {
  if (job.kind === "push" || job.kind === "merge") {
    const [head, ok] = gitImpl(["rev-parse", "HEAD"], ws);
    if (!ok || !head) return null;          // transient git failure → uncertain → KEEP (never lose on a blip)
    // Kind-prefixed so a merge block's identity recomputes as `merge:…` — recomputing every range
    // job as `push:…` made durable MERGE blocks always look "changed" → retired at the next Stop.
    // HEAD as the seed = "addressed" signal: a new commit (the fix) retires the block. Merge blocks
    // get their contentKey stamped at BLOCK time (deep-review-runner), not enqueue time, because the
    // merge itself moves HEAD between enqueue and review.
    return deepKey(`${job.kind}:${job.range}`, head);
  }
  // spec (default) — keyed on the FULL current file content, identically to the enqueue + the deep
  // run, so an unchanged spec (any size) yields the same key (no false retire) and a change anywhere
  // (incl. beyond any prompt cap) is detected.
  if (!existsImpl(job.specPath)) return GONE; // deleted spec → definitively gone → RETIRE (block is moot)
  let content;
  try { content = readImpl(job.specPath); } catch { return null; }   // present but unreadable → transient → KEEP
  return deepKey(job.specPath, content);
}
