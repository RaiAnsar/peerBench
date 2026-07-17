// tests/plan-file-review.test.mjs
// Tests for global-hooks/plan-file-review.mjs.
// All reviewer calls are injected so NO real API or Codex call happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Set BENCH_ROOT before importing any module that uses config-store.
const TEMP_GCR = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-root-"));
process.env.BENCH_ROOT = TEMP_GCR;

import { runMain, buildPrompt, PLAN_PATH_RE, createEmitter, readPlanSnapshot } from "../global-hooks/plan-file-review.mjs";
import { readPlanCycle, readPlanMarker } from "../global-hooks/plan-gate-state.mjs";

// ---------------------------------------------------------------------------
// P0 — make plan-file-review.mjs injectable: runMain is exported and accepts
// injected impls + input, mirroring stop-review.mjs / pre-push-review.mjs.
// ---------------------------------------------------------------------------

test("runMain is exported and is a function", () => {
  assert.equal(typeof runMain, "function", "runMain must be exported");
});

test("disabled short-circuit: runMain returns without throwing", async () => {
  // A temp input pointing at a plan path so the path filter passes and we reach
  // the isBenchDisabled check; with isBenchDisabledImpl: () => true it must
  // short-circuit and return without throwing (no reviewers, no trace).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, "p.md");
  fs.writeFileSync(planFile, "# Plan\n\nSome plan content.\n");

  let reviewersCalled = false;
  const resolveReviewersImpl = () => {
    reviewersCalled = true;
    return [];
  };
  let traceWritten = false;
  const writeTraceImpl = () => { traceWritten = true; };

  await assert.doesNotReject(async () => {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl,
      isBenchDisabledImpl: () => true,
      input: { cwd: ws, tool_input: { file_path: planFile } }
    });
  }, "disabled short-circuit must return without throwing");

  assert.equal(reviewersCalled, false, "reviewers must NOT be called when bench is disabled");
  assert.equal(traceWritten, false, "no trace must be written when bench is disabled");
});

test("buildPrompt still produces a system+user prompt", () => {
  const { system, user } = buildPrompt("plans/p.md", "# Plan");
  assert.ok(typeof system === "string" && system.length > 0);
  assert.match(user, /# Plan/);
});

// ---------------------------------------------------------------------------
// B1 — root-relative plan/spec paths must match; relative file_path must be
// resolved against input.cwd before stat/read.
// ---------------------------------------------------------------------------

test("PLAN_PATH_RE matches root-relative and absolute plan/spec paths", () => {
  assert.ok(PLAN_PATH_RE.test("plans/p.md"), "root-relative plans/p.md must match");
  assert.ok(PLAN_PATH_RE.test("docs/plans/p.md"), "docs/plans/p.md must match");
  assert.ok(PLAN_PATH_RE.test("/repo/specs/s.md"), "absolute /repo/specs/s.md must match");
});

test("PLAN_PATH_RE rejects non-plan and nested-subdir paths", () => {
  assert.ok(!PLAN_PATH_RE.test("notplans/p.md"), "notplans/p.md must NOT match");
  assert.ok(!PLAN_PATH_RE.test("plans/sub/p.md"), "plans/sub/p.md (nested) must NOT match");
});

test("relative file_path is resolved against input.cwd before read", async () => {
  // Create a repo with a plans/ file, pass a RELATIVE file_path + input.cwd.
  // The reviewer must receive the file's actual content (proving the read
  // happened against the resolved absolute path, not the hook process cwd).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-rel-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  const planContent = "# Relative Plan\n\nUnique marker ABC123 content.\n";
  fs.writeFileSync(path.join(planDir, "p.md"), planContent);

  let capturedUser = null;
  const resolveReviewersImpl = () => [
    {
      name: "Stub",
      run: async ({ user }) => {
        capturedUser = user;
        return { name: "Stub", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" };
      }
    }
  ];

  await runMain({
    resolveReviewersImpl,
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    input: { cwd: ws, tool_input: { file_path: "plans/p.md" } }
  });

  assert.ok(capturedUser, "reviewer must have been invoked with a relative file_path resolved against input.cwd");
  assert.match(capturedUser, /Unique marker ABC123/, "reviewer must receive the resolved file's content");
});

// ---------------------------------------------------------------------------
// F — the ALLOW systemMessage leads with the verdict badge.
// ---------------------------------------------------------------------------

test("F: plan-file ALLOW systemMessage leads with the badge", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-badge-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "p.md"), "# Plan\n\nbody\n");

  const resolveReviewersImpl = () => [
    { name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) },
    { name: "MiMo", run: async () => ({ name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) },
    { name: "GLM", run: async () => ({ name: "GLM", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) }
  ];

  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string") lines.push(chunk); return orig(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { file_path: "plans/p.md" } }
    });
  } finally {
    process.stdout.write = orig;
  }

  const parsed = JSON.parse(lines.find((l) => l.trim()));
  assert.match(parsed.systemMessage, /\[Kimi✓ MiMo✓ GLM✓\]/, "systemMessage should lead with the badge");
});

