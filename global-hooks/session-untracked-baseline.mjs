// Session-scoped identities for untracked paths. SessionStart records old backlog once; Stop
// excludes only unchanged initial/adopted identities. Missing or invalid state excludes nothing.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSessionId, workspaceStateDir } from "./config-store.mjs";
import { untrackedSnapshot } from "./panel-lib.mjs";

const STATE_SCHEMA = 1;
const INVENTORY_FORMAT = "peerbench-session-untracked-v1";
const MAX_PATHS = 10_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const DEFAULT_MAX_FILES_PER_CHUNK = 20;
const DEFAULT_MAX_BYTES_PER_SEGMENT = 20_000;
const DEFAULT_MAX_REVIEW_CHUNKS = 2;
const BASELINE_LOCK_TIMEOUT_MS = 60_000;
const BASELINE_LOCK_POLL_MS = 25;
const BASELINE_LOCK_ORPHAN_GRACE_MS = 1_000;

function baselineFile(ws, sessionKey) {
  const normalized = normalizeSessionId(sessionKey);
  return normalized
    ? path.join(workspaceStateDir(ws), `untracked-baseline.${normalized}.json`)
    : null;
}

function baselineFenceFile(ws, sessionKey) {
  const file = baselineFile(ws, sessionKey);
  return file ? `${file}.stop-arrived` : null;
}

function pathExists(target) {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function stopArrivedFenceExists(ws, sessionKey) {
  const file = baselineFenceFile(ws, sessionKey);
  return Boolean(file && pathExists(file));
}

function ensureStopArrivedFence(ws, sessionKey) {
  const file = baselineFenceFile(ws, sessionKey);
  if (!file) return false;
  if (pathExists(file)) return true;
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, sessionKey: normalizeSessionId(sessionKey), ts: Date.now() })}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    // Atomic create-if-absent: concurrent Stops agree on the same permanent fence.
    try { fs.linkSync(temporary, file); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return pathExists(file);
  } catch {
    return pathExists(file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export function markSessionUntrackedStopStarted(ws, sessionKey, startedBaseline) {
  if (!normalizeSessionId(sessionKey) || startedBaseline?.complete === true) return true;
  return ensureStopArrivedFence(ws, sessionKey);
}

function baselineLockDir(ws, sessionKey) {
  const file = baselineFile(ws, sessionKey);
  return file ? `${file}.lock` : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function readLockOwner(lockDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return value && Number.isInteger(value.pid) && typeof value.token === "string" ? value : null;
  } catch { return null; }
}

function lockInstance(lockDir) {
  try {
    const stat = fs.lstatSync(lockDir);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null;
  } catch { return null; }
}

function restoreQuarantinedLock(lockDir, quarantine) {
  try {
    fs.renameSync(quarantine, lockDir);
    return true;
  } catch {
    // Never delete a quarantined instance unless identity proves it is ours.
    return false;
  }
}

function retireLockInstance(lockDir, expectedInstance, expectedToken = "") {
  const quarantine = `${lockDir}.retire-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockDir, quarantine);
  } catch {
    return false;
  }
  const movedInstance = lockInstance(quarantine);
  const movedOwner = readLockOwner(quarantine);
  const instanceMatches = Boolean(expectedInstance) && movedInstance === expectedInstance;
  const ownerMatches = !expectedToken || movedOwner?.token === expectedToken;
  if (!instanceMatches || !ownerMatches) {
    restoreQuarantinedLock(lockDir, quarantine);
    return false;
  }
  try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { /* inert quarantine */ }
  return true;
}

function recoverDeadBaselineLock(lockDir) {
  try {
    const stat = fs.lstatSync(lockDir);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs < BASELINE_LOCK_ORPHAN_GRACE_MS) return false;
    const observedInstance = lockInstance(lockDir);
    const owner = readLockOwner(lockDir);
    if (owner && processAlive(owner.pid)) return false;
    // Quarantine before deletion so a replacement won after lstat is restored, never erased.
    return retireLockInstance(lockDir, observedInstance, owner?.token || "");
  } catch { return false; }
}

function tryAcquireBaselineLock(ws, sessionKey) {
  const lockDir = baselineLockDir(ws, sessionKey);
  if (!lockDir) return null;
  const token = randomUUID();
  let acquiredInstance = null;
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(lockDir, { mode: 0o700 });
    acquiredInstance = lockInstance(lockDir);
    const temporary = path.join(lockDir, `.owner-${token}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, token, ts: Date.now() })}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    if (!acquiredInstance || lockInstance(lockDir) !== acquiredInstance) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* moved with a reclaimed instance */ }
      if (acquiredInstance) retireLockInstance(lockDir, acquiredInstance);
      return null;
    }
    fs.renameSync(temporary, path.join(lockDir, "owner.json"));
    if (lockInstance(lockDir) !== acquiredInstance || readLockOwner(lockDir)?.token !== token) {
      retireLockInstance(lockDir, acquiredInstance, token);
      return null;
    }
  } catch {
    // If owner publication failed, retire only the exact directory instance we created.
    if (acquiredInstance) {
      const publishedToken = readLockOwner(lockDir)?.token === token ? token : "";
      retireLockInstance(lockDir, acquiredInstance, publishedToken);
    }
    else try { recoverDeadBaselineLock(lockDir); } catch { /* best effort */ }
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    if (!release.owns()) return;
    released = true;
    retireLockInstance(lockDir, acquiredInstance, token);
  };
  release.owns = () => {
    if (released || lockInstance(lockDir) !== acquiredInstance) return false;
    const owner = readLockOwner(lockDir);
    return owner?.pid === process.pid && owner?.token === token;
  };
  return release;
}

