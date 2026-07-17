import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runMain } from "../global-hooks/native-session-start.mjs";
import { readReviewedHead, writeReviewedHead } from "../global-hooks/config-store.mjs";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-root-")));

test("SessionStart arms a fresh repository before its first push", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-arm-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: ws }).status, 0);
  const result = runMain({ input: { cwd: ws, hook_event_name: "SessionStart", source: "startup" } });
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.match(fs.readFileSync(path.join(ws, ".git", "hooks", "pre-push"), "utf8"), /peerBench managed native pre-push dispatcher/);
});

test("direct Codex SessionStart records the pre-turn HEAD for the later Stop review", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-baseline-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: ws });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  assert.equal(readReviewedHead(ws), null);

  runMain({
    input: { cwd: ws, hook_event_name: "SessionStart", source: "startup" },
    ensureImpl: () => ({ ok: true, installed: true })
  });
  assert.equal(readReviewedHead(ws), head, "SessionStart supplies the baseline even when no Bash PreToolUse hook runs");

  writeReviewedHead(ws, "older-unreviewed-marker");
  runMain({ input: { cwd: ws }, ensureImpl: () => ({ ok: true, installed: true }) });
  assert.equal(readReviewedHead(ws), "older-unreviewed-marker", "an existing unreviewed baseline is never overwritten");
});

test("SessionStart does not seed reviewed-head while peerBench is disabled", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-disabled-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  runMain({
    input: { cwd: ws },
    ensureImpl: () => ({ ok: true, installed: true }),
    isBenchDisabledImpl: () => true
  });
  assert.equal(readReviewedHead(ws), null);
});

test("SessionStart is quiet outside Git and visibly reports a real install conflict", () => {
  let output = "";
  const outside = runMain({ input: { cwd: "/tmp" }, ensureImpl: () => ({ ok: false, installed: false, reason: "not a Git repository" }), stdout: (s) => { output += s; } });
  assert.equal(outside.installed, false);
  assert.equal(output, "");
  runMain({ input: { cwd: "/repo" }, ensureImpl: () => ({ ok: false, installed: false, reason: "hook conflict" }), stdout: (s) => { output += s; } });
  assert.match(JSON.parse(output).systemMessage, /hook conflict/);
});
