import { test } from "node:test";
import assert from "node:assert/strict";
import {
  huntPanel, buildHuntUser, HUNT_SYSTEM, parseSpecFindings,
  PUSH_REVIEW_SYSTEM, pushReviewPanel, specReviewPanel, deepReviewBudgetMs
} from "../global-hooks/hunt.mjs";
import { summarizeSpecReview, shouldRewake } from "../global-hooks/deep-review.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hunt-"));

test("buildHuntUser uses the seed when given, broad sweep otherwise", () => {
  assert.match(buildHuntUser("monitor never alerted"), /monitor never alerted/);
  assert.match(buildHuntUser(""), /broad bug-hunt sweep/);
});

test("push review prompt requires one exhaustive, grouped pass without dropping sibling paths", () => {
  assert.match(PUSH_REVIEW_SYSTEM, /ONE exhaustive review pass/i);
  assert.match(PUSH_REVIEW_SYSTEM, /never stop after finding the first blocker/i);
  assert.match(PUSH_REVIEW_SYSTEM, /every verified blocking manifestation/i);
  assert.match(PUSH_REVIEW_SYSTEM, /never omit an independent verified blocker/i);
  assert.doesNotMatch(PUSH_REVIEW_SYSTEM, /at most 3/i);
  assert.match(PUSH_REVIEW_SYSTEM, /every affected file\/path or execution path/i);
});

test("deep review budget resolves per call and rejects unusable env values", () => {
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "4321" }), 4321);
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "0" }), 10 * 60 * 1000);
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "not-a-number" }), 10 * 60 * 1000);
});

test("push/spec deep panels accept direct budgets and read env defaults at call time", async () => {
  const seen = [];
  const huntPanelImpl = async (opts) => {
    seen.push(opts);
    return [{ name: "Codex", findings: "ALLOW: clean\nSEVERITY: none", error: null }];
  };

  const push = await pushReviewPanel({
    cwd: process.cwd(), range: "base..head", content: "diff", budgetMs: 1234, huntPanelImpl
  });
  const spec = await specReviewPanel({
    cwd: process.cwd(), filePath: "plan.md", content: "plan",
    env: { BENCH_DEEP_REVIEW_BUDGET_MS: "5678" }, huntPanelImpl
  });

  assert.equal(seen[0].budgetMs, 1234, "explicit push budget wins");
  assert.equal(seen[1].budgetMs, 5678, "spec budget is resolved from this call's env");
  assert.equal(push[0].verdict, "ALLOW");
  assert.equal(spec[0].verdict, "ALLOW");
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
test("huntPanel deep=true flips a TOGGLE provider (GLM) to thinking:enabled but OMITS it for a null provider (K3 kimi)", async () => {
  // Deep must turn thinking ON only where the param is a live toggle (GLM/Qwen: disabled↔enabled).
  // A provider with thinking:null — kimi on K3 (param unsupported), MiMo/MiniMax (always-on) — must
  // stay OMITTED, or the deep path reintroduces a field the fast path drops (K3 rejects it → hard fail).
  const root = process.env.BENCH_ROOT;
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi", "glm"], providers: {
    kimi: { baseURL: "https://k/v1", apiKey: "k" }, glm: { baseURL: "https://g/v1", apiKey: "g" } } }));
  const enc = new TextEncoder();
  const byHost = {};
  const reviewImpl = async (url, opts) => {
    const host = new URL(url).host;
    (byHost[host] ||= []).push(JSON.parse(opts.body));
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "deep finding at z.ts:1" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const out = await huntPanel({ cwd: process.cwd(), seed: "x", deep: true, reviewImpl });
  assert.deepEqual(out.map((o) => o.name).sort(), ["GLM", "Kimi"]);
  assert.ok(byHost["g"]?.length && byHost["k"]?.length, "both reviewers called");
  for (const b of byHost["g"]) assert.deepStrictEqual(b.thinking, { type: "enabled" }, "GLM toggles ON for deep");
  for (const b of byHost["k"]) assert.equal("thinking" in b, false, "K3 kimi: thinking OMITTED even on deep (unsupported param)");
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
