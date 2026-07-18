#!/usr/bin/env node
// Native Git pre-push entrypoint. Git, not a hand-written shell parser, supplies the exact ref
// updates. Any non-zero exit aborts the push before refs are changed on the remote.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isBenchDisabled, writeReviewedHead } from "./config-store.mjs";
import { parsePrePushUpdates, reviewNativePush } from "./pre-push-lib.mjs";

function readStdin() { return fs.readFileSync(0, "utf8"); }
function readStdinBuffer() { return fs.readFileSync(0); }
function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}
function headSha(cwd) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim().toLowerCase(); }
  catch { return ""; }
}
function truthy(value) { return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase()); }

const SELF_PATH = fileURLToPath(import.meta.url);
const WORKER_ARG = "--peerbench-native-push-worker-v1";
const DISPATCH_ARG = "--peerbench-native-push-dispatch-v1";
const JOB_PREFIX = "peerbench-native-push-";
const DISPATCH_PREFIX = "peerbench-native-dispatch.";
const REQUEST_FILE = "request.json";
const INPUT_FILE = "input.bin";
const RESULT_FILE = "result.json";
const SENTINEL_FILE = "job-sentinel.json";
const OWNER_FILE = "worker-owner.json";
const DISPATCH_SENTINEL_FILE = "dispatch-sentinel.json";
const DISPATCH_REMOTE_NAME_FILE = "remote-name.bin";
const DISPATCH_REMOTE_URL_FILE = "remote-url.bin";
const JOB_VERSION = 1;
const MAX_JOB_FILE_BYTES = 16 * 1024 * 1024;
const STALE_JOB_MS = 24 * 60 * 60 * 1000;
export const NATIVE_PUSH_FOREGROUND_BUDGET_MS = 90_000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function realTempDir(tempDir = os.tmpdir()) {
  const resolved = path.resolve(tempDir);
  const real = fs.realpathSync.native(resolved);
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("temporary directory is not a real directory");
  return real;
}

function assertPrivateOwned(stat, label, { directory = false } = {}) {
  const expected = directory ? stat.isDirectory() : stat.isFile();
  if (!expected || stat.isSymbolicLink()) throw new Error(`${label} is not a regular ${directory ? "directory" : "file"}`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new Error(`${label} is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are not private`);
}

function validatePrivateTempChild(runDir, { tempDir = os.tmpdir(), prefix, label }) {
  if (!path.isAbsolute(String(runDir || ""))) throw new Error(`${label} path must be absolute`);
  const expectedParent = realTempDir(tempDir);
  const resolved = path.resolve(runDir);
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`${label} path is outside the private spool area`);
  }
  const stat = fs.lstatSync(resolved);
  assertPrivateOwned(stat, `${label} directory`, { directory: true });
  const real = fs.realpathSync.native(resolved);
  if (real !== resolved || path.dirname(real) !== expectedParent) {
    throw new Error(`${label} directory resolves through a symlink`);
  }
  return real;
}

/** Validate an untrusted worker argv path before opening anything below it. */
export function validateNativePushJobDir(runDir, { tempDir = os.tmpdir() } = {}) {
  return validatePrivateTempChild(runDir, { tempDir, prefix: JOB_PREFIX, label: "native push worker job" });
}

/** Validate the shell dispatcher's credential-free argv path before reading its private files. */
export function validateNativePushDispatchDir(runDir, { tempDir = os.tmpdir() } = {}) {
  return validatePrivateTempChild(runDir, { tempDir, prefix: DISPATCH_PREFIX, label: "native push dispatch" });
}

