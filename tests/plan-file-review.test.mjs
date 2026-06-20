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

import { runMain, buildPrompt, PLAN_PATH_RE } from "../global-hooks/plan-file-review.mjs";

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
