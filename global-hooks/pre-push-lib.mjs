// Authoritative native pre-push review logic.
//
// This module consumes Git's canonical pre-push tuples. It never parses a shell command, guesses a
// remote from argv, or reviews a pre-amend HEAD. Exact update tuples are also the cache identity, so
// retrying an unchanged push is instant.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, workspaceStateDir, readReviewerCooldown } from "./config-store.mjs";
import { shouldRewake } from "./deep-review.mjs";
import { consumeCycleReset } from "./cycle-reset.mjs";
import { runPushReview as defaultRunPushReview } from "./spec-review-run.mjs";

// Bump whenever the evidence contract changes. Exact-range ALLOW caches from an older evidence
// implementation must never authorize a push under a stronger policy.
export const NATIVE_PUSH_REVIEW_VERSION = "native-push-v3-exhaustive-evidence";
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CYCLE_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BLOCK_CYCLES = 3;
const MAX_STORED_FINDINGS = 50_000;

function gitTry(args, cwd) {
  try {
    return [execFileSync("git", ["-c", "advice.graftFileDeprecated=false", "--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull }
    }).trim(), true];
  } catch {
    return ["", false];
  }
}

const isOid = (value) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(value || ""));
export const isZeroOid = (value) => isOid(value) && /^0+$/.test(value);

export function parsePrePushUpdates(input) {
  const updates = [];
  const lines = String(input ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const fields = lines[index].split(/\s+/);
    if (fields.length !== 4) throw new Error(`malformed pre-push input on line ${index + 1}: expected 4 fields`);
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!isOid(localSha) || !isOid(remoteSha)) throw new Error(`malformed pre-push object id on line ${index + 1}`);
    if (!localRef || !remoteRef) throw new Error(`malformed pre-push ref on line ${index + 1}`);
    updates.push({ localRef, localSha: localSha.toLowerCase(), remoteRef, remoteSha: remoteSha.toLowerCase() });
  }
  return updates;
}

function resolveCommit(cwd, value, gitImpl) {
  const [sha, ok] = gitImpl(["rev-parse", "--verify", "--quiet", `${value}^{commit}`], cwd);
  return ok && isOid(sha) ? sha.toLowerCase() : null;
}

function resolveObjectTarget(cwd, value, gitImpl) {
  const commit = resolveCommit(cwd, value, gitImpl);
  if (commit) return { ok: true, commit };

  const [type, typeOk] = gitImpl(["cat-file", "-t", value], cwd);
  if (!typeOk || !type) return { ok: false, reason: `cannot determine object type for ${value}` };
  const normalizedType = String(type).trim().toLowerCase();
  if (["blob", "tree"].includes(normalizedType)) return { ok: true, nonCommitType: normalizedType };
  if (normalizedType !== "tag") return { ok: false, reason: `unsupported object type ${normalizedType} for ${value}` };

  // `^{}` recursively peels annotated tags. Only a definitive blob/tree target is safe to skip;
  // a missing or otherwise indeterminate target fails closed.
  const [peeled, peeledOk] = gitImpl(["rev-parse", "--verify", "--quiet", `${value}^{}`], cwd);
  if (!peeledOk || !isOid(peeled)) return { ok: false, reason: `cannot peel annotated tag ${value}` };
  const [peeledType, peeledTypeOk] = gitImpl(["cat-file", "-t", peeled], cwd);
  if (!peeledTypeOk || !peeledType) return { ok: false, reason: `cannot determine annotated tag target type for ${value}` };
  const targetType = String(peeledType).trim().toLowerCase();
  if (["blob", "tree"].includes(targetType)) return { ok: true, nonCommitType: targetType, peeled: peeled.toLowerCase() };
  if (targetType === "commit") return { ok: true, commit: peeled.toLowerCase() };
  return { ok: false, reason: `unsupported annotated tag target type ${targetType} for ${value}` };
}

function emptyTreeOid(cwd, gitImpl) {
  // Do not assume SHA-1: repositories created with Git's SHA-256 object format have a different
  // empty-tree object id. `hash-object` asks this repository's object database which format it uses.
  const [sha, ok] = gitImpl(["hash-object", "-t", "tree", "--stdin"], cwd);
  return ok && isOid(sha) ? sha.toLowerCase() : null;
}

