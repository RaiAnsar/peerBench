#!/usr/bin/env node
// global-hooks/deep-review-runner.mjs
// The ONE async hook: an asyncRewake Stop hook that delivers deep-review findings to the agent
// RELIABLY, even when it has gone idle after its turn (exit 2 wakes an idle agent per the docs).
//
// Each turn end: recover orphaned claims → re-deliver pending .blocked jobs (retire ONLY on
// content-change; wake within WAKE_WINDOW, else non-waking advisory, file KEPT) → claim ≤ CLAIM_LIMIT
// queued jobs → run them CONCURRENTLY (errors requeue) → CLEAN delete / BLOCK persist-then-wake.
// Crash-safe with NO delivery counter (see the spec). Fails OPEN everywhere.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isBenchDisabled as defaultIsBenchDisabled } from "./config-store.mjs";
import { shouldRewake } from "./deep-review.mjs";
import { runSpecReview as defaultRunSpecReview, runPushReview as defaultRunPushReview } from "./spec-review-run.mjs";
import {
  recoverOrphans, listBlocked, listJobs, claim, requeueForRetry, markBlocked, deleteJob, currentContentKey
} from "./deep-queue.mjs";

export const MAX_BATCH = 3;                     // claim+run at most this many CONCURRENTLY per invocation — a safety bound
                                                // on concurrent agentic load. Full concurrency makes wall-clock ≈ one
                                                // review regardless of N, so it stays under the timeout. Unclaimed surplus
                                                // (> MAX_BATCH, rare) is drained via a continuation-wake (step 6), so a
                                                // blocking finding in a surplus job is NEVER stranded while the agent idles.
export const WAKE_WINDOW_MS = 30 * 60 * 1000;   // re-WAKE a .blocked within this; after, downgrade to advisory (file kept)
export const MAX_REVIEW_ATTEMPTS = 3;           // bound retries of a QUEUED job whose review keeps failing (git/transient).
                                                // Safe to cap: a queued job has no completed finding, so dropping it after
                                                // the cap loses no review RESULT (unlike a delivered .blocked, which is
                                                // retired ONLY on content-change and never by count).

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

// Synchronous stdin read (the runner reads the Stop hook JSON from fd 0).
function readInputSync() {
  try { const raw = fs.readFileSync(0, "utf8").trim(); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

export async function runMain({
  input: inputOverride,
  ws: wsOverride,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  runSpecReviewImpl = defaultRunSpecReview,
  runPushReviewImpl = defaultRunPushReview,
  now = Date.now(),
  exitImpl = (code) => process.exit(code),
  stderr = (s) => process.stderr.write(s),
  stdout = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
} = {}) {
  const input = inputOverride ?? readInputSync();
  const cwd = (input && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = wsOverride || workspaceRoot(cwd);

  if (isBenchDisabledImpl(ws)) return exitImpl(0);

  // 1. Recover orphaned claims (killed/timed-out prior runner) → back to .json.
  try { recoverOrphans(ws, { now }); } catch (e) { stderr(`⛩ deep-runner: orphan recovery failed (${msg(e)}).\n`); }

  const wake = [];       // findings to deliver via exit-2 wake
  const advisory = [];   // findings past WAKE_WINDOW → stdout note (non-waking), file kept

  // 2. Re-deliver pending .blocked jobs (retire ONLY on content-change; never by time/count).
  for (const b of safe(() => listBlocked(ws), [])) {
    let cur = null;
    try { cur = currentContentKey(ws, b); } catch { cur = null; }
    if (cur !== b.contentKey) { deleteJob(b._path); continue; }   // content changed (or target gone) → retired
    const findings = b.findings || b.summary || "(deep block)";
    if ((now - (Number(b.firstBlockedTs) || 0)) < WAKE_WINDOW_MS) wake.push(findings);
    else advisory.push(findings);   // KEEP the file — never deleted by elapsed time
  }

  // 3. Claim up to MAX_BATCH queued jobs (run concurrently in step 4). If MORE than MAX_BATCH are
  //    queued, the surplus is left as .json and drained via a continuation-wake in step 6 — so an
  //    unreviewed surplus job (which might hold a HIGH block) is never stranded while the agent idles.
  const queued = safe(() => listJobs(ws), []);
  const surplus = queued.length > MAX_BATCH;
  const claimed = [];
  for (const job of queued.slice(0, MAX_BATCH)) {
    const claimedPath = claim(ws, job._jobKey);
    if (claimedPath) claimed.push({ job, claimedPath });
  }

  // 4. Run the claimed batch CONCURRENTLY. Errors are NOT requeued here — step 5 handles every
  //    retry (a throw OR a returned {retry:true}) uniformly so a single bounded path governs them.
  const outcomes = await Promise.all(claimed.map(async ({ job, claimedPath }) => {
    try {
      const res = job.kind === "push"
        ? await runPushReviewImpl(job.range, ws)
        : await runSpecReviewImpl(job.specPath, ws);
      return { job, claimedPath, res };
    } catch (e) {
      return { job, claimedPath, error: msg(e) };
    }
  }));

  // 5. Persist results BEFORE delivering. A transient failure (throw OR {retry:true}) REQUEUES the
  //    job (bounded) — never deletes it (that would lose a queued review). CLEAN → delete claim;
  //    BLOCK → .blocked (durable) + wake.
  for (const o of outcomes) {
    const retryReason = o.error || (o.res && o.res.retry ? (o.res.reason || "retry") : null);
    if (retryReason) {
      const next = (Number(o.job.attempts) || 0) + 1;
      if (next >= MAX_REVIEW_ATTEMPTS) {
        deleteJob(o.claimedPath);
        stderr(`⛩ deep-runner: ${o.job.kind} review failed ${next}x (${retryReason}); giving up on this queued job.\n`);
      } else {
        requeueForRetry(ws, o.claimedPath, o.job, next, { now });
        stderr(`⛩ deep-runner: ${o.job.kind} review error (${retryReason}); requeued (attempt ${next}).\n`);
      }
      continue;
    }
    if (shouldRewake({ maxSeverity: o.res.maxSeverity, findingCount: o.res.findingCount })) {
      const findings = o.res.findings || o.res.summary || "(deep block)";
      markBlocked(ws, o.job._jobKey, {
        kind: o.job.kind, specPath: o.job.specPath, range: o.job.range,
        contentKey: o.job.contentKey, findings, firstBlockedTs: now
      }, { claimedPath: o.claimedPath });
      wake.push(findings);
    } else {
      deleteJob(o.claimedPath);   // clean — nothing to lose
    }
  }

  // 6. Deliver. wake → stderr + exit 2 (wakes even idle, and a next Stop drains any surplus); else
  //    a continuation-wake if unreviewed surplus remains (so it can't strand while idle); else
  //    advisory → stdout note; else quiet.
  if (wake.length) {
    stderr(`⛩ deep review found blocking issues — address them before continuing:\n\n${wake.join("\n\n")}\n`);
    return exitImpl(2);
  }
  if (surplus) {
    // No findings this batch, but more queued reviews remain unclaimed. exit 2 forces a next Stop
    // to drain them (a clean/advisory exit 0 would let the agent idle with surplus unprocessed —
    // a HIGH block in a surplus job would then sit unseen). Benign: no action required.
    stderr(`⛩ deep review: ${queued.length - claimed.length} more queued review(s) — continuing to process (no action needed; a blocking finding will wake you).\n`);
    return exitImpl(2);
  }
  if (advisory.length) {
    stdout({ systemMessage: `⛩ deep review (advisory, not blocking): ${advisory.join(" · ").slice(0, 400)}` });
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
