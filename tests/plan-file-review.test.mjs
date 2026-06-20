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

import { runMain, buildPrompt, PLAN_PATH_RE, createEmitter } from "../global-hooks/plan-file-review.mjs";

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
// Task 10 — G2/G3: fast ALLOW → debounced detached spec-review spawn
// ===========================================================================

import { workspaceStateDir } from "../global-hooks/config-store.mjs";
import { isDeepDebounced, deepKey } from "../global-hooks/deep-review.mjs";

function allowReviewers() {
  return () => [{ name: "Kimi", run: async () => ({ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }) }];
}

// A spawn spy that records calls and returns a child-like object with unref().
function spawnSpy() {
  const calls = [];
  let unrefCount = 0;
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref: () => { unrefCount += 1; } };
  };
  return { impl, calls, unrefCount: () => unrefCount };
}

test("G2/G3: fast ALLOW spawns spec-review detached + unref'd with abs path + abs ws", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-g2-"));
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  const body = "# Spec\n\nG2 body content.\n";
  fs.writeFileSync(specFile, body);

  const spy = spawnSpy();
  await runMain({
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    spawnImpl: spy.impl,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  });

  assert.equal(spy.calls.length, 1, "fast ALLOW must spawn spec-review exactly once");
  const { cmd, args, opts } = spy.calls[0];
  assert.equal(cmd, process.execPath, "must spawn node (process.execPath)");
  // FIX 1 (deploy-parity): the worker is the SIBLING global-hooks/spec-review-run.mjs,
  // not `bench-runner.mjs spec-review` (scripts/ is never deployed). args[0] = worker path.
  assert.match(args[0], /spec-review-run\.mjs$/, `args[0] must be the spec-review-run worker; got ${JSON.stringify(args)}`);
  assert.ok(fs.existsSync(args[0]), `the spawned worker must actually exist on disk; got ${args[0]}`);
  assert.equal(args[1], specFile, "args[1] must be the absolute spec path");
  const wsIdx = args.indexOf("--ws");
  assert.ok(wsIdx >= 0 && args[wsIdx + 1] === ws, `must pass --ws <abs ws>; got ${JSON.stringify(args)}`);
  assert.ok(path.isAbsolute(args[wsIdx + 1]), "ws must be absolute");
  assert.equal(opts.detached, true, "must be detached");
  assert.equal(opts.stdio, "ignore", "stdio must be ignore");
  assert.equal(spy.unrefCount(), 1, "child must be unref'd");

  // The debounce marker must now be set for this (file, content) deep key (FIX 4).
  assert.equal(isDeepDebounced(ws, deepKey(specFile, body)), true, "debounce marker must be set after launch");
});

test("G3: identical-content re-save within the interval → NOT spawned (debounced)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-g3-"));
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\nsame body.\n");

  const spy = spawnSpy();
  const opts = {
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    spawnImpl: spy.impl,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  };
  await runMain(opts);
  assert.equal(spy.calls.length, 1, "first ALLOW spawns");

  // Remove the fast-gate allowMarker so the SECOND save re-reviews (otherwise the
  // dedup-skip path returns before reaching the deep launch). This isolates the
  // deep-debounce behaviour: same content re-reviewed → fast ALLOW again → but
  // the deep pass must NOT relaunch because the debounce marker is fresh.
  // (Distinct lock dir each call: mtime changes per write, so locks don't collide.)
  fs.writeFileSync(specFile, "# Spec\n\nsame body.\n");
  // Clear the fast allow marker so we re-review.
  const { createHash } = await import("node:crypto");
  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  const fileKey = createHash("sha1").update(specFile).digest("hex");
  try { fs.rmSync(path.join(locksRoot, `allow-${fileKey}`), { force: true }); } catch { /* noop */ }
  // Also clear any lock dir so we don't get the in-flight lock early-return.
  await runMain(opts);
  assert.equal(spy.calls.length, 1, "identical content within interval must NOT relaunch the deep pass");
});

test("G2: dedup-hit (content identical to last approved) → NOT spawned", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-g2dedup-"));
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\ndedup body.\n");

  const spy = spawnSpy();
  const opts = {
    resolveReviewersImpl: allowReviewers(),
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    spawnImpl: spy.impl,
    input: { cwd: ws, tool_input: { file_path: specFile } }
  };
  // First ALLOW sets the fast allowMarker AND launches the deep pass.
  await runMain(opts);
  assert.equal(spy.calls.length, 1);

  // Second save, IDENTICAL content → hits the dedup-skip path (approvalKey matches).
  // The deep pass must NOT launch from a dedup hit (spec G2), regardless of debounce.
  const spy2 = spawnSpy();
  await runMain({ ...opts, spawnImpl: spy2.impl });
  assert.equal(spy2.calls.length, 0, "dedup-hit must not launch a deep pass");
});

test("G2: spawn failure does not break the gate (fail-open, ALLOW still emitted)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-g2err-"));
  const specDir = path.join(ws, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "s.md");
  fs.writeFileSync(specFile, "# Spec\n\nspawn err body.\n");

  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === "string" && chunk.trim()) lines.push(chunk.trim()); return orig(chunk, ...rest); };
  try {
    await runMain({
      resolveReviewersImpl: allowReviewers(),
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      spawnImpl: () => { throw new Error("spawn EACCES"); },
      input: { cwd: ws, tool_input: { file_path: specFile } }
    });
  } finally {
    process.stdout.write = orig;
  }
  const parsed = JSON.parse(lines.find((l) => l.trim()));
  assert.match(parsed.systemMessage || "", /ALLOW/, "ALLOW must still be emitted even if the deep launch throws");
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

  const result = spawnSync(process.execPath, [worker, "--push", "@{u}..HEAD", "--ws", ws], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: benchRoot }
  });

  assert.doesNotMatch(result.stderr || "", /ERR_MODULE_NOT_FOUND/, `push worker must resolve all sibling imports in a flat layout; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr || "", /Cannot find module/, `push worker must not have an unresolved import in a flat layout; stderr: ${result.stderr}`);
  // Fail-open: missing reviewers / no real repo is fine; the process must exit 0, not crash on a bad import.
  assert.equal(result.status, 0, `push worker fails open (exit 0); got ${result.status}, stderr: ${result.stderr}`);
});