// Resolve one exact Git update to the commit range the panel must inspect. A non-commit tag and a
// deletion carry no code; every indeterminate commit update fails closed.
export function resolveNativeUpdateRange(cwd, remoteName, update, { gitImpl = gitTry } = {}) {
  if (isZeroOid(update.localSha)) return { ok: true, skip: true, reason: "deletion" };
  const local = resolveObjectTarget(cwd, update.localSha, gitImpl);
  if (!local.ok) return { ok: false, reason: `${local.reason}; cannot verify ${update.localRef}` };
  if (local.nonCommitType) return { ok: true, skip: true, reason: `non-commit ${local.nonCommitType} update` };
  const localCommit = local.commit;

  if (!isZeroOid(update.remoteSha)) {
    const remote = resolveObjectTarget(cwd, update.remoteSha, gitImpl);
    if (!remote.ok) {
      return { ok: false, reason: `remote base ${update.remoteSha} is not available or indeterminate; fetch ${remoteName || "the remote"} and retry` };
    }
    if (remote.nonCommitType) {
      const emptyTree = emptyTreeOid(cwd, gitImpl);
      if (!emptyTree) return { ok: false, reason: "cannot resolve this repository's empty-tree object id" };
      return { ok: true, range: `${emptyTree}..${localCommit}`, localCommit, baseCommit: emptyTree, note: `replacing non-commit ${remote.nonCommitType} with commit content; reviewing full history` };
    }
    const remoteCommit = remote.commit;
    return { ok: true, range: `${remoteCommit}..${localCommit}`, localCommit, baseCommit: remoteCommit };
  }

  // remoteSha=0 is the authoritative statement that this target ref does not exist. Local
  // refs/remotes/* and upstreams are mutable/stale hints, not proof of content on this remote (for
  // example after changing origin to a new empty repository). Review the complete local snapshot.
  const emptyTree = emptyTreeOid(cwd, gitImpl);
  if (!emptyTree) return { ok: false, reason: "cannot resolve this repository's empty-tree object id" };
  return { ok: true, range: `${emptyTree}..${localCommit}`, localCommit, baseCommit: emptyTree, note: "new ref with no local remote base; reviewing full history" };
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function normalizeReviewerName(name) { return String(name || "").trim().toLowerCase(); }

export function nativePushIdentity({ remoteName = "", remoteUrl = "", updates = [], reviewers = [], policy = {} } = {}) {
  const canonicalUpdates = updates
    .map((u) => [u.localRef, u.localSha, u.remoteRef, u.remoteSha])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const canonical = {
    version: NATIVE_PUSH_REVIEW_VERSION,
    remoteName,
    remoteUrl,
    updates: canonicalUpdates,
    reviewers: reviewers.map(normalizeReviewerName).sort(),
    policy: stableValue(policy)
  };
  return stableHash(JSON.stringify(canonical));
}

function nativePushScope({ remoteName = "", remoteUrl = "", updates = [] } = {}) {
  return stableHash(JSON.stringify({
    remote: remoteUrl || remoteName,
    // The repair-loop ceiling protects remote targets. Renaming the local source ref must not buy
    // a fresh three-cycle budget for the same destination ref.
    refs: [...new Set(updates.map((u) => u.remoteRef))].sort()
  }));
}

function readJson(file, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonAtomic(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fsImpl.renameSync(tmp, file);
}

function cacheFile(ws, identity) { return path.join(workspaceStateDir(ws), "native-push-cache", `${identity}.json`); }
function rangeCacheFile(ws, identity) { return path.join(workspaceStateDir(ws), "native-push-range-cache", `${identity}.json`); }
function cycleFile(ws, scope) { return path.join(workspaceStateDir(ws), "native-push-cycles", `${scope}.json`); }

function readDecisionCache(file, identity, { now, ttlMs, fsImpl }) {
  const cached = readJson(file, fsImpl);
  if (!cached || cached.identity !== identity || !["allow", "block"].includes(cached.decision)) return null;
  if (now - Number(cached.ts || 0) > ttlMs) return null;
  return cached;
}

function readCache(ws, identity, opts) {
  return readDecisionCache(cacheFile(ws, identity), identity, opts);
}

function readRangeCache(ws, identity, opts) {
  return readDecisionCache(rangeCacheFile(ws, identity), identity, opts);
}

function writeDecisionCache(file, identity, result, { now, fsImpl }) {
  try {
    writeJsonAtomic(file, {
      identity, ts: now, decision: result.decision,
      summary: String(result.summary || "").slice(0, MAX_STORED_FINDINGS),
      findings: String(result.findings || "").slice(0, MAX_STORED_FINDINGS),
      badge: result.badge || "", traceIds: result.traceIds || []
    }, fsImpl);
  } catch { /* cache is an optimization; review result still stands */ }
}

function writeCache(ws, identity, result, opts) {
  writeDecisionCache(cacheFile(ws, identity), identity, result, opts);
}

function writeRangeCache(ws, identity, result, opts) {
  writeDecisionCache(rangeCacheFile(ws, identity), identity, result, opts);
}

function clearCache(ws, identity, fsImpl) {
  try { fsImpl.rmSync(cacheFile(ws, identity), { force: true }); } catch { /* best effort */ }
}

function clearRangeCache(ws, identity, fsImpl) {
  try { fsImpl.rmSync(rangeCacheFile(ws, identity), { force: true }); } catch { /* best effort */ }
}

function clearCycle(ws, scope, fsImpl) {
  try { fsImpl.rmSync(cycleFile(ws, scope), { force: true }); } catch { /* best effort */ }
}

function recordBlockCycle(ws, scope, identity, result, { now, windowMs, maxCycles, fsImpl }) {
  const file = cycleFile(ws, scope);
  let state = readJson(file, fsImpl);
  // An unresolved ceiling never renews merely because time passed. Successful verification or an
  // explicit one-shot reset clears it; otherwise a long debugging session still gets only three
  // automatic blocked revisions.
  if (!state) state = { count: 0, identities: [], findings: [] };
  if (!state.identities.includes(identity)) {
    state.count = Number(state.count || 0) + 1;
    state.identities = [...state.identities, identity].slice(-maxCycles);
    state.findings = [...(state.findings || []), String(result.findings || result.summary || "blocked").slice(0, 12_000)].slice(-maxCycles);
  }
  state.ts = now;
  try { writeJsonAtomic(file, state, fsImpl); } catch { /* best effort */ }
  return state;
}

function cycleHold(ws, scope, { now, windowMs, maxCycles, reset, fsImpl }) {
  if (reset) { clearCycle(ws, scope, fsImpl); return null; }
  const state = readJson(cycleFile(ws, scope), fsImpl);
  if (!state || Number(state.count || 0) < maxCycles) return null;
  return state;
}

// FAST-FAIL before the (multi-minute) panel: if reviewer availability cooldowns make the policy
// unsatisfiable — the trusted Codex verdict is required but Codex is out of quota, or too few
// non-cooled reviewers remain to meet quorum — say so honestly and immediately. Without this,
// every push retry re-ran the whole dying panel, burned its timeouts, and then blocked anyway
// with an opaque "quorum not met".
export function pushPolicyDoomedByCooldowns(intendedReviewers, policy, { now = Date.now() } = {}) {
  const intended = [...new Set((intendedReviewers || []).map(normalizeReviewerName).filter(Boolean))];
  const cooled = intended
    .map((name) => ({ name, cooldown: readReviewerCooldown(name, { now }) }))
    .filter((entry) => entry.cooldown);
  if (!cooled.length) return null;
  const describe = ({ name, cooldown }) => {
    const minutesLeft = Math.max(1, Math.ceil((Number(cooldown.until) - now) / 60_000));
    return `${name}: ${cooldown.kind === "auth" ? "auth failed (re-auth needed)" : "out of quota/credits"} — retry in ~${minutesLeft} min`;
  };
  const codexRequiredButCooled = policy.requireCodex && cooled.some((entry) => entry.name === "codex");
  const availableCount = intended.length - cooled.length;
  if (codexRequiredButCooled || availableCount < policy.quorum) {
    return `push review cannot currently succeed — ${cooled.map(describe).join("; ")}. ` +
      "Wait for the quota/cooldown to clear (or re-auth), then push again; " +
      "BENCH_NATIVE_PUSH_BYPASS=1 git push is the explicit peerBench-only bypass.";
  }
  return null;
}

export function evaluatePushReview(review, intendedReviewers, env = process.env) {
  // Deterministic evidence-coverage failures are policy BLOCKs, not provider outages. They are
  // safe to cache by exact immutable range and participate in the same three-revision ceiling.
  if (review?.coverageBlocked) {
    return {
      decision: "block",
      findings: review.findings || review.reason || "push evidence could not be reviewed exhaustively",
      summary: review.summary || review.reason || "push evidence coverage blocked"
    };
  }
  if (review?.retry) return { decision: "unavailable", reason: review.reason || "review requested retry" };
  const intended = [...new Set((intendedReviewers || []).map(normalizeReviewerName).filter(Boolean))];
  const intendedSet = new Set(intended);
  const sides = Array.isArray(review?.reviewers) ? review.reviewers : [];
  const validByName = new Map();
  for (const side of sides) {
    const name = normalizeReviewerName(side?.name);
    if (!intendedSet.has(name) || side?.error || !["ALLOW", "BLOCK"].includes(String(side?.verdict || "").toUpperCase())) continue;
    if (!validByName.has(name)) validByName.set(name, side);
  }
  const valid = [...validByName.values()];
  const configuredQuorum = Number(env.BENCH_PUSH_REVIEW_QUORUM);
  // A configured quorum larger than the panel can never be met and would block every push as
  // unavailable; clamp to all configured reviewers (the documented "or all when fewer are
  // configured" behavior).
  const quorum = Number.isInteger(configuredQuorum) && configuredQuorum > 0
    ? Math.max(1, Math.min(configuredQuorum, intended.length || 1))
    : Math.max(1, Math.min(2, intended.length || sides.length || 1));
  const requireCodex = intended.includes("codex") && !["0", "false", "no", "off"].includes(String(env.BENCH_PUSH_REQUIRE_CODEX || "").toLowerCase());
  const unavailableReasons = [];
  if (valid.length < quorum) unavailableReasons.push(`review quorum not met (${valid.length}/${quorum} verdicts)`);
  if (requireCodex && !valid.some((r) => normalizeReviewerName(r.name) === "codex")) {
    unavailableReasons.push("trusted Codex verdict missing");
  }
  const failedReviewers = intended.flatMap((name) => {
    const rows = sides.filter((side) => normalizeReviewerName(side?.name) === name);
    if (!rows.length) return [`${name}: missing result`];
    if (validByName.has(name)) return [];
    return [`${name}: ${rows.map((side) => side?.error || "invalid verdict").join("; ")}`];
  });

  // A concrete blocker remains a blocker, but it must never erase an unavailable quorum/Codex
  // signal from the same panel. The caller surfaces both and deliberately does not cache this
  // range, so a retry can finish the missing review without rerunning other completed ranges.
  // The native push gate is an AND gate. A reviewer's explicit, valid BLOCK vote is authoritative
  // regardless of its severity label; severity controls Stop-hook rewakes, not push authorization.
  const hasExplicitBlock = valid.some((side) => String(side?.verdict || "").toUpperCase() === "BLOCK");
  if (hasExplicitBlock || shouldRewake(review)) {
    return {
      decision: "block",
      findings: review.findings || review.summary || "blocking issue",
      summary: review.summary,
      badge: review.badge,
      traceId: review.traceId,
      ...(failedReviewers.length ? { failedReviewers } : {}),
      ...(unavailableReasons.length ? {
        incomplete: true,
        unavailableReason: unavailableReasons.join("; ")
      } : {})
    };
  }
  if (unavailableReasons.length) return { decision: "unavailable", reason: unavailableReasons.join("; "), failedReviewers };
  return {
    decision: "allow",
    summary: review.summary || "review quorum passed",
    badge: review.badge,
    traceId: review.traceId,
    ...(failedReviewers.length ? { failedReviewers } : {})
  };
}

function nativePushPolicy(config, env) {
  const intended = config.reviewers.map(normalizeReviewerName);
  const configuredQuorum = Number(env.BENCH_PUSH_REVIEW_QUORUM);
  // Same clamp as evaluatePushReview: an over-large configured quorum means "all reviewers",
  // never an unreachable bar (and it keeps the policy fingerprint identical for equivalent values).
  const quorum = Number.isInteger(configuredQuorum) && configuredQuorum > 0
    ? Math.max(1, Math.min(configuredQuorum, intended.length || 1))
    : Math.max(1, Math.min(2, intended.length || 1));
  const requireCodex = intended.includes("codex") && !["0", "false", "no", "off"].includes(String(env.BENCH_PUSH_REQUIRE_CODEX || "").toLowerCase());
  const configuredReviewers = intended.map((name) => {
    const provider = config.providers?.[name];
    return provider ? {
      name,
      model: provider.model || "",
      baseURL: provider.baseURL || "",
      thinking: provider.thinking ?? null,
      temperature: provider.temperature ?? null,
      headers: stableValue(provider.headers || {}),
      timeoutMs: provider.timeoutMs ?? null,
      concurrency: provider.concurrency ?? null
    } : { name, model: "cli" };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const maxCyclesRaw = Number(env.BENCH_PUSH_MAX_BLOCK_CYCLES);
  // Operators may choose a stricter 1- or 2-cycle gate, but configuration can never turn the
  // product's hard three-cycle UX ceiling into an unbounded repair loop.
  const maxBlockCycles = Number.isInteger(maxCyclesRaw) && maxCyclesRaw > 0
    ? Math.min(DEFAULT_MAX_BLOCK_CYCLES, maxCyclesRaw)
    : DEFAULT_MAX_BLOCK_CYCLES;
  return { quorum, requireCodex, maxBlockCycles, configuredReviewers };
}

function nativeRangeIdentity({ remoteName, remoteUrl, range, reviewers, policy }) {
  return stableHash(JSON.stringify({
    version: NATIVE_PUSH_REVIEW_VERSION,
    kind: "exact-range",
    remoteName,
    remoteUrl,
    range,
    reviewers: reviewers.map(normalizeReviewerName).sort(),
    policy: stableValue(policy)
  }));
}

function updateLabel(updates) {
  return updates.map((update) => `${update.localRef} -> ${update.remoteRef}`).join(", ");
}

function remoteLockId(remoteName, remoteUrl) {
  return stableHash(remoteUrl || remoteName || "remote-unspecified");
}

async function acquireNativePushLock(cwd, remoteName, remoteUrl, fsImpl = fs, waitMs = 5_000) {
  const root = path.join(workspaceStateDir(cwd), "native-push-locks");
  const lock = path.join(root, `${remoteLockId(remoteName, remoteUrl)}.lock`);
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(1, Number(waitMs) || 5_000);
  const ownerFile = path.join(lock, "owner.json");
  const ownerAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === "EPERM"; }
  };
  for (;;) {
    try {
      fsImpl.mkdirSync(lock, { mode: 0o700 });
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        fsImpl.writeFileSync(ownerFile, `${JSON.stringify({
          pid: process.pid,
          nonce,
          createdAt: Date.now()
        })}\n`, { mode: 0o600 });
      } catch (error) {
        try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
        throw error;
      }
      // The lease may be legitimately replaced while we still hold it (a contender reclaimed it
      // after we looked dead). Only remove the lock while the owner record is still OURS, or an
      // evicted owner's release would delete the new owner's lease (the deep-review runner's
      // lease release checks the same nonce).
      return () => {
        try {
          const owner = JSON.parse(fsImpl.readFileSync(ownerFile, "utf8"));
          if (owner?.nonce !== nonce) return;
          fsImpl.rmSync(lock, { recursive: true, force: true });
        } catch { /* owner already released/replaced */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      let ageMs = 0;
      try { owner = JSON.parse(fsImpl.readFileSync(ownerFile, "utf8")); } catch { /* creator may be writing it */ }
      try { ageMs = Date.now() - fsImpl.statSync(lock).mtimeMs; } catch { ageMs = Infinity; }
      const liveOwner = owner && ownerAlive(Number(owner.pid));
      const deadOwner = owner && !liveOwner;
      const abandonedWithoutOwner = !owner && ageMs > 2_000;
      // A legitimate multi-range review can exceed any fixed age ceiling (each range may run up to
      // the deep-review budget), so age alone never evicts a LIVE owner — only a dead owner's or
      // an unreadable owner record's lease is reclaimable by age.
      const impossiblyOldLease = !liveOwner && ageMs > 30 * 60 * 1000;
      if (deadOwner || abandonedWithoutOwner || impossiblyOldLease) {
        try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch { /* another process won */ }
        continue;
      }
      if (Date.now() >= deadline) {
        // A LIVE holder is not a crash and not a wedge: a review deliberately survives its push
        // command being timed-out/killed (its verdict is cached on completion), so the retry must
        // be told exactly what is happening and that waiting resolves it — not a generic "active".
        const busy = new Error(
          `another native push review for ${remoteUrl || remoteName || "this remote"} is already running` +
          `${owner?.pid ? ` (pid ${owner.pid}, ~${Math.max(1, Math.round(ageMs / 60_000))} min in)` : ""}`
        );
        busy.code = "BENCH_PUSH_REVIEW_IN_FLIGHT";
        busy.ownerPid = owner?.pid ?? null;
        busy.ageMs = ageMs;
        throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function reviewNativePushLocked({
  cwd,
  remoteName = "",
  remoteUrl = "",
  updates,
  env = process.env,
  runPushReviewImpl = defaultRunPushReview,
  gitImpl = gitTry,
  fsImpl = fs,
  now = Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cycleWindowMs = DEFAULT_CYCLE_WINDOW_MS
} = {}) {
  if (!cwd) throw new Error("reviewNativePush: missing cwd");
  if (!Array.isArray(updates)) throw new Error("reviewNativePush: updates must be an array");
  const config = resolveConfig({ env });
  const intendedReviewers = config.reviewers;
  const policy = nativePushPolicy(config, env);
  const identity = nativePushIdentity({ remoteName, remoteUrl, updates, reviewers: intendedReviewers, policy });
  const scope = nativePushScope({ remoteName, remoteUrl, updates });
  const maxCycles = policy.maxBlockCycles;
  const reset = consumeCycleReset(cwd, {
    gate: `native-push-${scope}`,
    value: env.BENCH_PUSH_CYCLE_RESET,
    fsImpl
  });
  const refresh = reset || ["1", "true", "yes", "on"].includes(String(env.BENCH_PUSH_REVIEW_REFRESH || "").toLowerCase());
  if (reset) clearCycle(cwd, scope, fsImpl);
  if (refresh) clearCache(cwd, identity, fsImpl);
  const cached = refresh ? null : readCache(cwd, identity, { now, ttlMs: cacheTtlMs, fsImpl });
  if (cached) {
    if (cached.decision === "allow") clearCycle(cwd, scope, fsImpl);
    return { ...cached, cached: true };
  }

  const hold = cycleHold(cwd, scope, { now, windowMs: cycleWindowMs, maxCycles, reset: false, fsImpl });
  if (hold) {
    const consolidated = (hold.findings || []).map((f, i) => `Cycle ${i + 1}:\n${f}`).join("\n\n");
    return {
      decision: "block", kind: "cycle-ceiling", cached: true, identity,
      summary: `automatic review ceiling reached after ${hold.count} blocked revisions`,
      findings: `${consolidated}\n\nFix the consolidated findings, then run the push once with a new BENCH_PUSH_CYCLE_RESET nonce to authorize a fresh verification. BENCH_NATIVE_PUSH_BYPASS=1 git push bypasses peerBench only; git push --no-verify bypasses every pre-push hook.`.trim()
    };
  }

  const doomed = pushPolicyDoomedByCooldowns(intendedReviewers, policy, { now });
  if (doomed) {
    return { decision: "unavailable", kind: "reviewer-cooldown", identity, reason: doomed };
  }

  const traceIds = [];
  const summaries = [];
  const blockers = [];
  const unavailable = [];
  const rangeGroups = new Map();
  let badge = "";
  for (const update of updates) {
    const resolved = resolveNativeUpdateRange(cwd, remoteName, update, { gitImpl });
    if (!resolved.ok) {
      unavailable.push(`[${updateLabel([update])}] ${resolved.reason}`);
      continue;
    }
    if (resolved.skip) continue;
    const group = rangeGroups.get(resolved.range) || {
      range: resolved.range,
      localCommit: resolved.localCommit,
      baseCommit: resolved.baseCommit,
      updates: []
    };
    group.updates.push(update);
    rangeGroups.set(resolved.range, group);
  }

  let rangeCacheHits = 0;
  for (const group of rangeGroups.values()) {
    const label = updateLabel(group.updates);
    // Only ask whether at least one commit is present; never capture an unbounded log merely to
    // distinguish an empty new-ref range. Existing refs still review an empty commit range because
    // a force rewind can change the remote tree.
    const [countRaw, countOk] = gitImpl(["rev-list", "--count", "--max-count=1", group.range], cwd);
    if (!countOk || !/^\d+$/.test(String(countRaw || "").trim())) {
      unavailable.push(`[${label}] git rev-list failed for ${group.range}`);
      continue;
    }
    if (Number(countRaw) === 0 && group.updates.every((update) => isZeroOid(update.remoteSha))) continue;

    const rangeIdentity = nativeRangeIdentity({
      remoteName, remoteUrl, range: group.range, reviewers: intendedReviewers, policy
    });
    if (refresh) clearRangeCache(cwd, rangeIdentity, fsImpl);
    let rangeResult = refresh ? null : readRangeCache(cwd, rangeIdentity, { now, ttlMs: cacheTtlMs, fsImpl });
    if (rangeResult) {
      rangeResult = { ...rangeResult, cached: true };
      rangeCacheHits++;
    } else {
      const review = await runPushReviewImpl(group.range, cwd, {
        env,
        targetCommit: group.localCommit,
        baseCommit: group.baseCommit
      });
      const evaluated = evaluatePushReview(review, intendedReviewers, env);
      if (review?.traceId) traceIds.push(review.traceId);
      badge = review?.badge || badge;
      if (evaluated.decision === "unavailable") {
        unavailable.push(`[${label}] ${evaluated.reason}`);
        continue;
      }
      if (evaluated.incomplete) {
        blockers.push(`[${label}]\n${evaluated.findings || evaluated.summary || "blocking issue"}`);
        const reviewerDetail = evaluated.failedReviewers?.length
          ? ` (${evaluated.failedReviewers.join(" | ")})`
          : "";
        unavailable.push(`[${label}] ${evaluated.unavailableReason}${reviewerDetail}`);
        continue;
      }
      const reviewerNote = evaluated.failedReviewers?.length
        ? `Reviewer unavailable (quorum still met): ${evaluated.failedReviewers.join(" | ")}`
        : "";
      rangeResult = {
        decision: evaluated.decision,
        findings: [evaluated.findings || "", reviewerNote].filter(Boolean).join("\n\n"),
        summary: [evaluated.summary || (evaluated.decision === "allow" ? "review quorum passed" : "blocking issue"), reviewerNote].filter(Boolean).join("; "),
        badge: evaluated.badge || review?.badge || "",
        traceIds: review?.traceId ? [review.traceId] : []
      };
      writeRangeCache(cwd, rangeIdentity, rangeResult, { now, fsImpl });
    }
    if (Array.isArray(rangeResult.traceIds)) traceIds.push(...rangeResult.traceIds.filter((id) => !traceIds.includes(id)));
    badge = rangeResult.badge || badge;
    if (rangeResult.decision === "block") {
      blockers.push(`[${label}]${rangeResult.cached ? " (cached exact range)" : ""}\n${rangeResult.findings || rangeResult.summary}`);
    } else {
      summaries.push(`${label}: ${rangeResult.summary}${rangeResult.cached ? " (cached exact range)" : ""}`);
    }
  }

  if (!blockers.length && unavailable.length) {
    const reason = unavailable.join(" | ").slice(0, MAX_STORED_FINDINGS);
    return {
      decision: "unavailable", identity, reason,
      summary: `${unavailable.length} pushed range(s) could not be verified`,
      findings: unavailable.join("\n\n"), traceIds, rangeCacheHits
    };
  }

  const partialUnavailable = blockers.length > 0 && unavailable.length > 0;
  const findings = [
    ...blockers,
    ...(partialUnavailable ? [`[REVIEW INCOMPLETE]\n${unavailable.join("\n")}`] : [])
  ].join("\n\n");
  const result = blockers.length
    ? {
      decision: "block", identity, findings,
      summary: `${blockers.length} exact pushed range(s) blocked${partialUnavailable ? `; ${unavailable.length} additional range(s) unavailable` : ""}`,
      badge, traceIds, partialUnavailable, unavailable, rangeCacheHits
    }
    : {
      decision: "allow", identity, findings: "",
      summary: summaries.join(" · ") || "no new commits to review",
      badge, traceIds, rangeCacheHits
    };
  // A partial transaction is never cached as a whole-set decision. Completed exact ranges have
  // already been cached independently, so the retry reruns only unavailable/changed ranges.
  if (!partialUnavailable) writeCache(cwd, identity, result, { now, fsImpl });
  if (result.decision === "block") {
    const state = recordBlockCycle(cwd, scope, identity, result, { now, windowMs: cycleWindowMs, maxCycles, fsImpl });
    result.cycle = state.count;
    result.maxCycles = maxCycles;
    if (state.count >= maxCycles) result.summary += `; automatic cycle ceiling ${state.count}/${maxCycles} reached`;
  } else {
    clearCycle(cwd, scope, fsImpl);
  }
  return result;
}

// Serialize all policy/cache/cycle state for one canonical remote. This is deliberately broader
// than an individual range: concurrent multi-ref pushes can share exact-range caches while using
// different ref-set scopes, so only a remote-wide transaction prevents stale ALLOW overwrites and
// lost block-cycle increments.
export async function reviewNativePush(options = {}) {
  const { cwd, remoteName = "", remoteUrl = "", updates, env = process.env, fsImpl = fs, nativeLockWaitMs = 5_000, now = Date.now(), cacheTtlMs = DEFAULT_CACHE_TTL_MS } = options;
  if (!cwd) throw new Error("reviewNativePush: missing cwd");
  let release;
  try {
    release = await acquireNativePushLock(cwd, remoteName, remoteUrl, fsImpl, nativeLockWaitMs);
  } catch (error) {
    if (error?.code !== "BENCH_PUSH_REVIEW_IN_FLIGHT") throw error;
    // The in-flight review may have JUST finished (or an identical push was already decided) —
    // its decision cache is readable without the lock, so a retry can complete instantly.
    try {
      const config = resolveConfig({ env });
      const policy = nativePushPolicy(config, env);
      const identity = nativePushIdentity({ remoteName, remoteUrl, updates, reviewers: config.reviewers, policy });
      const cached = readCache(cwd, identity, { now, ttlMs: cacheTtlMs, fsImpl });
      if (cached) return { ...cached, cached: true };
    } catch { /* fall through to the honest in-flight report */ }
    return {
      decision: "unavailable",
      kind: "review-in-flight",
      reason:
        `${error.message}. That review keeps working even if the push command that started it timed out, and its ` +
        "verdict is CACHED when it finishes — wait a minute, then retry the push (give the command a 5–10 min timeout " +
        "so the inline review can complete). BENCH_NATIVE_PUSH_BYPASS=1 git push is the explicit peerBench-only bypass."
    };
  }
  try {
    return await reviewNativePushLocked(options);
  } finally {
    release();
  }
}
