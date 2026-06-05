// tests/runner.integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "scripts", "grok-runner.mjs");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  return ws;
}

function run(args, { ws = freshWs(), envExtra = {} } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const out = execFileSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    cwd: ws,
    env: {
      ...process.env,
      GROK_BIN: path.join(FIXTURES, "fake-grok"),
      CLAUDE_PLUGIN_DATA: dataRoot,
      FAKE_GROK_LOG: path.join(dataRoot, "argv.log"),
      ...envExtra
    }
  });
  return { out, dataRoot, ws };
}

test("task --json returns runner JSON and records a job", () => {
  const { out, dataRoot } = run(["task", "--json", "do the thing"]);
  const payload = JSON.parse(out);
  assert.equal(payload.status, 0);
  assert.equal(payload.rawOutput, "ALLOW: looks fine");
  assert.equal(payload.sessionId, "fake-session-1");
  const stateDirs = fs.readdirSync(path.join(dataRoot, "state"));
  assert.equal(stateDirs.length, 1);
  const jobs = fs.readdirSync(path.join(dataRoot, "state", stateDirs[0], "jobs"));
  assert.equal(jobs.length, 1);
});

test("template shape: ['task','--json','--write fix …'] — embedded flag lifted, prompt verbatim", () => {
  // Exactly what `task --json "$ARGUMENTS"` produces when the user typed
  // `/grok:task --write fix the "auth bug" in app.ts; don't touch tests`.
  const { dataRoot } = run(["task", "--json", `--write fix the "auth bug" in app.ts; don't touch tests`]);
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.doesNotMatch(log, /--permission-mode plan/); // --write recognized -> write mode
  assert.match(log, /fix the "auth bug" in app\.ts; don't touch tests/); // prompt intact incl. quotes/semicolon
  assert.doesNotMatch(log, /-p --write/); // the flag was lifted, not left in the prompt
});

test("template shape: ['review','--json','--base main'] — embedded --base recognized", () => {
  const ws = freshWs();
  fs.writeFileSync(path.join(ws, "feature.txt"), "NEEDLE_BRANCH_DIFF\n");
  execFileSync("git", ["checkout", "-qb", "feat"], { cwd: ws });
  execFileSync("git", ["add", "feature.txt"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat"], { cwd: ws });
  const { dataRoot } = run(["review", "--json", "--base main"], { ws });
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.match(log, /NEEDLE_BRANCH_DIFF/);   // base diff content reached the prompt
  assert.doesNotMatch(log, /--base main/);   // flag consumed, not leaked into prompt
});

test("task without --write runs read-only; with --write relaxes", () => {
  const a = run(["task", "--json", "investigate"]);
  assert.match(fs.readFileSync(path.join(a.dataRoot, "argv.log"), "utf8"), /--permission-mode plan/);
  const b = run(["task", "--json", "--write", "fix it"]);
  assert.doesNotMatch(fs.readFileSync(path.join(b.dataRoot, "argv.log"), "utf8"), /--permission-mode plan/);
});

test("review includes untracked file contents", () => {
  const ws = freshWs();
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "brand-new.ts"), "export const NEEDLE_UNTRACKED = 42;\n");
  const { dataRoot } = run(["review", "--json"], { ws });
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.match(log, /NEEDLE_UNTRACKED/);          // content present in prompt
  assert.match(log, /src\/brand-new\.ts/);         // labeled with its path
});

test("status prints recorded jobs", () => {
  const ws = freshWs();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const env = {
    ...process.env,
    GROK_BIN: path.join(FIXTURES, "fake-grok"),
    CLAUDE_PLUGIN_DATA: dataRoot,
    FAKE_GROK_LOG: "/dev/null"
  };
  execFileSync(process.execPath, [RUNNER, "task", "--json", "first"], { encoding: "utf8", cwd: ws, env });
  const out = execFileSync(process.execPath, [RUNNER, "status"], { encoding: "utf8", cwd: ws, env });
  assert.match(out, /Grok Task/);
  assert.match(out, /completed/);
});

test("setup reports version or missing binary without throwing", () => {
  const { out } = run(["setup"]);
  assert.match(out, /grok|GROK/i);
});
