import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureNativePrePushHook,
  nativePrePushStatus,
  uninstallNativePrePushHook,
  NATIVE_HOOK_MARKER,
  NATIVE_PUSH_DISPATCH_ARG
} from "../global-hooks/native-git-hook.mjs";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-native-hook-"));
  run("git", ["init", "-q"], dir);
  return dir;
}

function fakeRuntime(dir) {
  const file = path.join(dir, "runtime.mjs");
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args[0] !== '--peerbench-native-push-dispatch-v1' || args.length !== 2) process.exit(91);",
    "const spool = args[1];",
    "const input = fs.readFileSync(path.join(spool, 'input.bin'), 'utf8');",
    "const remoteName = fs.readFileSync(path.join(spool, 'remote-name.bin'), 'utf8');",
    "const remoteUrl = fs.readFileSync(path.join(spool, 'remote-url.bin'), 'utf8');",
    "fs.appendFileSync(process.env.CAPTURE, `peerbench:${remoteName}|${remoteUrl}:${input}`);",
    "fs.rmSync(spool, { recursive: true, force: true });"
  ].join("\n"));
  return file;
}

function e2eRuntime(dir) {
  const file = path.join(dir, "e2e-runtime.mjs");
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "const args = process.argv.slice(2);",
    "const spool = args[1];",
    "const input = fs.readFileSync(path.join(spool, 'input.bin'), 'utf8');",
    "const remoteName = fs.readFileSync(path.join(spool, 'remote-name.bin'), 'utf8');",
    "const remoteUrl = fs.readFileSync(path.join(spool, 'remote-url.bin'), 'utf8');",
    "const localSha = input.trim().split(/\\s+/)[1] || '';",
    "const commitExists = Boolean(localSha) && spawnSync('git', ['cat-file', '-e', `${localSha}^{commit}`]).status === 0;",
    "fs.writeFileSync(process.env.RUNTIME_CAPTURE, JSON.stringify({ input, args, remoteName, remoteUrl, localSha, commitExists }));",
    "fs.rmSync(spool, { recursive: true, force: true });",
    "process.exit(Number(process.env.RUNTIME_EXIT || 0));"
  ].join("\n"));
  return file;
}

function commitFile(ws, name, content, message) {
  fs.writeFileSync(path.join(ws, name), content);
  run("git", ["add", name], ws);
  run("git", ["commit", "-q", "-m", message], ws);
  return run("git", ["rev-parse", "HEAD"], ws);
}

