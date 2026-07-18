// Install/remove the authoritative native Git pre-push dispatcher.
//
// Why this exists: Claude/Codex Bash hooks receive an opaque shell string. Re-implementing
// Bash/Zsh parsing well enough to prove what `git push` will execute is not a finite security
// boundary. Git's own pre-push hook runs after Git has resolved the command and receives the exact
// ref updates on stdin, so it is the only hard gate. The agent-side Bash hook merely makes sure this
// dispatcher is present.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_HOOK_MARKER = "# peerBench managed native pre-push dispatcher v1";
export const LOCAL_HOOK_NAME = "pre-push.local";
export const NATIVE_PUSH_DISPATCH_ARG = "--peerbench-native-push-dispatch-v1";

function pathEntryExists(target, fsImpl = fs) {
  try { fsImpl.lstatSync(target); return true; }
  catch { return false; }
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function nativeRuntimePath(metaUrl = import.meta.url) {
  return fileURLToPath(new URL("./git-pre-push-review.mjs", metaUrl));
}

export function resolveGitHooksDir(cwd, { gitImpl = git } = {}) {
  try {
    // --path-format=absolute makes core.hooksPath handling unambiguous (absolute, relative, and
    // worktree layouts). Fall back for older Git versions.
    const modern = gitImpl(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], cwd);
    if (modern) return path.resolve(modern);
  } catch { /* older Git */ }
  try {
    const raw = gitImpl(["rev-parse", "--git-path", "hooks"], cwd);
    return raw ? path.resolve(cwd, raw) : null;
  } catch {
    return null;
  }
}

