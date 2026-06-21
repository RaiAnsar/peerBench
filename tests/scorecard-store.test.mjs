import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sc-root-")));
import { recordGrade, loadScorecard, autoStatsFromTraces, computeScorecard, renderScorecard, letterGrade } from "../global-hooks/scorecard-store.mjs";

// Build a fake shared root with per-workspace traces.
function freshRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sc-")));
  return root;
}
function writeTrace(root, wsSlug, id, reviewers, gate = "stop") {
  const td = path.join(root, "state", wsSlug, "traces");
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, `${id}.json`), JSON.stringify({ id, gate, reviewers }));
}

test("autoStatsFromTraces: participation, errors, blocks, and UNIQUE blocks across workspaces", () => {
  const root = freshRoot();
  // ws1: MiMo blocks alone (unique), others allow
  writeTrace(root, "ws1-aaaaaaaaaaaaaaaa", "100-aaa", [
    { name: "Kimi", verdict: "ALLOW" }, { name: "GLM", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }
  ]);
  // ws2: Kimi AND MiMo both block → NOT unique for either
  writeTrace(root, "ws2-bbbbbbbbbbbbbbbb", "200-bbb", [
    { name: "Kimi", verdict: "BLOCK" }, { name: "MiMo", verdict: "BLOCK" }
  ]);
  // ws2: Qwen errored (quota)
  writeTrace(root, "ws2-bbbbbbbbbbbbbbbb", "300-ccc", [
    { name: "Kimi", verdict: "ALLOW" }, { name: "Qwen", error: "http: 429 quota" }
  ]);
  const m = autoStatsFromTraces({ root });
  assert.equal(m.MiMo.participated, 2);
  assert.equal(m.MiMo.blocks, 2);
  assert.equal(m.MiMo.uniqueBlocks, 1, "MiMo blocked alone once (ws1), shared once (ws2)");
  assert.equal(m.Kimi.blocks, 1);
  assert.equal(m.Kimi.uniqueBlocks, 0, "Kimi never blocked alone");
  assert.equal(m.Qwen.errors, 1);
  assert.equal(m.Qwen.participated, 1);
});

test("autoStatsFromTraces canonicalizes reviewer casing (glm + GLM → one row)", () => {
  const root = freshRoot();
  writeTrace(root, "ws1-aaaaaaaaaaaaaaaa", "100-aaa", [{ name: "GLM", verdict: "ALLOW" }]);
  writeTrace(root, "ws2-bbbbbbbbbbbbbbbb", "200-bbb", [{ name: "glm", verdict: "BLOCK" }]);
  const m = autoStatsFromTraces({ root });
  assert.ok(m.GLM, "merged under the canonical display name GLM");
  assert.equal(m.glm, undefined, "no separate lowercase row");
  assert.equal(m.GLM.participated, 2);
  assert.equal(m.GLM.blocks, 1);
});

test("recordGrade appends an event; loadScorecard reads it back; rejects bad grade", () => {
  const root = freshRoot();
  const e = recordGrade({ traceId: "100-aaa", reviewer: "MiMo", grade: "tp", note: "caught a leaked token", ws: "ws1", gate: "stop" }, { root, now: 1000 });
  assert.equal(e.grade, "tp");
  assert.equal(e.by, "claude");
  const { events } = loadScorecard({ root });
  assert.equal(events.length, 1);
  assert.equal(events[0].reviewer, "MiMo");
  assert.equal(events[0].note, "caught a leaked token");
  assert.throws(() => recordGrade({ traceId: "x", reviewer: "MiMo", grade: "good" }, { root }), /tp\|fp\|miss/);
  assert.throws(() => recordGrade({ traceId: "x", reviewer: "", grade: "tp" }, { root }), /reviewer is required/);
});

test("recordGrade is append-only across calls (distinct ids)", () => {
  const root = freshRoot();
  recordGrade({ traceId: "a", reviewer: "MiMo", grade: "tp" }, { root, now: 10 });
  recordGrade({ traceId: "b", reviewer: "Kimi", grade: "fp" }, { root, now: 20 });
  const { events } = loadScorecard({ root });
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
});

test("computeScorecard merges auto + judgment layers; precision from TP/(TP+FP)", () => {
  const root = freshRoot();
  writeTrace(root, "ws1-aaaaaaaaaaaaaaaa", "100-aaa", [
    { name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }
  ]);
  recordGrade({ traceId: "100-aaa", reviewer: "MiMo", grade: "tp" }, { root, now: 1 });
  recordGrade({ traceId: "100-aaa", reviewer: "MiMo", grade: "fp" }, { root, now: 2 });
  recordGrade({ traceId: "100-aaa", reviewer: "MiMo", grade: "tp" }, { root, now: 3 });
  const card = computeScorecard({ root });
  assert.equal(card.gradedEvents, 3);
  assert.equal(card.models.MiMo.tp, 2);
  assert.equal(card.models.MiMo.fp, 1);
  assert.ok(Math.abs(card.models.MiMo.precision - 2 / 3) < 1e-9, "precision = 2/3");
  assert.equal(card.models.Kimi.precision, null, "ungraded → null precision");
});

test("computeScorecard tolerates a graded reviewer that never appears in traces", () => {
  const root = freshRoot();
  recordGrade({ traceId: "z", reviewer: "Ghost", grade: "tp" }, { root, now: 1 });
  const card = computeScorecard({ root });
  assert.equal(card.models.Ghost.tp, 1);
  assert.equal(card.models.Ghost.participated, 0);
});

test("letterGrade: reliable + high verified precision + unique value → A; flaky+unverified → low", () => {
  assert.equal(letterGrade({ participated: 100, errorRate: 0.0, precision: 0.95, uniqueBlocks: 3 }), "A");
  assert.equal(letterGrade({ participated: 100, errorRate: 0.5, precision: null, uniqueBlocks: 0 }), "F");
  assert.equal(letterGrade({ participated: 0 }), "—", "no participation → no grade");
});

test("renderScorecard returns a table with a header and every model row", () => {
  const root = freshRoot();
  writeTrace(root, "ws1-aaaaaaaaaaaaaaaa", "100-aaa", [
    { name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }
  ]);
  recordGrade({ traceId: "100-aaa", reviewer: "MiMo", grade: "tp" }, { root, now: 1 });
  const out = renderScorecard(computeScorecard({ root }));
  assert.match(out, /Reviewer scorecard/);
  assert.match(out, /MiMo/);
  assert.match(out, /Kimi/);
  assert.match(out, /grade/);
});

test("renderScorecard: empty root → friendly empty message", () => {
  const root = freshRoot();
  assert.match(renderScorecard(computeScorecard({ root })), /no traces yet/);
});