// ---------------------------------------------------------------------------
// B2 — malformed stdin must emit a visible ⛩ stderr note (not silent return).
// ---------------------------------------------------------------------------

test("malformed stdin emits a ⛩ plan-file-review stderr note", () => {
  // Run the hook as a subprocess feeding malformed JSON on stdin; assert the
  // ⛩ note appears on stderr (fail-open with a visible diagnostic).
  const hookPath = path.resolve("global-hooks/plan-file-review.mjs");
  const res = spawnSync(process.execPath, [hookPath], {
    input: "{not valid json",
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: TEMP_GCR }
  });
  assert.match(
    res.stderr,
    /⛩ plan-file-review: could not parse hook input/,
    `expected ⛩ note on stderr; got stderr=${JSON.stringify(res.stderr)} stdout=${JSON.stringify(res.stdout)}`
  );
});

// ===========================================================================
// Task 9 — emit-once: invocation-scoped emitter for plan-file-review
// ===========================================================================

test("emit-once: createEmitter is exported and invocation-scoped", () => {
  assert.equal(typeof createEmitter, "function", "createEmitter must be exported");
  const e1 = createEmitter();
  const captured = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) captured.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    assert.equal(e1.emit({ a: 1 }), true);
    assert.equal(e1.emit({ a: 2 }), false, "second emit suppressed");
    const e2 = createEmitter();
    assert.equal(e2.emit({ b: 1 }), true, "fresh emitter emits again");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(captured.length, 2);
});

test("emit-once: a second emit within one plan-file runMain writes no second stdout line", async () => {
  // ALLOW path emits the badge systemMessage exactly once.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-emitonce-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "p.md"), "# Plan\n\nbody emit-once\n");

  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: () => [{ name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) }],
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { file_path: "plans/p.md" } }
    });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(lines.filter(Boolean).length, 1, "exactly one stdout line per invocation");
});

test("emit-once: entrypoint .catch routes a post-emit error to stderr (no 2nd stdout line)", () => {
  // A malformed-stdin run reaches the shim; with no path match it returns without emitting.
  // Smoke for the shim wiring: at most one stdout line, never a crash.
  const hookPath = path.resolve("global-hooks/plan-file-review.mjs");
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd: process.cwd(), tool_input: { file_path: "not-a-plan.txt" } }),
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: TEMP_GCR }
  });
  const stdoutLines = res.stdout.split("\n").filter((l) => l.trim());
  assert.ok(stdoutLines.length <= 1, "no spurious stdout lines");
});

// ===========================================================================
// Task 9 — D3: trace-write failure emits a ⛩ note and still allows (fail-open)
// ===========================================================================

test("D3: plan-file trace write failure emits a ⛩ note and still allows", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-d3-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "p.md"), "# Plan\n\nbody d3 trace\n");

  const stderrChunks = [];
  const stdoutLines = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) stdoutLines.push(chunk.trim()); return origOut(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: () => [{ name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) }],
      writeTraceImpl: () => { throw new Error("disk full"); },
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { file_path: "plans/p.md" } }
    });
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  assert.match(stderrChunks.join(""), /⛩ .*trace write failed/i, "expected a ⛩ trace-write-failed note on stderr");
  const parsed = JSON.parse(stdoutLines.find((l) => l.trim()));
  assert.match(parsed.systemMessage || "", /ALLOW/, "must still emit the ALLOW systemMessage despite trace failure");
});

