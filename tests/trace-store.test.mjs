import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-root-"));
import { writeTrace, readTrace, listTraces } from "../global-hooks/trace-store.mjs";
import { normalizeSessionId } from "../global-hooks/config-store.mjs";

test("write/read/list round-trip and prompt cap", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tw-"));
  const id = writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "kimi", model: "kimi-k2.7-code", latencyMs: 12, verdict: "ALLOW", firstLine: "ALLOW: ok" }],
    systemPrompt: "s", userPrompt: "u", rawResponses: { kimi: "x".repeat(100_000) } }, { now: 1750000000000 });
  assert.match(id, /^\d+-[0-9a-f]{12}$/);
  const t = readTrace(ws, id);
  assert.equal(t.gate, "stop");
  assert.ok(t.rawResponses.kimi.length <= 64 * 1024);
  assert.equal(listTraces(ws, 5)[0].id, id);
});
test("two writes in the same ms get distinct ids (no collision)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const a = writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "kimi", verdict: "ALLOW" }], systemPrompt: "s", userPrompt: "u", rawResponses: {} }, { now: 1750000000000 });
  const b = writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "kimi", verdict: "ALLOW" }], systemPrompt: "s", userPrompt: "u", rawResponses: {} }, { now: 1750000000000 });
  assert.notEqual(a, b);
  assert.equal(listTraces(ws, 10).length, 2);
});
test("writeTrace persists a normalized sessionKey when provided", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ts-session-"));
  const id = writeTrace(ws, { gate: "stop", ws, sessionKey: "chat-A", reviewers: [{ name: "kimi", verdict: "ALLOW" }] });
  assert.equal(readTrace(ws, id).sessionKey, normalizeSessionId("chat-A"));
});

// The stop gate deliberately does NOT persist its prompts (they are the user's whole dirty diff),
// which left no way to ask afterwards whether slow reviews correlate with large evidence — the
// exact question the 15s stop timeouts raised (4 of 6 runs, 2026-07-26). Size is cheap and safe.
test("writeTrace persists evidenceBytes when a gate reports it, and omits it otherwise", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "trace-evidence-"));
  const withSize = readTrace(ws, writeTrace(ws, { gate: "stop", ws, evidenceBytes: 4096, reviewers: [{ name: "MiMo", verdict: "ALLOW" }] }));
  assert.equal(withSize.evidenceBytes, 4096);

  const without = readTrace(ws, writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "MiMo", verdict: "ALLOW" }] }));
  assert.equal(without.evidenceBytes, undefined, "no invented zero for gates that do not measure it");
});
