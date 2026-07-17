import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Set BENCH_ROOT before importing any module that uses config-store.
const PR_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-root-")));
process.env.BENCH_ROOT = PR_ROOT;

import { buildPrompt, runMain, createEmitter } from "../global-hooks/plan-review.mjs";
import { normalizeSessionId } from "../global-hooks/config-store.mjs";
import { readPlanCycle, readPlanMarker } from "../global-hooks/plan-gate-state.mjs";

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
  assert.match(system, /ONE exhaustive discovery pass/i);
  assert.match(system, /never stop after the first blocker/i);
  assert.match(system, /do not impose a finding-count cap/i);
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
// Severity-gating — deny only on HIGH+; medium/low → advisory (allow + note).
// ===========================================================================

/** A reviewer that emits a given verdict + SEVERITY line in its raw. */
function prSevReviewer(name, verdict, severity) {
  return {
    name,
    async run() {
      return { name, verdict, firstLine: `${verdict}: ${name} reason`, raw: `${verdict}: ${name} reason\nSEVERITY: ${severity}\n- a finding from ${name}` };
    }
  };
}

async function runPlanCapture(reviewers) {
  const ws = prRepo();
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: () => reviewers,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { plan: "do a thing" } }
    });
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(lines.find((l) => l.trim()));
}

test("severity-gate: a MEDIUM-severity BLOCK does NOT deny the plan (allows with advisory)", async () => {
  const parsed = await runPlanCapture([prReviewer("Kimi", "ALLOW"), prSevReviewer("MiMo", "BLOCK", "medium")]);
  const out = parsed.hookSpecificOutput;
  assert.equal(out.permissionDecision, "allow", "a medium BLOCK must NOT deny");
  assert.match(out.permissionDecisionReason, /MiMo~/, "badge shows MiMo~ (advisory)");
  assert.match(parsed.systemMessage || "", /advisor/i, "an advisory note is surfaced");
});

test("severity-gate: plan-review persists per-reviewer severity in the trace (regression: parseSeverity must be imported)", async () => {
  const ws = prRepo();
  let captured = null;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await runMain({
      resolveReviewersImpl: () => [prReviewer("Kimi", "ALLOW"), prSevReviewer("MiMo", "BLOCK", "medium")],
      writeTraceImpl: (_ws, trace) => { captured = trace; },
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, session_id: "chat-A", tool_input: { plan: "do a thing" } }
    });
  } finally {
    process.stdout.write = orig;
  }
  // A missing `parseSeverity` import throws while BUILDING the trace object (inside the best-effort
  // try/catch), so the trace is silently never written — captured stays null. This asserts it IS written.
  assert.ok(captured, "a trace must be written (a missing parseSeverity import would throw → no trace)");
  assert.equal(captured.sessionKey, normalizeSessionId("chat-A"), "trace is stamped with the hook session");
  const mimo = (captured.reviewers || []).find((r) => r.name === "MiMo");
  assert.equal(mimo?.severity, "medium", "the BLOCK reviewer's severity is persisted so the statusline can render ~");
  assert.equal(mimo?.raw, undefined, "raw is stripped from the trace");
});

