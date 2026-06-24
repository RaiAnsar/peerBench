import { test } from "node:test";
import assert from "node:assert/strict";
import { review } from "../global-hooks/review-client.mjs";

function fakeFetch(captured, response) {
  return async (url, opts) => { captured.url = url; captured.opts = opts; captured.body = JSON.parse(opts.body); return response; };
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });

test("sends no tools/tool_choice, sets stream:false, returns text+usage", async () => {
  const cap = {};
  const res = await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "sys", user: "usr", timeoutMs: 5000,
    fetchImpl: fakeFetch(cap, ok({ choices: [{ message: { content: "ALLOW: ok" } }], usage: { total_tokens: 9 } })) });
  assert.equal(res.ok, true);
  assert.equal(res.text, "ALLOW: ok");
  assert.deepEqual(res.usage, { total_tokens: 9 });
  assert.equal(cap.url, "https://x/v1/chat/completions");
  assert.equal("tools" in cap.body, false);
  assert.equal("tool_choice" in cap.body, false);
  assert.equal(cap.body.temperature, 0);
  assert.equal(cap.body.stream, false);
  assert.equal(cap.opts.headers.Authorization, "Bearer k");
});
test("maps HTTP 401 to auth error", async () => {
  const res = await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "auth");
});
test("no api key → nokey error", async () => {
  const res = await review({ baseURL: "https://x/v1", apiKey: "", model: "m", system: "s", user: "u" });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "nokey");
});
test("sends provided temperature and merges extra headers", async () => {
  const cap = {};
  await review({ baseURL: "https://x/v1", apiKey: "k", model: "kimi-for-coding", system: "s", user: "u", timeoutMs: 5000,
    temperature: 1, headers: { "User-Agent": "claude-cli/1.0.83 (external, cli)" },
    fetchImpl: (url, opts) => { cap.body = JSON.parse(opts.body); cap.headers = opts.headers; return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }); } });
  assert.equal(cap.body.temperature, 1);
  assert.equal(cap.headers["User-Agent"], "claude-cli/1.0.83 (external, cli)");
  assert.equal(cap.headers.Authorization, "Bearer k");
});
test("invalid-temperature HTTP 400 retries once with provider-declared temperature", async () => {
  const bodies = [];
  let calls = 0;
  const res = await review({
    baseURL: "https://x/v1",
    apiKey: "k",
    model: "kimi-k2.6",
    system: "s",
    user: "u",
    temperature: 1,
    timeoutMs: 5000,
    fetchImpl: async (_url, opts) => {
      calls++;
      bodies.push(JSON.parse(opts.body));
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: "invalid temperature: only 0.6 is allowed for this model" } })
        };
      }
      return ok({ choices: [{ message: { content: "ALLOW: ok" } }] });
    }
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(bodies[0].temperature, 1);
  assert.equal(bodies[1].temperature, 0.6);
});
test("data-inspection HTTP 400 retries once with redacted payment-security terms", async () => {
  const bodies = [];
  let calls = 0;
  const res = await review({
    baseURL: "https://x/v1",
    apiKey: "k",
    model: "qwen",
    system: "Never expose PAN or CVV.",
    user: "Review saving a card XXXX, then run card later.",
    timeoutMs: 5000,
    fetchImpl: async (_url, opts) => {
      calls++;
      bodies.push(JSON.parse(opts.body));
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { code: "data_inspection_failed", message: "Input text data may contain inappropriate content." } })
        };
      }
      return ok({ choices: [{ message: { content: "ALLOW: ok" } }] });
    }
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.doesNotMatch(bodies[1].messages[0].content, /\bPAN\b|CVV/i);
  assert.doesNotMatch(bodies[1].messages[1].content, /card XXXX|run card/i);
  assert.match(bodies[1].messages[1].content, /masked saved payment method|run saved payment method/);
});
test("thinking:disabled includes thinking:{type:disabled} in body", async () => {
  const cap = {};
  await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000, thinking: "disabled",
    fetchImpl: (url, opts) => { cap.body = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }); } });
  assert.deepEqual(cap.body.thinking, { type: "disabled" });
});
test("no thinking option → no thinking key in body (back-compat)", async () => {
  const cap = {};
  await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000,
    fetchImpl: (url, opts) => { cap.body = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }); } });
  assert.equal("thinking" in cap.body, false);
});
test("thinking:null → no thinking key in body", async () => {
  const cap = {};
  await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000, thinking: null,
    fetchImpl: (url, opts) => { cap.body = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }); } });
  assert.equal("thinking" in cap.body, false);
});
test("reserved headers (Authorization, Content-Type) in provider headers are stripped; additive headers kept", async () => {
  const cap = {};
  await review({
    baseURL: "https://x/v1", apiKey: "real-key", model: "m", system: "s", user: "u", timeoutMs: 5000,
    headers: { Authorization: "Bearer EVIL", "Content-Type": "text/plain", "User-Agent": "x" },
    fetchImpl: (url, opts) => { cap.headers = opts.headers; return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }); }
  });
  assert.equal(cap.headers.Authorization, "Bearer real-key");
  assert.equal(cap.headers["Content-Type"], "application/json");
  assert.equal(cap.headers["User-Agent"], "x");
});
