import { test } from "node:test";
import assert from "node:assert/strict";
import { huntPanel, buildHuntUser, HUNT_SYSTEM } from "../global-hooks/hunt.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hunt-"));

test("buildHuntUser uses the seed when given, broad sweep otherwise", () => {
  assert.match(buildHuntUser("monitor never alerted"), /monitor never alerted/);
  assert.match(buildHuntUser(""), /broad bug-hunt sweep/);
});
test("huntPanel runs kimi+mimo agentically and returns findings", async () => {
  // companion.json in the temp root with kimi+mimo keys, reviewers kimi+mimo (no codex to avoid spawning real codex)
  const root = process.env.BENCH_ROOT;
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi", "mimo"], providers: {
    kimi: { baseURL: "https://x/v1", model: "kimi-for-coding", apiKey: "k" }, mimo: { baseURL: "https://y/v1", model: "mimo", apiKey: "m" } } }));
  // stub fetch: immediately return a findings message (no tool calls) — SSE format (stream:true)
  const enc = new TextEncoder();
  const reviewImpl = async () => {
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "1. bug at x.js:3" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const out = await huntPanel({ cwd: process.cwd(), seed: "test", reviewImpl });
  assert.deepEqual(out.map((o) => o.name).sort(), ["Kimi", "MiMo"]);
  for (const o of out) assert.match(o.findings, /x\.js:3/);
});
test("huntPanel deep=true sends thinking:{type:'enabled'} in the request body", async () => {
  const root = process.env.BENCH_ROOT;
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi", "mimo"], providers: {
    kimi: { baseURL: "https://x/v1", model: "kimi-for-coding", apiKey: "k" }, mimo: { baseURL: "https://y/v1", model: "mimo", apiKey: "m" } } }));
  const enc = new TextEncoder();
  const capturedThinking = [];
  const reviewImpl = async (_url, opts) => {
    const parsed = JSON.parse(opts.body);
    capturedThinking.push(parsed.thinking);
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "deep finding at z.ts:1" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const out = await huntPanel({ cwd: process.cwd(), seed: "x", deep: true, reviewImpl });
  assert.deepEqual(out.map((o) => o.name).sort(), ["Kimi", "MiMo"]);
  // every request body must include thinking:{type:"enabled"}
  assert.ok(capturedThinking.length > 0, "reviewImpl must have been called");
  for (const t of capturedThinking) {
    assert.deepStrictEqual(t, { type: "enabled" });
  }
});