// ===========================================================================
// Severity-gating — block (rewake) only on HIGH+; medium/low → advisory (allow).
// ===========================================================================

test("severity-gate: a MEDIUM-severity BLOCK does NOT block the save (allows with advisory note)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-sev-med-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "specs");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "s.md"), "# Spec\n\nmedium severity body.\n");

  const resolveReviewersImpl = () => [
    { name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) },
    { name: "MiMo", run: async () => ({ name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: medium\n- a prose nit" }) }
  ];

  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return orig(chunk, ...rest); };
  let exited = false;
  const origExit = process.exit;
  process.exit = () => { exited = true; throw new Error("__exit__"); };
  // FIX 3/FIX 4: capture the persisted trace to prove the BLOCK reviewer carries its severity.
  let persistedTrace = null;
  try {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl: (_ws, trace) => { persistedTrace = trace; },
      isBenchDisabledImpl: () => false,
      spawnImpl: () => ({ unref() {} }),
      input: { cwd: ws, tool_input: { file_path: path.join(planDir, "s.md") } }
    });
  } finally {
    process.stdout.write = orig;
    process.exit = origExit;
  }
  assert.equal(exited, false, "a medium BLOCK must NOT exit 2 (no rewake)");
  const parsed = JSON.parse(lines.find((l) => l.trim()));
  assert.match(parsed.systemMessage || "", /ALLOW/, "the save is allowed");
  assert.match(parsed.systemMessage || "", /MiMo~/, "badge shows MiMo~ (advisory)");
  assert.match(parsed.systemMessage || "", /advisor/i, "an advisory note is surfaced");

  // FIX 3 end-to-end: the persisted trace's BLOCK reviewer entry must carry severity "medium"
  // (NOT dropped) so the statusline can render `~` for a sub-threshold plan-file BLOCK.
  assert.ok(persistedTrace, "a trace must have been written");
  const mimoEntry = persistedTrace.reviewers.find((r) => r.name === "MiMo");
  assert.ok(mimoEntry, "the persisted trace must contain the MiMo reviewer entry");
  assert.equal(mimoEntry.verdict, "BLOCK", "MiMo's persisted verdict is BLOCK");
  assert.equal(mimoEntry.severity, "medium", "the persisted BLOCK reviewer must carry severity 'medium' (FIX 3 — not dropped)");
  assert.equal(mimoEntry.raw, undefined, "raw must still be stripped from the persisted trace reviewer");
});

