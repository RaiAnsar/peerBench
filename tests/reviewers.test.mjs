import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-reviewer-root-"));
process.env.BENCH_ROOT = ROOT;

import {
  classifyReviewerFailureText,
  extractVerdict,
  resolveReviewers,
  withAvailability
} from "../global-hooks/reviewers.mjs";
import {
  clearReviewerCooldowns,
  readReviewerCooldown,
  recordReviewerCooldown
} from "../global-hooks/config-store.mjs";

test("extractVerdict ignores fenced examples and finds the real verdict", () => {
  assert.equal(extractVerdict("Sure!\n```\nALLOW: example\n```"), null);
  assert.equal(extractVerdict("```\nALLOW: example\n```\nBLOCK: concrete bug")?.verdict, "BLOCK");
  assert.equal(extractVerdict("ALLOW: clean")?.verdict, "ALLOW");
});

test("default resolver exposes exactly Grok and MiMo", () => {
  const reviewers = resolveReviewers({ env: {} });
  assert.deepEqual(reviewers.map((reviewer) => reviewer.name), ["grok", "mimo"]);
});

test("MiMo receives the caller's bounded timeout and can retry malformed output once", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const calls = [];
  const [mimo] = resolveReviewers({
    env: { MIMO_API_KEY: "fake-mimo-key" },
    reviewers: ["mimo"],
    reviewImpl: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? { ok: true, text: "looks fine", usage: null }
        : { ok: true, text: "ALLOW: clean", usage: null };
    }
  });
  const result = await mimo.run({ system: "system", user: "user", timeoutMs: 15_000 });
  assert.equal(result.verdict, "ALLOW");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 15_000));
  assert.equal(calls[0].maxOverloadRetries, 0);
});

test("an active cooldown skips the model call", async () => {
  clearReviewerCooldowns({ root: ROOT });
  recordReviewerCooldown("mimo", "rate", "HTTP 429", { root: ROOT, now: 1_000, ttlMs: 60_000, env: {} });
  let calls = 0;
  const run = withAvailability("mimo", "MiMo", async () => {
    calls += 1;
    return { name: "MiMo", verdict: "ALLOW" };
  }, { now: () => 2_000, env: {} });
  const result = await run({});
  assert.equal(calls, 0);
  assert.equal(result.skipped, "cooldown");
  assert.equal(result.errorKind, "rate");
  clearReviewerCooldowns({ root: ROOT });
});

test("quota failures start a cooldown and redact diagnostics before returning or persisting", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const secret = "fake_mimo_secret_456";
  const run = withAvailability("mimo", "MiMo", async () => ({
    name: "MiMo",
    error: [
      "HTTP 402 payment required",
      `Authorization: ${["Bearer", "bearer-token"].join(" ")}`,
      ["https://", ["user", "pass"].join(String.fromCharCode(58)), "@example.invalid"].join(""),
      secret
    ].join("; "),
    errorKind: "quota"
  }), { now: () => 5_000, env: { MIMO_API_KEY: secret } });
  const result = await run({});
  assert.equal(result.errorKind, "quota");
  assert.doesNotMatch(result.error, /fake_mimo_secret_456|bearer-token|user:pass/);
  const cooldown = readReviewerCooldown("mimo", {
    root: ROOT,
    now: 6_000,
    env: { MIMO_API_KEY: secret }
  });
  assert.equal(cooldown.kind, "quota");
  assert.doesNotMatch(cooldown.detail, /fake_mimo_secret_456|bearer-token|user:pass/);
  clearReviewerCooldowns({ root: ROOT });
});

test("failure classification separates quota, rate, timeout, and network failures", () => {
  assert.equal(classifyReviewerFailureText("HTTP 402 Payment Required"), "quota");
  assert.equal(classifyReviewerFailureText("usage balance exhausted"), "quota");
  assert.equal(classifyReviewerFailureText("HTTP 429 Too Many Requests"), "rate");
  assert.equal(classifyReviewerFailureText("HTTP 503 Service Unavailable"), "network");
  assert.equal(classifyReviewerFailureText("network: fetch failed"), "network");
  assert.equal(classifyReviewerFailureText("operation aborted after timeout"), "timeout");
});

test("generic HTTP 503 adapter failures enter the network cooldown", async () => {
  clearReviewerCooldowns({ root: ROOT });
  let calls = 0;
  const run = withAvailability("mimo", "MiMo", async () => {
    calls += 1;
    return { name: "MiMo", error: "http: HTTP 503: service unavailable", errorKind: "http" };
  }, { now: () => 20_000, env: {} });

  const first = await run({});
  const second = await run({});
  assert.equal(first.errorKind, "network");
  assert.match(first.error, /network unavailable/i);
  assert.equal(second.skipped, "cooldown");
  assert.equal(calls, 1, "the unavailable provider is not called again during cooldown");
  assert.equal(readReviewerCooldown("mimo", { root: ROOT, now: 20_001, env: {} }).kind, "network");
  clearReviewerCooldowns({ root: ROOT });
});

test("a thrown reviewer failure is contained and starts the matching cooldown", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const run = withAvailability("mimo", "MiMo", async () => {
    throw new Error("network: fetch failed");
  }, { now: () => 10_000, env: {} });
  const result = await run({});
  assert.equal(result.errorKind, "network");
  assert.match(result.error, /network unavailable/i);
  assert.equal(readReviewerCooldown("mimo", { root: ROOT, now: 10_001, env: {} }).kind, "network");
  clearReviewerCooldowns({ root: ROOT });
});

test("MiMo without a key fails locally without invoking the HTTP client", async () => {
  clearReviewerCooldowns({ root: ROOT });
  let calls = 0;
  const [mimo] = resolveReviewers({
    env: {},
    reviewers: ["mimo"],
    reviewImpl: async () => { calls += 1; return { ok: true, text: "ALLOW: clean" }; }
  });
  const result = await mimo.run({ system: "s", user: "u" });
  assert.equal(calls, 0);
  assert.equal(result.errorKind, "auth");
  assert.match(result.error, /authentication unavailable|no API key/i);
  clearReviewerCooldowns({ root: ROOT });
});
