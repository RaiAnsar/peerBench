import { test } from "node:test";
import assert from "node:assert/strict";
import { agenticReview } from "../global-hooks/agentic-review.mjs";

const SCHEMAS = [{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];

// Build a streaming SSE response from an array of delta message objects.
// Each object becomes one SSE event as choices[0].delta; the last gets the finish_reason.
function sse(messages, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder();
  const parts = messages.map((m, i) => `data: ${JSON.stringify({ choices: [{ delta: m, finish_reason: i === messages.length - 1 ? (m.tool_calls ? "tool_calls" : "stop") : null }] })}\n\n`);
  parts.push("data: [DONE]\n\n");
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(parts.join(""))); c.close(); } });
  return { ok, status, body, text: async () => "" };
}

// queued fetch: each call returns the next response (last one repeats)
function fetchQueue(responses) {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

const baseArgs = { baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000 };

test("tool call then verdict → ALLOW, records filesRead", async () => {
  const tools = { schemas: SCHEMAS, execute: async (n, a) => `contents of ${a.path}` };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([
      sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: '{"path":"a.js"}' } }] }]),
      sse([{ content: "ALLOW: looks fine" }])
    ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW");
  assert.deepEqual(res.filesRead, ["a.js"]); assert.equal(res.steps, 2);
});

test("tool error is fed back, not thrown → loop still reaches a verdict", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => { throw new Error("path escapes workspace"); } };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([
      sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: '{"path":"../etc"}' } }] }]),
      sse([{ content: "BLOCK: cannot access" }])
    ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "BLOCK");
});

test("malformed tool arguments don't crash", async () => {
  const seen = [];
  const tools = { schemas: SCHEMAS, execute: async (n, a) => { seen.push(a); return "ok"; } };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([
      sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: "{not json" } }] }]),
      sse([{ content: "ALLOW: ok" }])
    ]) });
  assert.equal(res.ok, true); assert.deepEqual(seen[0], {}); // bad JSON → empty args
});

test("non-conforming content → nudge → verdict", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools,
    fetchImpl: fetchQueue([
      sse([{ content: "I think it is fine" }]),
      sse([{ content: "ALLOW: fine" }])
    ]) });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW");
});

test("step cap → error when model never finishes", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools, maxSteps: 3,
    fetchImpl: fetchQueue([
      sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: '{"path":"a"}' } }] }])
    ]) });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "maxsteps");
});

test("HTTP 401 → auth error", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, tools, fetchImpl: async () => sse([], { ok: false, status: 401 }) });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "auth");
});

test("no api key → nokey", async () => {
  const res = await agenticReview({ ...baseArgs, apiKey: "", tools: { schemas: SCHEMAS, execute: async () => "x" } });
  assert.equal(res.ok, false); assert.equal(res.error.kind, "nokey");
});

test("report mode returns final content as report (no verdict needed)", async () => {
  const tools = { schemas: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {}, } } }], execute: async () => "x" };
  const res = await agenticReview({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000, mode: "report", tools,
    fetchImpl: fetchQueue([
      sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: "{}" } }] }]),
      sse([{ content: "Findings:\n1. bug at a.js:5" }])
    ]) });
  assert.equal(res.ok, true); assert.match(res.report, /a\.js:5/);
});

test("retries a transient network error, then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) { const e = new Error("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
    return sse([{ content: "ALLOW: ok" }]);
  };
  const tools = { schemas: [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }], execute: async () => "x" };
  const res = await agenticReview({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000, tools, fetchImpl });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW"); assert.equal(calls, 2);
});

test("report mode forces conclusion near the step cap (no infinite tool loop)", async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tool_choice === "none") return sse([{ content: "Findings: bug at z.js:1" }]);
    return sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: "{}" } }] }]);
  };
  const tools = { schemas: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }], execute: async () => "x" };
  const res = await agenticReview({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000, mode: "report", maxSteps: 4, tools, fetchImpl });
  assert.equal(res.ok, true); assert.match(res.report, /z\.js:1/);
});
test("thinking:disabled includes thinking:{type:disabled} in first request body", async () => {
  const bodies = [];
  const tools = { schemas: SCHEMAS, execute: async (n, a) => `contents of ${a.path}` };
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sse([{ content: "ALLOW: ok" }]); };
  const res = await agenticReview({ ...baseArgs, tools, thinking: "disabled", fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
});
test("no thinking option → no thinking key in body (back-compat)", async () => {
  const bodies = [];
  const tools = { schemas: SCHEMAS, execute: async (n, a) => `contents of ${a.path}` };
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sse([{ content: "ALLOW: ok" }]); };
  const res = await agenticReview({ ...baseArgs, tools, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal("thinking" in bodies[0], false);
});
test("per-round watchdog caps a slow exploration round, forcing conclusion", async () => {
  let call = 0;
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    call++;
    if (call === 1) { opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }); }
    else resolve(sse([{ content: "Findings: bug at q.js:2" }]));
  });
  const tools = { schemas: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }], execute: async () => "x" };
  const res = await agenticReview({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 10000, maxRoundMs: 50, mode: "report", maxSteps: 6, tools, fetchImpl });
  assert.equal(res.ok, true); assert.match(res.report, /q\.js:2/);
});