async function acquireBaselineLock(ws, sessionKey, { timeoutMs = BASELINE_LOCK_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || BASELINE_LOCK_TIMEOUT_MS);
  for (;;) {
    const release = tryAcquireBaselineLock(ws, sessionKey);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, BASELINE_LOCK_POLL_MS));
  }
}

function withinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function hashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const data = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    hash.update(`${data.length}\0`);
    hash.update(data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableStat(stat) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .map((key) => String(stat?.[key] ?? ""))
    .join(":");
}

function enumerateUntracked(ws, { maxPaths = MAX_PATHS, maxListBytes = MAX_LIST_BYTES } = {}) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: ws,
      encoding: null,
      maxBuffer: Math.max(1, Number(maxListBytes) || MAX_LIST_BYTES),
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (error) {
    return { ok: false, names: [], reason: `could not enumerate untracked files (${error instanceof Error ? error.message : String(error)})` };
  }
  if (output.length > maxListBytes) return { ok: false, names: [], reason: `untracked path list exceeds ${maxListBytes} bytes` };
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(output); }
  catch { return { ok: false, names: [], reason: "untracked path list contains non-UTF-8 names" }; }
  const names = decoded.split("\0").filter(Boolean);
  if (names.length > maxPaths) return { ok: false, names: [], reason: `untracked path count exceeds ${maxPaths}` };
  if (names.some((name) => Buffer.byteLength(name) > MAX_PATH_BYTES)) {
    return { ok: false, names: [], reason: `an untracked path exceeds ${MAX_PATH_BYTES} bytes` };
  }
  return { ok: true, names, reason: "" };
}

function renderBytes(data) {
  if (!data.includes(0)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { /* base64 below */ }
  }
  return `[binary/non-UTF8 bytes; base64]\n${data.toString("base64")}`;
}

