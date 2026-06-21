// tests/bench-runner.test.mjs
// C3 (reviewers bad-name → stdout Error + exit 1), D2b (setup gate-registration status),
// D4 (status <id> expands a trace) for scripts/bench-runner.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate BENCH_ROOT before importing so trace/config writes never touch real data.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-root-"));

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewersCommand, setupStatus, statusCommand, huntCommand, gradeCommand } from "../scripts/bench-runner.mjs";
import { resolveConfig, workspaceStateDir } from "../global-hooks/config-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/bench-runner.mjs", import.meta.url));

// Build an isolated git workspace with a committed change and a config that
// selects a single reviewer (kimi) with NO api key → deterministic fail-open.
function reviewSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-review-root-"));
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi"] }));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "br-review-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: ws });
  spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "a.txt"), "v1\n");
  spawnSync("git", ["add", "-A"], { cwd: ws });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "a.txt"), "v2 changed\n");
  const env = { ...process.env, BENCH_ROOT: root };
  delete env.KIMI_API_KEY; delete env.MIMO_API_KEY; delete env.GLM_API_KEY;
  return { ws, env };
}

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "br-ws-"));
}

// Capture process.stdout.write for the duration of fn().
function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk, ...a) => { out += chunk; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

// ── C3: /bench:reviewers <bad> must surface an error to stdout + exit 1 ───────
test("C3: reviewersCommand(bogus) → stdout Error, exitCode 1, list unchanged", () => {
  const before = resolveConfig().reviewers.slice();
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = captureStdout(() => reviewersCommand(["bogusname"]));
  assert.match(out, /Error:/);
  assert.equal(process.exitCode, 1);
  const after = resolveConfig().reviewers;
  assert.deepEqual(after, before, "reviewer list must be unchanged after a bad set");
  process.exitCode = prevExit;
});

test("C3: reviewersCommand(valid) still sets without error", () => {
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = captureStdout(() => reviewersCommand(["kimi"]));
  assert.doesNotMatch(out, /Error:/);
  assert.match(out, /Reviewers set to/i);
  assert.notEqual(process.exitCode, 1);
  process.exitCode = prevExit;
});

// ── D4: /bench:status <id> expands a stored trace ────────────────────────────
test("D4: statusCommand(ws, [id]) prints the trace's reviewers + prompts", () => {
  const ws = freshWs();
  const id = writeTrace(ws, {
    gate: "review", ws,
    reviewers: [{ name: "kimi", verdict: "ALLOW" }, { name: "mimo", verdict: "BLOCK" }],
    systemPrompt: "SYS-PROMPT-MARKER",
    userPrompt: "USER-PROMPT-MARKER",
    rawResponses: { kimi: "ALLOW: looks fine", mimo: "BLOCK: nope" }
  });
  const out = captureStdout(() => statusCommand(ws, [id]));
  assert.match(out, /kimi/);
  assert.match(out, /mimo/);
  assert.match(out, /SYS-PROMPT-MARKER/);
  assert.match(out, /USER-PROMPT-MARKER/);
  assert.match(out, /ALLOW: looks fine/);
});

test("D4: statusCommand(ws, [unknownId]) → friendly not found", () => {
  const ws = freshWs();
  const out = captureStdout(() => statusCommand(ws, ["does-not-exist"]));
  assert.match(out, /not found/i);
});

test("D4: statusCommand(ws, []) lists traces (no id → list mode)", () => {
  const ws = freshWs();
  writeTrace(ws, { gate: "hunt", ws, reviewers: [{ name: "kimi", verdict: "ALLOW" }] });
  const out = captureStdout(() => statusCommand(ws, []));
  assert.match(out, /gate:hunt/);
});

// ── D2b: setup reports per-gate registration in ~/.claude/settings.json ──────
const GATES = [
  { event: "PreToolUse", matcher: "ExitPlanMode", file: "plan-review.mjs" },
  { event: "PostToolUse", matcher: "Write|Edit", file: "plan-file-review.mjs" },
  { event: "PreToolUse", matcher: "Bash", file: "pre-push-review.mjs" },
  { event: "Stop", matcher: undefined, file: "stop-review.mjs" }
];

function writeSettings(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-")), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test("D2b: setupStatus reports all four gates as missing when settings has no hooks", () => {
  const p = writeSettings({ hooks: {} });
  const out = setupStatus(p);
  for (const g of GATES) {
    assert.match(out, new RegExp(g.file), `should mention ${g.file}`);
  }
  // None registered → each should read as missing / not registered.
  assert.match(out, /missing|not registered|absent/i);
});

test("D2b: setupStatus reports a correctly-registered gate as present", () => {
  const p = writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/.claude/hooks/stop-review.mjs"' }] }]
    }
  });
  const out = setupStatus(p);
  // The stop-review line should indicate it's registered.
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /registered|present|ok|✓/i);
});

test("D2b: a stop hook trapped in a matcher-scoped block reports as misregistered", () => {
  const p = writeSettings({
    hooks: {
      Stop: [{ matcher: "SomeTool", hooks: [{ type: "command", command: 'node "/x/.claude/hooks/stop-review.mjs"' }] }]
    }
  });
  const out = setupStatus(p);
  const stopLine = out.split("\n").find((l) => l.includes("stop-review.mjs"));
  assert.ok(stopLine, "must have a stop-review line");
  assert.match(stopLine, /misregistered|wrong|missing|not registered/i);
});