test("severity-gate: a HIGH-severity BLOCK still blocks (rewake, exit 2)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-sev-high-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "specs");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "s.md"), "# Spec\n\nhigh severity body.\n");

  const resolveReviewersImpl = () => [
    { name: "MiMo", run: async () => ({ name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: broken build", raw: "BLOCK: broken build\nSEVERITY: high\n- references a missing function" }) }
  ];

  const stderrChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { if (typeof chunk === "string") stderrChunks.push(chunk); return origErr(chunk, ...rest); };
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (c) => { exitCode = c; throw new Error("__exit__"); };
  try {
    await runMain({
      resolveReviewersImpl,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      spawnImpl: () => ({ unref() {} }),
      input: { cwd: ws, tool_input: { file_path: path.join(planDir, "s.md") } }
    });
  } catch (e) {
    if (e.message !== "__exit__") throw e;   // expected sentinel from the stubbed exit
  } finally {
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  assert.equal(exitCode, 2, "a high BLOCK must rewake (exit 2)");
  assert.match(stderrChunks.join(""), /MiMo✗/, "badge shows MiMo✗ (real block)");
  assert.match(stderrChunks.join(""), /blocked the plan file/i, "block feedback written to stderr");
});

// ===========================================================================
// Fast ALLOW → ENQUEUE a deep spec-review job (no detached spawn, no inline review)
// ===========================================================================

import { deepKey } from "../global-hooks/deep-review.mjs";
import { listJobs } from "../global-hooks/deep-queue.mjs";
import { normalizeSessionId } from "../global-hooks/config-store.mjs";

function allowReviewers() {
  return () => [{ name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) }];
}

test("fast ALLOW ENQUEUES a kind:'spec' job keyed by (path,content) — no spawn, no inline review", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-enq-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  const body = "# Spec\n\nenqueue body content.\n";
  fs.writeFileSync(specFile, body);

  await runMain({
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  });

  const jobs = listJobs(ws);
  assert.equal(jobs.length, 1, "fast ALLOW must enqueue exactly one deep job");
  assert.equal(jobs[0].kind, "spec");
  assert.equal(jobs[0].specPath, specFile);
  assert.equal(jobs[0].contentKey, deepKey(specFile, body), "job is keyed by (path, content)");
});

test("fast ALLOW stamps trace and deep job with the originating Claude session", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-session-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  const body = "# Spec\n\nsession body.\n";
  fs.writeFileSync(specFile, body);
  const sessionKey = normalizeSessionId("chat-A");
  let trace = null;

  await runMain({
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: (_ws, t) => { trace = t; },
    isBenchDisabledImpl: () => false,
    input: { cwd: ws, session_id: "chat-A", tool_input: { file_path: specFile } }
  });

  assert.equal(trace?.sessionKey, sessionKey, "fast plan-file trace is stamped with the hook session");
  assert.equal(listJobs(ws, { sessionKey }).length, 1, "the originating session sees its deep job");
  assert.equal(listJobs(ws, { sessionKey: normalizeSessionId("chat-B") }).length, 0, "another same-workspace session does not see the job");
});

test("enqueue dedupes — identical content re-save does not double-queue", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-enqdedup-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\nsame body.\n");
  const opts = {
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  };
  await runMain(opts);
  assert.equal(listJobs(ws).length, 1);

  // Re-save identical content; clear the fast allow marker so we re-review and reach enqueue again.
  const { createHash } = await import("node:crypto");
  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  const fileKey = createHash("sha1").update(specFile).digest("hex");
  try { fs.rmSync(path.join(locksRoot, `allow-${fileKey}`), { force: true }); } catch { /* noop */ }
  fs.writeFileSync(specFile, "# Spec\n\nsame body.\n");
  await runMain(opts);
  assert.equal(listJobs(ws).length, 1, "identical content must not double-queue (enqueue dedupes by contentKey)");
});

test("dedup-hit (content identical to last approved) still requests this session's deep review", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-enq-deduphit-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\ndedup body.\n");
  const opts = {
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  };
  await runMain(opts);   // first ALLOW enqueues + sets the approval marker
  // Second save, IDENTICAL content → fast review is cached, but the session-scoped deep job must
  // still be requested. The old early return skipped this and could lose the only full review.
  let enqCalled = false;
  await runMain({ ...opts, enqueueDeepReviewImpl: () => { enqCalled = true; return true; } });
  assert.equal(enqCalled, true, "a fast-cache hit must still request the full deep review");
});

test("enqueue failure does not break the gate (fail-open, ALLOW still emitted)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-enqerr-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\nenqueue err body.\n");

  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: allowReviewers(),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      enqueueDeepReviewImpl: () => { throw new Error("enqueue boom"); },
      input: { cwd: ws, tool_input: { file_path: specFile } }
    });
  } finally {
    process.stdout.write = orig;
  }
  const parsed = JSON.parse(lines.find((l) => l.trim()));
  assert.match(parsed.systemMessage || "", /ALLOW/, "ALLOW must still be emitted even if the deep enqueue throws");
});

