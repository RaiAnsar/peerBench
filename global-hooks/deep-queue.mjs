// global-hooks/deep-queue.mjs
// Durable, crash-safe job queue for the deep reviews. The synchronous gates (plan-file, pre-push)
// ENQUEUE jobs here; the asyncRewake Stop runner (deep-review-runner.mjs) claims, runs, and delivers
// them. State moves by ATOMIC RENAME so a crash at any window leaves a recoverable file:
//
//   <jobKey>.json            queued
//   <jobKey>.claimed.<pid>   a runner is reviewing it
//   <jobKey>.blocked         review found a HIGH block (DURABLE; {kind,specPath?,range?,contentKey,findings,firstBlockedTs})
//
// jobKey == contentKey (a hash): deepKey(specPath,content) for spec, deepKey(`push:<range>`,headSha)
// for push. There is NO delivery counter — a .blocked file is retired ONLY on content-change.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeSessionId, workspaceStateDir } from "./config-store.mjs";
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
  fs.mkdirSync(dir, { recursive: true });
  let existing = [];
  try {
    existing = fs.readdirSync(dir).filter((f) =>
      f === `${jobKey}.json` || f === `${jobKey}.blocked` || f.startsWith(`${jobKey}.claimed.`));
  } catch { /* dir just created */ }
  if (existing.length) return false;
  const file = path.join(dir, `${jobKey}.json`);
  const tmp = TMP(file);
  fs.writeFileSync(tmp, `${JSON.stringify({ kind, specPath, range, contentKey, sessionKey: ownerSessionKey || undefined, ts: now }, null, 2)}\n`);
  fs.renameSync(tmp, file);
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

// Persist a BLOCK result durably (rename claim → <jobKey>.blocked) BEFORE any wake, then drop the
// claim. payload: { kind, specPath?, range?, contentKey, findings, firstBlockedTs }.
export function markBlocked(ws, jobKey, payload, { claimedPath } = {}) {
  const dir = queueDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, `${jobKey}.blocked`);
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
  if (job.kind === "push") {
    const [head, ok] = gitImpl(["rev-parse", "HEAD"], ws);
    if (!ok || !head) return null;          // transient git failure → uncertain → KEEP (never lose on a blip)
    return deepKey(`push:${job.range}`, head);
  }
  // spec (default) — keyed on the FULL current file content, identically to the enqueue + the deep
  // run, so an unchanged spec (any size) yields the same key (no false retire) and a change anywhere
  // (incl. beyond any prompt cap) is detected.
  if (!existsImpl(job.specPath)) return GONE; // deleted spec → definitively gone → RETIRE (block is moot)
  let content;
  try { content = readImpl(job.specPath); } catch { return null; }   // present but unreadable → transient → KEEP
  return deepKey(job.specPath, content);
}
