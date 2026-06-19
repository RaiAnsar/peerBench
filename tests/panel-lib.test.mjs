// tests/panel-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseVerdict, combinePanel, untrackedBlock } from "../global-hooks/panel-lib.mjs";

test("untrackedBlock embeds a real untracked file but NEVER follows a symlink out of the workspace", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ub-")));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "real.txt"), "REAL_UNTRACKED_CONTENT");
  const secret = path.join(os.tmpdir(), `ub-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, "TOP_SECRET_SHOULD_NOT_LEAK");
  fs.symlinkSync(secret, path.join(ws, "leak.txt"));   // untracked symlink pointing OUTSIDE the workspace
  const out = untrackedBlock(ws);
  assert.match(out, /REAL_UNTRACKED_CONTENT/, "the real untracked file content is included");
  assert.doesNotMatch(out, /TOP_SECRET_SHOULD_NOT_LEAK/, "symlink target content must NOT leak");
  assert.match(out, /symlink skipped/, "the symlink is reported as skipped");
});

test("parseVerdict extracts ALLOW/BLOCK/null", () => {
  assert.equal(parseVerdict("ALLOW: fine\nmore").verdict, "ALLOW");
  assert.equal(parseVerdict("BLOCK: broken\n- a").verdict, "BLOCK");
  assert.equal(parseVerdict("something weird").verdict, null);
  assert.equal(parseVerdict("").verdict, null);
});

test("combinePanel: both allow", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: also ok", raw: "ALLOW: also ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Codex.*ok/);
  assert.match(r.summary, /Kimi.*also ok/);
});

test("combinePanel: either blocks -> block with labeled findings", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- finding" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.findings, /\[Kimi\]/);
  assert.doesNotMatch(r.findings, /\[Codex\]/);
});

test("combinePanel: one errored -> working reviewer decides, note attached", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", error: "no api key" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Kimi review skipped/);
});

test("combinePanel: both errored -> fail open", () => {
  const r = combinePanel([{ name: "Codex", error: "quota" }, { name: "Kimi", error: "down" }]);
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
