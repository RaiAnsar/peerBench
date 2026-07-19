import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_HOOK_MARKER = "# peerBench lightweight native pre-push v2";
export const LEGACY_NATIVE_HOOK_MARKER = "# peerBench managed native pre-push dispatcher v1";
export const ORIGINAL_HOOK_NAME = "pre-push.peerbench-original";
export const LEGACY_LOCAL_HOOK_NAME = "pre-push.local";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function quote(value) { return `'${String(value).replaceAll("'", `'\"'\"'`)}'`; }

function exists(file, fsImpl = fs) {
  try { fsImpl.lstatSync(file); return true; }
  catch { return false; }
}

function pathState(file, fsImpl = fs) {
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch { return { exists: false }; }
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", linkTarget: fsImpl.readlinkSync(file) };
  if (!stat.isFile()) return { exists: true, type: stat.isDirectory() ? "directory" : "other" };
  return {
    exists: true,
    type: "file",
    mode: stat.mode & 0o777,
    sha256: crypto.createHash("sha256").update(fsImpl.readFileSync(file)).digest("hex")
  };
}

export function resolveGitHooksDir(cwd, { gitImpl = git } = {}) {
  try {
    const modern = gitImpl(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], cwd);
    if (modern) return path.resolve(modern);
  } catch {}
  try {
    const raw = gitImpl(["rev-parse", "--git-path", "hooks"], cwd);
    return raw ? path.resolve(cwd, raw) : null;
  } catch { return null; }
}

export function nativeRuntimePath(metaUrl = import.meta.url) {
  return fileURLToPath(new URL("./git-pre-push-review.mjs", metaUrl));
}

export function nativeHookScript(runtimePath, nodePath = process.execPath) {
  return `#!/bin/sh
${NATIVE_HOOK_MARKER}
set -u
hooks_dir=\${0%/*}
original="$hooks_dir/${ORIGINAL_HOOK_NAME}"
# The global marker is authoritative and checked before buffering stdin or resolving Node. A
# disabled peerBench is therefore transparent to an existing user hook and starts no subprocess of
# its own (apart from that preserved hook).
if [ -f "\${BENCH_ROOT:-$HOME/.claude/plugins/data/bench-shared}/disabled-global" ]; then
  if [ -x "$original" ]; then exec "$original" "$@"; fi
  exit 0
fi
node_runtime=${quote(path.resolve(nodePath))}
runtime=${quote(path.resolve(runtimePath))}
if [ ! -x "$node_runtime" ]; then node_runtime=$(command -v node 2>/dev/null || true); fi
if [ ! -x "$node_runtime" ] || [ ! -f "$runtime" ]; then
  echo "peerBench UNREVIEWED: runtime unavailable; push allowed." >&2
  if [ -x "$original" ]; then exec "$original" "$@"; fi
  exit 0
fi
if [ ! -x "$original" ]; then
  "$node_runtime" "$runtime" "\${1:-origin}"
  exit $?
fi

# Buffer only when both hooks need Git's one-shot stdin. Setup failure occurs before stdin is read,
# so the original hook can still run unchanged and peerBench can fail open safely.
tmp=$(mktemp "\${TMPDIR:-/tmp}/peerbench-push.XXXXXX") || {
  echo "peerBench UNREVIEWED: temporary input buffer unavailable; push allowed." >&2
  exec "$original" "$@"
}
trap 'rm -f "$tmp"' 0 1 2 3 15
chmod 600 "$tmp" || {
  echo "peerBench UNREVIEWED: temporary input buffer unavailable; push allowed." >&2
  exec "$original" "$@"
}
cat > "$tmp" || {
  echo "peerBench: could not preserve Git input for the existing pre-push hook; push stopped." >&2
  exit 1
}
"$original" "$@" < "$tmp" || exit $?
"$node_runtime" "$runtime" "\${1:-origin}" < "$tmp"
`;
}