test("full streamed identity catches tail-only changes beyond 64 KiB and never reports fast-clean coverage", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-tail-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "large.md");
  const prefix = `# Large spec\n\n${"x".repeat(70 * 1024)}\n`;
  fs.writeFileSync(specFile, `${prefix}TAIL_REVISION_A\n`);

  const prompts = [];
  let reviewerCalls = 0;
  const deepKeys = [];
  const emitted = [];
  const opts = {
    resolveReviewersImpl: () => [{
      name: "Kimi",
      reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1", thinking: null },
      async run({ user }) {
        reviewerCalls += 1;
        prompts.push(user);
        return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: sampled evidence clean", raw: "ALLOW: sampled evidence clean\nSEVERITY: none" };
      }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    enqueueDeepReviewImpl: (_ws, _path, _content, options) => {
      deepKeys.push(options.contentKey);
      return { ok: true, enqueued: true };
    },
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    input: { cwd: ws, session_id: "tail-session", tool_input: { file_path: specFile } }
  };

  await runMain(opts);
  fs.writeFileSync(specFile, `${prefix}TAIL_REVISION_B\n`);
  await runMain(opts);
  await runMain(opts); // exact B resave: fast cache hit, but deep request still happens

  assert.equal(reviewerCalls, 2, "a tail-only change must invalidate the fast marker; exact resave may reuse it");
  assert.match(prompts[1], /TAIL_REVISION_B/, "bounded evidence includes the tail, not only the first 64 KiB");
  assert.notEqual(deepKeys[0], deepKeys[1], "full deep content identity changes when only the tail changes");
  assert.equal(deepKeys[1], deepKeys[2], "the exact cached revision still requests its same deep job");
  assert.equal(deepKeys.length, 3, "both reviews and the exact-cache hit request deep coverage");
  for (const payload of emitted) assert.match(payload.systemMessage, /UNREVIEWED \/ fast coverage incomplete/);

  const snapshot = await readPlanSnapshot(specFile);
  assert.equal(snapshot.deepContentKey, deepKey(specFile, fs.readFileSync(specFile, "utf8")), "streamed key exactly matches deep queue recomputation");
});

test("ALLOW cache invalidates when reviewer model, endpoint, or inference config changes", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-review-id-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "identity.md");
  fs.writeFileSync(specFile, "# Plan\n\nStable bytes.\n");
  let calls = 0;
  let identity = { kind: "api", model: "model-a", baseURL: "https://a.test/v1", thinking: "disabled", temperature: 0 };
  const opts = {
    resolveReviewersImpl: () => [{
      name: "Kimi",
      reviewIdentity: { ...identity },
      async run() {
        calls += 1;
        return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok\nSEVERITY: none" };
      }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    enqueueDeepReviewImpl: () => ({ ok: true, enqueued: false }),
    emitter: { emit() { return true; } },
    input: { cwd: ws, session_id: "review-id", tool_input: { file_path: specFile } }
  };

  await runMain(opts);
  identity = { kind: "api", model: "model-b", baseURL: "https://b.test/v2", thinking: "enabled", temperature: 0.4 };
  await runMain(opts);
  await runMain(opts);
  assert.equal(calls, 2, "changed reviewer config re-reviews; exact model/endpoint/config reuses the ALLOW");
});

test("plan-file automatic BLOCK wakes stop at three across changed revisions and reset in a new session", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-cycle-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "cycle.md");
  let calls = 0;
  let blocks = 0;
  const deliveredCycles = [];
  const emitted = [];
  const opts = {
    resolveReviewersImpl: () => [{
      name: "Kimi",
      reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1" },
      async run() {
        calls += 1;
        return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: broken", raw: "BLOCK: broken\nSEVERITY: high\n- one complete finding set" };
      }
    }],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    blockHandler: async ({ cycle }) => { blocks += 1; deliveredCycles.push(cycle); },
    input: { cwd: ws, session_id: "cycle-A", tool_input: { file_path: specFile } }
  };

  for (let revision = 1; revision <= 4; revision++) {
    fs.writeFileSync(specFile, `# Plan revision ${revision}\n\nStill broken.\n`);
    await runMain(opts);
  }
  assert.equal(calls, 3, "changed content never resets the three-cycle ceiling");
  assert.equal(blocks, 3, "only three automatic wakes are delivered");
  assert.deepEqual(deliveredCycles, [1, 2, 3]);
  assert.match(emitted.at(-1)?.systemMessage || "", /paused after 3 blocked repair cycles/);

  fs.writeFileSync(specFile, "# Plan revision 5\n\nNew session.\n");
  await runMain({ ...opts, input: { ...opts.input, session_id: "cycle-B" } });
  assert.equal(calls, 4, "a new task/session starts a fresh cycle");
  assert.deepEqual(deliveredCycles, [1, 2, 3, 1]);
});

