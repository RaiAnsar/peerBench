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
