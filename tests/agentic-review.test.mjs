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

// RC-1: the agentic path (hunt / investigate / deep gate) had NO 429 retry — a single transient
// overload killed the whole run (trace evidence: GLM steps:1, "http 429"). It must now back off & retry.
const r429 = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '{"error":{"code":"1305","message":"overloaded"}}' });

test("RC-1: a transient 429 is retried, not fatal (agentic overload retry)", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? r429() : sse([{ content: "1. bug at a.js:3" }]); };
  const res = await agenticReview({ ...baseArgs, mode: "report", tools, fetchImpl, sleepImpl: async () => {}, rng: () => 0.5 });
  assert.equal(res.ok, true, "a transient 429 must be retried, not returned as a fatal http error");
  assert.match(res.report, /a\.js:3/);
  assert.ok(calls >= 2, `expected a retry after the 429 (got ${calls} fetch calls)`);
});

test("RC-1: gives up cleanly after exhausting 429 retries (1 + 5)", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  let calls = 0;
  const fetchImpl = async () => { calls++; return r429(); };
  const res = await agenticReview({ ...baseArgs, mode: "report", tools, fetchImpl, sleepImpl: async () => {}, rng: () => 0.5 });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "http");
  assert.match(res.error.detail, /429/);
  assert.equal(calls, 6, `expected 1 initial + 5 overload retries = 6 fetches (got ${calls})`);
});

test("readSSE captures a final event with NO trailing blank line (truncated stream)", async () => {
  // A stream whose last `data:` event isn't terminated by \n\n (and no [DONE]) — the old reader
  // dropped it, losing the verdict → spurious no-verdict/timeout (found by the bench's own hunt).
  const enc = new TextEncoder();
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: "ALLOW: fine" }, finish_reason: "stop" }] })}`;
  const resp = { ok: true, status: 200, text: async () => "",
    body: new ReadableStream({ start(c) { c.enqueue(enc.encode(raw)); c.close(); } }) };
  const res = await agenticReview({ ...baseArgs, tools: { schemas: SCHEMAS, execute: async () => "" }, fetchImpl: async () => resp });
  assert.equal(res.ok, true); assert.equal(res.verdict, "ALLOW");
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

test("report mode rejects raw tool-call markup and nudges for final findings", async () => {
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, mode: "report", tools,
    fetchImpl: fetchQueue([
      sse([{ content: "<tool_call><function=read_file><parameter=path>src/a.ts</parameter></function></tool_call>" }]),
      sse([{ content: "Findings:\n1. bug at fixed.ts:7" }])
    ]) });
  assert.equal(res.ok, true);
  assert.match(res.report, /fixed\.ts:7/);
});

test("data-inspection HTTP 400 retries once with redacted payment-security terms", async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls++;
    bodies.push(JSON.parse(opts.body));
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        body: null,
        text: async () => JSON.stringify({ error: { code: "data_inspection_failed", message: "Input text data may contain inappropriate content." } })
      };
    }
    return sse([{ content: "Findings:\n1. safe at payment.ts:3" }]);
  };
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({
    ...baseArgs,
    mode: "report",
    user: "Review saving a card XXXX; never log PAN/CVV; later run card on date.",
    tools,
    fetchImpl
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  const retriedUser = bodies[1].messages.find((m) => m.role === "user").content;
  assert.doesNotMatch(retriedUser, /\bPAN\b|CVV|card XXXX|run card/i);
  assert.match(retriedUser, /payment-account-number|security-code|saved payment method/);
  assert.equal(res.diag.rounds[0].retry, "redacted-data-inspection");
});

test("invalid-temperature HTTP 400 retries once with provider-declared temperature", async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls++;
    bodies.push(JSON.parse(opts.body));
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        body: null,
        text: async () => JSON.stringify({ error: { message: "invalid temperature: only 1 is allowed for this model" } })
      };
    }
    if (calls === 2) {
      return sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: '{"path":"package.json"}' } }] }]);
    }
    return sse([{ content: "Findings:\n1. safe at temp.ts:1" }]);
  };
  const tools = { schemas: SCHEMAS, execute: async () => "x" };
  const res = await agenticReview({ ...baseArgs, mode: "report", temperature: 0.6, tools, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);
  assert.equal(bodies[0].temperature, 0.6);
  assert.equal(bodies[1].temperature, 1);
  assert.equal(bodies[2].temperature, 1);
  assert.equal(res.diag.rounds[0].retry, "temperature-1");
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

test("conclude round OMITS tools so a tool_choice-ignoring model still converges (kimi-k2.6 fix)", async () => {
  // Simulate a model that IGNORES tool_choice and keeps calling tools whenever tools are offered.
  // The fix: on the conclude round the tools array is omitted entirely → it cannot call tools → must answer.
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tools === undefined) return sse([{ content: "Findings: bug at z.js:1" }]);   // conclude round: no tools offered
    return sse([{ tool_calls: [{ id: "1", index: 0, function: { name: "read_file", arguments: "{}" } }] }]); // keeps reading regardless of tool_choice
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

test("every agentic request carries the coding-client User-Agent (bare Node UA is deterministically 429'd by coding-plan endpoints)", async () => {
  const { DEFAULT_USER_AGENT } = await import("../global-hooks/review-client.mjs");
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts.headers); return sse([{ content: "ALLOW: fine" }]); };
  await agenticReview({ ...baseArgs, tools: { schemas: SCHEMAS, execute: async () => "" }, fetchImpl });
  assert.ok(seen.length > 0);
  for (const h of seen) assert.equal(h["User-Agent"], DEFAULT_USER_AGENT, "agentic calls must send the same UA as review-client");
  // provider-supplied headers still win (spread after the default)
  seen.length = 0;
  await agenticReview({ ...baseArgs, headers: { "User-Agent": "custom/1" }, tools: { schemas: SCHEMAS, execute: async () => "" }, fetchImpl });
  for (const h of seen) assert.equal(h["User-Agent"], "custom/1", "provider header overrides the default UA");
});

test("agentic: temperature null → omitted from every request body (K3 contract)", async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sse([{ content: "ALLOW: fine" }]); };
  await agenticReview({ ...baseArgs, temperature: null, tools: { schemas: SCHEMAS, execute: async () => "" }, fetchImpl });
  assert.ok(bodies.length > 0);
  for (const b of bodies) assert.equal("temperature" in b, false, "null must mean ABSENT on the agentic path too");
});
