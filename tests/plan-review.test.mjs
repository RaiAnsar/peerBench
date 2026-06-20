import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Set BENCH_ROOT before importing any module that uses config-store.
const PR_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-root-")));
process.env.BENCH_ROOT = PR_ROOT;

import { buildPrompt, runMain, createEmitter } from "../global-hooks/plan-review.mjs";

/** Fake reviewer that always returns the given verdict. */
function prReviewer(name, verdict) {
  return {
    name,
    async run() {
      return { name, verdict, firstLine: `${verdict}: test`, raw: `${verdict}: test\n\nDetails for ${name}.` };
    }
  };
}

/** A fresh git repo so workspaceRoot resolves cleanly. */
function prRepo() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-ws-")));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}
test("plan prompt is content-only (no repo-read claim)", () => {
  const { system, user } = buildPrompt("PLAN BODY");
  assert.doesNotMatch(system, /read access|verify.*against.*code|explore the/i);
  assert.match(system, /ALLOW:|BLOCK:/);
  assert.match(user, /PLAN BODY/);
});

// F: the plan gate's permissionDecisionReason leads with the verdict badge.
// Driven via subprocess: a single configured reviewer (kimi) with NO api key
// errors → fail-open ALLOW, whose reason leads with the badge `[Kimi!]`.
test("F: plan-review fail-open reason leads with the badge", () => {
  const HOOK = fileURLToPath(new URL("../global-hooks/plan-review.mjs", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-badge-root-"));
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi"] }));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-badge-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });

  const env = { ...process.env, BENCH_ROOT: root, CLAUDE_PROJECT_DIR: ws };
  delete env.KIMI_API_KEY; delete env.MIMO_API_KEY; delete env.GLM_API_KEY;

  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env,
    input: JSON.stringify({ cwd: ws, tool_input: { plan: "do a thing" } })
  });

  const lines = result.stdout.split("\n").filter((l) => l.trim());
  const parsed = JSON.parse(lines[0]);
  const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(reason, /\[Kimi!\]/, `reason should lead with the badge; got: ${reason}`);
});

// ===========================================================================
// Task 9 — H1: invocation-scoped emit-once guard for plan-review
// ===========================================================================

test("H1: a second decision within one invocation writes no second stdout line", async () => {
  // BLOCK path emits once; if any later code path tried to emit again it'd be a 2nd line.
  const ws = prRepo();
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim());
    return orig(chunk, ...rest);
  };
  try {
    await runMain({
      resolveReviewersImpl: () => [prReviewer("Kimi", "BLOCK")],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { plan: "do a thing" } }
    });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(lines.filter(Boolean).length, 1, "exactly one decision line per invocation");
});

test("H1: two separate runMain invocations in one process each emit", async () => {
  const ws = prRepo();
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim());
    return orig(chunk, ...rest);
  };
  try {
    for (let i = 0; i < 2; i++) {
      await runMain({
        resolveReviewersImpl: () => [prReviewer("Kimi", "ALLOW")],
        writeTraceImpl: () => {},
        isBenchDisabledImpl: () => false,
        input: { cwd: ws, tool_input: { plan: "do a thing" } }
      });
    }
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(lines.filter(Boolean).length, 2, "each invocation emits its own decision line");
});

test("H1: createEmitter is invocation-scoped (emit once, then suppress; fresh emitter emits again)", () => {
  const e1 = createEmitter();
  const captured = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) captured.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    assert.equal(e1.emit({ a: 1 }), true, "first emit returns true");
    assert.equal(e1.hasEmitted(), true);
    assert.equal(e1.emit({ a: 2 }), false, "second emit on same emitter is suppressed");
    const e2 = createEmitter();
    assert.equal(e2.hasEmitted(), false, "a fresh emitter has not emitted");
    assert.equal(e2.emit({ b: 1 }), true, "fresh emitter emits again");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(captured.length, 2, "exactly two lines written (one per distinct emitter)");
});

test("H1: entrypoint .catch routes a post-emit error to stderr, never a second stdout line", () => {
  // Drive the real subprocess so the import.meta.url shim runs. With no plan content
  // the hook emits an ALLOW once; the shim must not produce a second stdout JSON line.
  const HOOK = fileURLToPath(new URL("../global-hooks/plan-review.mjs", import.meta.url));
  const ws = prRepo();
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: ws, tool_input: { plan: "" } }),
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: PR_ROOT }
  });
  const stdoutLines = result.stdout.split("\n").filter((l) => l.trim());
  assert.ok(stdoutLines.length <= 1, `no spurious stdout lines; got ${stdoutLines.length}`);
});

// ===========================================================================
// Task 9 — D3: trace-write failure emits a ⛩ note and still allows
// ===========================================================================

test("D3: plan-review trace write failure emits a ⛩ note and still allows", async () => {
  const ws = prRepo();
  const stderrChunks = [];
  const stdoutLines = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) stdoutLines.push(chunk.trim()); return origOut(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: () => [prReviewer("Kimi", "ALLOW")],
      writeTraceImpl: () => { throw new Error("disk full"); },
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { plan: "do a thing" } }
    });
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  const parsed = JSON.parse(stdoutLines.find((l) => l.trim()));
  assert.equal(parsed.hookSpecificOutput?.permissionDecision, "allow", "must still allow despite trace failure");
});
