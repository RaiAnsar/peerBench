import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPLICIT_REVIEW_TIMEOUT_MS,
  LIGHTWEIGHT_REVIEW_TIMEOUT_MS,
  PUSH_REVIEW_SYSTEM,
  buildHuntUser,
  huntPanel,
  parseSpecFindings,
  pushReviewPanel
} from "../global-hooks/hunt.mjs";
import { summarizeSpecReview, shouldRewake } from "../global-hooks/deep-review.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hunt-"));

test("buildHuntUser uses the seed when given, broad sweep otherwise", () => {
  assert.match(buildHuntUser("monitor never alerted"), /monitor never alerted/);
  assert.match(buildHuntUser(""), /broad bug-hunt sweep/);
});
test("huntPanel runs Grok+MiMo without real provider calls", async () => {
  const root = process.env.BENCH_ROOT;
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["grok", "mimo"], providers: {
    mimo: { baseURL: "https://example.invalid/v1", model: "mimo", apiKey: "m" }
  } }));
  // Stub both reviewer transports: no CLI or network provider is invoked.
  const enc = new TextEncoder();
  const reviewImpl = async () => {
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "1. bug at x.js:3" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const grokImpl = async () => ({ name: "Grok", raw: "1. bug at x.js:3" });
  const out = await huntPanel({ cwd: process.cwd(), seed: "test", reviewImpl, grokImpl });
  assert.deepEqual(out.map((o) => o.name).sort(), ["Grok", "MiMo"]);
  for (const o of out) assert.match(o.findings, /x\.js:3/);
});
test("huntPanel deep=true sends thinking:{type:'enabled'} in the request body", async () => {
  const root = process.env.BENCH_ROOT;
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["grok", "mimo"], providers: {
    mimo: { baseURL: "https://example.invalid/v1", model: "mimo", apiKey: "m" }
  } }));
  const enc = new TextEncoder();
  const capturedThinking = [];
  const reviewImpl = async (_url, opts) => {
    const parsed = JSON.parse(opts.body);
    capturedThinking.push(parsed.thinking);
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "deep finding at z.ts:1" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const grokImpl = async () => ({ name: "Grok", raw: "deep finding at z.ts:1" });
  const out = await huntPanel({ cwd: process.cwd(), seed: "x", deep: true, reviewImpl, grokImpl });
  assert.deepEqual(out.map((o) => o.name).sort(), ["Grok", "MiMo"]);
  assert.equal(capturedThinking.length, 1, "only the MiMo API transport uses reviewImpl");
  for (const t of capturedThinking) {
    assert.deepStrictEqual(t, { type: "enabled" });
  }
});

test("pushReviewPanel is one-shot, tool-free, uses the explicit five-minute budget, and bypasses transient cooldowns", async () => {
  const calls = [];
  const results = await pushReviewPanel({
    cwd: "/workspace",
    range: "base..head",
    content: "<commits>c1</commits>\n<diff>+safe</diff>",
    resolveReviewersImpl: () => [
      {
        name: "grok",
        async run(args) {
          calls.push(args);
          return { name: "Grok", raw: "ALLOW: exact diff is safe" };
        }
      },
      {
        name: "mimo",
        async run(args) {
          calls.push(args);
          return {
            name: "MiMo",
            error: "timed out on this run",
            errorKind: "timeout",
            latencyMs: LIGHTWEIGHT_REVIEW_TIMEOUT_MS
          };
        }
      }
    ]
  });

  assert.equal(LIGHTWEIGHT_REVIEW_TIMEOUT_MS, 60_000);
  // Explicit reviews (/bench:review, spec/push review runs) are deliberate multi-minute asks:
  // 60s reliably timed out on real push diffs (MiMo needs 47–110s, Grok more) — 2026-07-24.
  assert.equal(EXPLICIT_REVIEW_TIMEOUT_MS, 300_000);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.timeoutMs === 300_000));
  assert.ok(calls.every((call) => call.ignoreTransientCooldowns === true),
    "an explicitly requested review must never be skipped because an earlier run timed out");
  assert.ok(calls.every((call) => call.cooldownScope === "push-review:/workspace"));
  assert.ok(calls.every((call) => call.system === PUSH_REVIEW_SYSTEM));
  assert.match(calls[0].system, /Do not use tools/i);
  assert.match(calls[0].user, /<diff>\+safe<\/diff>/);
  assert.equal(results[0].verdict, "ALLOW");
  assert.equal(results[1].errorKind, "timeout");
});

// ── FIX 2 (deep-path consistency): a prose BLOCK (no `- ` bullets) must still rewake ──
test("FIX 2: a high BLOCK phrased in PROSE (no bullets) counts as >=1 finding", () => {
  // No `- ` bullet lines — the reviewer wrote findings as prose. Pre-fix bulletCount was 0,
  // so shouldRewake (needs findingCount > 0) skipped the rewake even at high severity.
  const prose = "BLOCK: this breaks the build\nSEVERITY: high\nThe plan references parseFoo() which no longer exists; executing it fails.";
  const parsed = parseSpecFindings(prose);
  assert.equal(parsed.verdict, "BLOCK");
  assert.equal(parsed.severity, "high");
  assert.ok(parsed.findingCount >= 1, "a BLOCK verdict must count as at least one finding even without bullets");
});

test("FIX 2: a prose high BLOCK crosses the manual deep-review threshold", () => {
  // End-to-end: prose high BLOCK → parseSpecFindings → summarizeSpecReview → blocking threshold.
  const prose = "BLOCK: regression\nSEVERITY: high\nDeletes the user record on every save — data loss.";
  const parsed = parseSpecFindings(prose);
  const summary = summarizeSpecReview([{ name: "MiMo", verdict: parsed.verdict, severity: parsed.severity, findingCount: parsed.findingCount }]);
  assert.equal(shouldRewake(summary), true, "a high prose BLOCK must remain blocking on the manual deep path");
});

test("FIX 2: an ALLOW with no bullets stays findingCount 0 (no spurious rewake)", () => {
  const parsed = parseSpecFindings("ALLOW: looks fine, no issues");
  assert.equal(parsed.verdict, "ALLOW");
  assert.equal(parsed.findingCount, 0, "an ALLOW must NOT be counted as a finding");
});
