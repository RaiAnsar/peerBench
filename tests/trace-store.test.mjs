import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-root-"));
import { writeTrace, readTrace, listTraces } from "../global-hooks/trace-store.mjs";
import { normalizeSessionId, workspaceStateDir } from "../global-hooks/config-store.mjs";

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
test("writeTrace stores traces 0600 under a 0700 directory (prompts contain source diffs)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  const oldUmask = process.umask(0o022);   // prove the modes are enforced, not umask luck
  let id;
  try {
    id = writeTrace(ws, { gate: "stop", ws, reviewers: [], systemPrompt: "s", userPrompt: "u", rawResponses: {} });
  } finally {
    process.umask(oldUmask);
  }
  const dir = path.join(workspaceStateDir(ws), "traces");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "the traces directory must be owner-only");
  assert.equal(fs.statSync(path.join(dir, `${id}.json`)).mode & 0o777, 0o600, "trace files must be owner-only");
});
