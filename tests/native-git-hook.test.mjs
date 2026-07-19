import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LEGACY_LOCAL_HOOK_NAME,
  LEGACY_NATIVE_HOOK_MARKER,
  NATIVE_HOOK_MARKER,
  ORIGINAL_HOOK_NAME,
  ensureNativePrePushHook,
  nativePrePushStatus,
  uninstallNativePrePushHook
} from "../global-hooks/native-git-hook.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

test("install chains and uninstall restores an existing hook, including paths with spaces", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench hook parent "));
  const ws = path.join(parent, "repository with spaces");
  fs.mkdirSync(ws);
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const originalPath = path.join(hooksDir, ORIGINAL_HOOK_NAME);
  const originalLog = path.join(parent, "original hook input.log");
  const runtimeLog = path.join(parent, "runtime input.json");

  const original = [
    "#!/bin/sh",
    `cat > ${shellQuote(originalLog)}`,
    "exit 0",
    ""
  ].join("\n");
  fs.writeFileSync(hookPath, original, { mode: 0o755 });

  const runtimeDir = path.join(parent, "runtime directory");
  const binDir = path.join(parent, "node bin");
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(binDir);
  const runtimePath = path.join(runtimeDir, "peer bench runtime.mjs");
  const nodePath = path.join(binDir, "node with spaces");
  fs.symlinkSync(process.execPath, nodePath);
  fs.writeFileSync(runtimePath, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(runtimeLog)}, JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }));`,
    ""
  ].join("\n"));

  const installed = ensureNativePrePushHook(ws, { runtimePath, nodePath });
  assert.equal(installed.ok, true);
  assert.equal(installed.installed, true);
  assert.equal(installed.chained, true);
  assert.equal(fs.readFileSync(originalPath, "utf8"), original);
  assert.match(fs.readFileSync(hookPath, "utf8"), new RegExp(NATIVE_HOOK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(nativePrePushStatus(ws).installed, true);

  const tuple = `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n`;
  const benchRoot = path.join(parent, "isolated bench root");
  const execution = spawnSync(hookPath, ["origin", path.join(parent, "remote with spaces")], {
    cwd: ws,
    env: { ...process.env, BENCH_ROOT: benchRoot },
    input: tuple,
    encoding: "utf8"
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(fs.readFileSync(originalLog, "utf8"), tuple, "the pre-existing hook receives the original stdin");
  const runtime = JSON.parse(fs.readFileSync(runtimeLog, "utf8"));
  assert.deepEqual(runtime.args, ["origin"]);
  assert.equal(runtime.input, tuple, "the peerBench runtime receives the same stdin after the chained hook");

  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  assert.equal(removed.restored, true);
  assert.equal(fs.readFileSync(hookPath, "utf8"), original, "uninstall restores the exact prior hook contents");
  assert.equal(fs.statSync(hookPath).mode & 0o111, 0o111, "the restored hook remains executable");
  assert.equal(fs.existsSync(originalPath), false, "the backup is consumed during restoration");
  assert.equal(nativePrePushStatus(ws).managed, false);
});

test("the real native runtime main entry executes when its installed path contains spaces", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench real runtime parent "));
  const ws = path.join(parent, "repository with spaces");
  fs.mkdirSync(ws);
  git(ws, "init", "-q", "-b", "main");

  // Copy the whole flat runtime because git-pre-push-review imports sibling modules.
  // A malformed tuple exits before reviewer selection, so this can never call a provider.
  const runtimeDir = path.join(parent, "deployed hooks with spaces");
  fs.cpSync(path.join(import.meta.dirname, "..", "global-hooks"), runtimeDir, { recursive: true });
  const runtimePath = path.join(runtimeDir, "git-pre-push-review.mjs");
  const installed = ensureNativePrePushHook(ws, { runtimePath });
  assert.equal(installed.ok, true);

  const hookPath = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push");
  const execution = spawnSync(hookPath, ["origin", path.join(parent, "remote with spaces")], {
    cwd: ws,
    env: { ...process.env, BENCH_ROOT: path.join(parent, "isolated root") },
    input: "malformed tuple\n",
    encoding: "utf8"
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stderr, /peerBench UNREVIEWED: invalid pre-push update tuple/i,
    "the ESM main guard must work with URL-encoded spaces; silence means the runtime no-op'd");
});

test("global disable bypasses peerBench buffering and runs the preserved hook with original stdin", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-disabled-native-"));
  const ws = path.join(parent, "repo");
  fs.mkdirSync(ws);
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const originalLog = path.join(parent, "original.log");
  fs.writeFileSync(hookPath, `#!/bin/sh\n/bin/cat > ${shellQuote(originalLog)}\n`, { mode: 0o755 });

  const runtimeLog = path.join(parent, "runtime-called");
  const runtimePath = path.join(parent, "runtime.mjs");
  fs.writeFileSync(runtimePath, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(runtimeLog)}, "called");\n`);
  assert.equal(ensureNativePrePushHook(ws, { runtimePath }).ok, true);

  const benchRoot = path.join(parent, "bench-root");
  fs.mkdirSync(benchRoot);
  fs.writeFileSync(path.join(benchRoot, "disabled-global"), "disabled global\n");
  const fakeBin = path.join(parent, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "mktemp"), "#!/bin/sh\necho mktemp-was-called >&2\nexit 99\n", { mode: 0o755 });
  const tuple = `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n`;
  const execution = spawnSync(hookPath, ["origin", "unused"], {
    cwd: ws,
    env: { ...process.env, BENCH_ROOT: benchRoot, PATH: `${fakeBin}:${process.env.PATH}` },
    input: tuple,
    encoding: "utf8"
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.doesNotMatch(execution.stderr, /mktemp-was-called/);
  assert.equal(fs.readFileSync(originalLog, "utf8"), tuple);
  assert.equal(fs.existsSync(runtimeLog), false, "disabled native hook must not launch peerBench Node");
});

test("buffer setup failure fails peerBench open without bypassing the preserved hook", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-buffer-fail-"));
  const ws = path.join(parent, "repo");
  fs.mkdirSync(ws);
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const originalLog = path.join(parent, "original.log");
  fs.writeFileSync(hookPath, `#!/bin/sh\n/bin/cat > ${shellQuote(originalLog)}\n`, { mode: 0o755 });
  const runtimePath = path.join(parent, "runtime.mjs");
  fs.writeFileSync(runtimePath, "process.exitCode = 0;\n");
  assert.equal(ensureNativePrePushHook(ws, { runtimePath }).ok, true);

  const fakeBin = path.join(parent, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "mktemp"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const tuple = `refs/heads/main ${"3".repeat(40)} refs/heads/main ${"4".repeat(40)}\n`;
  const execution = spawnSync(hookPath, ["origin", "unused"], {
    cwd: ws,
    env: { ...process.env, BENCH_ROOT: path.join(parent, "enabled-root"), PATH: `${fakeBin}:${process.env.PATH}` },
    input: tuple,
    encoding: "utf8"
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stderr, /UNREVIEWED: temporary input buffer unavailable/);
  assert.equal(fs.readFileSync(originalLog, "utf8"), tuple, "the original hook still receives untouched stdin");
});

