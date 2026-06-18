// tests/panel-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseVerdict, combinePanel, grokGateEnv, buildGrokGateArgs, runGrokReview } from "../global-hooks/panel-lib.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function commitAll(dir, msg = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: dir });
}

test("parseVerdict extracts ALLOW/BLOCK/null", () => {
  assert.equal(parseVerdict("ALLOW: fine\nmore").verdict, "ALLOW");
  assert.equal(parseVerdict("BLOCK: broken\n- a").verdict, "BLOCK");
  assert.equal(parseVerdict("something weird").verdict, null);
  assert.equal(parseVerdict("").verdict, null);
});

test("combinePanel: both allow", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: also ok", raw: "ALLOW: also ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Codex.*ok/);
  assert.match(r.summary, /Grok.*also ok/);
});

test("combinePanel: either blocks -> block with labeled findings", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Grok", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- finding" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.findings, /\[Grok\]/);
  assert.doesNotMatch(r.findings, /\[Codex\]/);
});

test("combinePanel: one errored -> working reviewer decides, note attached", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Grok", error: "grok not on PATH" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Grok review skipped/);
});

test("combinePanel: both errored -> fail open", () => {
  const r = combinePanel([{ name: "Codex", error: "quota" }, { name: "Grok", error: "down" }]);
  assert.equal(r.decision, "fail-open");
});

test("combinePanel: single reviewer (array of 1) allows", () => {
  const r = combinePanel([{ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: fine", raw: "ALLOW: fine" }]);
  assert.equal(r.decision, "allow");
});
test("combinePanel: N=3 with one error, one block -> block", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: a", raw: "ALLOW: a" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" },
    { name: "Extra", error: "boom" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.summary, /MiMo: BLOCK/);
});

test("grokGateEnv strips codex plugin vars", () => {
  const env = grokGateEnv({
    PATH: "/bin",
    CLAUDE_PLUGIN_DATA: "/codex-data",
    CODEX_COMPANION_SESSION_ID: "x",
    HOME: "/Users/rai"
  });
  assert.equal(env.CLAUDE_PLUGIN_DATA, undefined);
  assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/Users/rai");
});

test("buildGrokGateArgs adds --sandbox only when profile set", () => {
  assert.ok(!buildGrokGateArgs({}).includes("--sandbox"));
  const withProfile = buildGrokGateArgs({ GROK_SANDBOX_PROFILE: "readonly" });
  const idx = withProfile.indexOf("--sandbox");
  assert.notEqual(idx, -1);
  assert.equal(withProfile[idx + 1], "readonly");
});

test("runGrokReview detects NEW file creation -> error side", async () => {
  const ws = tmpGitRepo();
  const res = await runGrokReview({
    prompt: "review",
    cwd: ws,
    env: {
      ...process.env,
      GROK_BIN: path.join(FIXTURES, "fake-grok"),
      FAKE_GROK_LOG: "/dev/null",
      FAKE_GROK_TOUCH: path.join(ws, "SHOULD_NOT_EXIST")
    }
  });
  assert.equal(res.name, "Grok");
  assert.match(String(res.error), /mutated/i);
});

test("runGrokReview detects content change to ALREADY-DIRTY file -> error side", async () => {
  // This is the plan-file gate's exact situation: the plan md was just
  // written, so it is already dirty when the review starts. A status-only
  // check would miss Grok rewriting it; the content fingerprint must not.
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "plan.md"), "v1\n");
  commitAll(ws);
  fs.writeFileSync(path.join(ws, "plan.md"), "v2 dirty before review\n");
  const res = await runGrokReview({
    prompt: "review",
    cwd: ws,
    env: {
      ...process.env,
      GROK_BIN: path.join(FIXTURES, "fake-grok"),
      FAKE_GROK_LOG: "/dev/null",
      FAKE_GROK_TOUCH: path.join(ws, "plan.md")
    }
  });
  assert.match(String(res.error), /mutated/i);
});

test("runGrokReview detects rewrite of a PRE-EXISTING untracked file -> error side", async () => {
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "notes.txt"), "original untracked\n");
  const res = await runGrokReview({
    prompt: "review", cwd: ws,
    env: { ...process.env, GROK_BIN: path.join(FIXTURES, "fake-grok"), FAKE_GROK_LOG: "/dev/null", FAKE_GROK_TOUCH: path.join(ws, "notes.txt") }
  });
  assert.match(String(res.error), /mutated/i);
});

test("runGrokReview prepends the no-tools preamble to grok's prompt", async () => {
  const ws = tmpGitRepo();
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pl-log-")), "argv.log");
  await runGrokReview({
    prompt: "REVIEW_BODY_MARKER",
    cwd: ws,
    env: { ...process.env, GROK_BIN: path.join(FIXTURES, "fake-grok"), FAKE_GROK_LOG: log }
  });
  const logged = fs.readFileSync(log, "utf8");
  assert.match(logged, /Do NOT use any tools/);
  assert.match(logged, /REVIEW_BODY_MARKER/);
});

test("runGrokReview happy path via fake grok", async () => {
  const ws = tmpGitRepo();
  const res = await runGrokReview({
    prompt: "review",
    cwd: ws,
    env: { ...process.env, GROK_BIN: path.join(FIXTURES, "fake-grok"), FAKE_GROK_LOG: "/dev/null" }
  });
  assert.equal(res.verdict, "ALLOW");
});
