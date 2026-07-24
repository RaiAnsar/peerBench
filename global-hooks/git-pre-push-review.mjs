#!/usr/bin/env node
// Bounded native Git pre-push review. No queue, detached worker, retry wake, or shell parsing.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isBenchDisabled, workspaceStateDir } from "./config-store.mjs";
import { isMainModule } from "./is-main.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { resolveReviewers } from "./reviewers.mjs";
import { writeTrace } from "./trace-store.mjs";

export const PUSH_POLICY_VERSION = "lightweight-v2-exhaustive-commits";
export const MAX_PUSH_EVIDENCE_BYTES = 256 * 1024;
// The panel must actually fit inside this. At 45s it did not: MiMo exceeded 42s on 5 of 6
// successful real push reviews (40.8s–114.8s, traces 2026-07-24), so the gate timed MiMo out and
// silently degraded to Grok-only or "unreviewed". `git push` waits on this (a normal, Ctrl-C-able
// terminal wait — NOT the old PreToolUse freeze that made the session unusable).
export const PUSH_DEADLINE_MS = 150_000;
// Every budget message derives from the constant; a hardcoded duration goes stale the moment it moves.
const BUDGET = `${Math.round(PUSH_DEADLINE_MS / 1000)}-second`;
const ZERO_RE = /^0+$/;

function boundedTimeout(deadline, cap) {
  if (!Number.isFinite(deadline)) return cap;
  return Math.max(1, Math.min(cap, deadline - Date.now()));
}

function git(args, cwd, { timeout = 5_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync("git", ["--no-replace-objects", ...args], {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull },
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    };
  } catch (error) {
    return { ok: false, out: String(error?.stdout || "").trim(), error };
  }
}

function workspaceRoot(cwd, { deadline = Number.POSITIVE_INFINITY } = {}) {
  return git(["rev-parse", "--show-toplevel"], cwd, { timeout: boundedTimeout(deadline, 5_000) }).out || cwd;
}

