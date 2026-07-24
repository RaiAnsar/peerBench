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
  assert.deepEqual(reviewers[0].reviewIdentity, {
    kind: "grok-cli",
    model: "grok-4.5",
    effort: "low",
    mode: "tool-free-no-plan-v1"
  });
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

test("MiMo can use the explicit review's one-minute budget instead of the old 45-second ceiling", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const calls = [];
  const [mimo] = resolveReviewers({
    env: { MIMO_API_KEY: "fake-mimo-key" },
    reviewers: ["mimo"],
    reviewImpl: async (request) => {
      calls.push(request);
      return { ok: true, text: "ALLOW: clean", usage: null };
    }
  });

  const result = await mimo.run({
    system: "system",
    user: "user",
    timeoutMs: 60_000,
    cooldownScope: "review:/workspace-a"
  });
  assert.equal(result.verdict, "ALLOW");
  assert.ok(calls[0].timeoutMs > 45_000 && calls[0].timeoutMs <= 60_000);
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

test("ignoreTransientCooldowns bypasses a timeout cooldown but still honors quota/auth/rate", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const scope = "push-review:/workspace-a";
  recordReviewerCooldown("mimo", "timeout", "timed out", { root: ROOT, now: 1_000, env: {}, scope });
  let calls = 0;
  const run = withAvailability("mimo", "MiMo", async () => {
    calls += 1;
    return { name: "MiMo", verdict: "ALLOW" };
  }, { now: () => 2_000, env: {} });

  // A prior timeout must not skip an explicitly requested review — the whole point is a fresh call.
  const bypassed = await run({ cooldownScope: scope, ignoreTransientCooldowns: true });
  assert.equal(calls, 1);
  assert.equal(bypassed.verdict, "ALLOW");
  assert.equal(bypassed.skipped, undefined);

  // Without the flag the same cooldown still fast-skips (stop-gate noise suppression depends on it).
  const skipped = await run({ cooldownScope: scope });
  assert.equal(calls, 1);
  assert.equal(skipped.skipped, "cooldown");

  // Hard availability failures are NOT transient: quota still skips even for explicit reviews.
  clearReviewerCooldowns({ root: ROOT });
  recordReviewerCooldown("mimo", "quota", "HTTP 402", { root: ROOT, now: 1_000, env: {}, scope });
  const quotaSkipped = await run({ cooldownScope: scope, ignoreTransientCooldowns: true });
  assert.equal(calls, 1);
  assert.equal(quotaSkipped.skipped, "cooldown");
  assert.equal(quotaSkipped.errorKind, "quota");
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
  assert.match(first.error, /network failed on this run/i);
  assert.doesNotMatch(first.error, /skipped without a model call/i);
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
  assert.match(result.error, /network failed on this run/i);
  assert.equal(readReviewerCooldown("mimo", { root: ROOT, now: 10_001, env: {} }).kind, "network");
  clearReviewerCooldowns({ root: ROOT });
});

test("a live timeout is labeled as this run and starts its cooldown after the call finishes", async () => {
  clearReviewerCooldowns({ root: ROOT });
  const times = [1_000, 46_000];
  const run = withAvailability("grok", "Grok", async () => ({
    name: "Grok",
    error: "timed out",
    errorKind: "timeout"
  }), { now: () => times.shift(), env: {} });

  const result = await run({ cwd: "/workspace-a", cooldownScope: "review:/workspace-a" });
  assert.equal(result.errorKind, "timeout");
  assert.equal(result.latencyMs, 45_000);
  assert.match(result.error, /timed out on this run/i);
  assert.doesNotMatch(result.error, /skipped without a model call/i);
  const cooldown = readReviewerCooldown("grok", {
    root: ROOT,
    now: 46_001,
    env: {},
    scope: "review:/workspace-a"
  });
  assert.equal(cooldown.ts, 46_000);
  assert.equal(cooldown.until, 106_000);
  clearReviewerCooldowns({ root: ROOT });
});

test("timeout cooldowns are scoped and do not suppress unrelated workspaces", async () => {
  clearReviewerCooldowns({ root: ROOT });
  let calls = 0;
  let clock = 1_000;
  const run = withAvailability("grok", "Grok", async () => {
    calls += 1;
    return calls === 1
      ? { name: "Grok", error: "timed out", errorKind: "timeout" }
      : { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: clean" };
  }, { now: () => clock++, env: {} });

  const first = await run({ cwd: "/workspace-a", cooldownScope: "review:/workspace-a" });
  const otherWorkspace = await run({ cwd: "/workspace-b", cooldownScope: "review:/workspace-b" });
  const sameWorkspace = await run({ cwd: "/workspace-a", cooldownScope: "review:/workspace-a" });

  assert.equal(first.errorKind, "timeout");
  assert.equal(otherWorkspace.verdict, "ALLOW");
  assert.equal(sameWorkspace.skipped, "cooldown");
  assert.equal(calls, 2);
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