function inspectPath(root, name, {
  retainSegments = false,
  maxBytesEach = DEFAULT_MAX_BYTES_PER_SEGMENT,
  maxSegments = DEFAULT_MAX_FILES_PER_CHUNK * DEFAULT_MAX_REVIEW_CHUNKS
} = {}) {
  const result = { name, identity: "", complete: true, reason: "", segments: [], overflow: false };
  const fail = (kind, reason, detail = "") => {
    result.identity = hashParts([INVENTORY_FORMAT, name, kind, detail]);
    result.complete = false;
    result.reason = reason;
    if (retainSegments) result.segments.push(`--- NEW UNTRACKED FILE (${kind}, not reviewed): ${name} ---`);
    return result;
  };
  const abs = path.resolve(root, name);
  if (!withinRoot(root, abs)) return fail("outside workspace", `outside-workspace untracked path could not be reviewed: ${name}`);

  let lst;
  try { lst = fs.lstatSync(abs, { bigint: true }); }
  catch { return fail("unreadable", `unreadable untracked path: ${name}`); }

  if (lst.isSymbolicLink()) {
    try {
      const link = fs.readlinkSync(abs);
      result.identity = hashParts([INVENTORY_FORMAT, name, "symlink", link]);
      if (retainSegments) result.segments.push(`--- NEW UNTRACKED SYMLINK: ${name} ---\n<link-target>${link}</link-target>`);
      return result;
    } catch {
      return fail("unreadable symlink", `unreadable untracked symlink: ${name}`, stableStat(lst));
    }
  }
  if (!lst.isFile()) return fail("non-regular", `non-regular untracked path could not be reviewed: ${name}`, stableStat(lst));

  let real;
  try { real = fs.realpathSync.native(abs); }
  catch { return fail("unreadable", `unreadable untracked path: ${name}`, stableStat(lst)); }
  if (!withinRoot(root, real)) return fail("outside workspace", `outside-workspace untracked path could not be reviewed: ${name}`);

  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) return fail("non-regular", `non-regular untracked path could not be reviewed: ${name}`, stableStat(before));

    const fileHash = createHash("sha256");
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    const bytesPerSegment = Math.max(1, Number(maxBytesEach) || DEFAULT_MAX_BYTES_PER_SEGMENT);
    const segmentLimit = Math.max(0, Number(maxSegments) || 0);
    let total = 0;
    let segmentStart = 0;
    let segmentBytes = 0;
    let segmentChunks = [];
    const finishSegment = () => {
      if (!segmentBytes) return;
      if (retainSegments && result.segments.length < segmentLimit) {
        const data = Buffer.concat(segmentChunks, segmentBytes);
        result.segments.push(
          `--- NEW UNTRACKED FILE: ${name} (mode ${(Number(before.mode) & 0o777).toString(8)}, bytes ${segmentStart}-${segmentStart + segmentBytes - 1}) ---\n${renderBytes(data)}`
        );
      } else if (retainSegments) {
        result.overflow = true;
      }
      segmentStart += segmentBytes;
      segmentBytes = 0;
      segmentChunks = [];
    };

    for (;;) {
      const read = fs.readSync(fd, readBuffer, 0, readBuffer.length, null);
      if (!read) break;
      const chunk = readBuffer.subarray(0, read);
      fileHash.update(chunk);
      total += read;
      if (!retainSegments || result.overflow) continue;
      let cursor = 0;
      while (cursor < read) {
        const take = Math.min(read - cursor, bytesPerSegment - segmentBytes);
        segmentChunks.push(Buffer.from(chunk.subarray(cursor, cursor + take)));
        segmentBytes += take;
        cursor += take;
        if (segmentBytes === bytesPerSegment) finishSegment();
        if (result.overflow) break;
      }
    }
    finishSegment();
    const after = fs.fstatSync(fd, { bigint: true });
    if (stableStat(before) !== stableStat(after) || BigInt(total) !== after.size) {
      return fail("changed while reading", `untracked file changed while being captured: ${name}`, `${stableStat(before)}:${stableStat(after)}:${total}`);
    }
    const contentHash = fileHash.digest("hex");
    result.identity = hashParts([
      INVENTORY_FORMAT,
      name,
      "file",
      String(Number(after.mode) & 0o777),
      String(after.size),
      contentHash
    ]);
    if (retainSegments && total === 0) {
      result.segments.push(`--- NEW UNTRACKED FILE: ${name} (mode ${(Number(after.mode) & 0o777).toString(8)}, empty file) ---`);
    }
    return result;
  } catch {
    return fail("unreadable content", `unreadable untracked file content: ${name}`, stableStat(lst));
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function inventoryFingerprint(entries, baselineMode) {
  const hash = createHash("sha256");
  hash.update(`${INVENTORY_FORMAT}\0${baselineMode}\0${entries.length}\0`);
  for (const entry of entries) hash.update(`${entry.path.length}\0${entry.path}\0${entry.identity}\0${entry.reviewable ? "1" : "0"}\0`);
  return hash.digest("hex");
}

function captureInventory(ws, baselineEntries = null, {
  maxFiles = DEFAULT_MAX_FILES_PER_CHUNK,
  maxBytesEach = DEFAULT_MAX_BYTES_PER_SEGMENT,
  maxReviewChunks = DEFAULT_MAX_REVIEW_CHUNKS,
  buildReview = true
} = {}) {
  let root;
  try { root = fs.realpathSync.native(ws); }
  catch { return { complete: false, reason: "workspace root could not be resolved", root: "", entries: [], snapshot: null } };
  const listed = enumerateUntracked(root);
  if (!listed.ok) return { complete: false, reason: listed.reason, root, entries: [], snapshot: null };

  const baseline = baselineEntries instanceof Map ? baselineEntries : new Map();
  const baselineMode = baselineEntries instanceof Map ? "baseline" : "review-all";
  const segmentsPerBlock = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES_PER_CHUNK);
  const bytesPerSegment = Math.max(1, Number(maxBytesEach) || DEFAULT_MAX_BYTES_PER_SEGMENT);
  const chunkLimit = Math.max(1, Number(maxReviewChunks) || DEFAULT_MAX_REVIEW_CHUNKS);
  const segmentLimit = segmentsPerBlock * chunkLimit;
  const entries = [];
  const reviewSegments = [];
  const problems = [];
  const seenProblems = new Set();
  let reviewableCount = 0;
  let conditionalAdoptedCount = 0;
  const addProblem = (reason) => {
    if (!reason || seenProblems.has(reason)) return;
    seenProblems.add(reason);
    if (problems.length < 5) problems.push(reason);
  };

  for (const name of listed.names) {
    // Retain at most one path's prompt bytes before comparing its identity.
    const inspected = inspectPath(root, name, {
      retainSegments: buildReview,
      maxBytesEach: bytesPerSegment,
      maxSegments: segmentLimit
    });
    const accepted = baseline.get(name);
    const initialMatch = accepted?.initial === inspected.identity;
    const adoptedMatch = accepted?.adopted === inspected.identity;
    const reviewable = !initialMatch && !adoptedMatch;
    if (!initialMatch && adoptedMatch) conditionalAdoptedCount += 1;
    entries.push({ path: name, identity: inspected.identity, reviewable });
    if (!reviewable) continue;
    reviewableCount += 1;
    if (!inspected.complete) addProblem(inspected.reason);
    if (!buildReview) continue;
    for (const segment of inspected.segments) {
      if (reviewSegments.length < segmentLimit) reviewSegments.push(segment);
      else addProblem(`untracked review exceeds ${chunkLimit} bounded chunk(s); first omitted path: ${name}`);
    }
    if (inspected.overflow) addProblem(`untracked review exceeds ${chunkLimit} bounded chunk(s); first omitted path: ${name}`);
  }

  const reviewBlocks = [];
  for (let i = 0; i < reviewSegments.length; i += segmentsPerBlock) {
    reviewBlocks.push(reviewSegments.slice(i, i + segmentsPerBlock).join("\n\n"));
  }
  let block = reviewBlocks[0] || "";
  if (reviewBlocks.length > 1) block += `\n\n(… ${reviewBlocks.length - 1} additional bounded untracked review chunk(s) follow)`;
  return {
    complete: problems.length === 0,
    reason: problems.join(" | "),
    root,
    entries,
    snapshot: {
      block,
      reviewBlocks,
      fingerprint: inventoryFingerprint(entries, baselineMode),
      count: reviewableCount,
      coverageComplete: problems.length === 0,
      coverageReason: problems.join(" | "),
      conditionalAdoptedCount
    }
  };
}

