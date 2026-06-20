// tests/deep-review.test.mjs
// Task 10 (capability G) — deep-review helpers + the spec-review subcommand (G1/G4).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate BENCH_ROOT before importing anything that uses config-store.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "deep-root-"));

import {
  contentHash, severityRank, summarizeSpecReview, shouldRewake,
  deepResultPath, deepDebouncePath, isDeepDebounced, markDeepDebounce,
  writeDeepResult, readLatestDeepResult, deleteDeepResult, DEEP_REWAKE_SEVERITY
} from "../global-hooks/deep-review.mjs";
import { specReviewCommand } from "../scripts/bench-runner.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";
import { listTraces, readTrace } from "../global-hooks/trace-store.mjs";

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deep-ws-"));
}

// ── helpers ──────────────────────────────────────────────────────────────────

test("contentHash is stable and content-keyed", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});

test("severityRank orders none<low<medium<high<critical", () => {
  assert.ok(severityRank("none") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("critical"));
  assert.equal(severityRank("bogus"), 0);
});

test("summarizeSpecReview produces the structured contract", () => {
  const s = summarizeSpecReview([
    { name: "Kimi", verdict: "ALLOW", findingCount: 1, severity: "low" },
    { name: "MiMo", verdict: "BLOCK", findingCount: 2, severity: "high" }
  ]);
  assert.deepEqual(s.reviewers, [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }]);
  assert.equal(s.findingCount, 3);
  assert.equal(s.maxSeverity, "high");
});

test("shouldRewake fires at/above the rewake severity with findings, else not", () => {
  assert.equal(shouldRewake({ maxSeverity: DEEP_REWAKE_SEVERITY, findingCount: 1 }), true);
  assert.equal(shouldRewake({ maxSeverity: "critical", findingCount: 1 }), true);
  assert.equal(shouldRewake({ maxSeverity: "medium", findingCount: 5 }), false);
  assert.equal(shouldRewake({ maxSeverity: "high", findingCount: 0 }), false);
});

test("deep-debounce: marker is content-hash + interval keyed", () => {
  const ws = freshWs();
  const h = contentHash("plan v1");
  assert.equal(isDeepDebounced(ws, h), false, "no marker → not debounced");
  markDeepDebounce(ws, h);
  assert.equal(isDeepDebounced(ws, h), true, "same hash within interval → debounced");
  assert.equal(isDeepDebounced(ws, contentHash("plan v2")), false, "different hash → not debounced");
  // Expired interval → not debounced
  markDeepDebounce(ws, h, { now: Date.now() - 10 * 60 * 1000 });
  assert.equal(isDeepDebounced(ws, h, { intervalMs: 5 * 60 * 1000 }), false, "expired → not debounced");
});

test("deep-result: write/read/delete round-trip in workspaceStateDir", () => {
  const ws = freshWs();
  const h = contentHash("spec body");
  const file = writeDeepResult(ws, { hash: h, traceId: "t1", badge: "Kimi✓ MiMo✗", summary: "found stuff", reviewers: [], findingCount: 2, maxSeverity: "high" });
  assert.equal(file, deepResultPath(ws, h));
  assert.ok(fs.existsSync(file));
  const found = readLatestDeepResult(ws);
  assert.ok(found, "must find the written deep-result");
  assert.equal(found.result.hash, h);
  assert.equal(found.result.traceId, "t1");
  deleteDeepResult(found.file);
  assert.equal(readLatestDeepResult(ws), null, "deleted → none found");
});

test("deepDebouncePath / deepResultPath live under workspaceStateDir", () => {
  const ws = freshWs();
  assert.ok(deepDebouncePath(ws).startsWith(workspaceStateDir(ws)));
  assert.ok(deepResultPath(ws, "abc").startsWith(workspaceStateDir(ws)));
});

// ── G1/G4: the spec-review subcommand ─────────────────────────────────────────

test("G1: specReviewCommand writes a gate:'spec-review' trace and returns the structured result", async () => {
  const ws = freshWs();
  const planDir = path.join(ws, "specs");
  fs.mkdirSync(planDir, { recursive: true });
  const file = path.join(planDir, "s.md");
  const body = "# Spec\n\nDeep review me.\n";
  fs.writeFileSync(file, body);

  // Mock panel: returns per-reviewer verdict + findingCount + severity.
  const panelImpl = async ({ content }) => {
    assert.match(content, /Deep review me/, "panel must be seeded with the file content");
    return [
      { name: "Kimi", verdict: "ALLOW", findings: "no major issues", findingCount: 0, severity: "none" },
      { name: "MiMo", verdict: "BLOCK", findings: "1. ambiguous step", findingCount: 1, severity: "high" }
    ];
  };

  const result = await specReviewCommand(file, ws, { panelImpl });

  assert.deepEqual(result.reviewers, [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }]);
  assert.equal(result.findingCount, 1);
  assert.equal(result.maxSeverity, "high");

  // Trace written with gate:"spec-review"
  const [latest] = listTraces(ws, 1);
  assert.ok(latest, "a trace must be written");
  assert.equal(latest.gate, "spec-review");
  const t = readTrace(ws, latest.id);
  assert.equal(t.gate, "spec-review");
});

test("G4: specReviewCommand writes deep-result-<hash>.json on completion (hash, traceId, badge, summary)", async () => {
  const ws = freshWs();
  const planDir = path.join(ws, "specs");
  fs.mkdirSync(planDir, { recursive: true });
  const file = path.join(planDir, "s2.md");
  const body = "# Spec 2\n\nbody two\n";
  fs.writeFileSync(file, body);
  const h = contentHash(body);

  const panelImpl = async () => [
    { name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }
  ];

  await specReviewCommand(file, ws, { panelImpl });

  const found = readLatestDeepResult(ws);
  assert.ok(found, "deep-result file must be written on completion");
  assert.equal(found.result.hash, h, "deep-result must carry the content hash");
  assert.ok(found.result.traceId, "deep-result must carry the trace id");
  assert.equal(typeof found.result.badge, "string");
  assert.equal(typeof found.result.summary, "string");
  assert.ok(Array.isArray(found.result.reviewers));
  assert.equal(typeof found.result.findingCount, "number");
});