test("native pre-push installer is executable, idempotent, and honors core.hooksPath", () => {
  const ws = repo();
  const hooks = path.join(ws, "custom-hooks");
  run("git", ["config", "core.hooksPath", hooks], ws);
  const runtime = fakeRuntime(ws);

  const first = ensureNativePrePushHook(ws, { runtimePath: runtime });
  assert.equal(first.ok, true);
  assert.equal(first.installed, true);
  assert.equal(first.changed, true);
  assert.equal(fs.realpathSync.native(first.hooksDir), fs.realpathSync.native(hooks));
  assert.match(fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), new RegExp(NATIVE_HOOK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok((fs.statSync(path.join(hooks, "pre-push")).mode & 0o111) !== 0);

  const second = ensureNativePrePushHook(ws, { runtimePath: runtime });
  assert.equal(second.changed, false);
  assert.equal(nativePrePushStatus(ws).installed, true);

  fs.chmodSync(path.join(hooks, "pre-push"), 0o644);
  const unhealthy = nativePrePushStatus(ws);
  assert.equal(unhealthy.installed, false);
  assert.equal(unhealthy.managed, true);
  assert.match(unhealthy.reason, /not executable/);
  const repaired = ensureNativePrePushHook(ws, { runtimePath: runtime });
  assert.equal(repaired.installed, true);
  assert.ok((fs.statSync(path.join(hooks, "pre-push")).mode & 0o111) !== 0);
});

test("dispatcher buffers stdin once, runs an existing user hook first, and uninstall restores it", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const original = path.join(hooks, "pre-push");
  const capture = path.join(ws, "capture.txt");
  fs.writeFileSync(original, "#!/bin/sh\ninput=$(cat)\nprintf 'local:%s:%s\\n' \"$1\" \"$input\" >> \"$CAPTURE\"\n");
  fs.chmodSync(original, 0o755);
  const runtime = fakeRuntime(ws);

  const installed = ensureNativePrePushHook(ws, { runtimePath: runtime });
  assert.equal(installed.chained, true);
  assert.ok(fs.existsSync(path.join(hooks, "pre-push.local")));

  const tuple = `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n`;
  const invoked = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
    cwd: ws, input: tuple, encoding: "utf8", env: { ...process.env, CAPTURE: capture }
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  const seen = fs.readFileSync(capture, "utf8");
  assert.match(seen, /local:origin:refs\/heads\/main/);
  assert.match(seen, /peerbench:origin\|file:\/\/\/remote:refs\/heads\/main/);

  fs.writeFileSync(path.join(hooks, "pre-push.local"), "#!/bin/sh\nprintf 'basename:%s\\n' \"$(basename \"$0\")\" >> \"$CAPTURE\"\ncat >/dev/null\n");
  fs.chmodSync(path.join(hooks, "pre-push.local"), 0o755);
  const basenameRun = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
    cwd: ws, input: tuple, encoding: "utf8", env: { ...process.env, CAPTURE: capture }
  });
  assert.equal(basenameRun.status, 0, basenameRun.stderr);
  assert.match(fs.readFileSync(capture, "utf8"), /basename:pre-push/);

  fs.writeFileSync(path.join(hooks, "pre-push.local"), "#!/usr/bin/env sh\nprintf 'env-sh-basename:%s\\n' \"$(basename \"$0\")\" >> \"$CAPTURE\"\ncat >/dev/null\n");
  fs.chmodSync(path.join(hooks, "pre-push.local"), 0o755);
  const envShRun = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
    cwd: ws, input: tuple, encoding: "utf8", env: { ...process.env, CAPTURE: capture }
  });
  assert.equal(envShRun.status, 0, envShRun.stderr);
  assert.match(fs.readFileSync(capture, "utf8"), /env-sh-basename:pre-push/);

  fs.chmodSync(original, 0o644);
  assert.equal(nativePrePushStatus(ws).installed, false);
  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.restored, true);
  assert.doesNotMatch(fs.readFileSync(original, "utf8"), /peerBench managed/);
  assert.equal(fs.existsSync(path.join(hooks, "pre-push.local")), false);
});

test("dispatcher preserves stdin byte-for-byte for empty and multi-line streams", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const original = path.join(hooks, "pre-push");
  const localCapture = path.join(ws, "local-bytes");
  const runtimeCapture = path.join(ws, "runtime-bytes");
  fs.writeFileSync(original, "#!/bin/sh\ncat > \"$LOCAL_BYTES\"\n");
  fs.chmodSync(original, 0o755);
  const runtime = path.join(ws, "bytes-runtime.mjs");
  fs.writeFileSync(runtime, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const spool = process.argv[3];",
    "fs.writeFileSync(process.env.RUNTIME_BYTES, fs.readFileSync(path.join(spool, 'input.bin')));",
    "fs.rmSync(spool, { recursive: true, force: true });"
  ].join("\n"));
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime }).ok, true);

  for (const input of [Buffer.alloc(0), Buffer.from("one\ntwo\n\n")]) {
    const invoked = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
      cwd: ws, input, env: { ...process.env, LOCAL_BYTES: localCapture, RUNTIME_BYTES: runtimeCapture }
    });
    assert.equal(invoked.status, 0, String(invoked.stderr || ""));
    assert.deepEqual(fs.readFileSync(localCapture), input);
    assert.deepEqual(fs.readFileSync(runtimeCapture), input);
  }
});