test("severity-gate: a HIGH-severity BLOCK still denies the plan", async () => {
  const parsed = await runPlanCapture([prReviewer("Kimi", "ALLOW"), prSevReviewer("MiMo", "BLOCK", "high")]);
  const out = parsed.hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny", "a high BLOCK must deny");
  assert.match(out.permissionDecisionReason, /MiMo✗/, "badge shows MiMo✗ (real block)");
  assert.match(out.permissionDecisionReason, /must be fixed/i, "block findings surfaced");
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

test("ExitPlanMode automatic denials stop at three across changed revisions with a durable advisory", async () => {
  const ws = prRepo();
  let calls = 0;
  const payloads = [];
  const reviewer = {
    name: "Kimi",
    reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1", thinking: null },
    async run() {
      calls += 1;
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: broken", raw: "BLOCK: broken\nSEVERITY: high\n- exhaustive finding" };
    }
  };

  for (let revision = 1; revision <= 4; revision++) {
    await runMain({
      resolveReviewersImpl: () => [reviewer],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      emitter: { emit(payload) { payloads.push(payload); return true; } },
      input: { cwd: ws, session_id: "plan-cycle-A", tool_input: { plan: `revision ${revision}` } }
    });
  }

  assert.equal(calls, 3, "changed plan text must not reset the repair-cycle count");
  assert.deepEqual(payloads.slice(0, 3).map((p) => p.hookSpecificOutput.permissionDecision), ["deny", "deny", "deny"]);
  assert.equal(payloads[3].hookSpecificOutput.permissionDecision, "allow", "the fourth invocation cannot auto-deny/wake");
  assert.match(payloads[3].hookSpecificOutput.permissionDecisionReason, /UNREVIEWED.*paused after 3 blocked repair cycles/s);

  await runMain({
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit() { return true; } },
    input: { cwd: ws, session_id: "plan-cycle-B", tool_input: { plan: "new session revision" } }
  });
  assert.equal(calls, 4, "a new task/session gets a fresh review cycle");
});

test("ExitPlanMode ALLOW cache includes the concrete reviewer model/endpoint/config identity", async () => {
  const ws = prRepo();
  let calls = 0;
  let reviewIdentity = { kind: "api", model: "model-a", baseURL: "https://a.test/v1", thinking: "disabled", temperature: 0 };
  const opts = () => ({
    resolveReviewersImpl: () => [{
      name: "Kimi",
      reviewIdentity: { ...reviewIdentity },
      async run() {
        calls += 1;
        return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok\nSEVERITY: none" };
      }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit() { return true; } },
    input: { cwd: ws, session_id: "plan-cache", tool_input: { plan: "identical plan bytes" } }
  });

  await runMain(opts());
  await runMain(opts());
  reviewIdentity = { kind: "api", model: "model-b", baseURL: "https://b.test/v2", thinking: "enabled", temperature: 0.5 };
  await runMain(opts());
  await runMain(opts());
  assert.equal(calls, 2, "each exact reviewer configuration reviews once; names alone never reuse the cache");
});

test("same-revision concurrent ExitPlanMode calls single-flight and a BLOCK can never race a false ALLOW cache", async () => {
  const ws = prRepo();
  const session = "plan-concurrent-same-revision";
  const payloads = [[], []];
  let calls = 0;
  let nextVerdict = "BLOCK";
  let releaseFirst;
  let signalFirst;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const reviewer = {
    name: "Kimi",
    reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1" },
    async run() {
      calls += 1;
      const verdict = nextVerdict;
      if (calls === 1) {
        signalFirst();
        await firstRelease;
      }
      return {
        name: "Kimi",
        verdict,
        firstLine: `${verdict}: deterministic race verdict`,
        raw: `${verdict}: deterministic race verdict\nSEVERITY: ${verdict === "BLOCK" ? "high" : "none"}`
      };
    }
  };
  const invoke = (index) => runMain({
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit(payload) { payloads[index].push(payload); return true; } },
    input: { cwd: ws, session_id: session, tool_input: { plan: "one immutable plan revision" } }
  });

  const first = invoke(0);
  await firstEntered;
  // If a second panel is incorrectly launched it returns ALLOW, recreating the original race.
  nextVerdict = "ALLOW";
  const second = invoke(1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(calls, 1, "the exact concurrent revision runs one reviewer panel");
  assert.deepEqual(payloads.map((items) => items[0]?.hookSpecificOutput?.permissionDecision), ["deny", "deny"]);
  assert.equal(readPlanCycle(ws, session).count, 1, "the shared result consumes exactly one BLOCK slot");
  assert.equal(readPlanMarker(ws, "exit-plan-mode", "inline-plan"), null, "a BLOCK never leaves an exact ALLOW marker");

  // A later, non-overlapping invocation is not skipped as ALLOW; it can safely re-review.
  nextVerdict = "BLOCK";
  const later = [];
  await runMain({
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit(payload) { later.push(payload); return true; } },
    input: { cwd: ws, session_id: session, tool_input: { plan: "one immutable plan revision" } }
  });
  assert.equal(calls, 2, "no false ALLOW cache skips the later review");
  assert.equal(later[0]?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(readPlanCycle(ws, session).count, 2);
});