export function parseUpdates(input) {
  const updates = [];
  for (const line of String(input || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return { ok: false, updates: [], reason: `invalid pre-push update tuple: ${line.slice(0, 120)}` };
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return { ok: true, updates };
}

function objectExists(sha, cwd, deadline = Number.POSITIVE_INFINITY) {
  return git(["cat-file", "-e", `${sha}^{commit}`], cwd, { timeout: boundedTimeout(deadline, 5_000) }).ok;
}

function commitForObject(sha, cwd, deadline = Number.POSITIVE_INFINITY) {
  const result = git(["rev-parse", "--verify", `${sha}^{commit}`], cwd, { timeout: boundedTimeout(deadline, 5_000) });
  return result.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(result.out) ? result.out.toLowerCase() : null;
}

function ancestor(base, tip, cwd, deadline = Number.POSITIVE_INFINITY) {
  return git(["merge-base", "--is-ancestor", base, tip], cwd, { timeout: boundedTimeout(deadline, 5_000) }).ok;
}

function distance(base, tip, cwd, deadline = Number.POSITIVE_INFINITY) {
  const result = git(["rev-list", "--count", `${base}..${tip}`], cwd, { timeout: boundedTimeout(deadline, 5_000) });
  return result.ok ? Number(result.out) : Number.POSITIVE_INFINITY;
}

export function advertisedHeads(remote, cwd, { gitImpl = git, deadline = Number.POSITIVE_INFINITY } = {}) {
  const result = gitImpl(["ls-remote", "--heads", remote], cwd, { timeout: boundedTimeout(deadline, 5_000), maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return { ok: false, shas: [], reason: "could not read advertised remote heads" };
  const shas = [...new Set(result.out.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean))];
  return { ok: true, shas };
}

export function resolveUpdateBase(update, remote, cwd, { advertisedHeadsImpl = advertisedHeads, deadline = Number.POSITIVE_INFINITY } = {}) {
  if (Date.now() >= deadline) return { ok: false, reason: `${BUDGET} budget reached before range resolution` };
  if (ZERO_RE.test(update.localSha)) return { ok: false, deleteOnly: true };
  const localCommit = commitForObject(update.localSha, cwd, deadline);
  if (!localCommit) return { ok: false, reason: "local update target does not resolve to a commit; no code review was attempted" };
  if (!ZERO_RE.test(update.remoteSha)) {
    const remoteCommit = commitForObject(update.remoteSha, cwd, deadline);
    if (!remoteCommit) return { ok: false, reason: "remote destination does not resolve to a locally available commit; fetch and retry" };
    return { ok: true, base: remoteCommit, localCommit, kind: "existing" };
  }

  const advertised = advertisedHeadsImpl(remote, cwd, { deadline });
  if (!advertised.ok) return { ok: false, reason: `${advertised.reason}; fetch and retry` };
  if (!advertised.shas.length) {
    const empty = git(["hash-object", "-t", "tree", "/dev/null"], cwd, { timeout: boundedTimeout(deadline, 5_000) });
    return empty.ok ? { ok: true, base: empty.out, localCommit, kind: "empty-remote" } : { ok: false, reason: "could not resolve Git empty tree" };
  }

  const candidates = [];
  let missing = 0;
  for (const sha of advertised.shas) {
    if (Date.now() >= deadline) return { ok: false, reason: `${BUDGET} budget reached while resolving advertised heads` };
    if (!objectExists(sha, cwd, deadline)) { missing += 1; continue; }
    if (ancestor(sha, localCommit, cwd, deadline)) {
      candidates.push({ sha, distance: distance(sha, localCommit, cwd, deadline) });
      continue;
    }
    const merged = git(["merge-base", sha, localCommit], cwd, { timeout: boundedTimeout(deadline, 5_000) });
    if (merged.ok && merged.out) candidates.push({ sha: merged.out, distance: distance(merged.out, localCommit, cwd, deadline) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  if (candidates.length) return { ok: true, base: candidates[0].sha, localCommit, kind: "new-branch" };
  return {
    ok: false,
    reason: missing
      ? "remote is non-empty but its advertised commits are not available locally; git fetch --prune and retry"
      : "remote is non-empty but no common ancestor could be proven; review manually"
  };
}

export function buildPushEvidence(update, base, cwd, { deadline = Number.POSITIVE_INFINITY } = {}) {
  if (Date.now() >= deadline) return { ok: false, reason: `${BUDGET} budget reached before evidence collection` };
  // Review every outgoing commit's patch, not only the base-to-tip net diff. A file introduced in
  // one commit and removed in the next is still transferred to the remote object database and must
  // remain visible to the reviewers. These flags also bypass attributes, textconv, external diff,
  // and rename folding so repository-controlled presentation cannot hide the actual changed bytes.
  const baseType = git(["cat-file", "-t", base], cwd, { timeout: boundedTimeout(deadline, 5_000) });
  if (!baseType.ok || !["commit", "tree"].includes(baseType.out)) {
    return { ok: false, reason: "could not resolve outgoing history base" };
  }
  const tip = update.localCommit || update.localSha;
  if (baseType.out === "commit" && !ancestor(base, tip, cwd, deadline)) {
    return {
      ok: false,
      reason: "non-fast-forward update is not covered by bounded per-commit evidence; inspect the dropped history and force-push manually"
    };
  }
  const revision = baseType.out === "commit" ? `${base}..${tip}` : tip;
  const history = spawnSync("git", [
    "--no-replace-objects",
    "log",
    "--reverse",
    "--topo-order",
    "--format=%ncommit %H%nparents %P%nauthor %an <%ae>%nsubject %s",
    "--patch",
    "--root",
    "--full-diff",
    "--diff-merges=first-parent",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--no-renames",
    "--full-index",
    revision
  ], {
    cwd,
    timeout: boundedTimeout(deadline, 10_000),
    maxBuffer: MAX_PUSH_EVIDENCE_BYTES + 4096,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull }
  });
  const raw = Buffer.isBuffer(history.stdout) ? history.stdout : Buffer.from(history.stdout || "");
  if (history.error?.code === "ENOBUFS" || raw.byteLength > MAX_PUSH_EVIDENCE_BYTES) {
    return { ok: false, tooLarge: true, reason: "evidence too large" };
  }
  if (history.status !== 0) return { ok: false, reason: "could not read outgoing commit history" };
  if (raw.includes(0)) return { ok: false, reason: "outgoing history contains binary data that cannot be represented safely" };
  let rendered;
  try { rendered = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { return { ok: false, reason: "outgoing history contains non-UTF-8 data that cannot be represented safely" }; }
  const system =
    "Review this exact outgoing Git update using only the supplied per-commit history. Do not use tools. " +
    "First line must be `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for a concrete bug, " +
    "regression, security issue, or unsafe change that should prevent this push.";
  const user = [
    `<update local_ref="${update.localRef}" remote_ref="${update.remoteRef}" local_object="${update.localSha}" local_commit="${tip}">`,
    "<per_commit_history>", rendered || "(no outgoing commits)", "</per_commit_history>",
    "</update>"
  ].join("\n");
  const bytes = Buffer.byteLength(`${system}\n${user}`);
  if (bytes > MAX_PUSH_EVIDENCE_BYTES) return { ok: false, tooLarge: true, reason: "evidence too large", bytes };
  return {
    ok: true,
    system,
    user,
    bytes,
    evidenceHash: createHash("sha256").update(system).update("\0").update(user).digest("hex")
  };
}

function cachePath(ws, fingerprint) {
  return path.join(workspaceStateDir(ws), "push-cache", `${fingerprint}.json`);
}

function lockPath(ws, fingerprint) {
  return `${cachePath(ws, fingerprint)}.lock`;
}

function readCache(ws, fingerprint) {
  try { return JSON.parse(fs.readFileSync(cachePath(ws, fingerprint), "utf8")); } catch { return null; }
}

function writeCache(ws, fingerprint, value) {
  try {
    const file = cachePath(ws, fingerprint);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* cache is optional */ }
}

function acquireReviewLock(ws, fingerprint, { now = Date.now(), staleAfterMs = PUSH_DEADLINE_MS + 5_000 } = {}) {
  const file = lockPath(ws, fingerprint);
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch { /* cache is optional */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid} ${now}\n`);
      return {
        acquired: true,
        release() {
          try { fs.closeSync(fd); } catch { /* already closed */ }
          try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") return { acquired: true, release() {} };
      try {
        if (now - fs.statSync(file).mtimeMs > staleAfterMs) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch { continue; }
      return { acquired: false, release() {} };
    }
  }
  return { acquired: false, release() {} };
}

async function waitForConcurrentReview(ws, fingerprint, deadline, { pollMs = 25 } = {}) {
  while (Date.now() < deadline) {
    const cached = readCache(ws, fingerprint);
    const results = (Array.isArray(cached?.results) ? cached.results : []).filter(validVerdict);
    if (results.length) return { results, completed: true };
    try {
      if (!fs.existsSync(lockPath(ws, fingerprint))) return { results: [], completed: true };
    } catch { return { results: [], completed: true }; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  return { results: [], completed: false };
}

function fingerprintFor(update, base, evidence, reviewers, remote) {
  const identities = reviewers.map((reviewer) => reviewer.reviewIdentity || reviewer.name);
  return createHash("sha256").update(JSON.stringify({
    policy: PUSH_POLICY_VERSION,
    remote: String(remote || ""),
    localRef: update.localRef,
    remoteRef: update.remoteRef,
    localSha: update.localSha,
    remoteSha: update.remoteSha,
    base,
    evidenceHash: evidence.evidenceHash,
    reviewers: identities
  })).digest("hex");
}

const validVerdict = (result) => result?.verdict === "ALLOW" || result?.verdict === "BLOCK";

export async function reviewUpdate(update, remote, ws, {
  resolveReviewersImpl = resolveReviewers,
  resolveUpdateBaseImpl = resolveUpdateBase,
  buildPushEvidenceImpl = buildPushEvidence,
  writeTraceImpl = writeTrace,
  env = process.env,
  deadline = Date.now() + PUSH_DEADLINE_MS
} = {}) {
  if (Date.now() >= deadline) return { decision: "unreviewed", note: `${BUDGET} budget reached before range resolution` };
  const resolved = resolveUpdateBaseImpl(update, remote, ws, { deadline });
  if (resolved.deleteOnly) return { decision: "allow", note: "branch deletion; no outgoing code" };
  if (!resolved.ok) return { decision: "unreviewed", note: resolved.reason };
  if (Date.now() >= deadline) return { decision: "unreviewed", note: `${BUDGET} budget reached before evidence collection` };
  const evidence = buildPushEvidenceImpl({ ...update, localCommit: resolved.localCommit }, resolved.base, ws, { deadline });
  if (!evidence.ok) return { decision: "unreviewed", note: evidence.tooLarge ? "evidence too large; split the push or run /bench:review manually" : evidence.reason };

  // Use the CONFIGURED panel. A hardcoded list took precedence over companion.json in resolveConfig,
  // so `/bench:reviewers mimo` still invoked Grok on every push — spending time (and failing loudly
  // off darwin, where the Grok runners refuse) on a reviewer the user had deliberately switched off.
  const reviewers = resolveReviewersImpl({ env });
  const fingerprint = fingerprintFor(update, resolved.base, evidence, reviewers, remote);
  const cached = readCache(ws, fingerprint);
  const cachedResults = Array.isArray(cached?.results) ? cached.results.filter(validVerdict) : [];
  if (cachedResults.some((result) => result.verdict === "BLOCK")) {
    return { decision: "block", panel: combinePanel(cachedResults), cached: true, fingerprint };
  }
  if (cachedResults.length) {
    return { decision: "allow", panel: combinePanel(cachedResults), cached: true, fingerprint };
  }

  const lock = acquireReviewLock(ws, fingerprint);
  if (!lock.acquired) {
    const waited = await waitForConcurrentReview(ws, fingerprint, deadline);
    if (waited.results.some((result) => result.verdict === "BLOCK")) {
      return { decision: "block", panel: combinePanel(waited.results), cached: true, fingerprint };
    }
    if (waited.results.length) {
      return { decision: "allow", panel: combinePanel(waited.results), cached: true, fingerprint };
    }
    return {
      decision: "unreviewed",
      note: waited.completed
        ? "identical review finished without a usable verdict; duplicate model calls skipped"
        : `${BUDGET} budget reached while waiting for the identical review; duplicate model calls skipped`,
      fingerprint
    };
  }

  try {
    // Another process may have completed between our first cache read and lock acquisition.
    // Re-check under the lock so that race never spends a second panel call.
    const racedCache = readCache(ws, fingerprint);
    const racedResults = (Array.isArray(racedCache?.results) ? racedCache.results : []).filter(validVerdict);
    if (racedResults.some((result) => result.verdict === "BLOCK")) {
      return { decision: "block", panel: combinePanel(racedResults), cached: true, fingerprint };
    }
    if (racedResults.length) {
      return { decision: "allow", panel: combinePanel(racedResults), cached: true, fingerprint };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { decision: "unreviewed", note: `${BUDGET} review budget already exhausted`, fingerprint };
    const results = await Promise.all(reviewers.map((reviewer) => reviewer.run({
      system: evidence.system,
      user: evidence.user,
      cwd: ws,
      env,
      timeoutMs: remaining,
      cooldownScope: `push:${ws}`
    })));
    const valid = results.filter(validVerdict);
    if (valid.length) writeCache(ws, fingerprint, { ts: Date.now(), results: valid });
    const panel = combinePanel(results);

    try {
      writeTraceImpl(ws, {
        gate: "push",
        ws,
        reviewers: results.map(({ raw: _raw, ...result }) => result),
        rawResponses: Object.fromEntries(results.map((result) => [result.name, result.firstLine || result.error || ""])),
        fingerprint
      });
    } catch { /* optional */ }

    if (!valid.length) return { decision: "unreviewed", panel, note: panel.summary, fingerprint };
    return { decision: panel.decision === "block" ? "block" : "allow", panel, fingerprint };
  } finally {
    lock.release();
  }
}

export async function runMain({
  cwd = process.cwd(),
  remote = process.argv[2] || "origin",
  input = fs.readFileSync(0, "utf8"),
  isBenchDisabledImpl = isBenchDisabled,
  reviewUpdateImpl = reviewUpdate,
  env = process.env
} = {}) {
  const deadline = Date.now() + PUSH_DEADLINE_MS;
  const ws = workspaceRoot(cwd, { deadline });
  if (isBenchDisabledImpl(ws)) return 0;
  const parsed = parseUpdates(input);
  if (!parsed.ok) {
    process.stderr.write(`peerBench UNREVIEWED: ${parsed.reason}; push allowed.\n`);
    return 0;
  }
  for (const update of parsed.updates) {
    if (Date.now() >= deadline) {
      process.stderr.write(`peerBench UNREVIEWED: ${BUDGET} total budget reached; remaining updates were not reviewed. Push allowed.\n`);
      return 0;
    }
    const result = await reviewUpdateImpl(update, remote, ws, { env, deadline });
    if (result.decision === "block") {
      process.stderr.write(`peerBench BLOCK [${result.panel?.badge || "?"}]:\n${result.panel?.findings || result.panel?.summary || "reviewer blocked this push"}\n`);
      return 1;
    }
    if (result.decision === "unreviewed") {
      process.stderr.write(`peerBench UNREVIEWED: ${result.note || "review unavailable"}; push allowed.\n`);
    } else if (result.panel) {
      process.stderr.write(`peerBench ALLOW [${result.panel.badge}]${result.cached ? " (cached)" : ""}.\n`);
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`peerBench UNREVIEWED: ${BUDGET} total budget reached; remaining updates were not reviewed. Push allowed.\n`);
      return 0;
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  runMain().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`peerBench UNREVIEWED: ${error instanceof Error ? error.message : String(error)}; push allowed.\n`);
    process.exitCode = 0;
  });
}
