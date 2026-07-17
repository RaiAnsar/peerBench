// Shared durable state for the two automatic plan gates.
//
// There are two separate concurrency problems to solve here:
//   1. the session-scoped three-BLOCK ceiling must be atomic across both hooks; and
//   2. an old review must never approve/resolve state created by a newer review.
//
// Every review therefore receives an immutable ticket containing the current reset epoch, the
// exact latest block id it observed, and a per-target review epoch. Completion is accepted only if
// all three still match. Exact concurrent reviews share a crash-recoverable lease and one durable
// result, so contradictory reviewer outcomes cannot race an ALLOW cache against a BLOCK.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSessionId, workspaceStateDir } from "./config-store.mjs";

export const MAX_PLAN_BLOCK_CYCLES = 3;
export const PLAN_CYCLE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const PLAN_REVIEW_POLICY_VERSION = "plan-review-v5-exhaustive-cycle3-epoch";
export const PLAN_FILE_REVIEW_POLICY_VERSION = "plan-file-review-v5-full-identity-epoch";
export const PLAN_REVIEW_LEASE_MS = 5 * 60 * 1000;
const PLAN_REVIEW_RESULT_TTL_MS = 60 * 1000;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

export function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

// Review adapters expose non-secret reviewIdentity metadata. Names alone are not a safe cache key:
// an unchanged plan must be reviewed again after its model, endpoint, or inference config changes.
export function reviewerPanelIdentity(reviewers = []) {
  return reviewers.map((reviewer) => ({
    name: String(reviewer?.name || "unknown").trim().toLowerCase(),
    identity: stableJson(reviewer?.reviewIdentity || {
      kind: "injected-or-legacy",
      model: reviewer?.model || "",
      baseURL: reviewer?.baseURL || "",
      config: reviewer?.config || null
    })
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function planApprovalIdentity({ policy, hookKind, target, contentDigest, reviewers }) {
  return sha256(JSON.stringify(stableJson({
    schema: 3,
    policy,
    hookKind,
    target,
    contentDigest,
    reviewers: reviewerPanelIdentity(reviewers)
  })));
}

function stateRoot(ws) {
  return path.join(workspaceStateDir(ws), "plan-gate");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* parent may enforce permissions */ }
  return dir;
}

function writeJsonAtomic(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeReadJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function normalizedSession(sessionKey) {
  return normalizeSessionId(sessionKey) || "session-unscoped";
}

function cycleDir(ws, sessionKey) {
  return path.join(stateRoot(ws), `cycle-${normalizedSession(sessionKey)}`);
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function withDirectoryLock(lock, operation, { staleMs = 30_000 } = {}) {
  ensurePrivateDir(path.dirname(lock));
  for (let attempt = 0; attempt < 400; attempt++) {
    let acquired = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > staleMs; } catch { stale = true; }
      if (stale) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* another process owns it */ }
        continue;
      }
      Atomics.wait(sleepBuffer, 0, 0, 5);
    }
    if (acquired) {
      try { return operation(); }
      finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
  throw new Error("plan state is busy");
}

function withCycleLock(ws, sessionKey, operation) {
  const dir = cycleDir(ws, sessionKey);
  return withDirectoryLock(`${dir}.lock`, () => operation(dir));
}

function cycleMetaPath(dir) {
  // Keep the reset epoch outside the removable cycle directory. Resolving all targets may remove
  // the ledger, but it must not make an older in-flight review look current again.
  return `${dir}.meta.json`;
}

function readCycleMeta(dir) {
  const existing = safeReadJson(cycleMetaPath(dir));
  if (existing && Number.isInteger(existing.resetEpoch) && existing.resetEpoch >= 1) return existing;
  const created = { schema: 1, resetEpoch: 1, lastResetToken: "", ts: Date.now() };
  writeJsonAtomic(cycleMetaPath(dir), created);
  return created;
}

function resetRequested(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function applyCycleResetIn(ws, sessionKey, dir, value, now = Date.now()) {
  const meta = readCycleMeta(dir);
  if (!resetRequested(value)) return { applied: false, meta };

  const token = sha256(String(value));
  const receipt = path.join(
    stateRoot(ws),
    "reset-receipts",
    sha256(normalizedSession(sessionKey)).slice(0, 24),
    `${token}.json`
  );
  const prior = safeReadJson(receipt);
  if (prior?.status === "applied") return { applied: false, meta };

  // A pending receipt is deliberately recoverable: if a process dies after creating it, the next
  // holder finishes the reset. lastResetToken makes that recovery idempotent if the crash happened
  // after the ledger was removed but before the receipt was marked applied.
  if (!prior) writeJsonAtomic(receipt, { schema: 1, status: "pending", token, ts: now });
  let next = meta;
  if (meta.lastResetToken !== token) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    next = { schema: 1, resetEpoch: meta.resetEpoch + 1, lastResetToken: token, ts: now };
    writeJsonAtomic(cycleMetaPath(dir), next);
  }
  writeJsonAtomic(receipt, { schema: 1, status: "applied", token, resetEpoch: next.resetEpoch, ts: now });
  return { applied: true, meta: next };
}

function cycleSlotsIn(dir) {
  const slots = [];
  for (let index = 1; index <= MAX_PLAN_BLOCK_CYCLES; index++) {
    const file = path.join(dir, `block-${index}.json`);
    if (fs.existsSync(file)) slots.push({ index, file, record: safeReadJson(file) });
  }
  return slots;
}

function normalizedBlock(slot) {
  if (!slot?.record) return null;
  const record = slot.record;
  return {
    ...record,
    blockId: String(record.blockId || `legacy-${slot.index}-${sha256(`${record.target}\0${record.revision}\0${record.ts}`).slice(0, 24)}`),
    slot: slot.index
  };
}

function latestBlocksIn(dir) {
  const latest = new Map();
  for (const slot of cycleSlotsIn(dir)) {
    const record = normalizedBlock(slot);
    if (record?.target) latest.set(record.target, record);
  }
  return latest;
}

function resolvedRecordsIn(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.startsWith("resolved-") && name.endsWith(".json")); }
  catch { return []; }
  return names.map((name) => safeReadJson(path.join(dir, name))).filter(Boolean);
}

function expireCycleIn(dir, { now = Date.now(), windowMs = PLAN_CYCLE_WINDOW_MS } = {}) {
  // Keep every unresolved block durable. The window is housekeeping only for an orphaned
  // resolution namespace; time must never silently grant three more automatic wakeups.
  if (cycleSlotsIn(dir).length > 0) return false;
  const latest = Math.max(0, ...resolvedRecordsIn(dir).map((record) => Number(record.ts) || 0));
  if (!latest || now - latest <= windowMs) return false;
  const expired = `${dir}.expired-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(dir, expired);
    fs.rmSync(expired, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function stateIn(dir) {
  const slots = cycleSlotsIn(dir);
  const records = slots.map(normalizedBlock).filter(Boolean);
  const resolved = resolvedRecordsIn(dir);
  return {
    count: slots.length,
    exhausted: slots.length >= MAX_PLAN_BLOCK_CYCLES,
    records,
    resolvedTargets: resolved.map((record) => record.target).filter(Boolean)
  };
}

function clearTargetIn(dir, target, {
  expectedBlockId,
  expectedResetEpoch,
  approvalRevision = "",
  now = Date.now()
} = {}) {
  const meta = readCycleMeta(dir);
  if (expectedResetEpoch != null && Number(expectedResetEpoch) !== meta.resetEpoch) {
    return { accepted: false, reason: "reset-epoch-changed", cleared: false };
  }

  const state = stateIn(dir);
  if (!state.count || state.records.length !== state.count) {
    return { accepted: true, reason: "no-block", cleared: false };
  }
  const latest = latestBlocksIn(dir);
  const blocked = latest.get(target);
  if (!blocked) return { accepted: true, reason: "target-not-blocked", cleared: false };
  if (Object.prototype.hasOwnProperty.call(arguments[2] || {}, "expectedBlockId") &&
      String(expectedBlockId ?? "") !== String(blocked.blockId ?? "")) {
    return { accepted: false, reason: "newer-block", cleared: false, latestBlockId: blocked.blockId };
  }

  const resolvedFile = path.join(dir, `resolved-${sha256(target).slice(0, 24)}.json`);
  writeJsonAtomic(resolvedFile, {
    schema: 2,
    target,
    approvalRevision: String(approvalRevision || ""),
    matchedBlockId: blocked.blockId,
    resetEpoch: meta.resetEpoch,
    ts: now
  });

  const resolutions = new Map(resolvedRecordsIn(dir).map((record) => [record.target, record]));
  const allResolved = [...latest.entries()].every(([blockedTarget, latestBlock]) => {
    const resolution = resolutions.get(blockedTarget);
    return resolution && resolution.matchedBlockId === latestBlock.blockId &&
      Number(resolution.resetEpoch || meta.resetEpoch) === meta.resetEpoch;
  });
  if (!allResolved) return { accepted: true, reason: "target-resolved", cleared: false };
  fs.rmSync(dir, { recursive: true, force: true });
  return { accepted: true, reason: "cycle-resolved", cleared: true };
}

function recordBlockIn(dir, { target, revision, badge = "", findings = "", reviewEpoch = null } = {}, {
  expectedResetEpoch,
  now = Date.now()
} = {}) {
  const meta = readCycleMeta(dir);
  if (expectedResetEpoch != null && Number(expectedResetEpoch) !== meta.resetEpoch) {
    return { stale: true, reason: "reset-epoch-changed", slot: null };
  }
  const targetName = String(target || "unknown-plan");
  const record = {
    schema: 2,
    blockId: randomUUID(),
    resetEpoch: meta.resetEpoch,
    reviewEpoch: Number.isInteger(reviewEpoch) ? reviewEpoch : null,
    ts: now,
    target: targetName,
    revision: String(revision || ""),
    badge: String(badge || ""),
    findings: String(findings || "").slice(0, 24_000)
  };
  try { fs.rmSync(path.join(dir, `resolved-${sha256(targetName).slice(0, 24)}.json`), { force: true }); } catch { /* noop */ }
  ensurePrivateDir(dir);
  for (let index = 1; index <= MAX_PLAN_BLOCK_CYCLES; index++) {
    const file = path.join(dir, `block-${index}.json`);
    try {
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { stale: false, slot: { index, exhausted: index >= MAX_PLAN_BLOCK_CYCLES, record } };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  return { stale: false, slot: null };
}

export function readPlanCycle(ws, sessionKey, options = {}) {
  return withCycleLock(ws, sessionKey, (dir) => {
    expireCycleIn(dir, options);
    return stateIn(dir);
  });
}

export function resetPlanCycle(ws, sessionKey) {
  return withCycleLock(ws, sessionKey, (dir) => {
    const meta = readCycleMeta(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    writeJsonAtomic(cycleMetaPath(dir), {
      schema: 1,
      resetEpoch: meta.resetEpoch + 1,
      lastResetToken: `direct-${randomUUID()}`,
      ts: Date.now()
    });
  });
}

// Compatibility API for tests/older callers. New hook code passes the immutable ticket fields;
// legacy calls without them resolve the latest currently visible block.
export function clearPlanCycleForTarget(ws, sessionKey, target, options = {}) {
  return withCycleLock(ws, sessionKey, (dir) => {
    expireCycleIn(dir, options);
    return clearTargetIn(dir, target, options).cleared;
  });
}

// Atomically claim one of exactly three shared block slots.
export function recordPlanBlock(ws, sessionKey, block = {}, options = {}) {
  return withCycleLock(ws, sessionKey, (dir) => {
    expireCycleIn(dir, options);
    return recordBlockIn(dir, block, options).slot;
  });
}

export function planCycleAdvisory(state) {
  const records = Array.isArray(state?.records) ? state.records : [];
  const previous = records.map((record, index) => {
    const detail = String(record.findings || "blocking finding recorded").trim().slice(0, 1200);
    return `Cycle ${index + 1}${record.badge ? ` [${record.badge}]` : ""}: ${detail}`;
  }).join("\n\n");
  return (
    `UNREVIEWED — automatic plan review paused after ${MAX_PLAN_BLOCK_CYCLES} blocked repair cycles in this task/session. ` +
    "The current revision was not re-validated and no further automatic plan wake will run in this session. " +
    "Start a new task/session or set BENCH_PLAN_CYCLE_RESET to a new one-shot nonce for one explicit fresh cycle." +
    (previous ? `\n\nPrior unresolved findings:\n${previous}` : "")
  );
}

function scopeDigest(hookKind, target) {
  return sha256(`${hookKind}\0${target}`).slice(0, 32);
}

function markerPath(ws, hookKind, target) {
  return path.join(stateRoot(ws), "cache", `${scopeDigest(hookKind, target)}.json`);
}

function scopeLockPath(ws, hookKind, target) {
  return path.join(stateRoot(ws), "locks", `${scopeDigest(hookKind, target)}.lock`);
}

function headPath(ws, hookKind, target, headScope = "shared") {
  const suffix = sha256(String(headScope)).slice(0, 20);
  return path.join(stateRoot(ws), "heads", `${scopeDigest(hookKind, target)}-${suffix}.json`);
}

function flightPath(ws, hookKind, target, sessionKey, identity) {
  const name = sha256(`${normalizedSession(sessionKey)}\0${identity}`).slice(0, 40);
  return path.join(stateRoot(ws), "flights", scopeDigest(hookKind, target), `${name}.json`);
}

function withScopeLock(ws, hookKind, target, operation) {
  return withDirectoryLock(scopeLockPath(ws, hookKind, target), operation);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function activeFlight(record, now) {
  if (record?.state !== "running") return false;
  if (Number(record.leaseExpiresAt) <= now) return false;
  // A dead owner can be recovered immediately instead of making a hook wait for the full lease.
  return record.pid === process.pid || pidAlive(Number(record.pid));
}

function markerMatchesSnapshot(marker, identity, head, headScope, cycle, refresh) {
  if (refresh || marker?.identity !== identity) return false;
  if (!["allow", "coverage-incomplete"].includes(marker?.status)) return false;
  if (head && (!marker.headScope || marker.headScope === headScope) &&
      (Number(marker.reviewEpoch) !== Number(head.epoch) || head.identity !== identity)) return false;
  if (marker.resetEpoch != null && Number(marker.resetEpoch) !== Number(cycle.resetEpoch)) return false;
  if (cycle.latestBlockId && marker.matchedBlockId !== cycle.latestBlockId) return false;
  // Legacy markers are safe only when there is no unresolved block for this target.
  if (cycle.latestBlockId && !marker.matchedBlockId) return false;
  return true;
}

function prepareCycleIn(ws, sessionKey, dir, target, resetNonce, now) {
  const reset = applyCycleResetIn(ws, sessionKey, dir, resetNonce, now);
  expireCycleIn(dir, { now });
  const latest = latestBlocksIn(dir).get(target) || null;
  return {
    resetApplied: reset.applied,
    resetEpoch: reset.meta.resetEpoch,
    latestBlockId: latest?.blockId || null,
    state: stateIn(dir)
  };
}

/**
 * Begin (or join) one exact review. The returned leader ticket is immutable and must be supplied to
 * completePlanReview. Followers wait on the same flight and never invoke another reviewer panel.
 */
export function beginPlanReview(ws, sessionKey, {
  hookKind,
  target,
  identity,
  refresh = false,
  resetNonce = "",
  sessionScoped = false,
  now = Date.now(),
  leaseMs = PLAN_REVIEW_LEASE_MS
} = {}) {
  if (!hookKind || !target || !identity) throw new Error("plan review scope, target, and identity are required");
  return withScopeLock(ws, hookKind, target, () => {
    const headScope = sessionScoped ? normalizedSession(sessionKey) : "shared";
    const markerFile = markerPath(ws, hookKind, target);
    const marker = safeReadJson(markerFile);
    const headFile = headPath(ws, hookKind, target, headScope);
    const head = safeReadJson(headFile);
    const cycle = withCycleLock(ws, sessionKey, (dir) => {
      const prepared = prepareCycleIn(ws, sessionKey, dir, target, resetNonce, now);
      if (markerMatchesSnapshot(marker, identity, head, headScope, prepared, refresh || prepared.resetApplied) && marker.status === "allow") {
        clearTargetIn(dir, target, {
          expectedBlockId: marker.matchedBlockId ?? null,
          expectedResetEpoch: prepared.resetEpoch,
          approvalRevision: marker.approvalRevision || identity,
          now
        });
      }
      return prepared;
    });
    const effectiveRefresh = Boolean(refresh || cycle.resetApplied);
    if (markerMatchesSnapshot(marker, identity, head, headScope, cycle, effectiveRefresh)) {
      return { role: marker.status === "allow" ? "cached-allow" : "cached-coverage", marker, cycle };
    }
    if (cycle.state.exhausted) return { role: "exhausted", cycle };

    const file = flightPath(ws, hookKind, target, sessionKey, identity);
    const flight = safeReadJson(file);
    if (activeFlight(flight, now)) return { role: "follower", flight, cycle };
    // Completed flight records exist only so callers that actually observed the running lease can
    // join its result via waitForPlanReview. A later invocation is a new review attempt (BLOCK is
    // never mistaken for an ALLOW cache, and a fail-open is never cached).

    const epoch = Math.max(0, Number(head?.epoch) || 0) + 1;
    const leaseId = randomUUID();
    const ticket = {
      schema: 1,
      hookKind,
      target,
      identity,
      session: normalizedSession(sessionKey),
      leaseId,
      reviewEpoch: epoch,
      headScope,
      resetEpoch: cycle.resetEpoch,
      expectedBlockId: cycle.latestBlockId,
      startedAt: now,
      leaseExpiresAt: now + Math.max(1_000, Number(leaseMs) || PLAN_REVIEW_LEASE_MS)
    };
    writeJsonAtomic(headFile, { schema: 1, epoch, identity, leaseId, ts: now });
    writeJsonAtomic(file, { ...ticket, state: "running", pid: process.pid });
    return { role: "leader", ticket, cycle };
  });
}

/** Wait asynchronously so a follower in the same Node process cannot deadlock the leader. */
export async function waitForPlanReview(ws, sessionKey, flight, {
  pollMs = 15,
  maxWaitMs = PLAN_REVIEW_LEASE_MS + 1_000
} = {}) {
  const started = Date.now();
  const file = flightPath(ws, flight.hookKind, flight.target, sessionKey, flight.identity);
  while (Date.now() - started <= maxWaitMs) {
    const current = withScopeLock(ws, flight.hookKind, flight.target, () => safeReadJson(file));
    if (current?.state === "completed") return { role: "completed", result: current };
    if (!current || !activeFlight(current, Date.now())) return { role: "retry" };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { role: "retry" };
}

function completeFlight(file, ticket, outcome, payload, now) {
  const completed = {
    ...ticket,
    state: "completed",
    outcome,
    payload: payload && typeof payload === "object" ? payload : {},
    completedAt: now,
    resultExpiresAt: now + PLAN_REVIEW_RESULT_TTL_MS
  };
  writeJsonAtomic(file, completed);
  return completed;
}

/**
 * Commit a leader result. ALLOW resolution/cache writes and BLOCK slot/cache invalidation happen
 * while the target lock is held. A stale lease, newer target review, newer block, or reset epoch
 * turns the result into `superseded` without mutating the approval cache or cycle ledger.
 */
export function completePlanReview(ws, sessionKey, ticket, {
  status,
  payload = {},
  badge = "",
  findings = "",
  now = Date.now()
} = {}) {
  const { hookKind, target, identity } = ticket || {};
  if (!hookKind || !target || !identity || !ticket.leaseId) throw new Error("a valid plan review ticket is required");
  return withScopeLock(ws, hookKind, target, () => {
    const file = flightPath(ws, hookKind, target, sessionKey, identity);
    const flight = safeReadJson(file);
    const head = safeReadJson(headPath(ws, hookKind, target, ticket.headScope || "shared"));
    if (flight?.state !== "running" || flight.leaseId !== ticket.leaseId) {
      return { outcome: "superseded", payload: { reason: "newer-review" } };
    }
    if (head?.leaseId !== ticket.leaseId || Number(head?.epoch) !== Number(ticket.reviewEpoch)) {
      return completeFlight(file, ticket, "superseded", { ...payload, reason: "newer-review" }, now);
    }

    if (status === "block") {
      const recorded = withCycleLock(ws, sessionKey, (dir) => recordBlockIn(dir, {
        target,
        revision: identity,
        badge,
        findings,
        reviewEpoch: ticket.reviewEpoch
      }, { expectedResetEpoch: ticket.resetEpoch, now }));
      if (recorded.stale) return completeFlight(file, ticket, "superseded", { ...payload, reason: recorded.reason }, now);
      if (!recorded.slot) return completeFlight(file, ticket, "advisory", payload, now);
      try { fs.rmSync(markerPath(ws, hookKind, target), { force: true }); } catch { /* best effort */ }
      return completeFlight(file, ticket, "block", { ...payload, cycle: recorded.slot.index }, now);
    }

    if (status === "allow") {
      const resolution = withCycleLock(ws, sessionKey, (dir) => clearTargetIn(dir, target, {
        expectedBlockId: ticket.expectedBlockId,
        expectedResetEpoch: ticket.resetEpoch,
        approvalRevision: identity,
        now
      }));
      if (!resolution.accepted) {
        return completeFlight(file, ticket, "superseded", { ...payload, reason: resolution.reason }, now);
      }
      writeJsonAtomic(markerPath(ws, hookKind, target), {
        schema: 2,
        ts: now,
        status: "allow",
        identity,
        approvalRevision: identity,
        matchedBlockId: ticket.expectedBlockId,
        resetEpoch: ticket.resetEpoch,
        reviewEpoch: ticket.reviewEpoch,
        headScope: ticket.headScope || "shared"
      });
      return completeFlight(file, ticket, "allow", payload, now);
    }

    if (status === "coverage-incomplete") {
      writeJsonAtomic(markerPath(ws, hookKind, target), {
        schema: 2,
        ts: now,
        status: "coverage-incomplete",
        identity,
        approvalRevision: identity,
        matchedBlockId: ticket.expectedBlockId,
        resetEpoch: ticket.resetEpoch,
        reviewEpoch: ticket.reviewEpoch,
        headScope: ticket.headScope || "shared"
      });
      return completeFlight(file, ticket, "coverage-incomplete", payload, now);
    }

    return completeFlight(file, ticket, status === "superseded" ? "superseded" : "fail-open", payload, now);
  });
}

export function readPlanMarker(ws, hookKind, target) {
  return withScopeLock(ws, hookKind, target, () => safeReadJson(markerPath(ws, hookKind, target)));
}

export function writePlanMarker(ws, hookKind, target, marker) {
  return withScopeLock(ws, hookKind, target, () => {
    const head = safeReadJson(headPath(ws, hookKind, target, marker?.headScope || "shared"));
    writeJsonAtomic(markerPath(ws, hookKind, target), {
      schema: 2,
      ts: Date.now(),
      reviewEpoch: Number(marker?.reviewEpoch ?? head?.epoch ?? 0),
      ...marker
    });
  });
}

export function clearPlanMarker(ws, hookKind, target) {
  return withScopeLock(ws, hookKind, target, () => {
    try { fs.rmSync(markerPath(ws, hookKind, target), { force: true }); } catch { /* best effort */ }
  });
}

export function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}
