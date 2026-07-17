#!/usr/bin/env node
// global-hooks/deep-review-runner.mjs
// The ONE async hook: an asyncRewake Stop hook that delivers deep-review findings to the agent
// RELIABLY, even when it has gone idle after its turn (exit 2 wakes an idle agent per the docs).
//
// Each turn end: recover orphaned claims → re-deliver pending .blocked jobs (retire ONLY on
// content-change; wake at most MAX_BLOCK_WAKES, else non-waking advisory, file KEPT) → claim ≤ MAX_BATCH
// queued jobs → run them CONCURRENTLY (errors requeue) → CLEAN delete / BLOCK persist-then-wake.
// Delivery/follow-up counters are persisted before a wake so crashes can shorten, never extend, the
// automatic loop. Fails OPEN for the turn while keeping durable jobs/findings visible.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput, workspaceStateDir } from "./config-store.mjs";
import { shouldRewake, deepKey } from "./deep-review.mjs";
import { runSpecReview as defaultRunSpecReview, runPushReview as defaultRunPushReview } from "./spec-review-run.mjs";
import {
  recoverOrphans, listBlocked, listJobs, claim, requeueForRetry, markBlocked, deleteJob, currentContentKey, GONE
} from "./deep-queue.mjs";

export const MAX_BATCH = 3;                     // claim+run at most this many CONCURRENTLY per batch — a safety bound
                                                // on concurrent agentic load. Surplus is drained in later batches inside
                                                // this same hook invocation, so Claude is not re-woken just to process
                                                // queued clean reviews.
export const RUNNER_BUDGET_MS = 12 * 60 * 1000; // MUST match the deep-runner Stop hook timeout in hooks/hooks.json (720s).
                                                // A batch may consume the full per-review budget (~10 min), so starting
                                                // another one near the end of this window gets the runner KILLED mid-claim —
                                                // and with no later Stop, the orphaned claims sit unprocessed indefinitely
                                                // (recovery only runs at the NEXT invocation). The drain loop therefore only
                                                // starts a new batch when a worst-case batch still fits. Deferred surplus
                                                // gets at most three continuation wakes, then waits durably for a natural Stop.
export const WAKE_WINDOW_MS = 30 * 60 * 1000;   // re-WAKE a .blocked within this; after, downgrade to advisory (file kept)
export const MAX_REVIEW_ATTEMPTS = 3;           // bound retries of a QUEUED job whose review keeps failing (git/transient).
                                                // At the cap the runner stops the exit-2 wake loop, but persists an
                                                // advisory-only unavailable record until the target changes. The absence
                                                // of a completed review must never be silently discarded.
export const MAX_BLOCK_WAKES = 3;                // completed finding: at most three automatic deliveries per unchanged target
export const MAX_RUNNER_FOLLOWUP_WAKES = 3;      // every deep-runner exit-2 combined: at most three automatic Stops per task/session
export const RUNNER_FOLLOWUP_WINDOW_MS = 2 * 60 * 60 * 1000; // stale-marker cleanup only; durable work never ages out

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