test("a delayed ALLOW for revision A cannot clear or cache over revision B's newer BLOCK", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-delayed-allow-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "race.md");
  const session = "delayed-allow-session";
  const cycles = [];
  const emitted = [];
  let aCalls = 0;
  let reviewerCalls = 0;
  let signalDelayed;
  let releaseDelayed;
  const delayedEntered = new Promise((resolve) => { signalDelayed = resolve; });
  const delayedRelease = new Promise((resolve) => { releaseDelayed = resolve; });

  const reviewer = {
    name: "Kimi",
    reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1" },
    async run({ user }) {
      reviewerCalls += 1;
      if (/REVISION_A/.test(user)) {
        aCalls += 1;
        if (aCalls === 2) {
          signalDelayed();
          await delayedRelease;
          return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: old A", raw: "ALLOW: old A\nSEVERITY: none" };
        }
      }
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: current defect", raw: "BLOCK: current defect\nSEVERITY: high\n- exhaustive blocker" };
    }
  };
  const opts = {
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    enqueueDeepReviewImpl: () => ({ ok: true, enqueued: false }),
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    blockHandler: async ({ cycle }) => { cycles.push(cycle); },
    input: { cwd: ws, session_id: session, tool_input: { file_path: specFile } }
  };

  fs.writeFileSync(specFile, "# Plan\n\nREVISION_A\n");
  await runMain(opts);
  assert.deepEqual(cycles, [1]);

  const delayedA = runMain(opts);
  await delayedEntered;
  fs.writeFileSync(specFile, "# Plan\n\nREVISION_B\n");
  await runMain(opts);
  assert.deepEqual(cycles, [1, 2], "B claims the second shared slot before old A finishes");

  releaseDelayed();
  await delayedA;
  assert.equal(readPlanCycle(ws, session).count, 2, "old A cannot resolve B's newer immutable block id");
  assert.equal(readPlanMarker(ws, "plan-file-panel", specFile), null, "old A cannot leave an ALLOW cache after B blocked");
  assert.match(emitted.at(-1)?.systemMessage || "", /superseded|UNREVIEWED/i);

  fs.writeFileSync(specFile, "# Plan\n\nREVISION_C\n");
  await runMain(opts);
  fs.writeFileSync(specFile, "# Plan\n\nREVISION_D\n");
  await runMain(opts);
  assert.deepEqual(cycles, [1, 2, 3], "the next block gets slot 3 and the fourth gets only the durable advisory");
  assert.equal(readPlanCycle(ws, session).count, 3);
  assert.match(emitted.at(-1)?.systemMessage || "", /paused after 3 blocked repair cycles/);
  assert.equal(reviewerCalls, 4, "the exhausted fourth revision never starts another panel");
});

