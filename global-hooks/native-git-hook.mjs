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
  return `#!/bin/sh
${NATIVE_HOOK_MARKER}
# Git gives pre-push update tuples on stdin. Spool the exact bytes once so an existing user hook
# and peerBench receive identical input, including a truly empty stream and trailing newlines.
umask 077
input_file=$(mktemp "\${TMPDIR:-/tmp}/peerbench-pre-push.XXXXXX") || {
  echo "peerBench: could not create a secure pre-push input buffer; push blocked." >&2
  exit 1
}
trap 'rm -f "$input_file"' 0 1 2 3 15
cat > "$input_file" || exit $?
local_hook="$(dirname "$0")/${LOCAL_HOOK_NAME}"
if [ -x "$local_hook" ]; then
  # For common shell hooks, source the renamed file in a fresh matching shell while keeping $0 as
  # .../pre-push. That preserves dirname/basename dispatch used by hook managers. Opaque executable
  # hooks still run directly with the same args, stdin, environment, and exit status.
  hook_header=$(head -n 1 "$local_hook" 2>/dev/null || true)
  case "$hook_header" in
    '#!/bin/sh') /bin/sh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env sh') /usr/bin/env sh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/bin/bash') /bin/bash -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env bash') /usr/bin/env bash -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/bin/zsh') /bin/zsh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
    '#!/usr/bin/env zsh') /usr/bin/env zsh -c 'script=$1; shift; . "$script"' "$0" "$local_hook" "$@" < "$input_file" || exit $? ;;
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
"$node_runtime" "$runtime" "$@" < "$input_file"
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

export function ensureNativePrePushHook(cwd, {
  runtimePath = nativeRuntimePath(),
  nodePath = process.execPath,
  fsImpl = fs,
  gitImpl = git
} = {}) {
  const status = nativePrePushStatus(cwd, { fsImpl, gitImpl });
  if (!status.ok) return status;
  const { hooksDir, hookPath, localPath } = status;
  try {
    fsImpl.mkdirSync(hooksDir, { recursive: true });
    const desired = nativeHookScript(runtimePath, nodePath);
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
      if (status.occupied) {
        return { ...status, ok: false, installed: false, reason: `${localPath} already exists; refusing to overwrite either user hook` };
      }
    }
    if (status.occupied) {
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
  } catch (error) {
    return { ...status, ok: false, installed: false, reason: error instanceof Error ? error.message : String(error) };
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