export function nativePrePushStatus(cwd, { fsImpl = fs, gitImpl = git } = {}) {
  const hooksDir = resolveGitHooksDir(cwd, { gitImpl });
  if (!hooksDir) return { ok: false, installed: false, reason: "not a Git repository" };
  const hookPath = path.join(hooksDir, "pre-push");
  const originalPath = path.join(hooksDir, ORIGINAL_HOOK_NAME);
  const legacyLocalPath = path.join(hooksDir, LEGACY_LOCAL_HOOK_NAME);
  const hookExists = exists(hookPath, fsImpl);
  let hookStat = null;
  try { if (hookExists) hookStat = fsImpl.lstatSync(hookPath); } catch {}
  const regularHook = Boolean(hookStat?.isFile() && !hookStat.isSymbolicLink());
  let content = "", readError = null, executable = false;
  try { if (regularHook) content = fsImpl.readFileSync(hookPath, "utf8"); } catch (error) { readError = error; }
  try { executable = regularHook && Boolean(hookStat.mode & 0o111); } catch { executable = false; }
  const managedV2 = regularHook && content.includes(NATIVE_HOOK_MARKER);
  const managedV1 = regularHook && content.includes(LEGACY_NATIVE_HOOK_MARKER);
  const managed = managedV2 || managedV1;
  return {
    ok: true,
    hooksDir,
    hookPath,
    originalPath,
    legacyLocalPath,
    managed,
    managedV1,
    managedV2,
    version: managedV2 ? 2 : managedV1 ? 1 : null,
    installed: managedV2 && executable,
    executable,
    occupied: hookExists && !managed,
    originalOccupied: exists(originalPath, fsImpl),
    legacyLocalOccupied: exists(legacyLocalPath, fsImpl),
    reason: readError
      ? `cannot read existing pre-push hook: ${readError instanceof Error ? readError.message : String(readError)}`
      : (managedV2 && !executable ? "managed pre-push hook is not executable" : undefined)
  };
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function withInstallLock(hooksDir, operation, {
  fsImpl = fs,
  staleMs = 30_000,
  attempts = 400,
  sleepMs = 5
} = {}) {
  const lock = path.join(hooksDir, "pre-push.peerbench-install.lock");
  for (let attempt = 0; attempt < attempts; attempt++) {
    let acquired = false;
    try {
      fsImpl.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const stat = fsImpl.lstatSync(lock);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`native pre-push install lock is not a regular directory: ${lock}`);
        stale = Date.now() - stat.mtimeMs > staleMs;
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        stale = true;
      }
      if (stale) {
        try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch {}
        continue;
      }
      Atomics.wait(sleepBuffer, 0, 0, sleepMs);
    }
    if (acquired) {
      try { return operation(); }
      finally { try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch {} }
    }
  }
  throw new Error("native pre-push install is busy");
}

