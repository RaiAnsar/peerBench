#!/usr/bin/env node
// global-hooks/stop-review.mjs
// Stop hook: review the turn's code diff with the configured non-Codex panel,
// content-only (no tools). On BLOCK: write findings to stderr + exit 2 (asyncRewake).
// On ALLOW: emit systemMessage + exit 0. Fails OPEN on any error.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { combinePanel, untrackedSnapshot } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled, normalizeSessionId, sessionKeyFromInput, workspaceStateDir, readReviewedHead, writeReviewedHead } from "./config-store.mjs";
export { readReviewedHead, writeReviewedHead };   // re-exported so tests + siblings share one impl
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { consumeCycleReset } from "./cycle-reset.mjs";

const MAX_DIFF_BYTES = 200_000;
const MAX_SYNTHESIS_PROMPT_BYTES = 120_000;
const MAX_STOP_LOOPS = 3;                  // hard cap on automatic BLOCK repair cycles in one task/session
export const STOP_REVIEW_POLICY_VERSION = "stop-review-v3-exhaustive-cycle3";
const STOP_LOCK_STALE_MS = 10 * 60 * 1000;
const STOP_LOCK_ORPHAN_GRACE_MS = 1_000;
const STOP_LOCK_POLL_MS = 25;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir, owner) {
  const target = path.join(lockDir, "owner.json");
  const temporary = path.join(lockDir, `.owner-${owner.token}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function writeStateJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* renamed or best-effort cleanup */ }
  }
}

function tryReclaimLock(lockDir, token) {
  const quarantine = `${lockDir}.reclaim-${process.pid}-${token}`;
  try {
    fs.renameSync(lockDir, quarantine);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
  try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { /* next waiter can ignore quarantine */ }
  return true;
}

// Serialize the whole Stop snapshot/review/commit transaction across processes. Keeping snapshot
// capture inside the lock is intentional: a delayed ALLOW can never commit after a concurrent
// BLOCK that it did not observe. Atomic mkdir supplies ownership; dead owners are reclaimed
// immediately, ownerless create-crashes after a short grace, and a heartbeat plus stale cutoff
// prevents abandoned/PID-reused locks from wedging Stop indefinitely.
export async function acquireStopGateLock(ws, {
  staleMs = STOP_LOCK_STALE_MS,
  orphanGraceMs = STOP_LOCK_ORPHAN_GRACE_MS,
  pollMs = STOP_LOCK_POLL_MS,
  now = () => Date.now()
} = {}) {
  const stateDir = workspaceStateDir(ws);
  const lockDir = path.join(stateDir, "stop-review.lock");
  const token = randomUUID();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const owner = { schema: 1, pid: process.pid, token, startedAt: now(), heartbeatAt: now() };
      writeLockOwner(lockDir, owner);
      let released = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        try {
          const current = readLockOwner(lockDir);
          if (current?.token !== token) return;
          writeLockOwner(lockDir, { ...current, heartbeatAt: now() });
        } catch { /* ownership is rechecked during release */ }
      }, Math.max(100, Math.min(5_000, Math.floor(staleMs / 3))));
      heartbeat.unref?.();

      return () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          if (readLockOwner(lockDir)?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
        } catch { /* stale recovery handles an interrupted release */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let stat = null;
    try { stat = fs.statSync(lockDir); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const owner = readLockOwner(lockDir);
    const observedAt = Number(owner?.heartbeatAt || owner?.startedAt || stat.mtimeMs || 0);
    const age = Math.max(0, now() - observedAt);
    const ownerDead = owner && !pidIsAlive(Number(owner.pid));
    const ownerlessStale = !owner && age >= orphanGraceMs;
    const heartbeatStale = age >= staleMs;
    if (ownerDead || ownerlessStale || heartbeatStale) {
      if (tryReclaimLock(lockDir, token)) continue;
    }
    await delay(Math.max(1, pollMs));
  }
}

function reviewerIdentity(reviewer) {
  const supplied = reviewer?.reviewIdentity;
  return {
    name: String(reviewer?.name || "").toLowerCase(),
    kind: String(supplied?.kind || reviewer?.kind || "reviewer"),
    model: String(supplied?.model ?? reviewer?.model ?? ""),
    baseURL: String(supplied?.baseURL ?? reviewer?.baseURL ?? ""),
    thinking: supplied?.thinking ?? reviewer?.thinking ?? null,
    temperature: supplied?.temperature ?? reviewer?.temperature ?? null
  };
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ bench stop: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function emptyGitSnapshot() {
  return {
    ok: true,
    text: "",
    totalBytes: 0,
    truncated: false,
    fingerprint: createHash("sha256").update("").digest("hex"),
    error: ""
  };
}

// Stream git output so snapshot identity covers arbitrarily large diffs without retaining them in
// memory. Only a bounded prefix enters reviewer prompts; a truncated/error result is explicit and is
// handled as a visible coverage block below, never as an empty/clean diff.
export function captureGitSnapshot(args, cwd, { maxPromptBytes = MAX_DIFF_BYTES } = {}) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const chunks = [];
    let captured = 0;
    let totalBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (ok, error = "") => {
      if (settled) return;
      settled = true;
      resolve({
        ok,
        text: Buffer.concat(chunks, captured).toString("utf8"),
        totalBytes,
        truncated: totalBytes > maxPromptBytes,
        fingerprint: hash.digest("hex"),
        error: ok ? "" : String(error || stderr || "git command failed").trim().slice(0, 500)
      });
    };

    let child;
    try { child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(false, error instanceof Error ? error.message : String(error)); return; }

    child.stdout.on("data", (data) => {
      if (settled) return;
      const buf = Buffer.from(data);
      totalBytes += buf.length;
      hash.update(buf);
      if (captured < maxPromptBytes) {
        const take = Math.min(buf.length, maxPromptBytes - captured);
        chunks.push(Buffer.from(buf.subarray(0, take)));
        captured += take;
      }
    });
    child.stderr.on("data", (data) => {
      if (settled) return;
      if (stderr.length < 4000) stderr += String(data).slice(0, 4000 - stderr.length);
    });
    child.on("error", (error) => finish(false, error instanceof Error ? error.message : String(error)));
    child.on("close", (code) => finish(code === 0, code === 0 ? "" : `git exited ${code}: ${stderr}`));
  });
}

function promptText(snapshot, label) {
  if (!snapshot) return "";
  return snapshot.truncated
    ? `${snapshot.text}\n\n[… ${label} truncated after ${MAX_DIFF_BYTES} bytes; full output was ${snapshot.totalBytes} bytes …]`
    : snapshot.text;
}

function snapshotIdentity(snapshot) {
  return snapshot ? `${snapshot.ok ? "ok" : "error"}:${snapshot.totalBytes}:${snapshot.fingerprint}` : "none";
}

// --- reviewed-head marker (helpers live in config-store, shared with the pre-push gate) -------
// The last HEAD this gate stop-reviewed up to. WITHOUT this, a turn that COMMITS its work leaves
// an empty `git diff HEAD`, so the gate's no-diff early-return fires and the committed changes
// escape review entirely — a session that commits 50 things gets ZERO review (the VisualSentinel
// gap). With it, every change is reviewed exactly once: committed-this-session AND uncommitted.
// The pre-push gate bootstraps the marker on the first `git` command (before any commit) so even
// committed-AND-pushed work is reviewed on the first stop (where @{upstream} has already advanced).
//
// The base commit to diff HEAD against = "everything not yet reviewed". Prefer the last-reviewed
// marker when it is a valid ANCESTOR of HEAD; else fall back to the upstream (unpushed commits) so
// even the FIRST stop of a session that committed-but-didn't-push is reviewed; else HEAD (review
// the working tree only — first run with no upstream, or a rebase that orphaned the marker).
export function resolveReviewBase(ws, curHead, gitImpl = git) {
  if (!curHead) return "";
  const last = readReviewedHead(ws);
  if (last === curHead) return curHead;                          // already reviewed up to HEAD
  if (last) {
    const mb = gitImpl(["merge-base", last, curHead], ws).trim();
    if (mb === last) return last;                                // marker is an ancestor → diff since it
  }
  const up = gitImpl(["rev-parse", "--verify", "--quiet", "@{upstream}"], ws).trim();
  if (up) {
    const mb = gitImpl(["merge-base", up, curHead], ws).trim();
    if (mb && mb !== curHead) return mb;                         // unpushed commits
  }
  return curHead;                                                // nothing better → working tree only
}

const REVIEWED_WORKTREE = (ws, sessionKey = null) => {
  const normalized = normalizeSessionId(sessionKey);
  return path.join(workspaceStateDir(ws), normalized ? `reviewed-worktree.${normalized}` : "reviewed-worktree");
};

export function reviewFingerprint({ scope = "review", policy = STOP_REVIEW_POLICY_VERSION, status = "", base = "", curHead = "", committed = "", diff = "", staged = "", untracked = "", reviewers = [] } = {}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 3, scope, policy, status, base, curHead, committed, diff, staged, untracked, reviewers }))
    .digest("hex");
}

export function readReviewedWorktree(ws, sessionKey = null) {
  return readReviewedWorktreeRecord(ws, sessionKey)?.fingerprint || null;
}

function readReviewedWorktreeRecord(ws, sessionKey = null) {
  try {
    const raw = fs.readFileSync(REVIEWED_WORKTREE(ws, sessionKey), "utf8").trim();
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      if (record?.schema === 2 && record.fingerprint && record.generation) return record;
    } catch { /* legacy plain-fingerprint marker */ }
    return {
      schema: 1,
      fingerprint: raw,
      generation: `legacy-${createHash("sha256").update(raw).digest("hex")}`
    };
  } catch {
    return null;
  }
}

export function writeReviewedWorktree(ws, fingerprint, sessionKey = null) {
  if (!fingerprint) return;
  try {
    fs.mkdirSync(workspaceStateDir(ws), { recursive: true });
    const target = REVIEWED_WORKTREE(ws, sessionKey);
    const generation = randomUUID();
    const temporary = `${target}.tmp-${process.pid}-${generation}`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      schema: 2,
      fingerprint,
      generation,
      ts: Date.now()
    })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch { /* best-effort marker */ }
}

export function clearReviewedWorktree(ws, sessionKey = null) {
  try { fs.rmSync(REVIEWED_WORKTREE(ws, sessionKey), { force: true }); } catch { /* best-effort marker */ }
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST line on stdout, so a second
// stdout emit in the same invocation is silently dropped. MUST be created per runMain invocation: a
// module-level flag would suppress later invocations in the same process and break the suite. The
// BLOCK path uses stderr + exit 2 (NOT stdout) and is unaffected.
export function createEmitter() {
  let emitted = false;
  return {
    hasEmitted: () => emitted,
    emit(payload) {
      if (emitted) return false;
      emitted = true;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return true;
    }
  };
}

export function buildPrompt(status, diff, untracked, lastMsg, staged = "", committed = "", {
  agentName = "Claude",
  chunkIndex = 0,
  chunkCount = 1
} = {}) {
  const turnLabel = agentName ? `${agentName} turn` : "agent turn";
  const chunkGuidance = chunkCount > 1
    ? ` This is bounded evidence chunk ${chunkIndex + 1}/${chunkCount}. Independent chunk calls do not share memory. ` +
      "After the verdict, include a concise `SYNTHESIS NOTES:` handoff (at most 1500 characters) naming changed paths/symbols/contracts, imports or callers, assumptions, and cross-file risks from this chunk. Include it even on ALLOW so a final synthesis pass can check relationships across chunks."
    : "";
  const system =
    `You are reviewing the code changes from a ${turnLabel}. Review based ONLY on the content ` +
    "provided in this message. Do NOT use any tools or explore the filesystem. " +
    "Changes may be ALREADY COMMITTED this session (<committed_diff>) and/or UNCOMMITTED in the " +
    "working tree (<git_diff>/<staged_diff>) — review ALL of them. Treat the git status, diffs, " +
    "and untracked file contents as the authoritative review target. The previous assistant " +
    "message is only context; never use a status/setup/chatty tail message to skip non-empty " +
    "repository changes. Complete one exhaustive pass over everything supplied before deciding; " +
    "never stop after the first blocker, and enumerate every concrete blocking manifestation you find. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. " +
    "BLOCK only if there is a concrete bug, regression, or unsafe change that should be fixed " +
    `before the session ends; otherwise ALLOW (minor notes may follow the first line).${chunkGuidance}`;
  const user = [
    "<git_status>",
    status,
    "</git_status>",
    "",
    "<committed_diff>",
    committed,
    "</committed_diff>",
    "",
    "<git_diff>",
    diff,
    "</git_diff>",
    "",
    "<staged_diff>",
    staged,
    "</staged_diff>",
    "",
    "<untracked_files>",
    untracked,
    "</untracked_files>",
    "",
    "<previous_assistant_message_context>",
    lastMsg,
    "</previous_assistant_message_context>"
  ].join("\n");
  return { system, user };
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Prefix(bytes, maxBytes) {
  for (let end = Math.min(bytes.length, Math.max(0, maxBytes)); end >= 0; end--) {
    try { return STRICT_UTF8_DECODER.decode(bytes.subarray(0, end)); } catch { /* trim a partial code point */ }
  }
  return "";
}

function decodeUtf8Suffix(bytes, maxBytes) {
  const initial = Math.max(0, bytes.length - Math.max(0, maxBytes));
  for (let start = initial; start <= bytes.length; start++) {
    try { return STRICT_UTF8_DECODER.decode(bytes.subarray(start)); } catch { /* trim a partial code point */ }
  }
  return "";
}

function boundedHeadTail(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ""));
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  const marker = Buffer.from("\n\n[… bounded synthesis excerpt omitted middle bytes …]\n\n");
  if (maxBytes <= marker.length) return decodeUtf8Prefix(bytes, maxBytes);
  const remaining = maxBytes - marker.length;
  const headBytes = Math.ceil(remaining / 2);
  const tailBytes = Math.floor(remaining / 2);
  return decodeUtf8Prefix(bytes, headBytes) + marker.toString("utf8") + decodeUtf8Suffix(bytes, tailBytes);
}

function buildSynthesisPrompt(prompts, chunkResults) {
  // The final call is a map/reduce synthesis, not a hidden unbounded third review. It receives a
  // bounded head+tail source excerpt plus each chunk reviewer's requested handoff. That gives one
  // stateless model call a coherent view of cross-file relationships while keeping total evidence
  // below the ordinary Stop diff budget.
  const usableBytes = Math.max(1, MAX_SYNTHESIS_PROMPT_BYTES - 8_000);
  const perChunkBytes = Math.max(1, Math.floor(usableBytes / Math.max(1, prompts.length)));
  const sourceBytes = Math.max(1, Math.floor(perChunkBytes * 0.6));
  const reviewBytes = Math.max(1, perChunkBytes - sourceBytes);
  const sections = prompts.map((prompt, index) => {
    const result = chunkResults[index]?.result;
    const source = boundedHeadTail(prompt.user, sourceBytes);
    const review = boundedHeadTail(result?.raw || result?.firstLine || result?.error || "(empty reviewer result)", reviewBytes);
    return [
      `<bounded_chunk index="${index + 1}" total="${prompts.length}">`,
      "<source_excerpt>", source, "</source_excerpt>",
      "<chunk_review_and_handoff>", review, "</chunk_review_and_handoff>",
      "</bounded_chunk>"
    ].join("\n");
  });
  const system =
    "You are the final synthesis pass for one code-review snapshot that was split into bounded, independent calls. " +
    "Review ONLY the supplied excerpts and chunk-review handoffs; do not use tools. Check interactions across chunks: " +
    "callers versus contracts, imports versus exports, shared state, ordering, configuration, migrations, and assumptions. " +
    "Any concrete blocker reported by a chunk remains a blocker, and you must add every concrete cross-chunk blocker you can verify. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. ALLOW only when the chunk results and their relationships contain no concrete blocking bug.";
  const user = boundedHeadTail([
    `<bounded_review_synthesis chunks="${prompts.length}">`,
    ...sections,
    "</bounded_review_synthesis>"
  ].join("\n\n"), MAX_SYNTHESIS_PROMPT_BYTES);
  return { system, user };
}

const verdictOf = (result) => String(result?.verdict || "").toUpperCase();

// Keep each reviewer call bounded while still covering every untracked chunk in this one Stop
// invocation. Chunk calls are stateless, so a multi-chunk review gets exactly ONE additional bounded
// synthesis call per reviewer. Any BLOCK from a chunk or synthesis wins; a missed chunk/synthesis
// makes that reviewer unavailable rather than crediting partial coverage.
export async function reviewPromptChunks(reviewers, prompts, { cwd, env } = {}) {
  if (!prompts.length) {
    return reviewers.map((reviewer) => ({ name: reviewer.name, error: "no bounded review prompts were supplied", raw: "" }));
  }
  return Promise.all(reviewers.map(async (reviewer) => {
    const chunkResults = [];
    for (let index = 0; index < prompts.length; index++) {
      const prompt = prompts[index];
      try {
        const result = await reviewer.run({ system: prompt.system, user: prompt.user, cwd, env });
        chunkResults.push({ index, result: result || { name: reviewer.name, error: "empty reviewer result" } });
      } catch (error) {
        chunkResults.push({
          index,
          result: { name: reviewer.name, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }

    let synthesis = null;
    let synthesisPrompt = null;
    if (prompts.length > 1) {
      synthesisPrompt = buildSynthesisPrompt(prompts, chunkResults);
      try {
        const result = await reviewer.run({
          system: synthesisPrompt.system,
          user: synthesisPrompt.user,
          cwd,
          env
        });
        synthesis = { result: result || { name: reviewer.name, error: "empty synthesis result" } };
      } catch (error) {
        synthesis = {
          result: { name: reviewer.name, error: error instanceof Error ? error.message : String(error) }
        };
      }
    }

    const displayName = chunkResults.find((entry) => entry.result?.name)?.result?.name
      || synthesis?.result?.name
      || reviewer.name;
    const blocks = chunkResults.filter((entry) => verdictOf(entry.result) === "BLOCK" && !entry.result?.error);
    if (synthesis && verdictOf(synthesis.result) === "BLOCK" && !synthesis.result?.error) blocks.push(synthesis);
    const chunkRaw = chunkResults.map(({ index, result }) =>
      `--- review chunk ${index + 1}/${prompts.length} ---\n${result?.raw || result?.firstLine || result?.error || "(empty)"}`
    ).join("\n\n");
    const raw = synthesis
      ? `${chunkRaw}\n\n--- cross-chunk synthesis ---\n${synthesis.result?.raw || synthesis.result?.firstLine || synthesis.result?.error || "(empty)"}`
      : chunkRaw;
    if (blocks.length) {
      return {
        ...blocks[0].result,
        name: displayName,
        verdict: "BLOCK",
        firstLine: blocks[0].result.firstLine || "BLOCK: blocking issue found in a bounded review chunk",
        raw,
        synthesisPrompt
      };
    }

    const failed = chunkResults.find(({ result }) =>
      result?.error || !["ALLOW", "BLOCK"].includes(verdictOf(result)));
    const synthesisFailed = synthesis && (synthesis.result?.error || !["ALLOW", "BLOCK"].includes(verdictOf(synthesis.result)));
    if (failed) {
      return {
        name: displayName,
        error: `chunk ${failed.index + 1}/${prompts.length}: ${failed.result?.error || "unparseable verdict"}`,
        raw,
        synthesisPrompt
      };
    }
    if (synthesisFailed) {
      return {
        name: displayName,
        error: `cross-chunk synthesis: ${synthesis.result?.error || "unparseable verdict"}`,
        raw,
        synthesisPrompt
      };
    }

    return {
      ...(synthesis?.result || chunkResults[0].result),
      name: displayName,
      verdict: "ALLOW",
      firstLine: synthesis?.result?.firstLine || `ALLOW: reviewed all ${prompts.length} bounded chunk(s)`,
      raw,
      synthesisPrompt
    };
  }));
}

const STOP_BLOCK_EXIT = Symbol("stop-block-exit");

async function runMainLocked({
  resolveReviewersImpl = defaultResolveReviewers,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  agentName = "Claude",
  blockHandler = null,
  lockContext = null
} = {}) {
  // FIX 5 — ALL stdout emits in this invocation (the surfaced deep note AND every runMain
  // emit below) route through one emit-once guard so only the FIRST line reaches the harness.
  const emit = (obj) => emitter.emit(obj);
  const input = inputOverride ?? readInput();
  const cwd = lockContext?.cwd || input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = lockContext?.ws || workspaceRoot(cwd);
  const sessionKey = lockContext?.sessionKey ?? sessionKeyFromInput(input, env);

  // (Deep spec/push review delivery now lives in deep-review-runner.mjs — a separate asyncRewake
  // Stop hook — so this gate only reviews the turn's own diff.)

  // Loop protection is session-scoped. `stop_hook_active` is shared across every Stop hook, so it is
  // never a safe key; the durable counter below spans changed repair revisions in this task window.
  const loopFile = path.join(workspaceStateDir(ws), sessionKey ? `stop-loop.${sessionKey}` : "stop-loop");
  const coverageFile = path.join(workspaceStateDir(ws), sessionKey ? `stop-coverage.${sessionKey}` : "stop-coverage");
  const cycleReset = consumeCycleReset(ws, {
    gate: "stop",
    sessionKey,
    value: env.BENCH_STOP_CYCLE_RESET
  });
  if (cycleReset) {
    try { fs.rmSync(loopFile, { force: true }); } catch { /* explicit reset is best effort */ }
    try { fs.rmSync(coverageFile, { force: true }); } catch { /* explicit reset is best effort */ }
  }

  const statusSnapshot = await captureGitSnapshot(["status", "--short", "--untracked-files=all"], ws);
  const status = promptText(statusSnapshot, "git status");
  const curHead = git(["rev-parse", "HEAD"], ws).trim();   // "" on an unborn HEAD (fresh repo)
  // GAP FIX: review changes COMMITTED since the last review, not just the working tree. A turn that
  // commits (and/or pushes) all its work leaves `git diff HEAD` empty; without this the gate would
  // skip and the committed changes would never be reviewed.
  const base = resolveReviewBase(ws, curHead);
  // Stream the full outputs into hashes while retaining only bounded prompt prefixes. This makes a
  // 66MiB+ change distinguishable from clean without allocating the whole diff or hitting maxBuffer.
  const committedSnapshot = (base && curHead && base !== curHead)
    ? await captureGitSnapshot(["diff", `${base}..${curHead}`], ws)
    : emptyGitSnapshot();
  const diffSnapshot = curHead
    ? await captureGitSnapshot(["diff", "HEAD"], ws)
    : emptyGitSnapshot();
  // Staged-diff FALLBACK only: on an unborn HEAD (fresh repo, no commits) `git diff HEAD`
  // is empty, so a staged-only change would be missed. Use `git diff --cached` only when
  // `diff` is empty — appending it unconditionally would duplicate the staged hunk that
  // `git diff HEAD` already shows in a normal repo.
  const stagedSnapshot = (!curHead || diffSnapshot.totalBytes === 0)
    ? await captureGitSnapshot(["diff", "--cached"], ws)
    : emptyGitSnapshot();
  const committed = promptText(committedSnapshot, "committed diff");
  const diff = promptText(diffSnapshot, "working-tree diff");
  const staged = promptText(stagedSnapshot, "staged diff");
  const {
    block: untracked,
    reviewBlocks: untrackedReviewBlocks = [],
    fingerprint: untrackedIdentity,
    count: untrackedCount,
    coverageComplete: untrackedCoverageComplete = true,
    coverageReason: untrackedCoverageReason = ""
  } = untrackedSnapshot(ws);

  const coverageProblems = [];
  for (const [label, snapshot] of [
    ["git status", statusSnapshot],
    ["committed diff", committedSnapshot],
    ["working-tree diff", diffSnapshot],
    ["staged diff", stagedSnapshot]
  ]) {
    if (!snapshot.ok) coverageProblems.push(`${label} failed: ${snapshot.error}`);
    else if (snapshot.truncated) coverageProblems.push(`${label} is ${snapshot.totalBytes} bytes, above the ${MAX_DIFF_BYTES}-byte bounded review limit`);
  }
  if (!untrackedCoverageComplete) coverageProblems.push(untrackedCoverageReason || "untracked content coverage is incomplete");

  const hasCommitted = committedSnapshot.totalBytes > 0;
  const hasWorkingTree = diffSnapshot.totalBytes > 0;
  const hasStaged = stagedSnapshot.totalBytes > 0;
  if (!coverageProblems.length && !hasCommitted && !hasWorkingTree && !hasStaged && untrackedCount === 0) {
    // Nothing changed since the last review (status/report-only) — keep the baseline current so
    // the NEXT committing turn diffs from here, then skip. Reaching a clean snapshot also breaks
    // any prior block streak: restoring the old bytes later is a new edit cycle, never an auto-skip.
    try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
    try { fs.rmSync(coverageFile, { force: true }); } catch { /* noop */ }
    writeReviewedHead(ws, curHead);
    clearReviewedWorktree(ws, sessionKey);
    return;
  }

  // Never ask Codex to review a Codex turn. Claude can still use Codex through codex-plugin-cc;
  // direct Codex work is reviewed by the non-Codex bench reviewers configured for this workspace.
  // Coverage failures are independent of panel configuration. Do not even resolve the panel here:
  // a broken reviewer config must not turn a known-unreviewed oversized snapshot into fail-open.
  const reviewers = coverageProblems.length
    ? []
    : resolveReviewersImpl({ env }).filter((r) => String(r.name).toLowerCase() !== "codex");
  const reviewerIdentities = reviewers.map(reviewerIdentity)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const reviewPolicy = `${STOP_REVIEW_POLICY_VERSION}:${String(agentName || "agent").toLowerCase()}`;

  // Full review identity for traceability and exact-ALLOW de-duplication. It includes the untruncated
  // committed + working-tree diffs, full-content untracked identity, reviewer model/endpoint, and
  // prompt-policy version. The repair-cycle ceiling itself intentionally spans changed revisions.
  const reviewSnapshotFingerprint = reviewFingerprint({
    scope: "full-review",
    status: snapshotIdentity(statusSnapshot),
    base,
    curHead,
    committed: snapshotIdentity(committedSnapshot),
    diff: snapshotIdentity(diffSnapshot),
    staged: snapshotIdentity(stagedSnapshot),
    untracked: untrackedIdentity,
    reviewers: reviewerIdentities,
    policy: reviewPolicy
  });
  // Coverage is evidence-scoped, not panel-scoped: changing a reviewer/model cannot make the same
  // oversized or unreadable bytes reviewable and must not buy three more automatic wakes.
  const coverageSnapshotFingerprint = reviewFingerprint({
    scope: "coverage",
    status: snapshotIdentity(statusSnapshot),
    base,
    curHead,
    committed: snapshotIdentity(committedSnapshot),
    diff: snapshotIdentity(diffSnapshot),
    staged: snapshotIdentity(stagedSnapshot),
    untracked: untrackedIdentity,
    policy: "stop-coverage-v1"
  });
  let priorBlocks = 0;
  let priorBlockMarker = null;
  let priorCoverageBlocks = 0;
  // One task/session cycle counter spans changed revisions. Counting only an identical snapshot is
  // not a repair-cycle ceiling: an agent that edits after every finding could otherwise be woken
  // forever. A new session, a clean/ALLOW transition, or a one-shot reset nonce starts fresh.
  try {
    const marker = JSON.parse(fs.readFileSync(loopFile, "utf8"));
    const count = Number(marker.count) || 0;
    priorBlocks = count;
    priorBlockMarker = marker;
  } catch { /* no active task/session cycle */ }
  if (coverageProblems.length) {
    // Coverage failures are NOT reviewer decisions. Keep a distinct persistent marker so they can
    // obey the same three-wake UX ceiling without ever being mistaken for reviewed/clean work.
    try {
      const marker = JSON.parse(fs.readFileSync(coverageFile, "utf8"));
      if (marker.snapshot === coverageSnapshotFingerprint) priorCoverageBlocks = Number(marker.count) || 0;
      else fs.rmSync(coverageFile, { force: true });
    } catch { /* no valid same-snapshot coverage marker */ }
    if (priorBlocks >= MAX_STOP_LOOPS || priorCoverageBlocks >= MAX_STOP_LOOPS) {
      const detail = coverageProblems.join(" | ").slice(0, 500);
      emit({
        systemMessage:
          `⛩ bench stop: UNREVIEWED / coverage incomplete — ${MAX_STOP_LOOPS} automatic wake attempts exhausted in this task/session. ` +
          `It remains unreviewed; automatic Stop review is paused for this task/session. ${detail}. ` +
          `Reduce or split the change, then use a new BENCH_STOP_CYCLE_RESET nonce for an explicit retry; /bench:off is the explicit bypass.`
      });
      return;
    }
  } else {
    // A reviewable or clean snapshot supersedes any prior incomplete-coverage state.
    try { fs.rmSync(coverageFile, { force: true }); } catch { /* noop */ }
    if (priorBlocks >= MAX_STOP_LOOPS) {
      emit({ systemMessage: `⛩ bench stop: automatic review ceiling reached after ${MAX_STOP_LOOPS} blocked repair cycles in this task/session. The current snapshot was not re-validated automatically. Address remaining findings manually, start a new task, or use a new BENCH_STOP_CYCLE_RESET nonce for an explicit retry; /bench:off is the explicit bypass.` });
      return;
    }
  }

  // Dirty working-tree changes can persist across many purely conversational turns. `reviewed-head`
  // handles committed history, so remember the exact UNCOMMITTED snapshot that already passed. It
  // intentionally excludes `base`/`committed`: ALLOW advances reviewed-head, which removes the
  // committed section on the next Stop even though the still-dirty worktree is unchanged. A pending
  // committed range always forces review; only an empty committed range may use this de-dupe marker.
  const worktreeFingerprint = reviewFingerprint({
    scope: "uncommitted",
    status: snapshotIdentity(statusSnapshot),
    curHead,
    diff: snapshotIdentity(diffSnapshot),
    staged: snapshotIdentity(stagedSnapshot),
    untracked: untrackedIdentity,
    reviewers: reviewerIdentities,
    policy: reviewPolicy
  });
  const currentReviewedWorktree = readReviewedWorktreeRecord(ws, sessionKey);
  if (
    !hasCommitted
    && priorBlocks === 0
    && currentReviewedWorktree?.fingerprint === worktreeFingerprint
    && currentReviewedWorktree.generation === lockContext?.startedReviewedWorktreeGeneration
  ) {
    return;
  }

  const lastMsg = String(input.last_assistant_message ?? "").slice(0, 4000);
  const untrackedBlocks = untrackedCount > 0
    ? (untrackedReviewBlocks.length ? untrackedReviewBlocks : [untracked])
    : [""];
  const prompts = untrackedBlocks.map((untrackedChunk, index) => buildPrompt(
    index === 0 ? status : `(same snapshot; bounded untracked continuation ${index + 1}/${untrackedBlocks.length})`,
    index === 0 ? diff : "",
    untrackedChunk,
    index === 0 ? lastMsg : "",
    index === 0 ? staged : "",
    index === 0 ? committed : "",
    { agentName, chunkIndex: index, chunkCount: untrackedBlocks.length }
  ));
  const { system, user } = prompts[0];

  if (!reviewers.length && !coverageProblems.length) {
    // e.g. reviewers configured as codex-only — nothing left after self-review suppression.
    try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
    // Treat this as an explicit no-reviewer policy decision, not a transient failure. Advancing the
    // committed baseline prevents the same already-seen commit range from producing a status line
    // at every later Stop while the configured panel still contains no eligible reviewer.
    writeReviewedHead(ws, curHead);
    writeReviewedWorktree(ws, worktreeFingerprint, sessionKey);
    emit({ systemMessage: "⛩ bench stop: no non-Codex reviewers configured — turn allowed (Codex reviewer excluded to avoid self-review)." });
    return;
  }
  const results = coverageProblems.length
    ? [{
        name: "Coverage",
        verdict: "BLOCK",
        firstLine: "BLOCK: repository changes exceed the bounded Stop-review coverage contract",
        raw: `BLOCK: repository changes exceed the bounded Stop-review coverage contract\n${coverageProblems.map((problem) => `- ${problem}`).join("\n")}\n\nReduce/split the change or explicitly bypass after inspecting it; it was not treated as clean.`
      }]
    : await reviewPromptChunks(reviewers, prompts, { cwd: ws, env });
  const panel = combinePanel(results);

  try {
    writeTraceImpl(ws, {
      gate: "stop",
      ws,
      sessionKey,
      reviewers: results.map(({ raw, synthesisPrompt, ...m }) => m),
      systemPrompt: [
        system,
        results.find((result) => result.synthesisPrompt)?.synthesisPrompt?.system
          ? `--- cross-chunk synthesis system ---\n${results.find((result) => result.synthesisPrompt).synthesisPrompt.system}`
          : ""
      ].filter(Boolean).join("\n\n"),
      userPrompt: [
        ...prompts.map((prompt, index) => `--- bounded review prompt ${index + 1}/${prompts.length} ---\n${prompt.user}`),
        ...results.filter((result) => result.synthesisPrompt).map((result) =>
          `--- bounded synthesis prompt for ${result.name} ---\n${result.synthesisPrompt.user}`)
      ].join("\n\n"),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — but say so on stderr instead of swallowing (D3).
    process.stderr.write(`⛩ bench stop: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    emit({ systemMessage: `⛩ bench stop: review failed (turn allowed) [${panel.badge}] — ${panel.summary.slice(0, 250)}` });
    return;
  }

  if (panel.decision === "block") {
    // Record only actual reviewer blocks of this exact snapshot. A coverage/infrastructure block
    // means no review happened, so its separate marker can downgrade to a persistent UNREVIEWED
    // advisory after three wakes without touching reviewed-head/worktree.
    const nextCount = priorBlocks + 1;
    // A BLOCK is authoritative for this immutable review snapshot. Invalidate any older exact
    // ALLOW marker before publishing the block ledger; otherwise the next Stop could de-duplicate
    // against that marker and silently erase the unresolved block.
    clearReviewedWorktree(ws, sessionKey);
    try {
      writeStateJsonAtomic(loopFile, {
        count: nextCount,
        exhausted: nextCount >= MAX_STOP_LOOPS,
        ts: Date.now(),
        generation: randomUUID(),
        snapshot: reviewSnapshotFingerprint,
        status: coverageProblems.length ? "unreviewed-coverage-incomplete" : "review-blocked"
      });
    } catch { /* block delivery still proceeds */ }
    if (coverageProblems.length) {
      try {
        writeStateJsonAtomic(coverageFile, {
          count: priorCoverageBlocks + 1,
          ts: Date.now(),
          snapshot: coverageSnapshotFingerprint,
          status: "unreviewed-coverage-incomplete"
        });
      } catch { /* noop */ }
    }
    // asyncRewake: write findings to STDERR and exit 2 so the harness wakes
    // Claude with them instead of blocking the turn inline.
    const message =
      `Review panel blocked the turn [${panel.badge}]:\n\n${panel.findings}\n\n` +
      `${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}` +
      `Address ALL findings before ending the session.`;
    if (blockHandler) {
      await blockHandler({ panel, message });
      return;
    }
    process.stderr.write(message);
    return STOP_BLOCK_EXIT;
  }

  // allow — clear the loop counter and ADVANCE the reviewed-head marker so this range isn't
  // re-reviewed next turn (committed work is reviewed exactly once). We deliberately do NOT advance
  // on block/fail-open above: a blocked or unreviewed range must be re-reviewed until it's clean.
  // The workspace lock normally makes this identity check tautological. Keep it as a defensive
  // commit condition: an ALLOW may clear only the exact latest block generation it observed before
  // review, never a block published behind its back by an older/misbehaving hook process.
  let currentBlockMarker = null;
  try { currentBlockMarker = JSON.parse(fs.readFileSync(loopFile, "utf8")); } catch { /* no block */ }
  const markerIdentity = (marker) => marker
    ? String(marker.generation || JSON.stringify([marker.count, marker.ts, marker.snapshot, marker.status]))
    : "";
  if (markerIdentity(currentBlockMarker) !== markerIdentity(priorBlockMarker)) {
    emit({
      systemMessage:
        "⛩ bench stop: ALLOW result was not committed because a newer concurrent BLOCK exists. " +
        "The blocked revision remains authoritative and the snapshot will be reviewed again."
    });
    return;
  }
  try { fs.rmSync(loopFile, { force: true }); } catch { /* noop */ }
  writeReviewedHead(ws, curHead);
  writeReviewedWorktree(ws, worktreeFingerprint, sessionKey);
  emit({ systemMessage: `⛩ bench stop: ALLOW [${panel.badge}] — ${panel.summary.slice(0, 220)}` });
}

