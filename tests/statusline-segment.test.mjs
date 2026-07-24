import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-statusline-root-"));
process.env.BENCH_ROOT = ROOT;

const { benchBadge, renderSegment, selectTrace } = await import("../global-hooks/statusline-segment.mjs");
const { writeTrace } = await import("../global-hooks/trace-store.mjs");
const { wsKey } = await import("../global-hooks/config-store.mjs");

const WS_A = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ws-a-"));
const WS_B = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ws-b-"));
const SESSION = "1111111111111111";
const OTHER_SESSION = "2222222222222222";

const reviewers = (...pairs) => pairs.map(([name, verdict, error]) => ({ name, verdict, error: error || null }));

test("one symbol per reviewer, using the panelBadge vocabulary", () => {
  assert.equal(benchBadge({ reviewers: reviewers(["Grok", "ALLOW"], ["MiMo", "ALLOW"]) }), "✓✓");
  assert.equal(benchBadge({ reviewers: reviewers(["Grok", "ALLOW"], ["MiMo", "BLOCK"]) }), "✓✗");
  assert.equal(benchBadge({ reviewers: reviewers(["Grok", null, "timed out"], ["MiMo", "ALLOW"]) }), "!✓");
  assert.equal(benchBadge({ reviewers: [] }), "");
});

// Gotcha #8: the statusline is ONE GLOBAL process whose cwd is the LAUNCHING project. Falling back
// to it renders peerBench's own badge inside every other project's window.
test("renders nothing without a per-window directory — never guesses from cwd", () => {
  assert.equal(renderSegment("", SESSION, { color: false }), "");
  assert.equal(renderSegment(undefined, SESSION, { color: false }), "");
  assert.equal(renderSegment(null, null, { color: false }), "");
});

test("surfaces this session's newest trace for this workspace", () => {
  writeTrace(WS_A, { gate: "stop", ws: WS_A, sessionKey: SESSION, reviewers: reviewers(["Grok", "BLOCK"], ["MiMo", "ALLOW"]) }, { now: 1_000 });
  writeTrace(WS_A, { gate: "stop", ws: WS_A, sessionKey: SESSION, reviewers: reviewers(["Grok", "ALLOW"], ["MiMo", "ALLOW"]) }, { now: 2_000 });

  assert.equal(renderSegment(WS_A, SESSION, { color: false }), "bench ✓✓", "newest wins");
});

// Gotcha #9: two chats in one checkout must not show each other's verdicts.
test("never surfaces another session's trace", () => {
  writeTrace(WS_B, { gate: "stop", ws: WS_B, sessionKey: OTHER_SESSION, reviewers: reviewers(["Grok", "BLOCK"], ["MiMo", "BLOCK"]) }, { now: 3_000 });

  assert.equal(renderSegment(WS_B, SESSION, { color: false }), "",
    "a stamped trace owned by a different session is not ours to render");
});

test("falls back to an UNSTAMPED legacy trace so pre-feature projects keep a badge", () => {
  writeTrace(WS_B, { gate: "stop", ws: WS_B, reviewers: reviewers(["Grok", "ALLOW"], ["MiMo", "ALLOW"]) }, { now: 4_000 });

  assert.equal(renderSegment(WS_B, SESSION, { color: false }), "bench ✓✓");
});

test("rejects a trace stamped for a different workspace", () => {
  const foreign = { id: "x", ts: "now", wsKey: wsKey(WS_A), sessionKey: SESSION, reviewers: reviewers(["Grok", "ALLOW"]) };
  assert.equal(selectTrace([foreign], WS_B, SESSION), null,
    "ownership stamp must survive symlink/relative-path aliasing of the same state dir");
});

test("the CLI prints the segment for the directory it is given", () => {
  const out = renderSegment(WS_A, SESSION, { color: true });
  assert.match(out, /bench/);
  assert.match(out, /\[/, "colored output for the real statusline");
});