test("dispatcher keeps credential URLs out of Node argv and preserves exact private spool bytes through physical paths", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench dispatch parent with spaces "));
  const tmpLink = path.join(ws, "tmp-link");
  fs.symlinkSync(tmpParent, tmpLink);
  const capture = path.join(ws, "dispatch-capture.json");
  const runtime = path.join(ws, "dispatch capture runtime.mjs");
  fs.writeFileSync(runtime, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const spool = args[1];",
    "const names = ['dispatch-sentinel.json', 'input.bin', 'remote-name.bin', 'remote-url.bin'];",
    "const sentinel = JSON.parse(fs.readFileSync(path.join(spool, 'dispatch-sentinel.json'), 'utf8'));",
    "let ownerAlive = false;",
    "try { process.kill(sentinel.ownerPid, 0); ownerAlive = true; } catch {}",
    "const files = Object.fromEntries(names.map((name) => {",
    "  const file = path.join(spool, name);",
    "  return [name, { mode: fs.lstatSync(file).mode & 0o777, bytes: fs.readFileSync(file).toString('base64') }];",
    "}));",
    "fs.writeFileSync(process.env.DISPATCH_CAPTURE, JSON.stringify({ args, spool, spoolMode: fs.lstatSync(spool).mode & 0o777, files, sentinel, ownerAlive, runtimePid: process.pid }));",
    "fs.rmSync(spool, { recursive: true, force: true });"
  ].join("\n"));
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime }).ok, true);

  const remoteName = "origin name\nsecond line";
  const remoteUrl = "https://user:top-secret@example.invalid/repo path?x=a&y=b\nfragment";
  const input = Buffer.from([0, 1, 2, 10, 13, 255, ...Buffer.from("tuple with spaces\n")]);
  const invoked = spawnSync(path.join(hooks, "pre-push"), [remoteName, remoteUrl], {
    cwd: ws,
    input,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmpLink, DISPATCH_CAPTURE: capture }
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  const seen = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(seen.args[0], NATIVE_PUSH_DISPATCH_ARG);
  assert.equal(seen.args.length, 2);
  assert.equal(seen.args.join("\n").includes("top-secret"), false);
  assert.equal(path.dirname(seen.spool), fs.realpathSync.native(tmpParent));
  assert.equal(seen.spoolMode, 0o700);
  assert.equal(seen.files["dispatch-sentinel.json"].mode, 0o600);
  assert.equal(seen.files["input.bin"].mode, 0o600);
  assert.equal(seen.files["remote-name.bin"].mode, 0o600);
  assert.equal(seen.files["remote-url.bin"].mode, 0o600);
  assert.deepEqual(Buffer.from(seen.files["input.bin"].bytes, "base64"), input);
  assert.deepEqual(Buffer.from(seen.files["remote-name.bin"].bytes, "base64"), Buffer.from(remoteName));
  assert.deepEqual(Buffer.from(seen.files["remote-url.bin"].bytes, "base64"), Buffer.from(remoteUrl));
  assert.deepEqual(
    { kind: seen.sentinel.kind, version: seen.sentinel.version },
    { kind: "peerbench-native-push-dispatch", version: 1 }
  );
  assert.equal(Number.isInteger(seen.sentinel.ownerPid) && seen.sentinel.ownerPid > 0, true);
  assert.equal(seen.sentinel.ownerPid === seen.runtimePid, false, "the sentinel owner is the sanitized shell, not its Node child");
  assert.equal(seen.ownerAlive, true, "the dispatch owner must still be alive during handoff");
  assert.equal(fs.existsSync(seen.spool), false, "the Node owner must remove the transient dispatch spool");
});

test("dispatcher fails closed when secure spool creation, writing, or chmod fails", () => {
  for (const utility of ["mktemp", "cat", "chmod"]) {
    const ws = repo();
    const bin = path.join(ws, `fail-${utility}`);
    fs.mkdirSync(bin);
    const failing = path.join(bin, utility);
    fs.writeFileSync(failing, "#!/bin/sh\nexit 97\n");
    fs.chmodSync(failing, 0o755);
    const capture = path.join(ws, "must-not-run");
    assert.equal(ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) }).ok, true);
    const hook = path.join(ws, ".git", "hooks", "pre-push");
    const invoked = spawnSync(hook, ["origin", "https://user:secret@example.invalid/repo"], {
      cwd: ws,
      input: "tuple\n",
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture }
    });
    assert.notEqual(invoked.status, 0, `${utility} failure must block`);
    assert.match(invoked.stderr, /push blocked/i);
    assert.equal(fs.existsSync(capture), false, `${utility} failure must not invoke Node`);
  }
});

test("dispatcher fails closed when Git does not supply exactly two remote arguments", () => {
  const ws = repo();
  const capture = path.join(ws, "must-not-run");
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) }).ok, true);
  const invoked = spawnSync(path.join(ws, ".git", "hooks", "pre-push"), ["origin"], {
    cwd: ws,
    input: "",
    encoding: "utf8",
    env: { ...process.env, CAPTURE: capture }
  });
  assert.notEqual(invoked.status, 0);
  assert.match(invoked.stderr, /invalid native pre-push argument set/);
  assert.equal(fs.existsSync(capture), false);
});

