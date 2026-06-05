// tests/grok-exec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGrokArgs, runGrok, READONLY_DENY_TOOLS } from "../scripts/lib/grok-exec.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ge-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function commitAll(dir, msg = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: dir });
}

function shimEnv(log, extra = {}) {
  return {
    ...process.env,
    GROK_BIN: path.join(FIXTURES, "fake-grok"),
    FAKE_GROK_LOG: log,
    ...extra
  };
}

test("buildGrokArgs review mode includes full read-only stack", () => {
  const s = buildGrokArgs({ mode: "review", prompt: "P", cwd: "/ws" }, {}).join(" ");
  assert.ok(s.includes("--permission-mode plan"));
  assert.ok(s.includes(`--disallowed-tools ${READONLY_DENY_TOOLS.join(",")}`));
  assert.ok(s.includes("--no-subagents"));
  assert.ok(s.includes("--disable-web-search"));
  assert.ok(s.includes("--max-turns 8"));
  assert.ok(s.includes("--effort medium"));
  assert.ok(s.includes("--output-format json"));
  assert.ok(!s.includes("--sandbox"));
});

test("buildGrokArgs adds --sandbox when GROK_SANDBOX_PROFILE set", () => {
  const s = buildGrokArgs({ mode: "review", prompt: "P", cwd: "/ws" }, { GROK_SANDBOX_PROFILE: "readonly" }).join(" ");
  assert.ok(s.includes("--sandbox readonly"));
});

test("buildGrokArgs write mode omits read-only stack, raises turns", () => {
  const s = buildGrokArgs({ mode: "write", prompt: "P", cwd: "/ws" }, {}).join(" ");
  assert.ok(!s.includes("--permission-mode plan"));
  assert.ok(!s.includes("--disallowed-tools"));
  assert.ok(s.includes("--max-turns 40"));
});

test("runGrok parses fake grok JSON", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ge-")), "argv.log");
  const ws = tmpGitRepo();
  const res = await runGrok({ mode: "review", prompt: "review this", cwd: ws }, { env: shimEnv(log) });
  assert.equal(res.status, 0);
  assert.equal(res.rawOutput, "ALLOW: looks fine");
  assert.equal(res.sessionId, "fake-session-1");
  assert.match(fs.readFileSync(log, "utf8"), /--permission-mode plan/);
});

test("runGrok review mode detects NEW file creation -> failure", async () => {
  const ws = tmpGitRepo();
  const res = await runGrok(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_GROK_TOUCH: path.join(ws, "SHOULD_NOT_EXIST") }) }
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runGrok review mode detects content change to ALREADY-DIRTY file -> failure", async () => {
  // The git-status-only check would miss this: the file is dirty both before
  // and after, so porcelain output is identical. Content fingerprint catches it.
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "doc.md"), "v1\n");
  commitAll(ws);
  fs.writeFileSync(path.join(ws, "doc.md"), "v2 dirty before review\n"); // dirty pre-review
  const res = await runGrok(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_GROK_TOUCH: path.join(ws, "doc.md") }) } // grok rewrites the dirty file
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runGrok review mode detects rewrite of a PRE-EXISTING untracked file -> failure", async () => {
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "notes.txt"), "original untracked\n"); // untracked, unchanged status both sides
  const res = await runGrok(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_GROK_TOUCH: path.join(ws, "notes.txt") }) }
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runGrok write mode does NOT run mutation check", async () => {
  const ws = tmpGitRepo();
  const res = await runGrok(
    { mode: "write", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_GROK_TOUCH: path.join(ws, "expected-edit.txt") }) }
  );
  assert.equal(res.status, 0);
});

test("runGrok surfaces nonzero exit as error result", async () => {
  const ws = tmpGitRepo();
  const res = await runGrok({ mode: "review", prompt: "x", cwd: ws }, { env: shimEnv("/dev/null", { FAKE_GROK_EXIT: "3" }) });
  assert.equal(res.status, 3);
  assert.equal(res.rawOutput, "");
});

test("runGrok missing binary -> error result, no throw", async () => {
  const res = await runGrok({ mode: "review", prompt: "x", cwd: "/tmp" }, { env: { ...process.env, GROK_BIN: "/nonexistent/grok" } });
  assert.notEqual(res.status, 0);
  assert.ok(res.error);
});