function readPrivateState(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return null;
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function validatedBaseline(ws, sessionKey) {
  const file = baselineFile(ws, sessionKey);
  if (!file) return null;
  const value = readPrivateState(file);
  let root;
  try { root = fs.realpathSync.native(ws); } catch { return null; }
  if (!value || value.schema !== STATE_SCHEMA || value.format !== INVENTORY_FORMAT
    || value.complete !== true || value.sessionKey !== normalizeSessionId(sessionKey)
    || value.workspace !== root || typeof value.generation !== "string"
    || !Array.isArray(value.initialEntries) || value.initialEntries.length > MAX_PATHS
    || !Array.isArray(value.adoptedEntries) || value.adoptedEntries.length > MAX_PATHS
    || typeof value.adoptedPolicy !== "string") return null;
  const parseEntries = (list) => {
    const entries = new Map();
    for (const entry of list) {
      if (!entry || typeof entry.path !== "string" || Buffer.byteLength(entry.path) > MAX_PATH_BYTES
        || typeof entry.identity !== "string" || !/^[0-9a-f]{64}$/.test(entry.identity)
        || entries.has(entry.path)) return null;
      const abs = path.resolve(root, entry.path);
      if (!withinRoot(root, abs)) return null;
      entries.set(entry.path, entry.identity);
    }
    return entries;
  };
  const initialEntries = parseEntries(value.initialEntries);
  const adoptedEntries = parseEntries(value.adoptedEntries);
  if (!initialEntries || !adoptedEntries) return null;
  // The permanent fence rejects initial identities published after Stop began.
  if (initialEntries.size > 0 && stopArrivedFenceExists(ws, sessionKey)) return null;
  return { file, value, initialEntries, adoptedEntries };
}

function writeBaseline(ws, sessionKey, {
  initialEntries = [],
  adoptedEntries = [],
  adoptedPolicy = ""
} = {}, { complete = true, reason = "", createOnly = false, expectedGeneration } = {}) {
  const file = baselineFile(ws, sessionKey);
  if (!file) return false;
  let root;
  try { root = fs.realpathSync.native(ws); } catch { return false; }
  const initial = complete
    ? initialEntries.map((entry) => ({ path: entry.path, identity: entry.identity }))
    : [];
  const adopted = complete
    ? adoptedEntries.map((entry) => ({ path: entry.path, identity: entry.identity }))
    : [];
  const value = {
    schema: STATE_SCHEMA,
    format: INVENTORY_FORMAT,
    complete: Boolean(complete),
    sessionKey: normalizeSessionId(sessionKey),
    workspace: root,
    capturedAt: Date.now(),
    generation: randomUUID(),
    reason: String(reason || "").slice(0, 500),
    adoptedPolicy: complete ? String(adoptedPolicy || "") : "",
    initialEntries: initial,
    adoptedEntries: adopted
  };
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) return false;
  const stateDir = path.dirname(file);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    if (createOnly) {
      // A hard link provides atomic create-if-absent; rename would replace the destination.
      fs.linkSync(temporary, file);
    } else {
      if (expectedGeneration !== undefined) {
        const current = readPrivateState(file);
        if (!current || current.generation !== expectedGeneration) return false;
      }
      fs.renameSync(temporary, file);
    }
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* renamed or best effort */ }
  }
}

