import { test } from "node:test";
import assert from "node:assert/strict";
import { huntPanel, buildHuntUser, HUNT_SYSTEM, parseSpecFindings } from "../global-hooks/hunt.mjs";
import { summarizeSpecReview, shouldRewake } from "../global-hooks/deep-review.mjs";
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

test("FIX 2: a prose high BLOCK rewakes on the deep path (shouldRewake fires)", () => {
  // End-to-end: prose high BLOCK → parseSpecFindings → summarizeSpecReview → shouldRewake true,
  // matching the fast gate (which blocks). Previously findingCount 0 made shouldRewake false.
  const prose = "BLOCK: regression\nSEVERITY: high\nDeletes the user record on every save — data loss.";
  const parsed = parseSpecFindings(prose);
  const summary = summarizeSpecReview([{ name: "MiMo", verdict: parsed.verdict, severity: parsed.severity, findingCount: parsed.findingCount }]);
  assert.equal(shouldRewake(summary), true, "a high prose BLOCK must rewake on the deep path (consistent with the fast gate)");
});

test("FIX 2: an ALLOW with no bullets stays findingCount 0 (no spurious rewake)", () => {
  const parsed = parseSpecFindings("ALLOW: looks fine, no issues");
  assert.equal(parsed.verdict, "ALLOW");
  assert.equal(parsed.findingCount, 0, "an ALLOW must NOT be counted as a finding");
});