export async function runMain(options = {}) {
  const env = options.env ?? process.env;
  const input = options.input ?? readInput();
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);
  const sessionKey = sessionKeyFromInput(input, env);
  const isBenchDisabledImpl = options.isBenchDisabledImpl ?? defaultIsBenchDisabled;

  if (isBenchDisabledImpl(ws)) return; // disabled-first

  // Stop hooks can fire from a malformed/empty input while the process cwd is not a repository.
  // There is no review target in that case; do not turn "not a git repository" into a coverage block.
  if (git(["rev-parse", "--is-inside-work-tree"], ws).trim() !== "true") return;

  // Record the exact ALLOW generation visible when this invocation began. A hook that was already
  // queued before another invocation committed ALLOW must still review; it cannot silently reuse a
  // marker that did not exist (or was replaced) at its own start.
  const startedReviewedWorktreeGeneration = readReviewedWorktreeRecord(ws, sessionKey)?.generation || null;
  const release = await acquireStopGateLock(ws);
  let outcome;
  try {
    outcome = await runMainLocked({
      ...options,
      env,
      input,
      isBenchDisabledImpl,
      lockContext: { cwd, ws, sessionKey, startedReviewedWorktreeGeneration }
    });
  } finally {
    release();
  }
  // Exit only after releasing the cross-process lock. A hard process.exit while owning the lock
  // would be recoverable, but every BLOCK would unnecessarily force the next hook to reclaim it.
  if (outcome === STOP_BLOCK_EXIT) process.exit(2);
  return outcome;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ bench stop: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