export function recordSessionUntrackedBaseline(ws, sessionKey, { captureInventoryImpl = captureInventory } = {}) {
  const file = baselineFile(ws, sessionKey);
  if (!file) return { enabled: false, recorded: false, complete: false, reason: "no reliable session id" };
  const release = tryAcquireBaselineLock(ws, sessionKey);
  if (!release) return { enabled: true, recorded: false, complete: false, reason: "baseline capture already in progress" };
  try {
    if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
    if (stopArrivedFenceExists(ws, sessionKey)) {
      const existing = validatedBaseline(ws, sessionKey);
      if (existing) return { enabled: true, recorded: false, complete: true, reason: "Stop already stabilized this session baseline" };
      if (pathExists(file)) {
        return { enabled: true, recorded: false, complete: false, reason: "Stop arrived before baseline capture completed" };
      }
      if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
      const recorded = writeBaseline(ws, sessionKey, {}, {
        complete: true,
        reason: "Stop arrived before SessionStart baseline capture; reviewing all paths",
        createOnly: true
      });
      return { enabled: true, recorded, complete: recorded, reason: recorded ? "" : "empty fenced baseline could not be persisted" };
    }
    // Never recapture an existing marker mid-session, even when it is invalid.
    if (pathExists(file)) {
      const existing = validatedBaseline(ws, sessionKey);
      return {
        enabled: true,
        recorded: false,
        complete: Boolean(existing),
        reason: existing ? "baseline already exists" : "existing baseline is incomplete or invalid"
      };
    }
    // Reserve before the inventory walk so Stop can identify an in-flight generation.
    if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
    const reserved = writeBaseline(ws, sessionKey, {}, {
      complete: false,
      reason: "baseline capture in progress",
      createOnly: true
    });
    if (!reserved) {
      const existing = validatedBaseline(ws, sessionKey);
      return {
        enabled: true,
        recorded: false,
        complete: Boolean(existing),
        reason: existing ? "baseline already exists" : "baseline reservation is incomplete or invalid"
      };
    }
    const reservationGeneration = readPrivateState(file)?.generation;
    if (typeof reservationGeneration !== "string") {
      return { enabled: true, recorded: false, complete: false, reason: "baseline reservation could not be verified" };
    }
    const inventory = captureInventoryImpl(ws, null, { buildReview: false });
    if (!release.owns()) {
      return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
    }
    if (stopArrivedFenceExists(ws, sessionKey)) {
      if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
      const recorded = writeBaseline(ws, sessionKey, {}, {
        complete: true,
        reason: "Stop arrived while SessionStart captured the baseline; reviewing all paths",
        expectedGeneration: reservationGeneration
      });
      return { enabled: true, recorded, complete: recorded, reason: recorded ? "" : "fenced baseline could not be persisted" };
    }
    if (!inventory.complete) {
      if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
      writeBaseline(ws, sessionKey, {}, {
        complete: false,
        reason: inventory.reason,
        expectedGeneration: reservationGeneration
      });
      return { enabled: true, recorded: false, complete: false, reason: inventory.reason };
    }
    if (!release.owns()) return { enabled: true, recorded: false, complete: false, reason: "baseline capture lock was lost" };
    const recorded = writeBaseline(ws, sessionKey, { initialEntries: inventory.entries }, {
      expectedGeneration: reservationGeneration
    });
    return { enabled: true, recorded, complete: recorded, reason: recorded ? "" : "baseline could not be persisted" };
  } finally {
    release();
  }
}