function readPrivateJobFile(runDir, name, { optional = false, maxBytes = MAX_JOB_FILE_BYTES, label = "native push worker" } = {}) {
  const file = path.join(runDir, name);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateOwned(stat, `${label} ${name}`);
    if (stat.size > maxBytes) throw new Error(`${label} ${name} is too large`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateNewFile(file, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    0o600
  );
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateAtomic(runDir, name, value) {
  const target = path.join(runDir, name);
  const tmp = path.join(runDir, `.${name}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    const existing = (() => { try { return fs.lstatSync(target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } })();
    if (existing) throw new Error(`native push worker ${name} already exists`);
    writePrivateNewFile(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    try {
      const dirFd = fs.openSync(runDir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is not available on every supported filesystem */ }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function parseJsonBuffer(buffer, label) {
  try { return JSON.parse(buffer.toString("utf8")); }
  catch (error) { throw new Error(`${label} is invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function validDispatchSentinel(runDir) {
  try {
    const sentinel = parseJsonBuffer(readPrivateJobFile(runDir, DISPATCH_SENTINEL_FILE, {
      label: "native push dispatch",
      maxBytes: 4_096
    }), "native push dispatch sentinel");
    const keys = sentinel && typeof sentinel === "object" && !Array.isArray(sentinel)
      ? Object.keys(sentinel).sort()
      : [];
    if (JSON.stringify(keys) !== JSON.stringify(["kind", "ownerPid", "version"])) return null;
    if (sentinel.kind !== "peerbench-native-push-dispatch" || sentinel.version !== 1) return null;
    if (!Number.isInteger(sentinel.ownerPid) || sentinel.ownerPid <= 0) return null;
    return sentinel;
  } catch {
    return null;
  }
}

function removeValidatedStaleDispatch(runDir) {
  const known = new Set([
    DISPATCH_SENTINEL_FILE,
    DISPATCH_REMOTE_NAME_FILE,
    DISPATCH_REMOTE_URL_FILE,
    INPUT_FILE
  ]);
  let entries;
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    const isAtomicTmp = /^\.(?:dispatch-sentinel\.json|input\.bin|remote-name\.bin|remote-url\.bin)\.tmp-\d+-[0-9a-f]{16}$/.test(entry.name);
    if (!known.has(entry.name) && !isAtomicTmp) return false;
    if (entry.isDirectory()) return false;
  }
  try {
    for (const entry of entries) fs.unlinkSync(path.join(runDir, entry.name));
    fs.rmdirSync(runDir);
    return true;
  } catch {
    return false;
  }
}

function removeAbandonedNativePushDispatches({
  tempDir = os.tmpdir(),
  currentDir = ""
} = {}) {
  let root;
  try { root = realTempDir(tempDir); } catch { return; }
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.name.startsWith(DISPATCH_PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    if (candidate === currentDir) continue;
    try {
      const validated = validateNativePushDispatchDir(candidate, { tempDir: root });
      const sentinel = validDispatchSentinel(validated);
      // The shell writes a live owner before any credential file. Once that exact owner is dead,
      // there is no legitimate startup race to protect; reclaim on the very next dispatch.
      // Invalid/malformed ownership is ambiguous and may belong to something else: preserve it.
      if (!sentinel || processIsAlive(sentinel.ownerPid)) continue;
      removeValidatedStaleDispatch(validated);
    } catch { /* unrelated prefix entries and races are preserved */ }
  }
}

function validJobSentinel(runDir) {
  try {
    const sentinel = parseJsonBuffer(readPrivateJobFile(runDir, SENTINEL_FILE, { maxBytes: 4_096 }), "native push worker sentinel");
    return sentinel?.kind === "peerbench-native-push-job"
      && sentinel.version === JOB_VERSION
      && /^[0-9a-f]{32}$/.test(String(sentinel.nonce || ""))
      ? sentinel
      : null;
  } catch {
    return null;
  }
}

function jobHasLiveOrAmbiguousOwner(runDir, nonce) {
  let ownerBuffer;
  try { ownerBuffer = readPrivateJobFile(runDir, OWNER_FILE, { optional: true, maxBytes: 4_096 }); }
  catch { return true; }
  if (!ownerBuffer) return false;
  try {
    const owner = parseJsonBuffer(ownerBuffer, "native push worker owner");
    if (owner?.version !== JOB_VERSION || owner?.nonce !== nonce || !Number.isInteger(owner?.pid)) return true;
    return processIsAlive(owner.pid);
  } catch {
    return true;
  }
}

function removeValidatedStaleJob(runDir) {
  const known = new Set([SENTINEL_FILE, OWNER_FILE, REQUEST_FILE, INPUT_FILE, RESULT_FILE]);
  let entries;
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    const isAtomicTmp = /^\.(?:result|worker-owner)\.json\.tmp-\d+-[0-9a-f]{16}$/.test(entry.name);
    if (!known.has(entry.name) && !isAtomicTmp) return false;
    if (entry.isDirectory()) return false;
  }
  // Never recursively delete a stale prefix match. Unlink only this protocol's known flat files,
  // then rmdir; a racing/unknown entry makes rmdir fail safely instead of becoming a deletion root.
  try {
    for (const entry of entries) fs.unlinkSync(path.join(runDir, entry.name));
    fs.rmdirSync(runDir);
    return true;
  } catch {
    return false;
  }
}

function removeOldNativePushJobs({ tempDir = os.tmpdir(), now = Date.now() } = {}) {
  let root;
  try { root = realTempDir(tempDir); } catch { return; }
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.name.startsWith(JOB_PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!entry.isDirectory() || stat.isSymbolicLink()) continue;
      const uid = currentUid();
      if (uid !== null && stat.uid !== uid) continue;
      if (now - stat.mtimeMs < STALE_JOB_MS) continue;
      const sentinel = validJobSentinel(candidate);
      if (!sentinel || jobHasLiveOrAmbiguousOwner(candidate, sentinel.nonce)) continue;
      removeValidatedStaleJob(candidate);
    } catch { /* another foreground/worker may own it */ }
  }
}