function atomicExecutable(file, content, fsImpl) {
  const tmp = `${file}.peerbench-tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(tmp, content, { mode: 0o755, flag: "wx" });
    fsImpl.chmodSync(tmp, 0o755);
    fsImpl.renameSync(tmp, file);
  } finally {
    try { fsImpl.rmSync(tmp, { force: true }); } catch {}
  }
}

export function ensureNativePrePushHook(cwd, {
  runtimePath = nativeRuntimePath(),
  nodePath = process.execPath,
  fsImpl = fs,
  gitImpl = git,
  lock = {}
} = {}) {
  const initial = nativePrePushStatus(cwd, { fsImpl, gitImpl });
  if (!initial.ok) return initial;
  try {
    const hooksState = pathState(initial.hooksDir, fsImpl);
    if (hooksState.exists && hooksState.type !== "directory") {
      throw new Error(`Git hooks directory is not a regular directory: ${initial.hooksDir}`);
    }
    fsImpl.mkdirSync(initial.hooksDir, { recursive: true });
    const desired = nativeHookScript(runtimePath, nodePath);
    return withInstallLock(initial.hooksDir, () => {
      const status = nativePrePushStatus(cwd, { fsImpl, gitImpl });
      if (!status.ok) return status;
      const beforeState = pathState(status.hookPath, fsImpl);

      if (status.managedV2) {
        const current = fsImpl.readFileSync(status.hookPath, "utf8");
        if (current !== desired) atomicExecutable(status.hookPath, desired, fsImpl);
        else fsImpl.chmodSync(status.hookPath, 0o755);
        return {
          ...nativePrePushStatus(cwd, { fsImpl, gitImpl }),
          ok: true,
          installed: true,
          changed: current !== desired || !status.executable,
          beforeState,
          afterState: pathState(status.hookPath, fsImpl),
          runtimePath: path.resolve(runtimePath)
        };
      }

      if (status.managedV1) {
        // v1 is peerBench itself, never a user predecessor. Preserve only its pre-push.local chain;
        // if none exists, replacing v1 leaves no original for uninstall to resurrect.
        let movedLegacyLocal = false;
        if (status.legacyLocalOccupied) {
          if (status.originalOccupied) {
            return { ...status, ok: false, installed: false, changed: false, reason: `${status.originalPath} already exists; refusing to overwrite it while migrating v1` };
          }
          fsImpl.renameSync(status.legacyLocalPath, status.originalPath);
          movedLegacyLocal = true;
        }
        try {
          atomicExecutable(status.hookPath, desired, fsImpl);
        } catch (error) {
          if (movedLegacyLocal && exists(status.originalPath, fsImpl) && !exists(status.legacyLocalPath, fsImpl)) {
            try { fsImpl.renameSync(status.originalPath, status.legacyLocalPath); } catch {}
          }
          throw error;
        }
        return {
          ...nativePrePushStatus(cwd, { fsImpl, gitImpl }),
          ok: true,
          installed: true,
          changed: true,
          migratedFromV1: true,
          chained: movedLegacyLocal || status.originalOccupied,
          beforeState,
          afterState: pathState(status.hookPath, fsImpl),
          runtimePath: path.resolve(runtimePath)
        };
      }

      if (status.occupied) {
        if (status.originalOccupied) {
          return { ...status, ok: false, installed: false, changed: false, reason: `${status.originalPath} already exists; refusing to overwrite either user hook` };
        }
        fsImpl.renameSync(status.hookPath, status.originalPath);
      } else if (status.originalOccupied) {
        return { ...status, ok: false, installed: false, changed: false, reason: `${status.originalPath} already exists; refusing to activate an unowned predecessor` };
      }
      try {
        atomicExecutable(status.hookPath, desired, fsImpl);
      } catch (error) {
        if (status.occupied && exists(status.originalPath, fsImpl) && !exists(status.hookPath, fsImpl)) {
          try { fsImpl.renameSync(status.originalPath, status.hookPath); } catch {}
        }
        throw error;
      }
      return {
        ...nativePrePushStatus(cwd, { fsImpl, gitImpl }),
        ok: true,
        installed: true,
        changed: true,
        chained: status.occupied,
        beforeState,
        afterState: pathState(status.hookPath, fsImpl),
        runtimePath: path.resolve(runtimePath)
      };
    }, { fsImpl, ...lock });
  } catch (error) {
    return { ...initial, ok: false, installed: false, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function uninstallNativePrePushHook(cwd, {
  fsImpl = fs,
  gitImpl = git,
  lock = {}
} = {}) {
  const initial = nativePrePushStatus(cwd, { fsImpl, gitImpl });
  if (!initial.ok) return { ...initial, changed: false };
  try {
    const hooksState = pathState(initial.hooksDir, fsImpl);
    if (hooksState.exists && hooksState.type !== "directory") {
      throw new Error(`Git hooks directory is not a regular directory: ${initial.hooksDir}`);
    }
    return withInstallLock(initial.hooksDir, () => {
      const status = nativePrePushStatus(cwd, { fsImpl, gitImpl });
      if (!status.ok || !status.managedV2) {
        return { ...status, changed: false, reason: status.reason || "peerBench v2 hook not installed" };
      }
      const beforeState = pathState(status.hookPath, fsImpl);
      fsImpl.rmSync(status.hookPath, { force: true });
      let restored = false;
      if (exists(status.originalPath, fsImpl)) {
        fsImpl.renameSync(status.originalPath, status.hookPath);
        restored = true;
      }
      // pre-push.local is never created by v2. A v1 migration moved a real chained hook to
      // ORIGINAL_HOOK_NAME; with no such predecessor, uninstall removes v2 and never restores v1.
      return {
        ...nativePrePushStatus(cwd, { fsImpl, gitImpl }),
        ok: true,
        installed: false,
        changed: true,
        restored,
        beforeState,
        afterState: pathState(status.hookPath, fsImpl)
      };
    }, { fsImpl, ...lock });
  } catch (error) {
    return { ...initial, ok: false, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