function sameInitialEntries(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((entry, index) => entry?.path === b[index]?.path && entry?.identity === b[index]?.identity);
}

// After taking Stop's workspace lock, wait for SessionStart and replace any late baseline with an
// empty trusted one. A baseline visible at Stop start keeps its initial entries; newer adoptions are
// rejected by expectedGeneration.
export async function prepareSessionUntrackedBaselineForStop(ws, sessionKey, startedBaseline, options = {}) {
  if (!normalizeSessionId(sessionKey)) return { safe: true, expectedGeneration: undefined };
  // Fence before waiting so a timed-out SessionStart can never publish trusted initial entries.
  if (!markSessionUntrackedStopStarted(ws, sessionKey, startedBaseline)) {
    return { safe: false, expectedGeneration: undefined, reason: "session Stop-arrival fence could not be persisted" };
  }
  const release = await acquireBaselineLock(ws, sessionKey, options);
  if (!release) return { safe: false, expectedGeneration: undefined, reason: "session baseline capture lock timed out" };
  try {
    if (!release.owns()) return { safe: false, expectedGeneration: undefined, reason: "session baseline capture lock was lost" };
    const file = baselineFile(ws, sessionKey);
    const current = validatedBaseline(ws, sessionKey);
    if (current && startedBaseline?.complete === true
      && sameInitialEntries(current.value.initialEntries, startedBaseline.initialEntries)) {
      return { safe: true, expectedGeneration: startedBaseline.generation };
    }

    const replaceOptions = current
      ? { expectedGeneration: current.value.generation }
      : pathExists(file)
        ? { expectedGeneration: readPrivateState(file)?.generation }
        : { createOnly: true };
    if (replaceOptions.expectedGeneration === undefined && pathExists(file)) {
      return { safe: false, expectedGeneration: undefined, reason: "session baseline state is invalid" };
    }
    if (!release.owns()) return { safe: false, expectedGeneration: undefined, reason: "session baseline capture lock was lost" };
    const stabilized = writeBaseline(ws, sessionKey, {}, {
      complete: true,
      reason: "Stop began before a trusted SessionStart baseline was available; reviewing all paths",
      ...replaceOptions
    });
    const safeBaseline = stabilized ? validatedBaseline(ws, sessionKey) : null;
    return safeBaseline
      ? { safe: true, expectedGeneration: safeBaseline.value.generation }
      : { safe: false, expectedGeneration: undefined, reason: "session baseline could not be stabilized" };
  } finally {
    release();
  }
}

