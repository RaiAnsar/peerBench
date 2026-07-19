import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHttpErrorKind, review } from "../global-hooks/review-client.mjs";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bearer = (token) => ["Bearer", token].join(" ");

test("sends one read-only OpenAI-compatible request", async () => {
  const captured = {};
  const result = await review({
    baseURL: "https://provider.invalid/v1",
    apiKey: "fake-key",
    model: "fake-mimo",
    system: "system",
    user: "user",
    timeoutMs: 5_000,
    headers: { "User-Agent": "peerbench-test", Authorization: bearer("attacker"), "Content-Type": "text/plain" },
    fetchImpl: async (url, options) => {
      captured.url = url;
      captured.options = options;
      captured.body = JSON.parse(options.body);
      return ok({ choices: [{ message: { content: "ALLOW: clean" } }], usage: { total_tokens: 9 } });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "ALLOW: clean");
  assert.deepEqual(result.usage, { total_tokens: 9 });
  assert.equal(captured.url, "https://provider.invalid/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, bearer("fake-key"));
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.options.headers["User-Agent"], "peerbench-test");
  assert.equal(captured.body.stream, false);
  assert.equal("tools" in captured.body, false);
  assert.equal("tool_choice" in captured.body, false);
});

test("missing API key fails before fetch", async () => {
  let fetched = false;
  const result = await review({
    baseURL: "https://provider.invalid/v1",
    apiKey: "",
    model: "fake-mimo",
    system: "s",
    user: "u",
    fetchImpl: async () => { fetched = true; return ok({}); }
  });
  assert.equal(fetched, false);
  assert.deepEqual(result, { ok: false, error: { kind: "nokey", detail: "no api key" } });
});

test("HTTP failure classification separates auth, quota, rate, and provider availability", () => {
  assert.equal(classifyHttpErrorKind(401, "unauthorized"), "auth");
  assert.equal(classifyHttpErrorKind(403, "forbidden"), "auth");
  assert.equal(classifyHttpErrorKind(402, "Payment Required"), "quota");
  assert.equal(classifyHttpErrorKind(400, "usage balance exhausted"), "quota");
  assert.equal(classifyHttpErrorKind(429, "Too Many Requests"), "rate");
  assert.equal(classifyHttpErrorKind(503, "Service Unavailable"), "network");
  assert.equal(classifyHttpErrorKind(500, "server error"), "http");
});

for (const [status, body, kind] of [
  [401, "unauthorized", "auth"],
  [402, "payment required", "quota"],
  [429, "too many requests", "rate"],
  [503, "service unavailable", "network"]
]) {
  test(`HTTP ${status} returns ${kind} without retry when the caller disables overload retries`, async () => {
    let calls = 0;
    const result = await review({
      baseURL: "https://provider.invalid/v1",
      apiKey: "fake-key",
      model: "fake-mimo",
      system: "s",
      user: "u",
      timeoutMs: 5_000,
      maxOverloadRetries: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status, text: async () => body };
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, kind);
  });
}

test("a key pool rotates on 429 when retry is enabled", async () => {
  const authorizations = [];
  const result = await review({
    baseURL: "https://provider.invalid/v1",
    apiKeys: ["fake-key-a", "fake-key-b"],
    model: "fake-mimo",
    system: "s",
    user: "u",
    timeoutMs: 5_000,
    maxOverloadRetries: 1,
    keyPick: () => 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      if (authorizations.length === 1) {
        return { ok: false, status: 429, headers: { get: () => null }, text: async () => "rate limited" };
      }
      return ok({ choices: [{ message: { content: "ALLOW: recovered" } }] });
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(authorizations, [bearer("fake-key-a"), bearer("fake-key-b")]);
});

test("Retry-After backoff cannot outlive the total request timeout", async () => {
  const started = Date.now();
  const result = await review({
    baseURL: "https://provider.invalid/v1",
    apiKey: "fake-key",
    model: "fake-mimo",
    system: "s",
    user: "u",
    timeoutMs: 20,
    maxOverloadRetries: 1,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "60" },
      text: async () => "rate limited"
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "timeout");
  assert.ok(Date.now() - started < 500, "a 60-second Retry-After must not hold a 20ms review open");
});

test("a stalled success body cannot outlive the total request timeout", async () => {
  const started = Date.now();
  const result = await review({
    baseURL: "https://provider.invalid/v1",
    apiKey: "fake-key",
    model: "fake-mimo",
    system: "s",
    user: "u",
    timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "timeout");
  assert.ok(Date.now() - started < 500);
});

test("thinking is included only for explicit enabled/disabled values", async () => {
  const bodies = [];
  for (const thinking of ["enabled", "disabled", null]) {
    await review({
      baseURL: "https://provider.invalid/v1",
      apiKey: "fake-key",
      model: "fake-mimo",
      system: "s",
      user: "u",
      thinking,
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return ok({ choices: [{ message: { content: "ALLOW: clean" } }] });
      }
    });
  }
  assert.deepEqual(bodies[0].thinking, { type: "enabled" });
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
  assert.equal("thinking" in bodies[2], false);
});

test("inline think blocks are stripped without erasing a reasoning-only response", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const content = calls === 1
      ? "<think>private reasoning</think>\nBLOCK: concrete bug"
      : "<think>reasoning only</think>";
    return ok({ choices: [{ message: { content } }] });
  };
  const first = await review({ baseURL: "https://provider.invalid/v1", apiKey: "fake", model: "fake", system: "s", user: "u", fetchImpl });
  const second = await review({ baseURL: "https://provider.invalid/v1", apiKey: "fake", model: "fake", system: "s", user: "u", fetchImpl });
  assert.equal(first.text, "BLOCK: concrete bug");
  assert.match(second.text, /reasoning only/);
});

test("malformed success responses return parse errors", async () => {
  const nonJson = await review({
    baseURL: "https://provider.invalid/v1", apiKey: "fake", model: "fake", system: "s", user: "u",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })
  });
  const noContent = await review({
    baseURL: "https://provider.invalid/v1", apiKey: "fake", model: "fake", system: "s", user: "u",
    fetchImpl: async () => ok({ choices: [] })
  });
  assert.equal(nonJson.error.kind, "parse");
  assert.equal(noContent.error.kind, "parse");
});