export function nativeHookScript(runtimePath, nodePath = process.execPath) {
  const runtime = shellQuote(path.resolve(runtimePath));
  const nodeRuntime = shellQuote(path.resolve(nodePath));
  const dispatchArg = shellQuote(NATIVE_PUSH_DISPATCH_ARG);
  return `#!/bin/sh
${NATIVE_HOOK_MARKER}
# Git gives pre-push update tuples on stdin. Spool the exact bytes once so an existing user hook
# and peerBench receive identical input, including a truly empty stream and trailing newlines.
# The private directory also carries Git's remote arguments in files so credential-bearing URLs do
# not remain visible in the long-lived Node/reviewer argv. The shell receives them briefly because
# that is Git's hook ABI; it clears them before replacing itself with a sanitized wrapper.
prev_umask=$(umask)
umask 077
created_dispatch_dir=$(mktemp -d "\${TMPDIR:-/tmp}/peerbench-native-dispatch.XXXXXX") || {
  umask "$prev_umask"
  echo "peerBench: could not create a secure pre-push dispatch buffer; push blocked." >&2
  exit 1
}
dispatch_dir=$(
  CDPATH= cd -P "$created_dispatch_dir" 2>/dev/null && pwd -P
) || {
  umask "$prev_umask"
  rmdir "$created_dispatch_dir" 2>/dev/null || true
  echo "peerBench: could not validate the secure pre-push dispatch buffer; push blocked." >&2
  exit 1
}
if [ -L "$dispatch_dir" ] || [ ! -d "$dispatch_dir" ] || ! chmod 700 "$dispatch_dir"; then
  umask "$prev_umask"
  rmdir "$created_dispatch_dir" 2>/dev/null || true
  echo "peerBench: could not secure the pre-push dispatch buffer; push blocked." >&2
  exit 1
fi
input_file="$dispatch_dir/input.bin"
remote_name_file="$dispatch_dir/remote-name.bin"
remote_url_file="$dispatch_dir/remote-url.bin"
dispatch_sentinel_file="$dispatch_dir/dispatch-sentinel.json"
cleanup_dispatch() {
  rm -f "$input_file" "$remote_name_file" "$remote_url_file" "$dispatch_sentinel_file" 2>/dev/null || true
  rmdir "$dispatch_dir" 2>/dev/null || true
}
trap 'cleanup_dispatch' 0 1 2 3 15
case "$$" in
  ''|*[!0-9]*)
    umask "$prev_umask"
    echo "peerBench: could not establish a secure pre-push dispatch owner; push blocked." >&2
    exit 1
    ;;
esac
if ! (umask 077; set -C; printf '{"kind":"peerbench-native-push-dispatch","version":1,"ownerPid":%s}\\n' "$$" > "$dispatch_sentinel_file") || ! chmod 600 "$dispatch_sentinel_file"; then
  umask "$prev_umask"
  echo "peerBench: could not write the secure pre-push dispatch sentinel; push blocked." >&2
  exit 1
fi
if ! (umask 077; set -C; cat > "$input_file") || ! chmod 600 "$input_file"; then
  umask "$prev_umask"
  echo "peerBench: could not write the secure pre-push input buffer; push blocked." >&2
  exit 1
fi
umask "$prev_umask"
local_hook="$(dirname "$0")/${LOCAL_HOOK_NAME}"
if [ -x "$local_hook" ]; then
  # For common shell hooks, source the renamed file in a fresh matching shell while keeping $0 as
  # .../pre-push. That preserves dirname/basename dispatch used by hook managers. Opaque executable
  # hooks still run directly with the same args, stdin, environment, and exit status. zsh resets $0
  # to the sourced file (FUNCTION_ARGZERO), so only the zsh branches unset that option first.
  hook_header=$(head -n 1 "$local_hook" 2>/dev/null || true)
  case "$hook_header" in
    '#!/bin/sh') /bin/sh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env sh') /usr/bin/env sh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/bin/bash') /bin/bash -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env bash') /usr/bin/env bash -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/bin/zsh') /bin/zsh -c 'script=$1; shift; setopt NO_FUNCTION_ARGZERO; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env zsh') /usr/bin/env zsh -c 'script=$1; shift; setopt NO_FUNCTION_ARGZERO; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    *) "$local_hook" "$@" < "$input_file" || exit $? ;;
  esac
fi

# PeerBench-only bypass: existing hooks above still run. --no-verify is the emergency bypass for
# every pre-push hook, including the user's chained hook.
case "\${BENCH_NATIVE_PUSH_BYPASS:-}" in
  1|true|TRUE|yes|YES|on|ON) exit 0 ;;
esac

runtime=${runtime}
node_runtime=${nodeRuntime}
if [ ! -x "$node_runtime" ]; then
  node_runtime=$(command -v node 2>/dev/null || true)
fi
if [ ! -x "$node_runtime" ]; then
  echo "peerBench: Node.js runtime is missing; push blocked. Run peerbench setup from a working Node install, or use BENCH_NATIVE_PUSH_BYPASS=1 git push." >&2
  exit 1
fi
if [ ! -f "$runtime" ]; then
  for candidate in "$HOME/.claude/hooks/git-pre-push-review.mjs" "$HOME/.codex/hooks/git-pre-push-review.mjs"; do
    if [ -f "$candidate" ]; then runtime="$candidate"; break; fi
  done
fi
if [ ! -f "$runtime" ]; then
  echo "peerBench: native pre-push reviewer is missing; push blocked. Run peerbench setup, use BENCH_NATIVE_PUSH_BYPASS=1 git push for a peerBench-only bypass, or use git push --no-verify to bypass every hook." >&2
  exit 1
fi
if [ "$#" -ne 2 ]; then
  echo "peerBench: Git supplied an invalid native pre-push argument set; push blocked." >&2
  exit 1
fi
remote_name=$1
remote_url=$2
if ! (umask 077; set -C; printf '%s' "$remote_name" > "$remote_name_file") || ! chmod 600 "$remote_name_file"; then
  echo "peerBench: could not secure the pre-push remote name; push blocked." >&2
  exit 1
fi
if ! (umask 077; set -C; printf '%s' "$remote_url" > "$remote_url_file") || ! chmod 600 "$remote_url_file"; then
  echo "peerBench: could not secure the pre-push remote URL; push blocked." >&2
  exit 1
fi
remote_name=
remote_url=
set --

# Replace the Git-invoked shell immediately so its original credential-bearing argv disappears.
# The replacement shell has only sanitized arguments; it stays around to guarantee cleanup even if
# Node cannot be executed, and Node removes the transient dispatch directory after durable handoff.
exec /bin/sh -c '
node_runtime=$1
runtime=$2
dispatch_arg=$3
dispatch_dir=$4
input_file="$dispatch_dir/input.bin"
remote_name_file="$dispatch_dir/remote-name.bin"
remote_url_file="$dispatch_dir/remote-url.bin"
dispatch_sentinel_file="$dispatch_dir/dispatch-sentinel.json"
cleanup_dispatch() {
  rm -f "$input_file" "$remote_name_file" "$remote_url_file" "$dispatch_sentinel_file" 2>/dev/null || true
  rmdir "$dispatch_dir" 2>/dev/null || true
}
trap "cleanup_dispatch" 0 1 2 3 15
# New runtimes consume the private dispatch directory and deliberately ignore stdin. A runtime from
# before the dispatch protocol instead treats argv as Git remote arguments and parses stdin; give
# it a nonempty malformed tuple so an upgrade mismatch fails closed rather than accepting EOF as
# "nothing to push". Keep the sentinel as a here-document so its creation cannot fail separately.
"$node_runtime" "$runtime" "$dispatch_arg" "$dispatch_dir" <<PEERBENCH_NATIVE_DISPATCH_SENTINEL
peerbench-native-dispatch-protocol-v1
PEERBENCH_NATIVE_DISPATCH_SENTINEL
status=$?
if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  echo "peerBench: could not start the native pre-push reviewer; push blocked." >&2
fi
exit "$status"
' peerbench-native-dispatch "$node_runtime" "$runtime" ${dispatchArg} "$dispatch_dir"
`;
}

