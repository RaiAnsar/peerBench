// tests/plan-file-review.test.mjs
// Tests for global-hooks/plan-file-review.mjs.
// All reviewer calls are injected so NO real API or Codex call happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set BENCH_ROOT before importing any module that uses config-store.
const TEMP_GCR = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-root-"));
process.env.BENCH_ROOT = TEMP_GCR;

import { runMain, buildPrompt } from "../global-hooks/plan-file-review.mjs";

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