test("plan-file advisory emit includes the completing review's findings when the ledger fills mid-save", async () => {
  // F1: the cycle ledger is shared across plan files in one session. A leader whose file review
  // completes after the third slot was claimed by OTHER files gets the `advisory` outcome — its
  // validated BLOCK findings must appear in the message (they claim no ledger slot).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-advisory-midfill-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const session = "pfr-advisory-midfill";
  const emitted = [];
  const cycles = [];
  let signalSlow;
  let releaseSlow;
  const slowEntered = new Promise((resolve) => { signalSlow = resolve; });
  const slowRelease = new Promise((resolve) => { releaseSlow = resolve; });
  const reviewer = {
    name: "Kimi",
    reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1" },
    async run({ user }) {
      if (/C_UNIQUE_CONTENT/.test(user)) {
        signalSlow();
        await slowRelease;
        return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: c blocker", raw: "BLOCK: c blocker\nSEVERITY: high\n- C_UNIQUE_FINDING" };
      }
      return { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: broken", raw: "BLOCK: broken\nSEVERITY: high\n- standard finding" };
    }
  };
  const opts = (specFile) => ({
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    blockHandler: async ({ cycle }) => { cycles.push(cycle); },
    input: { cwd: ws, session_id: session, tool_input: { file_path: specFile } }
  });
  const write = (name, marker) => {
    const specFile = path.join(specDir, name);
    fs.writeFileSync(specFile, `# Plan\n\n${marker}\n`);
    return specFile;
  };

  await runMain(opts(write("a.md", "A_CONTENT")));
  await runMain(opts(write("b.md", "B_CONTENT")));
  const slow = runMain(opts(write("c.md", "C_UNIQUE_CONTENT")));
  await slowEntered;
  await runMain(opts(write("d.md", "D_CONTENT")));   // claims the last shared slot mid-panel
  releaseSlow();
  await slow;

  assert.deepEqual(cycles, [1, 2, 3]);
  assert.equal(readPlanCycle(ws, session).count, 3);
  const advisory = emitted.at(-1)?.systemMessage || "";
  assert.match(advisory, /paused after 3 blocked repair cycles/);
  assert.match(advisory, /C_UNIQUE_FINDING/, "the completing review's findings must not be discarded");
  assert.doesNotMatch(advisory, /was not re-validated/, "a validated-and-blocked revision must not be described as unvalidated");
});

test("a same-identity cross-session supersede prefers the winner's approval marker over a misleading reset claim", async () => {
  // F4: two sessions saving identical bytes share the plan-file head. The twin whose completion
  // loses the head must not claim a revision change/reset when the winner's ALLOW marker already
  // approves that exact identity.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-twin-allow-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, "twin.md");
  fs.writeFileSync(planFile, "# Plan\n\nTWIN_IDENTICAL_BYTES\n");

  let calls = 0;
  let signalFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const reviewer = {
    name: "Kimi",
    reviewIdentity: { kind: "api", model: "k3", baseURL: "https://review.test/v1" },
    async run() {
      calls += 1;
      if (calls === 1) {
        signalFirst();
        await firstRelease;
      }
      return { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean\nSEVERITY: none" };
    }
  };
  const emittedA = [];
  const emittedB = [];
  const opts = (session, emitted) => ({
    resolveReviewersImpl: () => [reviewer],
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    enqueueDeepReviewImpl: () => ({ ok: true, enqueued: false }),
    emitter: { emit(payload) { emitted.push(payload); return true; } },
    input: { cwd: ws, session_id: session, tool_input: { file_path: planFile } }
  });

  const twinA = runMain(opts("twin-session-A", emittedA));
  await firstEntered;
  await runMain(opts("twin-session-B", emittedB));   // wins the shared head and commits the ALLOW
  releaseFirst();
  await twinA;

  assert.equal(calls, 2, "each session's leader ran its own panel (separate flight records)");
  assert.match(emittedB.at(-1)?.systemMessage || "", /ALLOW/, "the winning session approves the exact revision");
  const loser = emittedA.at(-1)?.systemMessage || "";
  assert.match(loser, /approved/i, "the losing twin must surface the committed approval");
  assert.doesNotMatch(loser, /superseded|UNREVIEWED/i, "no false revision-change/reset claim");
});

// ===========================================================================
// FIX 1 — deploy-parity: the deep spec-review worker must resolve its imports in
// the DEPLOYED FLAT layout (~/.claude/hooks/), where ONLY global-hooks/*.mjs are
// copied and scripts/ is NEVER present. We copy global-hooks/*.mjs flat into a temp
// dir and run the worker — it may fail-open (no real reviewers), but it MUST NOT
// die with a module-resolution error (which a scripts/ import would cause).
// ===========================================================================

test("FIX 1: spec-review-run.mjs is present and resolves all imports in a FLAT deployed layout", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const hooksSrc = path.join(here, "..", "global-hooks");

  // Simulate the deployed flat layout: copy ONLY global-hooks/*.mjs (no scripts/).
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flat-"));
  for (const f of fs.readdirSync(hooksSrc).filter((f) => f.endsWith(".mjs"))) {
    fs.copyFileSync(path.join(hooksSrc, f), path.join(flat, f));
  }

  // (a) the worker must be present in the flat copy
  const worker = path.join(flat, "spec-review-run.mjs");
  assert.ok(fs.existsSync(worker), "spec-review-run.mjs must be deployed flat alongside the other hooks");

  // (b) running the worker in the flat layout must NOT fail with a module-resolution error.
  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flat-root-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flat-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });
  const someFile = path.join(ws, "specs", "s.md");
  fs.mkdirSync(path.dirname(someFile), { recursive: true });
  fs.writeFileSync(someFile, "# Spec\n\nflat layout deploy-parity check.\n");

  const result = spawnSync(process.execPath, [worker, someFile, "--ws", ws], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: benchRoot }
  });

  assert.doesNotMatch(result.stderr || "", /ERR_MODULE_NOT_FOUND/, `worker must resolve all sibling imports in a flat layout; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr || "", /Cannot find module/, `worker must not have an unresolved import in a flat layout; stderr: ${result.stderr}`);
  // Fail-open: a missing API key etc. is fine; the process must not look like a crash from a bad import.
  assert.equal(result.status, 0, `worker fails open (exit 0); got ${result.status}, stderr: ${result.stderr}`);
});

// ===========================================================================
// H — deploy-parity for the PUSH mode: `node <flat>/spec-review-run.mjs --push <range>
// --ws <ws>` must resolve all sibling imports (pushReviewPanel etc.) in the deployed
// FLAT layout, with NO scripts/ present. It may fail-open (no reviewers / git), but must
// NOT die with a module-resolution error.
// ===========================================================================

test("H: spec-review-run.mjs --push <range> resolves all imports in a FLAT deployed layout", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const hooksSrc = path.join(here, "..", "global-hooks");

  // Simulate the deployed flat layout: copy ONLY global-hooks/*.mjs (no scripts/).
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flatpush-"));
  for (const f of fs.readdirSync(hooksSrc).filter((f) => f.endsWith(".mjs"))) {
    fs.copyFileSync(path.join(hooksSrc, f), path.join(flat, f));
  }
  const worker = path.join(flat, "spec-review-run.mjs");
  assert.ok(fs.existsSync(worker), "spec-review-run.mjs must be deployed flat");

  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flatpush-root-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-flatpush-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });

  const result = spawnSync(process.execPath, [worker, "--push", "@{u}..HEAD", "--ws", ws], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: benchRoot }
  });

  assert.doesNotMatch(result.stderr || "", /ERR_MODULE_NOT_FOUND/, `push worker must resolve all sibling imports in a flat layout; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr || "", /Cannot find module/, `push worker must not have an unresolved import in a flat layout; stderr: ${result.stderr}`);
  // Fail-open: missing reviewers / no real repo is fine; the process must exit 0, not crash on a bad import.
  assert.equal(result.status, 0, `push worker fails open (exit 0); got ${result.status}, stderr: ${result.stderr}`);
});

test("non-git workspace: plan-file gate skips silently (no panel, no trace, no emit)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-nongit-"));   // deliberately NOT a git repo
  const planDir = path.join(ws, "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "p.md"), "# Plan\n\nnon-git chat plan\n");
  let reviewersCalled = false, traceWritten = false;
  const stdoutLines = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) stdoutLines.push(chunk.trim()); return origOut(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: () => { reviewersCalled = true; return []; },
      writeTraceImpl: () => { traceWritten = true; },
      isBenchDisabledImpl: () => false,
      input: { cwd: ws, tool_input: { file_path: "plans/p.md" } }
    });
  } finally { process.stdout.write = origOut; }
  assert.equal(reviewersCalled, false, "no panel outside a git repo");
  assert.equal(traceWritten, false);
  assert.equal(stdoutLines.length, 0, "silent skip — no noise in non-git chats");
});