function atomicWriteExecutable(file, content, { fsImpl = fs } = {}) {
  const tmp = `${file}.peerbench-tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, content, { mode: 0o755 });
  fsImpl.chmodSync(tmp, 0o755);
  fsImpl.renameSync(tmp, file);
}

export function nativePrePushStatus(cwd, { fsImpl = fs, gitImpl = git } = {}) {
  const hooksDir = resolveGitHooksDir(cwd, { gitImpl });
  if (!hooksDir) return { ok: false, installed: false, reason: "not a Git repository" };
  const hookPath = path.join(hooksDir, "pre-push");
  const exists = pathEntryExists(hookPath, fsImpl);
  let content = "", readError = null, executable = false;
  try { if (exists) content = fsImpl.readFileSync(hookPath, "utf8"); } catch (error) { readError = error; }
  try { executable = exists && Boolean(fsImpl.statSync(hookPath).mode & 0o111); } catch { executable = false; }
  const managed = content.includes(NATIVE_HOOK_MARKER);
  const installed = managed && executable;
  return {
    ok: true,
    hooksDir,
    hookPath,
    localPath: path.join(hooksDir, LOCAL_HOOK_NAME),
    localOccupied: pathEntryExists(path.join(hooksDir, LOCAL_HOOK_NAME), fsImpl),
    installed,
    managed,
    executable,
    occupied: exists && !managed,
    reason: readError
      ? `cannot read existing pre-push hook: ${readError instanceof Error ? readError.message : String(readError)}`
      : (managed && !executable ? "managed pre-push hook is not executable" : undefined)
  };
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

// Serialize the status→rename→write sequence across peerBench processes (same mkdir-lock idiom as
// withDirectoryLock in plan-gate-state.mjs). Without it, two concurrent installers both read
// "occupied, no pre-push.local"; the second installer's rename then moves the first installer's new
// dispatcher onto pre-push.local, destroying the user's hook and self-chaining the dispatcher.
function withInstallLock(hooksDir, operation, { fsImpl = fs, staleMs = 30_000, attempts = 400, sleepMs = 5 } = {}) {
  const lock = path.join(hooksDir, "pre-push.peerbench-install.lock");
  for (let attempt = 0; attempt < attempts; attempt++) {
    let acquired = false;
    try {
      fsImpl.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - fsImpl.statSync(lock).mtimeMs > staleMs; } catch { stale = true; }
      if (stale) {
        try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch { /* another process owns it */ }
        continue;
      }
      Atomics.wait(sleepBuffer, 0, 0, sleepMs);
    }
    if (acquired) {
      try { return operation(); }
      finally { try { fsImpl.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
  throw new Error("native pre-push install is busy");
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
  const { hooksDir, hookPath, localPath } = initial;
  try {
    fsImpl.mkdirSync(hooksDir, { recursive: true });
    const desired = nativeHookScript(runtimePath, nodePath);
    return withInstallLock(hooksDir, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Re-read under the install lock: a concurrent installer may have chained or installed the
        // dispatcher between the first status read and lock acquisition.
        const status = nativePrePushStatus(cwd, { fsImpl, gitImpl });
        if (!status.ok) return status;
        if (status.installed) {
          const current = fsImpl.readFileSync(hookPath, "utf8");
          if (current !== desired) atomicWriteExecutable(hookPath, desired, { fsImpl });
          else fsImpl.chmodSync(hookPath, 0o755);
          return { ...status, installed: true, executable: true, changed: current !== desired, reason: undefined, runtimePath: path.resolve(runtimePath) };
        }

        if (!status.managed && status.localOccupied) {
          if (!status.occupied) {
            return { ...status, ok: false, installed: false, reason: `${localPath} already exists; refusing to activate a hook peerBench did not chain` };
          }
          return { ...status, ok: false, installed: false, reason: `${localPath} already exists; refusing to overwrite either user hook` };
        }
        if (status.occupied) {
          // Never rename onto an existing pre-push.local. One appearing since the status read came
          // from a writer that ignored the lock; abort and decide again from fresh status.
          if (pathEntryExists(localPath, fsImpl)) continue;
          fsImpl.renameSync(hookPath, localPath);
        }
        try {
          atomicWriteExecutable(hookPath, desired, { fsImpl });
        } catch (error) {
          // Restore an existing user hook if dispatcher creation failed after the move.
          if (status.occupied && pathEntryExists(localPath, fsImpl) && !pathEntryExists(hookPath, fsImpl)) {
            try { fsImpl.renameSync(localPath, hookPath); } catch { /* surface original error */ }
          }
          throw error;
        }
        return { ...status, ok: true, installed: true, executable: true, changed: true, chained: status.occupied, reason: undefined, runtimePath: path.resolve(runtimePath) };
      }
      return { ...nativePrePushStatus(cwd, { fsImpl, gitImpl }), ok: false, installed: false, reason: `${localPath} changed while installing; refusing to overwrite it` };
    }, { fsImpl, ...lock });
  } catch (error) {
    return { ...initial, ok: false, installed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function uninstallNativePrePushHook(cwd, { fsImpl = fs, gitImpl = git } = {}) {
  const status = nativePrePushStatus(cwd, { fsImpl, gitImpl });
  if (!status.ok || !status.managed) return { ...status, changed: false };
  try {
    if (pathEntryExists(status.localPath, fsImpl)) {
      fsImpl.rmSync(status.hookPath, { force: true });
      fsImpl.renameSync(status.localPath, status.hookPath);
      return { ...status, installed: false, changed: true, restored: true };
    }
    fsImpl.rmSync(status.hookPath, { force: true });
    return { ...status, installed: false, changed: true, restored: false };
  } catch (error) {
    return { ...status, ok: false, reason: error instanceof Error ? error.message : String(error), changed: false };
  }
}
