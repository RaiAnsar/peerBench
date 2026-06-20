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
  writeDeepResult, readLatestDeepResult, deleteDeepResult, DEEP_REWAKE_SEVERITY,
  deepKey
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

// ── FIX 4: deepKey is (path + content) keyed — distinct files with identical content do not collide ──
test("FIX 4: deepKey keys on (path, content) so byte-identical content in two files does NOT collide", () => {
  const same = "# identical body\n";
  const a = "/repo/specs/a.md";
  const b = "/repo/specs/b.md";
  // Same path + same content → stable.
  assert.equal(deepKey(a, same), deepKey(a, same));
  // Different path, identical content → distinct key (the collision FIX 4 fixes).
  assert.notEqual(deepKey(a, same), deepKey(b, same), "distinct files with identical content must produce distinct keys");
  // Same path, different content → distinct key (still content-sensitive).
  assert.notEqual(deepKey(a, "# v1\n"), deepKey(a, "# v2\n"));
});

test("FIX 4: debounce keyed via deepKey does not collide across files with identical content", () => {
  const ws = freshWs();
  const body = "# same body for two files\n";
  const a = path.join(ws, "specs", "a.md");
  const b = path.join(ws, "specs", "b.md");
  const keyA = deepKey(a, body);
  const keyB = deepKey(b, body);
  // A launches and is debounced for its own key…
  markDeepDebounce(ws, keyA);
  assert.equal(isDeepDebounced(ws, keyA), true, "A is debounced after launch");
  assert.equal(isDeepDebounced(ws, keyB), false, "B (different file, identical content) must NOT be debounced");
});

// ── FIX 2: a null / non-object deep-result file must not wedge the stop gate ──
test("FIX 2: deep-result file containing JSON null → readLatestDeepResult returns null AND deletes the file", () => {
  const ws = freshWs();
  const dir = workspaceStateDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deep-result-deadbeef.json");
  fs.writeFileSync(file, "null");   // valid JSON, but null — would crash surfaceDeepResult via result.specPath
  assert.equal(readLatestDeepResult(ws), null, "a null deep-result must be treated as corrupt → null");
  assert.equal(fs.existsSync(file), false, "the corrupt (null) deep-result file must be deleted so it never wedges the gate");
});

test("FIX 2: deep-result file containing a JSON array → treated as corrupt (null + deleted)", () => {
  const ws = freshWs();
  const dir = workspaceStateDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deep-result-cafef00d.json");
  fs.writeFileSync(file, "[1,2,3]");
  assert.equal(readLatestDeepResult(ws), null, "an array deep-result is not a valid result object → null");
  assert.equal(fs.existsSync(file), false, "the array deep-result file must be deleted");
});

// ── FIX 3: oversized deep-result file is dropped (defensive read cap) ──
test("FIX 3: oversized (>256KB) deep-result file → dropped (returns null, file deleted)", () => {
  const ws = freshWs();
  const dir = workspaceStateDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deep-result-bignum.json");
  const huge = JSON.stringify({ hash: "h", summary: "x".repeat(1024 * 1024), reviewers: [], findingCount: 0, maxSeverity: "none" });
  fs.writeFileSync(file, huge);
  assert.ok(fs.statSync(file).size > 256 * 1024, "fixture must actually exceed the cap");
  assert.equal(readLatestDeepResult(ws), null, "an oversized deep-result must be treated as corrupt → null");
  assert.equal(fs.existsSync(file), false, "the oversized deep-result file must be deleted");
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
  const h = deepKey(file, body);   // FIX 4: deep key is (path, content)-keyed

  const panelImpl = async () => [
    { name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }
  ];

  await specReviewCommand(file, ws, { panelImpl });

  const found = readLatestDeepResult(ws);
  assert.ok(found, "deep-result file must be written on completion");
  assert.equal(found.result.hash, h, "deep-result must carry the (path,content) deep key");
  assert.ok(found.result.traceId, "deep-result must carry the trace id");
  assert.equal(typeof found.result.badge, "string");
  assert.equal(typeof found.result.summary, "string");
  assert.ok(Array.isArray(found.result.reviewers));
  assert.equal(typeof found.result.findingCount, "number");
});
