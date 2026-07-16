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
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput } from "./config-store.mjs";
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
                                                // starts a new batch when a worst-case batch still fits; deferred surplus
                                                // forces a rewake (exit 2) so a next Stop is GUARANTEED to process it.
export const WAKE_WINDOW_MS = 30 * 60 * 1000;   // re-WAKE a .blocked within this; after, downgrade to advisory (file kept)
export const MAX_REVIEW_ATTEMPTS = 3;           // bound retries of a QUEUED job whose review keeps failing (git/transient).
                                                // Safe to cap: a queued job has no completed finding, so dropping it after
                                                // the cap loses no review RESULT (unlike a delivered .blocked, which is
                                                // retired ONLY on content-change and never by count).

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
  clock = Date.now,                       // live clock for the drain deadline (`now` is a snapshot)
  env = process.env,
  exitImpl = (code) => process.exit(code),
  stderr = (s) => process.stderr.write(s),
  stdout = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
} = {}) {
  const input = inputOverride ?? readInputSync();
  const cwd = (input && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = wsOverride || workspaceRoot(cwd);
  const sessionKey = sessionKeyFromInput(input, process.env);

  if (isBenchDisabledImpl(ws)) return exitImpl(0);

  // 1. Recover orphaned claims (killed/timed-out prior runner) → back to .json.
  try { recoverOrphans(ws, { now }); } catch (e) { stderr(`⛩ deep-runner: orphan recovery failed (${msg(e)}).\n`); }

  const wake = [];       // findings to deliver via exit-2 wake
  const advisory = [];   // findings past WAKE_WINDOW → stdout note (non-waking), file kept

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
            markBlocked(ws, b._jobKey, {
              kind: b.kind, specPath: b.specPath, range: b.range, contentKey: cur,
              sessionKey: b.sessionKey, findings: b.findings, traceId: b.traceId ?? null,
              firstBlockedTs: b.firstBlockedTs
            });
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
    if ((now - (Number(b.firstBlockedTs) || 0)) < WAKE_WINDOW_MS) wake.push(findings);
    else advisory.push(findings);   // KEEP the file — never deleted by elapsed time
  }

  // 3-5. Drain queued jobs in bounded concurrent batches. Older builds exited 2 after a clean
  //    MAX_BATCH batch just to force another Stop and process surplus, which created visible
  //    no-action Claude turns. Keep MAX_BATCH as the concurrency cap and drain surplus here — but
  //    only while a worst-case batch still FITS in the runner's hook budget (see RUNNER_BUDGET_MS);
  //    a deadline-deferred surplus rewakes instead (rare: only after a slow batch), so it is never
  //    stranded waiting on a Stop that may not come.
  const startTs = clock();
  const reviewBudgetMs = Number(env.BENCH_DEEP_REVIEW_BUDGET_MS) || 10 * 60 * 1000;
  const runnerBudgetMs = Number(env.BENCH_DEEP_RUNNER_BUDGET_MS) || RUNNER_BUDGET_MS;
  let deferred = 0;
  const seenJobKeys = new Set();
  for (;;) {
    const queued = safe(() => listJobs(ws, { sessionKey }), []).filter((job) => !seenJobKeys.has(job._jobKey));
    if (!queued.length) break;
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
          ? await runPushReviewImpl(job.range, ws, { sessionKey: job.sessionKey || sessionKey })
          : await runSpecReviewImpl(job.specPath, ws, { sessionKey: job.sessionKey || sessionKey });
        return { job, claimedPath, res };
      } catch (e) {
        return { job, claimedPath, error: msg(e) };
      }
    }));

    // Persist results BEFORE delivering. A transient failure (throw OR {retry:true}) REQUEUES the
    // job (bounded) — never deletes it (that would lose a queued review). CLEAN → delete claim;
    // BLOCK → .blocked (durable) + wake.
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
        // A MERGE block's durable identity is stamped NOW (post-merge HEAD), not at enqueue: the
        // merge itself moved HEAD between enqueue and review, so the enqueue-time key would read as
        // "changed" at the very next Stop and instantly retire the block. Stamped here, it retires
        // exactly when the agent lands the fix commit (HEAD moves again) — push-block semantics.
        // If the recompute FAILS here (transient git blip), persist contentKey:null — NOT the stale
        // enqueue key, which a later healthy recompute would read as "changed" and retire (losing
        // the finding). An unstamped block is never retired; step 2 self-heals it at the first
        // successful recompute.
        let contentKey = o.job.contentKey;
        if (o.job.kind === "merge") {
          try { contentKey = currentContentKey(ws, o.job); } catch { contentKey = null; }
          if (contentKey === GONE) contentKey = null;
        }
        markBlocked(ws, o.job._jobKey, {
          kind: o.job.kind, specPath: o.job.specPath, range: o.job.range,
          contentKey, sessionKey: o.job.sessionKey || sessionKey || undefined,
          findings, traceId: o.res.traceId || null, firstBlockedTs: now
        }, { claimedPath: o.claimedPath });
        wake.push(findings + traceHint(o.res.traceId));
      } else {
        deleteJob(o.claimedPath);   // clean — nothing to lose
      }
    }
    if (wake.length) break;
  }

  // 6. Deliver. wake → stderr + exit 2 (wakes even idle); else advisory → stdout note; else quiet.
  if (wake.length) {
    stderr(`⛩ deep review found blocking issues — address them before continuing:\n\n${wake.join("\n\n")}\n`);
    return exitImpl(2);
  }
  // Deadline-deferred surplus with nothing else waking: force the next Stop ourselves (exit 2) —
  // queued jobs must never depend on a future Stop that may not come (idle session = stranded jobs).
  if (deferred) {
    stderr(`⛩ deep review: ${deferred} queued job(s) deferred (runner budget exhausted); ending turn so the next Stop runs them.\n`);
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
