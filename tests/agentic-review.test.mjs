import { test } from "node:test";
import assert from "node:assert/strict";
import { agenticReview } from "../global-hooks/agentic-review.mjs";

const SCHEMAS = [{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
// queued fetch: each call returns the next response (last one repeats)
function fetchQueue(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.json, text: async () => r.text ?? "" };
  };
}
const toolMsg = (calls) => ({ json: { choices: [{ message: { tool_calls: calls } }] } });
const textMsg = (content) => ({ json: { choices: [{ message: { content } }] } });
const baseArgs = { baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000 };

test("tool call then verdict → ALLOW, records filesRead", async () => {
  const tools = { schemas: SCHEMAS, execute: async (n, a) => `contents of ${a.path}` };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([ toolMsg([{ id: "1", function: { name: "read_file", arguments: '{"path":"a.js"}' } }]), textMsg("ALLOW: looks fine") ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW");
  assert.deepEqual(res.filesRead, ["a.js"]); assert.equal(res.steps, 2);
});
test("tool error is fed back, not thrown → loop still reaches a verdict", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => { throw new Error("path escapes workspace"); } };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([ toolMsg([{ id: "1", function: { name: "read_file", arguments: '{"path":"../etc"}' } }]), textMsg("BLOCK: cannot access") ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "BLOCK");
});
test("malformed tool arguments don't crash", async () => {
  const seen = [];
  const tools = { schemas: SCHEMAS, execute: async (n, a) => { seen.push(a); return "ok"; } };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([ toolMsg([{ id: "1", function: { name: "read_file", arguments: "{not json" } }]), textMsg("ALLOW: ok") ]) });
  assert.equal(res.ok, true); assert.deepEqual(seen[0], {}); // bad JSON → empty args
});
test("non-conforming content → nudge → verdict", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([ textMsg("I think it is fine"), textMsg("ALLOW: fine") ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW");
});
test("step cap → error when model never finishes", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools, maxSteps: 3,
    fetchImpl: fetchQueue([ toolMsg([{ id: "1", function: { name: "read_file", arguments: '{"path":"a"}' } }]) ]) });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "maxsteps");
});
test("HTTP 401 → auth error", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools, fetchImpl: async () => ({ ok: false, status: 401, text: async () => "no" }) });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "auth");
});
test("no api key → nokey", async () => {
  const res = await agenticReview({ ...baseArgs, apiKey: "", tools: { schemas: SCHEMAS, execute: async () => "x" } });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "nokey");
});