test("the install-prepush CLI main entry executes from a path containing spaces", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench installer parent "));
  const ws = path.join(parent, "repository with spaces");
  fs.mkdirSync(ws);
  git(ws, "init", "-q", "-b", "main");

  const bundle = path.join(parent, "peerbench bundle with spaces");
  fs.mkdirSync(path.join(bundle, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "global-hooks"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "..", "scripts", "install-prepush.mjs"), path.join(bundle, "scripts", "install-prepush.mjs"));
  fs.copyFileSync(path.join(import.meta.dirname, "..", "global-hooks", "native-git-hook.mjs"), path.join(bundle, "global-hooks", "native-git-hook.mjs"));
  fs.copyFileSync(path.join(import.meta.dirname, "..", "global-hooks", "is-main.mjs"), path.join(bundle, "global-hooks", "is-main.mjs"));

  const execution = spawnSync(process.execPath, [path.join(bundle, "scripts", "install-prepush.mjs"), "--status"], {
    cwd: ws,
    encoding: "utf8"
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.notEqual(execution.stdout.trim(), "", "the CLI must not silently no-op when its module path has spaces");
  const status = JSON.parse(execution.stdout);
  assert.equal(status.ok, true);
  assert.equal(status.installed, false);
});

test("v1 dispatcher migrates under the native lock without becoming the v2 original", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-v1-migrate-"));
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const legacyLocalPath = path.join(hooksDir, LEGACY_LOCAL_HOOK_NAME);
  const originalPath = path.join(hooksDir, ORIGINAL_HOOK_NAME);
  const v1 = `#!/bin/sh\n${LEGACY_NATIVE_HOOK_MARKER}\nexit 0\n`;
  const userHook = "#!/bin/sh\necho user-hook >/dev/null\n";
  fs.writeFileSync(hookPath, v1, { mode: 0o755 });
  fs.writeFileSync(legacyLocalPath, userHook, { mode: 0o755 });

  const installed = ensureNativePrePushHook(ws, { runtimePath: path.join(ws, "runtime.mjs") });
  assert.equal(installed.ok, true);
  assert.equal(installed.migratedFromV1, true);
  assert.equal(installed.beforeState.sha256.length, 64);
  assert.equal(installed.afterState.sha256.length, 64);
  assert.match(fs.readFileSync(hookPath, "utf8"), new RegExp(NATIVE_HOOK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(fs.readFileSync(originalPath, "utf8"), /peerBench managed native pre-push dispatcher v1/,
    "the obsolete dispatcher is never chained as the user's original");
  assert.equal(fs.readFileSync(originalPath, "utf8"), userHook);
  assert.equal(fs.existsSync(legacyLocalPath), false);

  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.ok, true);
  assert.equal(removed.restored, true);
  assert.equal(fs.readFileSync(hookPath, "utf8"), userHook);
  assert.equal(fs.existsSync(originalPath), false);
  assert.doesNotMatch(fs.readFileSync(hookPath, "utf8"), /peerBench managed native pre-push dispatcher v1/);
});

test("v1 without pre-push.local migrates to v2 and uninstall never restores v1", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-v1-empty-"));
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  fs.writeFileSync(hookPath, `#!/bin/sh\n${LEGACY_NATIVE_HOOK_MARKER}\nexit 0\n`, { mode: 0o755 });

  const installed = ensureNativePrePushHook(ws, { runtimePath: path.join(ws, "runtime.mjs") });
  assert.equal(installed.ok, true);
  assert.equal(installed.migratedFromV1, true);
  assert.equal(fs.existsSync(path.join(hooksDir, ORIGINAL_HOOK_NAME)), false);
  assert.equal(fs.existsSync(path.join(hooksDir, LEGACY_LOCAL_HOOK_NAME)), false);
  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.ok, true);
  assert.equal(removed.restored, false);
  assert.equal(fs.existsSync(hookPath), false);
  assert.equal(fs.existsSync(path.join(hooksDir, LEGACY_LOCAL_HOOK_NAME)), false);
});

test("native uninstall preserves a later unmanaged hook replacement", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-v2-conflict-"));
  git(ws, "init", "-q", "-b", "main");
  const hooksDir = git(ws, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: path.join(ws, "runtime.mjs") }).ok, true);
  const replacement = "#!/bin/sh\necho later replacement\n";
  fs.writeFileSync(hookPath, replacement, { mode: 0o755 });

  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.changed, false);
  assert.equal(fs.readFileSync(hookPath, "utf8"), replacement);
});