// Where HEAD pointed at `atMs`, reconstructed from the LOCAL reflog — git's actual HEAD-movement
// record (each entry is stamped by the local clock AT UPDATE TIME, unlike %ct commit metadata,
// which is mutable/non-monotonic: a fast-forward onto a future-dated remote commit has a future
// %ct but an honest local reflog entry). Returns:
//   { sha }        — the newest entry at/before atMs (entry times floor to the second → a
//                    same-second movement counts as at-or-before: errs toward KEEP, never lose);
//   { sha: null }  — every recorded HEAD position postdates atMs (repo initialized after, or all
//                    pre-atMs entries pruned BECAUSE later movements exist) → HEAD moved for sure;
//   null           — reflog unavailable/unparseable → indeterminate.
// Residual (documented, not fixable locally): reflog entry idents honor an exported
// GIT_COMMITTER_DATE, so deliberately forged local commit dates can still skew this — but that
// requires explicit local action; the realistic failure (clock-skewed REMOTE commit metadata)
// never reaches the local reflog.
function reflogHeadAt(ws, atMs) {
  try {
    const out = execFileSync("git", ["log", "-g", "--date=unix", "--format=%H %gd", "HEAD"],
      { cwd: ws, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const entries = out.trim().split("\n").map((l) => {
      const m = l.match(/^([0-9a-f]{40,}) HEAD@\{(\d+)\}$/);
      return m ? { sha: m[1], ts: Number(m[2]) * 1000 } : null;
    });
    if (!entries.length || entries.some((e) => !e)) return null;
    const hit = entries.find((e) => e.ts <= atMs);   // newest-first → first at-or-before = position at atMs
    return { sha: hit ? hit.sha : null };
  } catch { return null; }
}

// Retrieval footer stamped on every block so the full per-reviewer findings are always one command
// away (`show <traceId>`) even if the inline text is truncated — no manual dig through the state dir.
const traceHint = (id) => (id ? `\n↳ full findings: /bench:show ${id}` : "");

function targetLabel(job) {
  return job?.specPath || job?.range || job?.kind || "unknown target";
}

function persistBlockedUpdate(ws, job, overrides = {}, opts = {}) {
  const { _path, _jobKey, ...payload } = job;
  return markBlocked(ws, _jobKey, { ...payload, ...overrides }, opts);
}

const followupFile = (ws, sessionKey) => path.join(
  workspaceStateDir(ws),
  sessionKey ? `deep-runner-followup.${sessionKey}` : "deep-runner-followup"
);

const DEEP_RUNNER_LEASE_STALE_MS = 30 * 60 * 1000;
const DEEP_RUNNER_HANDOFF_WAIT_MS = 250;
const DEEP_RUNNER_HANDOFF_POLL_MS = 10;

function runnerScope(sessionKey) {
  return String(sessionKey || "session-unscoped").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function runnerLeaseDir(ws, sessionKey) {
  return path.join(workspaceStateDir(ws), "deep-runner-leases", `${runnerScope(sessionKey)}.lock`);
}

function runnerContentionFile(ws, sessionKey) {
  return path.join(workspaceStateDir(ws), "deep-runner-contention", `${runnerScope(sessionKey)}.json`);
}

function readRunnerContentionEpoch(ws, sessionKey) {
  try {
    const value = JSON.parse(fs.readFileSync(runnerContentionFile(ws, sessionKey), "utf8"));
    return `${Math.max(0, Number(value?.epoch) || 0)}:${String(value?.nonce || "")}`;
  } catch {
    return "0:";
  }
}

// A contender cannot simply return while the owner is quiescing: a producer may have enqueued work
// after the owner's last empty queue read. Publish a durable epoch so the owner re-drains. The nonce
// keeps concurrent same-process writers observable even if both read the same prior numeric epoch.
function publishRunnerContention(ws, sessionKey, now = Date.now()) {
  const file = runnerContentionFile(ws, sessionKey);
  let prior = 0;
  try { prior = Math.max(0, Number(JSON.parse(fs.readFileSync(file, "utf8"))?.epoch) || 0); }
  catch { /* first contention or a recoverable corrupt marker */ }
  const marker = {
    schema: 1,
    epoch: prior + 1,
    nonce: `${process.pid}-${now}-${Math.random().toString(16).slice(2)}`,
    ts: now
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${marker.nonce}`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return `${marker.epoch}:${marker.nonce}`;
}

const handoffDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRunnerLease(ws, sessionKey, {
  waitMs = DEEP_RUNNER_HANDOFF_WAIT_MS,
  pollMs = DEEP_RUNNER_HANDOFF_POLL_MS
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (Date.now() < deadline) {
    await handoffDelay(Math.max(1, Number(pollMs) || DEEP_RUNNER_HANDOFF_POLL_MS));
    const release = acquireRunnerLease(ws, sessionKey);
    if (release) return release;
  }
  return null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

// One runner owns one workspace/session at a time. Queue claims alone do not serialize the global
// wake counter or per-block wakeCount updates; without this lease, parallel Stop hooks can each read
// count N, both deliver, and both persist N+1. A contender records an epoch so the owner re-drains at
// quiescence; it also briefly retries acquisition to cover the final epoch-check/lease-release gap.
// Dead owners are recoverable immediately.
function acquireRunnerLease(ws, sessionKey, now = Date.now()) {
  const lock = runnerLeaseDir(ws, sessionKey);
  const ownerFile = path.join(lock, "owner.json");
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    const nonce = `${process.pid}-${now}-${Math.random().toString(16).slice(2)}`;
    let created = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      created = true;
      fs.writeFileSync(ownerFile, `${JSON.stringify({ schema: 1, pid: process.pid, nonce, ts: now })}\n`, { mode: 0o600 });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
          if (owner?.nonce !== nonce) return;
          fs.rmSync(lock, { recursive: true, force: true });
        } catch { /* owner already released/replaced */ }
      };
    } catch (error) {
      if (created) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* failed lease never becomes authoritative */ }
      }
      if (error?.code !== "EEXIST") throw error;
      let owner = null, age = 0;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch { /* incomplete owner */ }
      try { age = Math.max(0, now - fs.statSync(lock).mtimeMs); } catch { age = DEEP_RUNNER_LEASE_STALE_MS + 1; }
      const dead = owner?.pid ? !processIsAlive(Number(owner.pid)) : false;
      const stale = age > DEEP_RUNNER_LEASE_STALE_MS;
      if (dead || stale) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* another contender */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

function readFollowupCount(file, now, { durableWorkRemains = false } = {}) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    // TTL is only crash/stale-state cleanup after a cycle has actually drained. Letting elapsed time
    // erase the counter while jobs/findings are still durable re-opens the exact unchanged wake loop
    // this task/session ceiling exists to stop.
    if (!durableWorkRemains && now - Number(marker.ts) >= RUNNER_FOLLOWUP_WINDOW_MS) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      return 0;
    }
    return Math.max(0, Number(marker.count) || 0);
  } catch {
    return 0;
  }
}

function requestedResetNonce(value) {
  const raw = String(value ?? "").trim();
  if (!raw || ["0", "false", "no", "off"].includes(raw.toLowerCase())) return null;
  // Store only a digest: callers can use any memorable/changing token without writing it back into
  // shared state. Legacy BENCH_DEEP_CYCLE_RESET=1 remains valid, but is consumed exactly once.
  return createHash("sha256").update(raw).digest("hex");
}

function consumeResetNonce(file, nonce, now) {
  if (!nonce) return { applied: false, error: false };
  try {
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first use/corrupt marker */ }
    if (prior?.nonce === nonce) return { applied: false, error: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ nonce, ts: now })}\n`);
    fs.renameSync(tmp, file);
    return { applied: true, error: false };
  } catch {
    // Fail closed for automatic waking: never clear the ceiling unless one-shot consumption itself
    // was persisted first. A reset-state write failure may shorten a cycle, but cannot unbound it.
    return { applied: false, error: true };
  }
}

function writeFollowupCount(file, count, now) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ count, ts: now })}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Synchronous stdin read (the runner reads the Stop hook JSON from fd 0).
function readInputSync() {
  try { const raw = fs.readFileSync(0, "utf8").trim(); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

export async function runMain(options = {}) {
  const {
    input: inputOverride,
    ws: wsOverride,
    isBenchDisabledImpl = defaultIsBenchDisabled,
    env = process.env,
    exitImpl = (code) => process.exit(code),
    contentionWaitMs = DEEP_RUNNER_HANDOFF_WAIT_MS,
    contentionPollMs = DEEP_RUNNER_HANDOFF_POLL_MS,
    onContentionRequest
  } = options;
  const input = inputOverride ?? readInputSync();
  const runtimeEnv = env || process.env;
  const cwd = (input && input.cwd) || runtimeEnv.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = wsOverride || workspaceRoot(cwd);
  const sessionKey = sessionKeyFromInput(input, runtimeEnv);

  if (isBenchDisabledImpl(ws)) return exitImpl(0);
  let release = acquireRunnerLease(ws, sessionKey);
  if (!release) {
    let epoch = null;
    try { epoch = publishRunnerContention(ws, sessionKey); }
    catch { /* bounded takeover still covers an owner already in its final release window */ }
    if (epoch && onContentionRequest) await onContentionRequest({ ws, sessionKey, epoch });
    release = await waitForRunnerLease(ws, sessionKey, { waitMs: contentionWaitMs, pollMs: contentionPollMs });
    if (!release) return exitImpl(0);
  }
  const observedContentionEpoch = readRunnerContentionEpoch(ws, sessionKey);
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    return await runMainUnlocked({
      ...options,
      input,
      ws,
      env: runtimeEnv,
      runnerContention: {
        observedEpoch: observedContentionEpoch,
        readEpoch: () => readRunnerContentionEpoch(ws, sessionKey)
      },
      isBenchDisabledImpl: () => false,
      exitImpl: (code) => {
        releaseOnce();
        return exitImpl(code);
      }
    });
  } finally {
    releaseOnce();
  }
}

async function runMainUnlocked({
  input: inputOverride,
  ws: wsOverride,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  runSpecReviewImpl = defaultRunSpecReview,
  runPushReviewImpl = defaultRunPushReview,
  now = Date.now(),
  clock = Date.now,                       // live clock for the drain deadline (`now` is a snapshot)
  env = process.env,
  runnerContention = null,
  onQueueQuiescent,
  exitImpl = (code) => process.exit(code),
  stderr = (s) => process.stderr.write(s),
  stdout = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
} = {}) {
  const input = inputOverride ?? readInputSync();
  const runtimeEnv = env || process.env;
  const cwd = (input && input.cwd) || runtimeEnv.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = wsOverride || workspaceRoot(cwd);
  const sessionKey = sessionKeyFromInput(input, runtimeEnv);

  if (isBenchDisabledImpl(ws)) return exitImpl(0);

  const runnerFollowupFile = followupFile(ws, sessionKey);
  // 1. Recover orphaned claims (killed/timed-out prior runner) → back to .json.
  try { recoverOrphans(ws, { now }); } catch (e) { stderr(`⛩ deep-runner: orphan recovery failed (${msg(e)}).\n`); }

  // Compute durability before applying TTL cleanup. The fallback deliberately says "work remains":
  // uncertainty must preserve the ceiling, never reopen an automatic loop.
  const durableWorkAtStart = safe(
    () => listBlocked(ws, { sessionKey }).length > 0 || listJobs(ws, { sessionKey }).length > 0,
    true
  );
  const resetNonce = requestedResetNonce(runtimeEnv.BENCH_DEEP_CYCLE_RESET);
  if (resetNonce) {
    const reset = consumeResetNonce(`${runnerFollowupFile}.reset-nonce`, resetNonce, now);
    if (reset.applied) {
      try { fs.rmSync(runnerFollowupFile, { force: true }); }
      catch { stderr("⛩ deep-runner: explicit cycle reset could not clear wake state; use a new reset nonce after fixing state permissions.\n"); }
    } else if (reset.error) {
      stderr("⛩ deep-runner: explicit cycle reset could not be consumed safely; the existing wake ceiling remains active.\n");
    }
  }
  const priorFollowupWakes = readFollowupCount(runnerFollowupFile, now, {
    durableWorkRemains: durableWorkAtStart
  });

  const wake = [];       // findings to deliver via exit-2 wake
  const advisory = [];   // findings past WAKE_WINDOW → stdout note (non-waking), file kept
  const unavailable = []; // queued reviews that must retry; consolidated into the one exit-2 delivery

  // 2. Re-deliver pending .blocked jobs (retire ONLY on content-change; never by time/count).
  for (const b of safe(() => listBlocked(ws, { sessionKey }), [])) {
    let cur = null;
    try { cur = currentContentKey(ws, b); } catch { cur = null; }
    if (!b.contentKey) {
      // UNSTAMPED merge block: it was persisted while the block-time recompute failed (transient git
      // blip), so there is no key to compare against — an unstamped block is NEVER retired on key
      // grounds. Self-heal at the first successful recompute — but the RIGHT baseline is HEAD as of
      // BLOCK time, which may be gone by now: if the agent already landed the fix while the block was
      // unstamped, stamping current HEAD would adopt the FIX as baseline and the addressed block
      // would keep re-waking (a stop-gate catch). The reflog reconstructs the block-time HEAD by SHA
      // (see reflogHeadAt — an actual movement record; commit timestamps like %ct are mutable
      // metadata that can retire an unmoved-but-future-dated HEAD, another stop-gate catch):
      // same SHA as now → HEAD never moved → current HEAD IS the baseline → stamp it; a different
      // (or no pre-block) SHA → HEAD moved after delivery → that IS the addressed signal → retire.
      if ((b.kind === "merge" || b.kind === "push") && cur !== null && cur !== GONE) {
        const blockedTs = Number(b.firstBlockedTs) || 0;
        const rec = blockedTs > 0 ? reflogHeadAt(ws, blockedTs) : null;
        if (rec) {
          const baselineKey = rec.sha ? deepKey(`${b.kind}:${b.range}`, rec.sha) : null;
          if (baselineKey !== cur) { deleteJob(b._path); continue; }   // moved since block → addressed → retired
          try {
            persistBlockedUpdate(ws, b, { contentKey: cur });
            b.contentKey = cur; // subsequent wake-count persistence in this same pass must keep the healed key
          } catch { /* best-effort — deliver regardless; heal again next Stop */ }
        }
        // rec null (no usable reflog) or blockedTs missing → keep unstamped; deliver, retry next
        // Stop. Bounded noise: past WAKE_WINDOW it downgrades to a non-waking advisory (file kept).
      }
    } else if (cur === GONE || (cur !== null && cur !== b.contentKey)) {
      // Retire on a DEFINITIVELY-gone target (deleted spec → GONE; the block is moot) OR a CONFIRMED
      // content change (a valid current key that DIFFERS). `cur === null` means we could NOT determine
      // the current key (transient `git rev-parse` failure, or a present-but-unreadable spec) — do NOT
      // delete a durable completed block on uncertainty (that would lose a HIGH finding on a transient
      // error); keep it and re-check next Stop.
      deleteJob(b._path); continue;   // gone or confirmed change → retired
    }
    const findings = (b.findings || b.summary || "(deep block)") + traceHint(b.traceId);
    // Exhausted review attempts are durable but advisory-only: keep the warning visible and keep
    // enqueue dedupe intact for this exact target, without creating an infinite asyncRewake loop.
    if (b.advisoryOnly) advisory.push(findings);
    else {
      // A completed block's initial persist+delivery counts as wake 1. Legacy records did not carry
      // the field, so conservatively treat them as already delivered once. Persist the increment
      // BEFORE exit 2: a crash can shorten the loop, never extend it past the hard ceiling.
      const priorWakeCount = Number.isInteger(Number(b.wakeCount)) && Number(b.wakeCount) >= 0
        ? Number(b.wakeCount)
        : 1;
      const withinWindow = (now - (Number(b.firstBlockedTs) || 0)) < WAKE_WINDOW_MS;
      if (withinWindow && priorWakeCount < MAX_BLOCK_WAKES) {
        // Compare-and-rewrite on the stored wakeCount: a LEGACY (session-less) block is listed by
        // every session's runner while the runner lease is per-session, so two sessions could
        // otherwise read N, both persist N+1, and BOTH deliver — two deliveries spent, one counted,
        // and a later pass exceeds MAX_BLOCK_WAKES. A refusal means a peer moved or retired the
        // block between our list and this persist; it owns this delivery, so skip the duplicate.
        const expectedWakeCount = Number.isInteger(Number(b.wakeCount)) && Number(b.wakeCount) >= 0
          ? Number(b.wakeCount)
          : null;
        const persisted = persistBlockedUpdate(ws, b, { wakeCount: priorWakeCount + 1 }, { expectedWakeCount });
        if (persisted) wake.push(findings);
      } else if (!withinWindow) {
        advisory.push(`${findings}\n(automatic deep-block wake window expired after ${Math.min(priorWakeCount, MAX_BLOCK_WAKES)}/${MAX_BLOCK_WAKES} deliveries; warning remains until the target changes)`);
      } else {
        advisory.push(`${findings}\n(automatic deep-block wakes exhausted at ${Math.min(priorWakeCount, MAX_BLOCK_WAKES)}/${MAX_BLOCK_WAKES}; warning remains until the target changes)`);
      }
    }
  }

  // 3-5. Drain queued jobs in bounded concurrent batches. Older builds exited 2 after a clean
  //    MAX_BATCH batch just to force another Stop and process surplus, which created visible
  //    no-action Claude turns. Keep MAX_BATCH as the concurrency cap and drain surplus here — but
  //    only while a worst-case batch still FITS in the runner's hook budget (see RUNNER_BUDGET_MS);
  //    a deadline-deferred surplus rewakes instead (rare: only after a slow batch), so it is never
  //    stranded waiting on a Stop that may not come.
  const startTs = clock();
  // Mirror deepReviewBudgetMs (hunt.mjs): only a finite, positive override counts. A negative value
  // survives Number(env) || default and corrupts the worst-case batch math below — a negative review
  // budget makes every batch "fit", so the hook is killed mid-claim by the real timeout.
  const configuredReviewBudgetMs = Number(runtimeEnv.BENCH_DEEP_REVIEW_BUDGET_MS);
  const reviewBudgetMs = Number.isFinite(configuredReviewBudgetMs) && configuredReviewBudgetMs > 0
    ? configuredReviewBudgetMs
    : 10 * 60 * 1000;
  const configuredRunnerBudgetMs = Number(runtimeEnv.BENCH_DEEP_RUNNER_BUDGET_MS);
  const runnerBudgetMs = Number.isFinite(configuredRunnerBudgetMs) && configuredRunnerBudgetMs > 0
    ? configuredRunnerBudgetMs
    : RUNNER_BUDGET_MS;
  let deferred = 0;
  let requeued = 0;
  const seenJobKeys = new Set();
  let observedContentionEpoch = runnerContention?.observedEpoch || "0:";
  let quiescenceChecks = 0;
  for (;;) {
    const queued = safe(() => listJobs(ws, { sessionKey }), []).filter((job) => !seenJobKeys.has(job._jobKey));
    if (!queued.length) {
      // This is the owner's last empty read. Give a contender that found the lease occupied a
      // durable handoff point: if its request epoch changed, re-read and drain before releasing.
      // A request that lands just after this check is covered by the contender's bounded takeover.
      if (onQueueQuiescent) {
        await onQueueQuiescent({ ws, sessionKey, observedEpoch: observedContentionEpoch, check: quiescenceChecks });
      }
      quiescenceChecks++;
      const currentEpoch = runnerContention?.readEpoch?.() || observedContentionEpoch;
      if (currentEpoch !== observedContentionEpoch) {
        observedContentionEpoch = currentEpoch;
        continue;
      }
      break;
    }
    // Every batch after the first must fit its worst case (per-review budget + margin) inside the
    // remaining hook budget, or the hook timeout kills the runner mid-claim.
    if (seenJobKeys.size && (clock() - startTs) + reviewBudgetMs + 30_000 > runnerBudgetMs) {
      deferred = queued.length;
      break;
    }
    const claimed = [];
    for (const job of queued.slice(0, MAX_BATCH)) {
      const claimedPath = claim(ws, job._jobKey);
      if (claimedPath) {
        seenJobKeys.add(job._jobKey);
        claimed.push({ job, claimedPath });
      }
    }
    if (!claimed.length) break; // another runner claimed the visible work; stay quiet.

    const outcomes = await Promise.all(claimed.map(async ({ job, claimedPath }) => {
      try {
        // merge jobs review through the same range machinery as push (their range is SHA-pinned by
        // the pre-merge gate, so reviewing after the merge has advanced HEAD is still exact).
        const res = (job.kind === "push" || job.kind === "merge")
          ? await runPushReviewImpl(job.range, ws, { sessionKey: job.sessionKey || sessionKey, env: runtimeEnv })
          : await runSpecReviewImpl(job.specPath, ws, { sessionKey: job.sessionKey || sessionKey, env: runtimeEnv });
        return { job, claimedPath, res };
      } catch (e) {
        return { job, claimedPath, error: msg(e) };
      }
    }));

    // Persist results BEFORE delivering. A transient failure (throw OR {retry:true}) REQUEUES the
    // job (bounded) — never deletes it (that would lose a queued review). CLEAN → delete claim;
    // BLOCK → .blocked (durable) + wake.
    for (const o of outcomes) {
      // `retry:true` is the normal contract from spec-review-run for git failures and panels with no
      // valid verdict. Defensively recognize the latter shape here too so a future/alternate review
      // implementation cannot turn an all-error or malformed panel into a clean delete by omission.
      const noReviewerVerdict = Array.isArray(o.res?.reviewers)
        && !o.res.reviewers.some((r) => !r?.error && ["ALLOW", "BLOCK"].includes(String(r?.verdict || "").toUpperCase()));
      const retryReason = o.error
        || (o.res && o.res.retry ? (o.res.reason || "retry") : null)
        || (noReviewerVerdict ? "no reviewer verdicts" : null);
      if (retryReason) {
        const next = (Number(o.job.attempts) || 0) + 1;
        if (next >= MAX_REVIEW_ATTEMPTS) {
          let contentKey = o.job.contentKey;
          if (o.job.kind === "merge") {
            try { contentKey = currentContentKey(ws, o.job); } catch { contentKey = null; }
            if (contentKey === GONE) contentKey = null;
          }
          const failure = `Deep ${o.job.kind} review for ${targetLabel(o.job)} remains UNREVIEWED after ${next} attempts: ${retryReason}. Automatic wake retries stopped to avoid a loop; change the target to enqueue a fresh review, or run /bench:review manually when providers recover.`;
          markBlocked(ws, o.job._jobKey, {
            kind: o.job.kind,
            specPath: o.job.specPath,
            range: o.job.range,
            contentKey,
            sessionKey: o.job.sessionKey || sessionKey || undefined,
            findings: failure,
            firstBlockedTs: clock(),
            advisoryOnly: true,
            reviewStatus: "unavailable",
            wakeCount: 0
          }, { claimedPath: o.claimedPath });
          advisory.push(failure);
          stderr(`⛩ deep-runner: ${o.job.kind} review failed ${next}x (${retryReason}); automatic retries stopped and a durable unreviewed advisory was saved.\n`);
        } else {
          requeueForRetry(ws, o.claimedPath, o.job, next, { now });
          requeued++;
          unavailable.push(`Deep ${o.job.kind} review unavailable for ${targetLabel(o.job)} (attempt ${next}/${MAX_REVIEW_ATTEMPTS}): ${retryReason}; the next Stop retries it`);
          stderr(`⛩ deep-runner: ${o.job.kind} review error (${retryReason}); requeued (attempt ${next}).\n`);
        }
        continue;
      }
      if (shouldRewake({ maxSeverity: o.res.maxSeverity, findingCount: o.res.findingCount })) {
        const findings = o.res.findings || o.res.summary || "(deep block)";
        // A MERGE block's durable identity is stamped NOW (post-merge HEAD), not at enqueue: the
        // merge itself moved HEAD between enqueue and review, so the enqueue-time key would read as
        // "changed" at the very next Stop and instantly retire the block. Stamped here, it retires
        // exactly when the agent lands the fix commit (HEAD moves again) — push-block semantics.
        // If the recompute FAILS here (transient git blip), persist contentKey:null — NOT the stale
        // enqueue key, which a later healthy recompute would read as "changed" and retire (losing
        // the finding). An unstamped block is never retired; step 2 self-heals it at the first
        // successful recompute.
        // A SPEC block's durable identity is the REVIEWED content: runSpecReview reads the file at
        // review time and returns hash = deepKey(specPath, reviewedContent) — the same formula
        // currentContentKey recomputes. An edit landed between enqueue and review is COVERED by the
        // review, so keying the block on the stale enqueue key would read the reviewed content as
        // "changed" at the next Stop and retire a HIGH block nothing addressed. (Push keeps its
        // enqueue key: res.hash there is evidence-keyed, not the HEAD-seeded identity
        // currentContentKey recomputes.)
        let contentKey = o.job.contentKey;
        if (o.job.kind === "merge") {
          try { contentKey = currentContentKey(ws, o.job); } catch { contentKey = null; }
          if (contentKey === GONE) contentKey = null;
        } else if (o.job.kind !== "push" && o.res.hash) {
          contentKey = o.res.hash;
        }
        // firstBlockedTs = the moment the block is PERSISTED/DELIVERED (live clock) — NOT the
        // invocation-start `now`: the review above can run ~10 min, and a commit landed DURING it
        // predates the delivery, so the unstamped-heal must not read it as "addressed the findings"
        // and discard the block (a push-gate catch).
        markBlocked(ws, o.job._jobKey, {
          kind: o.job.kind, specPath: o.job.specPath, range: o.job.range,
          contentKey, sessionKey: o.job.sessionKey || sessionKey || undefined,
          findings, traceId: o.res.traceId || null, firstBlockedTs: clock(), wakeCount: 1
        }, { claimedPath: o.claimedPath });
        wake.push(findings + traceHint(o.res.traceId));
      } else {
        deleteJob(o.claimedPath);   // clean — nothing to lose
      }
    }
    // Do not stop at the first blocking batch. Continue through every eligible queued job that fits
    // this invocation's budget, then deliver one consolidated wake. Drip-feeding later blockers over
    // repeated no-action turns is exactly the failure mode this runner exists to prevent.
  }

  // 6. Deliver exactly one consolidated wake for every blocking/unavailable/deferred outcome from
  // this pass. The ceiling is GLOBAL to this runner/session, not per target or merely per deferred
  // batch: otherwise a long queue whose successive batches each find a new blocker can still create
  // an unbounded no-action wake chain even though every individual block has its own counter.
  const hasContinuation = requeued > 0 || deferred > 0;
  const requestedWake = wake.length > 0 || hasContinuation;
  let automaticWake = false;
  if (requestedWake && priorFollowupWakes < MAX_RUNNER_FOLLOWUP_WAKES) {
    automaticWake = writeFollowupCount(runnerFollowupFile, priorFollowupWakes + 1, clock());
    if (!automaticWake) {
      advisory.push("Deep review wake state could not be persisted; automatic waking stopped to avoid an unbounded loop. Durable findings/jobs will continue on the next natural Stop.");
    }
  } else if (requestedWake) {
    advisory.push(
      `Deep review automatic wake ceiling exhausted at ${MAX_RUNNER_FOLLOWUP_WAKES}/${MAX_RUNNER_FOLLOWUP_WAKES}; ` +
      "new findings remain durable and queued work will continue only on natural Stops or after BENCH_DEEP_CYCLE_RESET=<new-nonce>."
    );
  }

  if (automaticWake) {
    const sections = [];
    if (wake.length) sections.push(`Blocking findings (${wake.length}):\n\n${wake.join("\n\n")}`);
    if (unavailable.length) sections.push(`Unavailable reviews (${unavailable.length}):\n${unavailable.map((note) => `- ${note}`).join("\n")}`);
    if (advisory.length) sections.push(`Persistent non-waking advisories (${advisory.length}):\n${advisory.join("\n\n")}`);
    if (deferred) sections.push(`${deferred} queued job(s) deferred (runner budget exhausted); the next automatic Stop will continue them.`);
    stderr(`⛩ deep review pass requires follow-up — all in-budget outcomes were consolidated:\n\n${sections.join("\n\n")}\n`);
    return exitImpl(2);
  }
  if (wake.length) {
    advisory.push(`Durable blocking findings (automatic wake suppressed):\n\n${wake.join("\n\n")}`);
  }
  if (unavailable.length) {
    advisory.push(`Unavailable reviews:\n${unavailable.map((note) => `- ${note}`).join("\n")}`);
  }
  if (deferred) {
    advisory.push(`${deferred} queued job(s) remain durable for the next natural Stop.`);
  }
  // Reset the task/session ceiling only after every durable target/job is gone. Clearing it merely
  // because this pass did not request another wake would let an unchanged advisory block start a
  // fresh three-wake loop on the next natural Stop.
  const durableWorkRemains = safe(() => listBlocked(ws, { sessionKey }).length > 0 || listJobs(ws, { sessionKey }).length > 0, true);
  if (!requestedWake && !durableWorkRemains) {
    try { fs.rmSync(runnerFollowupFile, { force: true }); } catch { /* drained/reset best effort */ }
  }
  if (advisory.length) {
    stdout({ systemMessage: `⛩ deep review (advisory, not blocking; ${advisory.length} item(s)): ${advisory.join(" · ").slice(0, 2000)}` });
    return exitImpl(0);
  }
  return exitImpl(0);
}

function msg(e) { return e instanceof Error ? e.message : String(e); }
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    // Fail OPEN — a runner crash must never wedge the turn. Durable queue files are re-processed next Stop.
    process.stderr.write(`⛩ deep-runner: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
