import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-root-"));

import {
  PLAN_CYCLE_WINDOW_MS,
  PLAN_REVIEW_LEASE_MS,
  beginPlanReview,
  clearPlanCycleForTarget,
  completePlanReview,
  readPlanCycle,
  readPlanMarker,
  recordPlanBlock
} from "../global-hooks/plan-gate-state.mjs";
import { resolveConfig } from "../global-hooks/config-store.mjs";

test("unresolved unscoped sessions remain capped after the old cycle window", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-expire-"));
  const start = 10_000;
  for (let index = 1; index <= 3; index++) {
    recordPlanBlock(ws, null, { target: "inline-plan", revision: `r${index}`, findings: `f${index}` }, { now: start + index });
  }
  assert.equal(readPlanCycle(ws, null, { now: start + 100 }).exhausted, true);

  const durable = readPlanCycle(ws, null, { now: start + PLAN_CYCLE_WINDOW_MS + 101 });
  assert.equal(durable.count, 3, "time alone must not authorize three more automatic wakes");
  assert.equal(durable.exhausted, true);
  const fourth = recordPlanBlock(ws, null, { target: "inline-plan", revision: "fresh", findings: "fresh" }, { now: start + PLAN_CYCLE_WINDOW_MS + 102 });
  assert.equal(fourth, null, "the unresolved hard ceiling stays closed until allow or explicit reset");
});

test("shared plan slots clear only after every actually blocked target later passes", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-targets-"));
  const session = "targets";
  recordPlanBlock(ws, session, { target: "plans/a.md", revision: "a1", findings: "A" }, { now: 100 });
  recordPlanBlock(ws, session, { target: "plans/b.md", revision: "b1", findings: "B" }, { now: 200 });
  recordPlanBlock(ws, session, { target: "inline-plan", revision: "c1", findings: "C" }, { now: 300 });
  assert.equal(readPlanCycle(ws, session, { now: 350 }).exhausted, true);

  assert.equal(clearPlanCycleForTarget(ws, session, "unrelated.md", { now: 400 }), false, "an unrelated ALLOW changes nothing");
  assert.equal(clearPlanCycleForTarget(ws, session, "plans/a.md", { now: 410 }), false);
  assert.equal(clearPlanCycleForTarget(ws, session, "plans/b.md", { now: 420 }), false);
  assert.equal(readPlanCycle(ws, session, { now: 425 }).count, 3, "one unresolved blocked target keeps the ceiling durable");
  assert.equal(clearPlanCycleForTarget(ws, session, "inline-plan", { now: 430 }), true, "the final resolved target closes the shared cycle");
  assert.equal(readPlanCycle(ws, session, { now: 431 }).count, 0);
});

test("a new block supersedes an earlier ALLOW for that same target", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-reblock-"));
  const session = "reblock";
  recordPlanBlock(ws, session, { target: "plans/a.md", revision: "a1", findings: "A1" }, { now: 100 });
  recordPlanBlock(ws, session, { target: "plans/b.md", revision: "b1", findings: "B1" }, { now: 200 });
  assert.equal(clearPlanCycleForTarget(ws, session, "plans/a.md", { now: 300 }), false);
  recordPlanBlock(ws, session, { target: "plans/a.md", revision: "a2", findings: "A2" }, { now: 300 });
  assert.equal(clearPlanCycleForTarget(ws, session, "plans/b.md", { now: 400 }), false);
  assert.equal(readPlanCycle(ws, session, { now: 401 }).count, 3, "A's old resolution cannot clear its newer block");
  assert.equal(clearPlanCycleForTarget(ws, session, "plans/a.md", { now: 402 }), true);
});

test("an ALLOW ticket resolves only the exact latest block id it observed", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-ticket-"));
  const session = "immutable-ticket";
  const target = "plans/race.md";
  recordPlanBlock(ws, session, { target, revision: "A", findings: "A" }, { now: 100 });
  const started = beginPlanReview(ws, session, {
    hookKind: "plan-file-panel",
    target,
    identity: "approval-A",
    now: 200
  });
  assert.equal(started.role, "leader");

  recordPlanBlock(ws, session, { target, revision: "B", findings: "B" }, { now: 300 });
  const completed = completePlanReview(ws, session, started.ticket, { status: "allow", now: 400 });
  assert.equal(completed.outcome, "superseded");
  assert.equal(readPlanCycle(ws, session).count, 2, "the delayed ALLOW cannot resolve B");
  assert.equal(readPlanMarker(ws, "plan-file-panel", target), null, "the delayed ALLOW cannot be cached");
});

test("expired single-flight leases are recoverable and a stale owner cannot commit", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-lease-"));
  const session = "lease-recovery";
  const scope = { hookKind: "exit-plan-mode", target: "inline-plan", identity: "same-revision" };
  const first = beginPlanReview(ws, session, { ...scope, now: 1_000, leaseMs: 1_000 });
  const follower = beginPlanReview(ws, session, { ...scope, now: 1_500, leaseMs: 1_000 });
  assert.equal(first.role, "leader");
  assert.equal(follower.role, "follower");

  const recovered = beginPlanReview(ws, session, { ...scope, now: 2_100, leaseMs: 1_000 });
  assert.equal(recovered.role, "leader", "the expired lease is reclaimed without manual cleanup");
  assert.notEqual(recovered.ticket.leaseId, first.ticket.leaseId);
  const stale = completePlanReview(ws, session, first.ticket, {
    status: "block",
    findings: "stale owner",
    now: 2_200
  });
  assert.equal(stale.outcome, "superseded");
  assert.equal(readPlanCycle(ws, session).count, 0, "the stale owner cannot consume a slot");
  const current = completePlanReview(ws, session, recovered.ticket, {
    status: "block",
    findings: "current owner",
    now: 2_300
  });
  assert.equal(current.outcome, "block");
  assert.equal(readPlanCycle(ws, session).count, 1);
});