test("dispatcher feeds legacy runtimes a malformed nonempty sentinel instead of fail-open EOF", () => {
  const ws = repo();
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-legacy-runtime-"));
  const runtime = path.join(ws, "legacy-runtime.mjs");
  const capture = path.join(ws, "legacy-capture.json");
  fs.writeFileSync(runtime, [
    "import fs from 'node:fs';",
    "const input = fs.readFileSync(0, 'utf8');",
    "const fields = input.trim() ? input.trim().split(/\\s+/) : [];",
    "if (process.env.LEGACY_CAPTURE) fs.writeFileSync(process.env.LEGACY_CAPTURE, JSON.stringify({ input, fields, args: process.argv.slice(2) }));",
    "process.exit(input.length === 0 ? 0 : (fields.length === 4 ? 0 : 17));"
  ].join("\n"));

  const legacyEof = spawnSync(process.execPath, [runtime], { input: "", encoding: "utf8" });
  assert.equal(legacyEof.status, 0, "the legacy fixture models the old fail-open EOF behavior");
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime }).ok, true);
  const secretUrl = "https://user:legacy-secret@example.invalid/repo";
  const invoked = spawnSync(path.join(ws, ".git", "hooks", "pre-push"), ["origin", secretUrl], {
    cwd: ws,
    input: `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n`,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmpParent, LEGACY_CAPTURE: capture }
  });
  assert.equal(invoked.status, 17, "a legacy runtime must reject the malformed dispatch sentinel");
  const seen = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.match(seen.input, /peerbench-native-dispatch-protocol-v1/);
  assert.notEqual(seen.input.length, 0);
  assert.notEqual(seen.fields.length, 4, "the sentinel must never parse as a Git update tuple");
  assert.equal(seen.args.includes(secretUrl), false, "legacy compatibility must not restore credentials to argv");
  assert.deepEqual(
    fs.readdirSync(tmpParent).filter((name) => name.startsWith("peerbench-native-dispatch.")),
    [],
    "legacy rejection must clean the credential spool"
  );
});

test("dispatcher removes the credential spool when exec cannot start Node", () => {
  const ws = repo();
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-exec-fail-"));
  const brokenNode = path.join(ws, "broken-node");
  fs.writeFileSync(brokenNode, "#!/definitely/missing/peerbench-interpreter\n");
  fs.chmodSync(brokenNode, 0o755);
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws), nodePath: brokenNode }).ok, true);

  const invoked = spawnSync(path.join(ws, ".git", "hooks", "pre-push"), [
    "origin",
    "https://user:credential@example.invalid/repo"
  ], {
    cwd: ws,
    input: "tuple\n",
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmpParent, CAPTURE: path.join(ws, "must-not-run") }
  });
  assert.notEqual(invoked.status, 0);
  assert.match(invoked.stderr, /push blocked|not found|no such file/i);
  assert.deepEqual(
    fs.readdirSync(tmpParent).filter((name) => name.startsWith("peerbench-native-dispatch.")),
    [],
    "failed exec must not leave remote credentials in a spool directory"
  );
});

test("dispatcher uses the embedded Node executable when hook PATH has no node", () => {
  const ws = repo();
  const runtimeCapture = path.join(ws, "restricted-path-runtime");
  const runtime = path.join(ws, "restricted-runtime.mjs");
  fs.writeFileSync(runtime, [
    "import fs from 'node:fs';",
    "const spool = process.argv[3];",
    "fs.writeFileSync(process.env.RUNTIME_CAPTURE, 'ran');",
    "fs.rmSync(spool, { recursive: true, force: true });"
  ].join("\n"));
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime, nodePath: process.execPath }).ok, true);
  const hook = path.join(ws, ".git", "hooks", "pre-push");
  const invoked = spawnSync(hook, ["origin", "file:///remote"], {
    cwd: ws,
    input: Buffer.alloc(0),
    env: { ...process.env, PATH: "/usr/bin:/bin", RUNTIME_CAPTURE: runtimeCapture },
    encoding: "utf8"
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(fs.readFileSync(runtimeCapture, "utf8"), "ran");
});