test("D2b: unreadable/malformed settings → 'unable to check' (no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-bad-"));
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, "{ this is not json");
  let out;
  assert.doesNotThrow(() => { out = setupStatus(p); });
  assert.match(out, /unable to check/i);
});

test("D2b: missing settings file → 'unable to check' (no crash)", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-settings-none-")), "nope.json");
  let out;
  assert.doesNotThrow(() => { out = setupStatus(p); });
  assert.match(out, /unable to check/i);
});

// ── F: review output leads with the verdict badge ───────────────────────────
test("F: bench-runner review human output leads with the badge", () => {
  const { ws, env } = reviewSandbox();
  const res = spawnSync(process.execPath, [RUNNER, "review"], { cwd: ws, env, encoding: "utf8" });
  const resultLine = res.stdout.split("\n").find((l) => l.startsWith("Result:"));
  assert.ok(resultLine, `must have a Result line; got: ${res.stdout}`);
  assert.match(resultLine, /\[Kimi!\]/, `Result line should lead with the badge; got: ${resultLine}`);
});

test("F: bench-runner review --json includes the badge", () => {
  const { ws, env } = reviewSandbox();
  const res = spawnSync(process.execPath, [RUNNER, "review", "--json"], { cwd: ws, env, encoding: "utf8" });
  const obj = JSON.parse(res.stdout.trim().split("\n").pop());
  assert.equal(obj.badge, "Kimi!", `--json must include badge; got: ${JSON.stringify(obj)}`);
});

// ── Task 9 — D3: trace-write failures emit a ⛩ note and still produce output ──

test("D3: huntCommand trace-write failure emits a ⛩ note and still returns findings", async () => {
  const ws = freshWs();
  const stderrChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  let out;
  try {
    out = await huntCommand(ws, "some symptom", {
      huntImpl: async () => [{ name: "Kimi", findings: "found a bug at x:1" }],
      writeTraceImpl: () => { throw new Error("disk full"); }
    });
  } finally {
    process.stderr.write = origErr;
  }
  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  assert.match(out, /found a bug at x:1/, "must still return the findings despite the trace failure");
});

test("D3: review trace-write failure emits a ⛩ note and still allows (subprocess)", () => {
  const { ws, env } = reviewSandbox();
  // Force writeTrace to throw inside the subprocess: plant a FILE where the
  // traces/ directory should be so mkdirSync(recursive) throws EEXIST.
  const stateDir = workspaceStateDir(ws);   // computed with this process's BENCH_ROOT...
  // ...but the subprocess uses env.BENCH_ROOT (from reviewSandbox). Recompute under that root.
  const prevRoot = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = env.BENCH_ROOT;
  let subStateDir;
  try { subStateDir = workspaceStateDir(ws); } finally { process.env.BENCH_ROOT = prevRoot; }
  fs.mkdirSync(subStateDir, { recursive: true });
  fs.writeFileSync(path.join(subStateDir, "traces"), "i am a file, not a dir");

  const res = spawnSync(process.execPath, [RUNNER, "review"], { cwd: ws, env, encoding: "utf8" });
  assert.match(res.stderr, /⛩ .*trace write failed/i, `expected a ⛩ trace-write-failed note on stderr; got: ${res.stderr}`);
  const resultLine = res.stdout.split("\n").find((l) => l.startsWith("Result:"));
  assert.ok(resultLine, `review must still produce a Result line; got stdout=${res.stdout}`);
});

// ── grade subcommand: parse `<traceId> Reviewer:grade [...] --note --ws` ──────
test("gradeCommand parses pairs + note via the recordImpl seam", () => {
  const calls = [];
  const out = captureStdout(() =>
    gradeCommand(["1782-abc", "MiMo:tp", "Kimi:fp", "--note", "leaked token caught"], { recordImpl: (e) => calls.push(e) })
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => `${c.reviewer}:${c.grade}`), ["MiMo:tp", "Kimi:fp"]);
  assert.equal(calls[0].traceId, "1782-abc");
  assert.equal(calls[0].note, "leaked token caught");
  assert.match(out, /Graded 1782-abc/);
});

test("gradeCommand with no args → usage + exit 1", () => {
  const prev = process.exitCode;
  const out = captureStdout(() => gradeCommand([], { recordImpl: () => { throw new Error("should not record"); } }));
  assert.match(out, /Usage: grade/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prev;
});

test("gradeCommand surfaces a bad grade error but keeps the good ones", () => {
  const prev = process.exitCode;
  const calls = [];
  const out = captureStdout(() =>
    gradeCommand(["t1", "MiMo:tp", "Kimi:bogus"], {
      recordImpl: (e) => { if (e.grade === "bogus") throw new Error("grade must be one of tp|fp|miss"); calls.push(e); }
    })
  );
  assert.equal(calls.length, 1, "the valid grade still records");
  assert.match(out, /Error grading 'Kimi:bogus'/);
  process.exitCode = prev;
});