export function createNativePushJob({
  cwd,
  remoteName = "",
  remoteUrl = "",
  input,
  workerDelayMs = 0,
  tempDir = os.tmpdir()
} = {}) {
  removeOldNativePushJobs({ tempDir });
  const root = realTempDir(tempDir);
  const runDir = fs.mkdtempSync(path.join(root, JOB_PREFIX));
  try {
    fs.chmodSync(runDir, 0o700);
    validateNativePushJobDir(runDir, { tempDir: root });
    const delayMs = Number(workerDelayMs || 0);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error("invalid native push worker delay");
    const nonce = randomBytes(16).toString("hex");
    const inputBuffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
    writePrivateNewFile(path.join(runDir, SENTINEL_FILE), `${JSON.stringify({
      kind: "peerbench-native-push-job",
      version: JOB_VERSION,
      nonce,
      createdAt: Date.now()
    })}\n`);
    writePrivateNewFile(path.join(runDir, INPUT_FILE), inputBuffer);
    writePrivateNewFile(path.join(runDir, REQUEST_FILE), `${JSON.stringify({
      version: JOB_VERSION,
      nonce,
      cwd: String(cwd || ""),
      remoteName: String(remoteName || ""),
      remoteUrl: String(remoteUrl || ""),
      workerDelayMs: delayMs
    })}\n`);
    return runDir;
  } catch (error) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function readWorkerRequest(runDir) {
  const sentinel = validJobSentinel(runDir);
  if (!sentinel) throw new Error("native push worker sentinel is invalid");
  const request = parseJsonBuffer(readPrivateJobFile(runDir, REQUEST_FILE), "native push worker request");
  if (!request || request.version !== JOB_VERSION) throw new Error("native push worker request version is invalid");
  if (request.nonce !== sentinel.nonce) throw new Error("native push worker request does not match its sentinel");
  for (const field of ["cwd", "remoteName", "remoteUrl"]) {
    if (typeof request[field] !== "string") throw new Error(`native push worker request ${field} is invalid`);
  }
  const workerDelayMs = Number(request.workerDelayMs || 0);
  if (!Number.isFinite(workerDelayMs) || workerDelayMs < 0 || workerDelayMs > 60_000) {
    throw new Error("native push worker request delay is invalid");
  }
  return { ...request, workerDelayMs, input: readPrivateJobFile(runDir, INPUT_FILE).toString("utf8") };
}

function readWorkerResult(runDir) {
  const buffer = readPrivateJobFile(runDir, RESULT_FILE, { optional: true });
  if (!buffer) return null;
  const result = parseJsonBuffer(buffer, "native push worker result");
  if (!result || result.version !== JOB_VERSION || ![0, 1].includes(result.code) || typeof result.stderr !== "string") {
    throw new Error("native push worker result is invalid");
  }
  return result;
}

export async function runMain({
  cwd = process.cwd(),
  remoteName = process.argv[2] || "",
  remoteUrl = process.argv[3] || "",
  input,
  env = process.env,
  isBenchDisabledImpl = isBenchDisabled,
  reviewImpl = reviewNativePush,
  stderr = (message) => process.stderr.write(message),
  exit = (code) => process.exit(code)
} = {}) {
  const ws = workspaceRoot(cwd);
  // Nested reviewer processes and explicit bypasses must never recursively invoke the panel.
  if (truthy(env.BENCH_SUPPRESS_HOOKS) || truthy(env.PEERBENCH_SUPPRESS_HOOKS) || truthy(env.BENCH_NATIVE_PUSH_BYPASS)) {
    return exit(0);
  }
  if (isBenchDisabledImpl(ws)) return exit(0);

  let updates;
  try {
    updates = parsePrePushUpdates(input ?? readStdin());
  } catch (error) {
    stderr(`⛩ peerBench native pre-push: ${error instanceof Error ? error.message : String(error)}; push blocked because the exact updates could not be verified.\n`);
    return exit(1);
  }
  if (!updates.length) return exit(0);

  // A push launched from a direct Codex task inherits CODEX_THREAD_ID. Never ask Codex to review
  // its own commit in that case; resolveConfig will select the configured non-Codex panel (or its
  // non-Codex defaults). Claude-launched Codex reviewers already set BENCH_SUPPRESS_HOOKS and exit
  // above, so this does not weaken Claude's normal Codex-inclusive push panel.
  const reviewEnv = env.CODEX_THREAD_ID
    ? { ...env, BENCH_SUPPRESS_CODEX_REVIEWER: "1" }
    : env;
  let result;
  try {
    result = await reviewImpl({ cwd: ws, remoteName, remoteUrl, updates, env: reviewEnv });
  } catch (error) {
    stderr(`⛩ peerBench native pre-push: review crashed (${error instanceof Error ? error.message : String(error)}); push blocked. Retry, use BENCH_NATIVE_PUSH_BYPASS=1 git push for a peerBench-only bypass, or use git push --no-verify to bypass every hook.\n`);
    return exit(1);
  }

  if (result.decision === "allow") {
    const current = headSha(ws);
    if (current && updates.some((u) => u.localSha === current)) writeReviewedHead(ws, current);
    const cached = result.cached ? " (cached exact ref set)" : "";
    stderr(`⛩ peerBench native pre-push: ALLOW${cached}${result.badge ? ` [${result.badge}]` : ""} — ${result.summary || "review passed"}\n`);
    return exit(0);
  }

  if (result.decision === "unavailable") {
    stderr(`⛩ peerBench native pre-push: review unavailable — ${result.reason || result.summary || "quorum not met"}. Push blocked rather than calling a degraded one-reviewer result clean. Retry, use BENCH_NATIVE_PUSH_BYPASS=1 git push for a peerBench-only bypass, or use git push --no-verify to bypass every hook.\n`);
    return exit(1);
  }

  const cached = result.cached ? " (cached; reviewers were not rerun)" : "";
  const cycle = result.cycle ? ` cycle ${result.cycle}/${result.maxCycles || 3}` : "";
  const partial = result.partialUnavailable
    ? "\n\nReview was incomplete for additional ranges; confirmed exact-range results were retained and only unavailable/changed ranges will rerun."
    : "";
  stderr(`⛩ peerBench native pre-push BLOCKED${cached}${cycle}${result.badge ? ` [${result.badge}]` : ""}\n\n${result.findings || result.summary || "blocking findings"}${partial}\n\nFix the consolidated findings, then push again. Unchanged completed ranges are reused instantly.\n`);
  return exit(1);
}

/**
 * Detached worker entrypoint. The only argv value is its random private spool directory; remote
 * URLs (which can contain credentials) and Git's tuples remain in 0600 files instead of process
 * listings. runMain is deliberately reused so cache, trace, policy, and bypass behavior stay exact.
 */
export async function runNativePushWorker(runDir, { env = process.env, tempDir = os.tmpdir() } = {}) {
  const validatedDir = validateNativePushJobDir(runDir, { tempDir });
  let code = 1;
  let capturedStderr = "";
  let ownerWritten = false;
  try {
    const sentinel = validJobSentinel(validatedDir);
    if (!sentinel) throw new Error("native push worker sentinel is invalid");
    writePrivateAtomic(validatedDir, OWNER_FILE, {
      version: JOB_VERSION,
      nonce: sentinel.nonce,
      pid: process.pid,
      startedAt: Date.now()
    });
    ownerWritten = true;
    const request = readWorkerRequest(validatedDir);
    // The worker now owns exact in-memory copies. Remove credential-bearing request material as
    // early as possible; the non-secret sentinel/owner/result retain safe recovery metadata.
    try { fs.rmSync(path.join(validatedDir, REQUEST_FILE), { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(validatedDir, INPUT_FILE), { force: true }); } catch { /* best effort */ }
    if (request.workerDelayMs) await sleep(request.workerDelayMs);
    await runMain({
      cwd: request.cwd,
      remoteName: request.remoteName,
      remoteUrl: request.remoteUrl,
      input: request.input,
      env,
      stderr: (message) => { capturedStderr += String(message); },
      exit: (value) => { code = Number(value) === 0 ? 0 : 1; }
    });
  } catch (error) {
    code = 1;
    capturedStderr += `⛩ peerBench native pre-push: worker failed (${error instanceof Error ? error.message : String(error)}); push blocked. Retry the same push after resolving the worker error.\n`;
  }
  writePrivateAtomic(validatedDir, RESULT_FILE, {
    version: JOB_VERSION,
    code,
    stderr: capturedStderr,
    workerPid: process.pid,
    completedAt: Date.now()
  });
  if (ownerWritten) {
    try { fs.rmSync(path.join(validatedDir, OWNER_FILE), { force: true }); } catch { /* stale cleanup verifies owner liveness */ }
  }
  return { code, stderr: capturedStderr, runDir: validatedDir };
}

/** Consume the managed shell dispatcher's private spool without ever putting its remote URL back
 * into a process argv. The durable detached-worker spool is made before this transient directory
 * is removed, so killing the shell/foreground cannot lose the review input. */
export async function runDispatchMain(dispatchDir, {
  cwd = process.cwd(),
  env = process.env,
  tempDir = os.tmpdir(),
  onSpawn = () => {},
  ...options
} = {}) {
  const validatedDir = validateNativePushDispatchDir(dispatchDir, { tempDir });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // This path came from argv and remains same-user mutable. Never turn it into a recursive
    // deletion root: unlink only the protocol's three flat files, then remove the directory iff it
    // is empty. Unknown/nested entries are left untouched, while credential files are still erased.
    for (const name of [DISPATCH_SENTINEL_FILE, DISPATCH_REMOTE_NAME_FILE, DISPATCH_REMOTE_URL_FILE, INPUT_FILE]) {
      try { fs.unlinkSync(path.join(validatedDir, name)); } catch { /* absent or replaced with a non-file */ }
    }
    try { fs.rmdirSync(validatedDir); } catch { /* unknown/racing content is deliberately retained */ }
  };
  try {
    const sentinel = validDispatchSentinel(validatedDir);
    if (!sentinel) throw new Error("native push dispatch sentinel is invalid");
    if (!processIsAlive(sentinel.ownerPid)) throw new Error("native push dispatch owner is no longer running");
    removeAbandonedNativePushDispatches({ tempDir, currentDir: validatedDir });
    const remoteName = readPrivateJobFile(validatedDir, DISPATCH_REMOTE_NAME_FILE, {
      label: "native push dispatch",
      maxBytes: 1024 * 1024
    }).toString("utf8");
    const remoteUrl = readPrivateJobFile(validatedDir, DISPATCH_REMOTE_URL_FILE, {
      label: "native push dispatch",
      maxBytes: 4 * 1024 * 1024
    }).toString("utf8");
    const input = readPrivateJobFile(validatedDir, INPUT_FILE, { label: "native push dispatch" });
    return await runDetachedMain({
      ...options,
      cwd,
      remoteName,
      remoteUrl,
      input,
      env,
      tempDir,
      onSpawn: (job) => {
        cleanup();
        onSpawn(job);
      }
    });
  } finally {
    cleanup();
  }
}

/**
 * Actual Git-hook path: launch the real review in its own session, then wait only for the bounded
 * interactive budget. A timeout is fail-closed, but it no longer kills the review or loses its
 * exact-range cache/trace; retrying the same push replays that durable verdict.
 */
export async function runDetachedMain({
  cwd = process.cwd(),
  remoteName = process.argv[2] || "",
  remoteUrl = process.argv[3] || "",
  input,
  env = process.env,
  pollTimeoutMs = NATIVE_PUSH_FOREGROUND_BUDGET_MS,
  pollIntervalMs = 50,
  workerDelayMs = 0,
  tempDir = os.tmpdir(),
  spawnImpl = spawn,
  isBenchDisabledImpl = isBenchDisabled,
  onSpawn = () => {},
  stderr = (message) => process.stderr.write(message),
  exit = (code) => process.exit(code)
} = {}) {
  // Preserve the documented fast bypass even when this module is invoked directly rather than by
  // the managed shell dispatcher. Disabled workspaces are equally immediate and spawn nothing.
  if (truthy(env.BENCH_SUPPRESS_HOOKS) || truthy(env.PEERBENCH_SUPPRESS_HOOKS) || truthy(env.BENCH_NATIVE_PUSH_BYPASS)) {
    return exit(0);
  }
  const ws = workspaceRoot(cwd);
  if (isBenchDisabledImpl(ws)) return exit(0);

  const rawInput = input === undefined
    ? readStdinBuffer()
    : (Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8"));
  let runDir;
  let child;
  try {
    runDir = createNativePushJob({ cwd, remoteName, remoteUrl, input: rawInput, workerDelayMs, tempDir });
    child = spawnImpl(process.execPath, [SELF_PATH, WORKER_ARG, runDir], {
      cwd: runDir,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env
    });
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw new Error("worker process did not start");
    child.unref();
    // Observability callbacks must never delete/abort a worker that was already detached.
    try { onSpawn({ pid: child.pid, runDir }); } catch { /* review durability wins */ }
  } catch (error) {
    if (runDir) {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    stderr(`⛩ peerBench native pre-push: could not start detached review (${error instanceof Error ? error.message : String(error)}); push blocked. Retry the same push.\n`);
    return exit(1);
  }

  const timeout = Math.max(0, Number(pollTimeoutMs) || 0);
  const interval = Math.max(5, Math.min(1_000, Number(pollIntervalMs) || 50));
  // A wall-clock correction must not extend the fail-closed foreground budget.
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      const result = readWorkerResult(validateNativePushJobDir(runDir, { tempDir }));
      if (result) {
        try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
        if (result.stderr) stderr(result.stderr);
        return exit(result.code);
      }
    } catch (error) {
      stderr(`⛩ peerBench native pre-push: detached review result could not be verified (${error instanceof Error ? error.message : String(error)}); push blocked.\n`);
      return exit(1);
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
  }

  stderr(
    `⛩ peerBench native pre-push: review continues in background (worker pid ${child.pid}); this push is blocked for now. ` +
    "Retry the same push after the review finishes — its exact verdict, cache, and trace will be reused without rerunning completed work.\n"
  );
  return exit(1);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(SELF_PATH); }
  catch { return path.resolve(process.argv[1]) === path.resolve(SELF_PATH); }
}

if (isDirectExecution()) {
  if (process.argv[2] === WORKER_ARG) {
    runNativePushWorker(process.argv[3]).then(() => {
      // The gate verdict lives in result.json; worker-process success means it was persisted.
      process.exitCode = 0;
    }).catch(() => {
      // Detached stdio is intentionally independent. The bounded foreground will fail closed if a
      // valid result cannot be read; caches/traces written before a final spool error remain useful.
      process.exitCode = 1;
    });
  } else if (process.argv[2] === DISPATCH_ARG) {
    runDispatchMain(process.argv[3], { exit: (code) => code }).then((code) => {
      process.exitCode = Number(code) === 0 ? 0 : 1;
    }).catch((error) => {
      process.stderr.write(`⛩ peerBench native pre-push: dispatch failed (${error instanceof Error ? error.message : String(error)}); push blocked.\n`);
      process.exitCode = 1;
    });
  } else {
    const remoteName = process.argv[2] || "";
    const remoteUrl = process.argv[3] || "";
    // Compatibility for an older managed dispatcher. New installs use DISPATCH_ARG and never put
    // the remote URL in argv; replace the visible title immediately for the upgrade window.
    try { process.title = "peerbench-native-push-gate"; } catch { /* cosmetic hardening */ }
    runDetachedMain({ remoteName, remoteUrl, exit: (code) => code }).then((code) => {
      process.exitCode = Number(code) === 0 ? 0 : 1;
    }).catch((error) => {
      process.stderr.write(`⛩ peerBench native pre-push: fatal error (${error instanceof Error ? error.message : String(error)}); push blocked. Use BENCH_NATIVE_PUSH_BYPASS=1 git push only if an explicit peerBench bypass is intended.\n`);
      process.exitCode = 1;
    });
  }
}