test("installer refuses to overwrite when both an unmanaged hook and pre-push.local exist", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(hooks, "pre-push.local"), "#!/bin/sh\nexit 0\n");
  const result = ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to overwrite/);
  assert.doesNotMatch(fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), /peerBench managed/);
});

test("installer refuses to activate a dormant pre-push.local when no pre-push hook exists", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const local = path.join(hooks, "pre-push.local");
  fs.writeFileSync(local, "#!/bin/sh\nexit 23\n");
  fs.chmodSync(local, 0o755);
  const result = ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to activate/);
  assert.equal(fs.existsSync(path.join(hooks, "pre-push")), false);
  assert.equal(fs.readFileSync(local, "utf8"), "#!/bin/sh\nexit 23\n");
});

test("installer and uninstall preserve a broken pre-push symlink exactly", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const hook = path.join(hooks, "pre-push");
  const local = path.join(hooks, "pre-push.local");
  const linkTarget = "../missing/pre-push-target";
  fs.symlinkSync(linkTarget, hook);

  const before = nativePrePushStatus(ws);
  assert.equal(before.occupied, true);
  assert.equal(before.managed, false);

  const installed = ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) });
  assert.equal(installed.ok, true);
  assert.equal(installed.chained, true);
  assert.equal(fs.lstatSync(local).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(local), linkTarget);

  const removed = uninstallNativePrePushHook(ws);
  assert.equal(removed.ok, true);
  assert.equal(removed.restored, true);
  assert.equal(fs.lstatSync(hook).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(hook), linkTarget);
  assert.equal(fs.existsSync(local), false);
});