test("a reset nonce is consumed once inside the cycle transaction", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-reset-"));
  const session = "atomic-reset";
  for (let index = 1; index <= 3; index++) {
    recordPlanBlock(ws, session, { target: `plans/${index}.md`, revision: String(index), findings: String(index) });
  }
  assert.equal(readPlanCycle(ws, session).exhausted, true);

  const first = beginPlanReview(ws, session, {
    hookKind: "plan-file-panel",
    target: "plans/a.md",
    identity: "reset-a",
    resetNonce: "nonce-1"
  });
  const second = beginPlanReview(ws, session, {
    hookKind: "plan-file-panel",
    target: "plans/b.md",
    identity: "reset-b",
    resetNonce: "nonce-1"
  });
  assert.equal(first.role, "leader");
  assert.equal(second.role, "leader");
  assert.equal(readPlanCycle(ws, session).count, 0, "both observers see one reset, never a second destructive reset");

  assert.equal(completePlanReview(ws, session, first.ticket, {
    status: "block",
    findings: "A"
  }).outcome, "block");
  assert.equal(completePlanReview(ws, session, second.ticket, {
    status: "block",
    findings: "B"
  }).outcome, "block");
  assert.equal(readPlanCycle(ws, session).count, 2, "the reused nonce does not erase work committed after its first use");
});

test("the default review lease outlives the slowest configured reviewer timeout", () => {
  // A leader whose lease expires mid-panel is reclaimed by a duplicate same-identity leader that
  // pays for a second panel while the original completion is discarded as superseded (F3). The
  // issued default lease must exceed the slowest reviewer timeoutMs (config-store DEFAULTS: Kimi).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-lease-ms-"));
  const slowest = Math.max(...Object.values(resolveConfig({ env: {} }).providers).map((p) => Number(p.timeoutMs) || 0));
  const started = beginPlanReview(ws, "lease-ms", {
    hookKind: "exit-plan-mode",
    target: "inline-plan",
    identity: "slow-panel",
    now: 5_000
  });
  assert.equal(started.role, "leader");
  const lease = started.ticket.leaseExpiresAt - started.ticket.startedAt;
  assert.equal(lease, PLAN_REVIEW_LEASE_MS, "no explicit leaseMs issues the default lease");
  assert.ok(lease > slowest, `default lease ${lease}ms must exceed the slowest reviewer timeout ${slowest}ms`);
});

test("session-total budget: full cycle resolutions never refund the total; the 9th block latches exhausted", async () => {
  const { recordPlanBlock, clearPlanCycleForTarget, readPlanCycle, MAX_PLAN_TOTAL_BLOCKS } = await import("../global-hooks/plan-gate-state.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pgs-total-"));
  const session = "session-total-budget";
  // 4 rounds of (2 blocks + full resolution) = 8 total; resolution wipes the slot ledger each time.
  for (let round = 0; round < 4; round++) {
    recordPlanBlock(ws, session, { target: "plans/a.md", revision: `r${round}a` });
    recordPlanBlock(ws, session, { target: "plans/b.md", revision: `r${round}b` });
    clearPlanCycleForTarget(ws, session, "plans/a.md", { approvalRevision: `r${round}a-fix` });
    clearPlanCycleForTarget(ws, session, "plans/b.md", { approvalRevision: `r${round}b-fix` });
    const state = readPlanCycle(ws, session);
    assert.equal(state.count, 0, `round ${round}: resolution wipes the slot ledger`);
    assert.equal(state.total, (round + 1) * 2, `round ${round}: the session total survives the wipe`);
  }
  assert.equal(readPlanCycle(ws, session).exhausted, false, "8/9 — one block left in the budget");
  recordPlanBlock(ws, session, { target: "plans/a.md", revision: "r-final" });   // 9th
  const latched = readPlanCycle(ws, session);
  assert.equal(latched.total, MAX_PLAN_TOTAL_BLOCKS);
  assert.equal(latched.exhausted, true, "the 9th total block latches exhausted even with free slots");
});
test("explicit resetPlanCycle refunds the session-total budget", async () => {
  const { recordPlanBlock, clearPlanCycleForTarget, resetPlanCycle, readPlanCycle } = await import("../global-hooks/plan-gate-state.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pgs-total-reset-"));
  const session = "session-total-reset";
  for (let round = 0; round < 4; round++) {
    recordPlanBlock(ws, session, { target: "plans/a.md", revision: `r${round}a` });
    recordPlanBlock(ws, session, { target: "plans/b.md", revision: `r${round}b` });
    clearPlanCycleForTarget(ws, session, "plans/a.md", { approvalRevision: `r${round}a-fix` });
    clearPlanCycleForTarget(ws, session, "plans/b.md", { approvalRevision: `r${round}b-fix` });
  }
  recordPlanBlock(ws, session, { target: "plans/a.md", revision: "r-final" });   // 9th — latches
  assert.equal(readPlanCycle(ws, session).exhausted, true);
  resetPlanCycle(ws, session);
  const state = readPlanCycle(ws, session);
  assert.equal(state.total, 0, "explicit reset refunds the total");
  assert.equal(state.exhausted, false);
});