export function sessionUntrackedSnapshot(ws, sessionKey, options = {}) {
  if (!normalizeSessionId(sessionKey)) {
    return { ...untrackedSnapshot(ws, options), sessionBaseline: false, inventory: null };
  }
  const baseline = validatedBaseline(ws, sessionKey);
  const {
    includeAdopted = true,
    includeInitial = true,
    expectedGeneration,
    rejectedAdoptedEntries = [],
    ...snapshotOptions
  } = options;
  const generationMatches = expectedGeneration === undefined
    || String(expectedGeneration || "") === String(baseline?.value?.generation || "");
  const rejectedAdopted = new Map();
  if (Array.isArray(rejectedAdoptedEntries) && rejectedAdoptedEntries.length <= MAX_PATHS) {
    for (const entry of rejectedAdoptedEntries) {
      if (entry && typeof entry.path === "string" && typeof entry.identity === "string") {
        rejectedAdopted.set(entry.path, entry.identity);
      }
    }
  }
  const accepted = baseline ? new Map() : null;
  if (accepted) {
    if (includeInitial) {
      for (const [name, identity] of baseline.initialEntries) accepted.set(name, { initial: identity, adopted: "" });
    }
    if (includeAdopted && generationMatches) {
      for (const [name, identity] of baseline.adoptedEntries) {
        if (rejectedAdopted.get(name) === identity) continue;
        accepted.set(name, { ...(accepted.get(name) || { initial: "" }), adopted: identity });
      }
    }
  }
  const captured = captureInventory(ws, accepted, snapshotOptions);
  if (!captured.snapshot) {
    return {
      block: "",
      reviewBlocks: [],
      fingerprint: hashParts([INVENTORY_FORMAT, "capture-incomplete", captured.reason]),
      count: 0,
      coverageComplete: false,
      coverageReason: captured.reason || "untracked inventory capture is incomplete",
      sessionBaseline: Boolean(baseline),
      baselineGeneration: baseline?.value?.generation || null,
      adoptedPolicy: baseline?.value?.adoptedPolicy || "",
      inventory: null
    };
  }
  return {
    ...captured.snapshot,
    sessionBaseline: Boolean(baseline),
    baselineGeneration: baseline?.value?.generation || null,
    adoptedPolicy: baseline?.value?.adoptedPolicy || "",
    inventory: captured.complete ? { root: captured.root, entries: captured.entries, complete: true } : null
  };
}

export function adoptSessionUntrackedBaseline(ws, sessionKey, inventory, policy = "") {
  if (!normalizeSessionId(sessionKey) || !inventory?.complete || !Array.isArray(inventory.entries)) return false;
  const release = tryAcquireBaselineLock(ws, sessionKey);
  if (!release) return false;
  try {
    if (!release.owns()) return false;
    const file = baselineFile(ws, sessionKey);
    const existing = validatedBaseline(ws, sessionKey);
    // An incomplete/invalid file may be an active SessionStart reservation. Never overwrite it.
    if (file && pathExists(file) && !existing) return false;
    const initialEntries = existing
      ? [...existing.initialEntries].map(([path, identity]) => ({ path, identity }))
      : [];
    if (!release.owns()) return false;
    return writeBaseline(ws, sessionKey, {
      initialEntries,
      adoptedEntries: inventory.entries,
      adoptedPolicy: String(policy || "")
    }, { createOnly: !existing, ...(existing ? { expectedGeneration: existing.value.generation } : {}) });
  } finally {
    release();
  }
}

export function readSessionUntrackedBaseline(ws, sessionKey) {
  const baseline = validatedBaseline(ws, sessionKey);
  return baseline ? baseline.value : null;
}