test("dispatcher executes shebang-option hooks directly so their failure semantics are preserved", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const original = path.join(hooks, "pre-push");
  const runtimeCapture = path.join(ws, "runtime-ran");
  fs.writeFileSync(original, "#!/bin/sh -e\nfalse\nprintf should-not-run\n");
  fs.chmodSync(original, 0o755);
  const runtime = path.join(ws, "runtime-options.mjs");
  fs.writeFileSync(runtime, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(runtimeCapture)}, "ran"); fs.rmSync(process.argv[3], { recursive: true, force: true });\n`);
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime }).ok, true);

  const invoked = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
    cwd: ws,
    input: "",
    encoding: "utf8"
  });
  assert.notEqual(invoked.status, 0);
  assert.equal(fs.existsSync(runtimeCapture), false, "peerBench must not run after the existing hook rejects the push");
});

test("real git push supplies exact post-commit tuples, chains identical stdin, and blocks rejected updates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-native-push-e2e-"));
  const remote = path.join(root, "remote.git");
  const ws = path.join(root, "work");
  fs.mkdirSync(ws);
  run("git", ["init", "--bare", "-q", remote], root);
  run("git", ["init", "-q"], ws);
  run("git", ["config", "user.name", "peerBench test"], ws);
  run("git", ["config", "user.email", "peerbench@example.invalid"], ws);
  run("git", ["checkout", "-q", "-b", "main"], ws);
  run("git", ["remote", "add", "origin", remote], ws);

  const hooks = path.join(ws, ".git", "hooks");
  const originalHook = path.join(hooks, "pre-push");
  fs.writeFileSync(originalHook, "#!/bin/sh\ncat > \"$LOCAL_CAPTURE\"\n");
  fs.chmodSync(originalHook, 0o755);
  const installed = ensureNativePrePushHook(ws, { runtimePath: e2eRuntime(root) });
  assert.equal(installed.ok, true);
  assert.equal(installed.chained, true);

  const zero = "0".repeat(40);
  const firstSha = commitFile(ws, "first.txt", "first\n", "first");
  const firstLocalCapture = path.join(root, "first-local.txt");
  const firstRuntimeCapture = path.join(root, "first-runtime.json");
  const firstPush = spawnSync("git", ["push", "origin", "main"], {
    cwd: ws,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCAL_CAPTURE: firstLocalCapture,
      RUNTIME_CAPTURE: firstRuntimeCapture,
      RUNTIME_EXIT: "0"
    }
  });
  assert.equal(firstPush.status, 0, firstPush.stderr || firstPush.stdout);
  const firstExpected = `refs/heads/main ${firstSha} refs/heads/main ${zero}\n`;
  const firstSeen = JSON.parse(fs.readFileSync(firstRuntimeCapture, "utf8"));
  assert.equal(firstSeen.input, firstExpected);
  assert.equal(fs.readFileSync(firstLocalCapture, "utf8"), firstSeen.input);
  assert.equal(firstSeen.args[0], NATIVE_PUSH_DISPATCH_ARG);
  assert.equal(firstSeen.args.length, 2);
  assert.equal(firstSeen.remoteName, "origin");
  assert.equal(firstSeen.remoteUrl, remote);
  assert.equal(firstSeen.args.includes(remote), false, "the remote URL must not remain in Node argv");
  assert.equal(firstSeen.localSha, firstSha);
  assert.equal(firstSeen.commitExists, true, "the commit must already exist when pre-push runs");
  assert.equal(run("git", ["rev-parse", "refs/heads/main"], remote), firstSha);

  const secondSha = commitFile(ws, "second.txt", "second\n", "second");
  const secondLocalCapture = path.join(root, "second-local.txt");
  const secondRuntimeCapture = path.join(root, "second-runtime.json");
  const blockedPush = spawnSync("git", ["push", "origin", "main"], {
    cwd: ws,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCAL_CAPTURE: secondLocalCapture,
      RUNTIME_CAPTURE: secondRuntimeCapture,
      RUNTIME_EXIT: "23"
    }
  });
  assert.notEqual(blockedPush.status, 0);
  assert.match(blockedPush.stderr, /failed to push/);
  const secondExpected = `refs/heads/main ${secondSha} refs/heads/main ${firstSha}\n`;
  const secondSeen = JSON.parse(fs.readFileSync(secondRuntimeCapture, "utf8"));
  assert.equal(secondSeen.input, secondExpected);
  assert.equal(fs.readFileSync(secondLocalCapture, "utf8"), secondSeen.input);
  assert.equal(secondSeen.args[0], NATIVE_PUSH_DISPATCH_ARG);
  assert.equal(secondSeen.args.length, 2);
  assert.equal(secondSeen.remoteName, "origin");
  assert.equal(secondSeen.remoteUrl, remote);
  assert.equal(secondSeen.args.includes(remote), false, "the remote URL must not remain in Node argv");
  assert.equal(secondSeen.localSha, secondSha);
  assert.equal(secondSeen.commitExists, true, "the rejected commit must exist before review");
  assert.equal(run("git", ["rev-parse", "refs/heads/main"], remote), firstSha, "rejection must leave the remote unchanged");

  const bypassSha = commitFile(ws, "bypass.txt", "bypass\n", "bypass");
  const bypassLocalCapture = path.join(root, "bypass-local.txt");
  const bypassRuntimeCapture = path.join(root, "bypass-runtime.json");
  const bypassedPush = spawnSync("git", ["push", "origin", "main"], {
    cwd: ws,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCAL_CAPTURE: bypassLocalCapture,
      RUNTIME_CAPTURE: bypassRuntimeCapture,
      RUNTIME_EXIT: "23",
      BENCH_NATIVE_PUSH_BYPASS: "1"
    }
  });
  assert.equal(bypassedPush.status, 0, bypassedPush.stderr || bypassedPush.stdout);
  assert.equal(fs.existsSync(bypassLocalCapture), true, "the user's existing hook still runs");
  assert.equal(fs.existsSync(bypassRuntimeCapture), false, "peerBench runtime is the only hook bypassed");
  assert.equal(run("git", ["rev-parse", "refs/heads/main"], remote), bypassSha);
});

test("concurrent installs never rename the dispatcher over an existing pre-push chain", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const hookPath = path.join(hooks, "pre-push");
  const localPath = path.join(hooks, "pre-push.local");
  const original = "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(hookPath, original);
  fs.chmodSync(hookPath, 0o755);
  const runtime = fakeRuntime(ws);

  // Interleave a full competing install between this install's status read and its hook rename —
  // exactly the window two simultaneous installers hit. Match on basenames because git may report
  // the hooks dir through a different symlink prefix than os.tmpdir().
  let interleaved = false;
  let competitor = null;
  const racingFs = Object.create(fs);
  racingFs.renameSync = (from, to) => {
    if (!interleaved && path.basename(from) === "pre-push" && path.basename(to) === "pre-push.local") {
      interleaved = true;
      competitor = ensureNativePrePushHook(ws, { runtimePath: runtime, lock: { attempts: 3, sleepMs: 1 } });
    }
    return fs.renameSync(from, to);
  };
  const installed = ensureNativePrePushHook(ws, { runtimePath: runtime, fsImpl: racingFs });
  assert.equal(interleaved, true);
  assert.equal(competitor.ok, false);
  assert.match(competitor.reason, /busy/);
  assert.equal(installed.ok, true);
  assert.equal(installed.chained, true);
  assert.equal(fs.readFileSync(localPath, "utf8"), original, "the user's hook must survive the race");
  assert.match(fs.readFileSync(hookPath, "utf8"), /peerBench managed/);
  assert.doesNotMatch(fs.readFileSync(localPath, "utf8"), /peerBench managed/, "the dispatcher must not chain itself");
});

test("install refuses to run while another installer holds the lock", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const hookPath = path.join(hooks, "pre-push");
  const original = "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(hookPath, original);
  fs.chmodSync(hookPath, 0o755);
  fs.mkdirSync(path.join(hooks, "pre-push.peerbench-install.lock"));

  const result = ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws), lock: { attempts: 3, sleepMs: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /busy/);
  assert.equal(fs.readFileSync(hookPath, "utf8"), original, "a busy install must not touch the hooks");
  assert.equal(fs.existsSync(path.join(hooks, "pre-push.local")), false);
  fs.rmdirSync(path.join(hooks, "pre-push.peerbench-install.lock"));
});

test("install steals a stale install lock left by a crashed installer", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const lockDir = path.join(hooks, "pre-push.peerbench-install.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const crashed = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, crashed, crashed);

  const result = ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws), lock: { staleMs: 30_000, attempts: 5, sleepMs: 1 } });
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.equal(fs.existsSync(lockDir), false, "the lock is released after install");
});

test("dispatcher restores the caller's umask before running a chained hook", () => {
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const capture = path.join(ws, "umask-capture");
  fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\numask > \"$UMASK_CAPTURE\"\ncat >/dev/null\n");
  fs.chmodSync(path.join(hooks, "pre-push"), 0o755);
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: fakeRuntime(ws) }).ok, true);

  const invoked = spawnSync("/bin/sh", ["-c", "umask 022; exec \"$0\" origin file:///remote", path.join(hooks, "pre-push")], {
    cwd: ws,
    input: "",
    encoding: "utf8",
    env: { ...process.env, CAPTURE: path.join(ws, "runtime-capture"), UMASK_CAPTURE: capture }
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(Number.parseInt(fs.readFileSync(capture, "utf8").trim(), 8), 0o022);
});

test("dispatcher preserves $0 for chained zsh hooks", (t) => {
  if (spawnSync("/bin/zsh", ["-c", "true"]).status !== 0) return t.skip("zsh is not available");
  const ws = repo();
  const hooks = path.join(ws, ".git", "hooks");
  const capture = path.join(ws, "zsh-basename");
  const runtime = fakeRuntime(ws);
  assert.equal(ensureNativePrePushHook(ws, { runtimePath: runtime }).ok, true);

  for (const shebang of ["#!/bin/zsh", "#!/usr/bin/env zsh"]) {
    fs.writeFileSync(path.join(hooks, "pre-push.local"), `${shebang}\nprintf 'zsh-basename:%s\\n' "$(basename "$0")" > "$ZSH_CAPTURE"\ncat >/dev/null\n`);
    fs.chmodSync(path.join(hooks, "pre-push.local"), 0o755);
    const invoked = spawnSync(path.join(hooks, "pre-push"), ["origin", "file:///remote"], {
      cwd: ws,
      input: "",
      encoding: "utf8",
      env: { ...process.env, CAPTURE: path.join(ws, "runtime-capture"), ZSH_CAPTURE: capture }
    });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.match(fs.readFileSync(capture, "utf8"), /^zsh-basename:pre-push$/m);
  }
});

test("install-prepush --status exits nonzero until the dispatcher is installed", () => {
  const ws = repo();
  const script = path.resolve("scripts/install-prepush.mjs");
  const missing = spawnSync(process.execPath, [script, "--status"], { cwd: ws, encoding: "utf8" });
  assert.equal(missing.status, 1, missing.stderr || missing.stdout);
  assert.equal(spawnSync(process.execPath, [script], { cwd: ws, encoding: "utf8" }).status, 0);
  const installed = spawnSync(process.execPath, [script, "--status"], { cwd: ws, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
});
