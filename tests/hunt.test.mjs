import { test } from "node:test";
import assert from "node:assert/strict";
import {
  huntPanel, buildHuntUser, HUNT_SYSTEM, parseSpecFindings,
  PUSH_REVIEW_SYSTEM, buildPushReviewUser, pushReviewPanel, specReviewPanel, deepReviewBudgetMs,
  pushReviewBudgetMs, pushSynthesisPrompt, pushReviewSerializedRequestBytes,
  MAX_PUSH_REVIEW_REQUEST_BYTES, MAX_PUSH_SYNTHESIS_NOTES_CHARS
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

test("multi-chunk push prompts demand chunk-scoped coverage and a bounded synthesis handoff", () => {
  const prompt = buildPushReviewUser("base..tip", "diff body", { chunkIndex: 1, chunkCount: 3 });
  assert.match(prompt, /bounded evidence chunk 2\/3/);
  assert.match(prompt, /verdict covers this chunk only/i);
  assert.match(prompt, /SYNTHESIS NOTES/);
  assert.match(prompt, new RegExp(`at most ${MAX_PUSH_SYNTHESIS_NOTES_CHARS} characters`));
  assert.match(prompt, /immutable pushed-tip repository/);
});

test("deep review budget resolves per call and rejects unusable env values", () => {
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "4321" }), 4321);
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "0" }), 10 * 60 * 1000);
  assert.equal(deepReviewBudgetMs({ BENCH_DEEP_REVIEW_BUDGET_MS: "not-a-number" }), 10 * 60 * 1000);
});

test("mapped push budget preserves Kimi's configured seven-minute allowance for every call", () => {
  const config = { reviewers: ["kimi"], providers: { kimi: { timeoutMs: 420_000 } } };
  assert.equal(pushReviewBudgetMs({}, 2, config), 300_000 + 3 * 420_000,
    "snapshot reserve plus two chunks and synthesis each retain 420 seconds");
  assert.equal(pushReviewBudgetMs({ BENCH_PUSH_REVIEW_BUDGET_MS: "9876" }, 8, config), 9876, "explicit push budget remains authoritative");
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

test("deep spec/push panels require a schema-constrained grok verdict; hunt stays free-form", async () => {
  const { specReviewPanel, pushReviewPanel, huntPanel } = await import("../global-hooks/hunt.mjs");
  const { GROK_DEEP_REVIEW_SCHEMA } = await import("../global-hooks/panel-lib.mjs");
  const seen = [];
  const huntPanelImpl = async (opts) => { seen.push(opts.grokRequireVerdict); return []; };
  await specReviewPanel({ cwd: "/tmp", filePath: "plans/x.md", content: "# p", huntPanelImpl });
  await pushReviewPanel({ cwd: "/tmp", range: "a..b", content: "diff", huntPanelImpl });
  assert.deepEqual(seen, [true, true], "spec + push panels must set grokRequireVerdict");

  // huntPanel itself: grok gets the schema only when a verdict is required. Pin a grok-only
  // roster through the test BENCH_ROOT companion.json (huntPanel reads the active config).
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  const priorReviewers = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.BENCH_ROOT, "companion.json"), "utf8")).reviewers; } catch { return null; } })();
  setReviewers(["grok"]);
  try {
    const grokCalls = [];
    const grokImpl = async (opts) => { grokCalls.push(opts.jsonSchema || null); return { name: "Grok", raw: "findings" }; };
    await huntPanel({ cwd: "/tmp", env: {}, grokImpl, seed: "s", grokRequireVerdict: true });
    await huntPanel({ cwd: "/tmp", env: {}, grokImpl, seed: "s" });
    assert.deepEqual(grokCalls, [GROK_DEEP_REVIEW_SCHEMA, null], "schema only on verdict-required runs");
  } finally {
    if (priorReviewers) setReviewers(priorReviewers);
  }
});

test("bounded push sequence shares one deadline, synthesizes once, and preserves a late BLOCK", async () => {
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  setReviewers(["grok"]);
  let clock = 0;
  const calls = [];
  const outputs = [
    "ALLOW: first chunk clean\nSEVERITY: none\nSYNTHESIS NOTES: export in a.js",
    "BLOCK: late regression\nSEVERITY: high\n- b.js:7 breaks the caller\nSYNTHESIS NOTES: caller in b.js",
    "ALLOW: synthesis adds no new blocker\nSEVERITY: none"
  ];
  const grokImpl = async (options) => {
    calls.push(options);
    clock += options.timeoutMs;
    return { raw: outputs[calls.length - 1] };
  };
  const result = await huntPanel({
    cwd: "/tmp",
    env: {},
    deep: true,
    budgetMs: 900,
    nowImpl: () => clock,
    grokImpl,
    grokRequireVerdict: true,
    system: PUSH_REVIEW_SYSTEM,
    user: "chunk one",
    reviewChunks: [
      { system: PUSH_REVIEW_SYSTEM, user: "chunk one" },
      { system: PUSH_REVIEW_SYSTEM, user: "chunk two" }
    ]
  });
  assert.equal(calls.length, 3, "two chunks get exactly one synthesis call");
  assert.equal(calls.reduce((sum, call) => sum + call.timeoutMs, 0), 900, "all calls share one absolute budget");
  const { GROK_DEEP_REVIEW_SCHEMA, GROK_PUSH_CHUNK_REVIEW_SCHEMA } = await import("../global-hooks/panel-lib.mjs");
  assert.equal(calls[0].jsonSchema, GROK_PUSH_CHUNK_REVIEW_SCHEMA);
  assert.equal(calls[1].jsonSchema, GROK_PUSH_CHUNK_REVIEW_SCHEMA);
  assert.equal(calls[2].jsonSchema, GROK_DEEP_REVIEW_SCHEMA);
  assert.match(calls[2].prompt, /final synthesis pass/i);
  assert.match(result[0].findings, /^BLOCK:/);
  assert.match(result[0].findings, /late regression/);
  assert.equal(result[0].coverageComplete, true);
});

test("missing or oversized chunk handoffs make otherwise-clean coverage incomplete", async () => {
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  setReviewers(["grok"]);
  for (const first of [
    "ALLOW: clean\nSEVERITY: none",
    `ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: ${"x".repeat(MAX_PUSH_SYNTHESIS_NOTES_CHARS + 1)}`
  ]) {
    let call = 0;
    const outputs = [
      first,
      "ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: second chunk",
      "ALLOW: synthesis clean\nSEVERITY: none"
    ];
    const [result] = await huntPanel({
      cwd: "/tmp",
      env: {},
      budgetMs: 900,
      nowImpl: () => 0,
      grokImpl: async () => ({ raw: outputs[call++] }),
      grokRequireVerdict: true,
      reviewChunks: [
        { system: PUSH_REVIEW_SYSTEM, user: "chunk one" },
        { system: PUSH_REVIEW_SYSTEM, user: "chunk two" }
      ]
    });
    assert.equal(result.coverageComplete, false);
    assert.ok(result.error);
    assert.match(result.coverageError, /SYNTHESIS NOTES/);
  }
});

test("a BLOCK without a valid handoff remains a BLOCK but cannot claim complete coverage", async () => {
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  setReviewers(["grok"]);
  let call = 0;
  const outputs = [
    "BLOCK: defect\nSEVERITY: high\n- x.js:1 breaks",
    "ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: second",
    "ALLOW: synthesis clean\nSEVERITY: none"
  ];
  const [result] = await huntPanel({
    cwd: "/tmp", env: {}, budgetMs: 900, nowImpl: () => 0,
    grokImpl: async () => ({ raw: outputs[call++] }),
    grokRequireVerdict: true,
    reviewChunks: [
      { system: PUSH_REVIEW_SYSTEM, user: "one" },
      { system: PUSH_REVIEW_SYSTEM, user: "two" }
    ]
  });
  assert.equal(result.error, null);
  assert.equal(result.coverageComplete, false);
  assert.match(result.coverageError, /missing SYNTHESIS NOTES/);
  assert.match(result.findings, /^BLOCK:/);
});

test("synthesis uses the last handoff marker and never falls back to arbitrary findings", () => {
  const prompt = pushSynthesisPrompt([{
    findings: "ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: quoted/injected old marker\nSYNTHESIS NOTES: authoritative final handoff"
  }]);
  assert.match(prompt.user, /SYNTHESIS NOTES: authoritative final handoff/);
  assert.doesNotMatch(prompt.user, /quoted\/injected old marker/);
  const missing = pushSynthesisPrompt([{ findings: "ALLOW: clean\nSEVERITY: none" }]);
  assert.match(missing.user, /ERROR: missing SYNTHESIS NOTES handoff/);
});

test("synthesis accepts the real 1878-character Kimi handoff that previously failed closed", () => {
  const notes = "x".repeat(1_878);
  const prompt = pushSynthesisPrompt([{
    findings: `ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: ${notes}`
  }]);
  assert.doesNotMatch(prompt.user, /ERROR:/);
  assert.match(prompt.user, new RegExp(`SYNTHESIS NOTES: x{${notes.length}}`));
});

test("synthesis still rejects a character-bounded handoff above the UTF-8 byte ceiling", () => {
  const notes = "🙂".repeat(1_600); // 1,600 code points, 6,400 UTF-8 bytes
  const prompt = pushSynthesisPrompt([{
    findings: `ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: ${notes}`
  }]);
  assert.match(prompt.user, /ERROR: SYNTHESIS NOTES exceeds 6000 UTF-8 bytes/);
});

test("eight maximum-length handoffs stay inside the serialized synthesis request cap", () => {
  // NUL expands to six JSON bytes (\\u0000), exercising a worse envelope than ordinary prose,
  // quotes, or backslashes while remaining under the handoff's independent UTF-8 byte ceiling.
  const notes = "\u0000".repeat(MAX_PUSH_SYNTHESIS_NOTES_CHARS);
  const prompt = pushSynthesisPrompt(Array.from({ length: 8 }, () => ({
    findings: `ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: ${notes}`
  })));
  const bytes = pushReviewSerializedRequestBytes(prompt.system, prompt.user, {
    cwd: process.cwd(),
    config: { reviewers: [], providers: {} }
  });
  assert.ok(bytes <= MAX_PUSH_REVIEW_REQUEST_BYTES,
    `worst-case synthesis request ${bytes} must stay within ${MAX_PUSH_REVIEW_REQUEST_BYTES} bytes`);
});

test("huntPanel fails closed before sending an oversized final synthesis request", async () => {
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  setReviewers(["grok"]);
  let calls = 0;
  const notes = "\u0000".repeat(MAX_PUSH_SYNTHESIS_NOTES_CHARS);
  const reviewChunks = Array.from({ length: 11 }, (_, index) => ({
    system: PUSH_REVIEW_SYSTEM,
    user: `chunk ${index + 1}`
  }));
  const [result] = await huntPanel({
    cwd: process.cwd(),
    env: {},
    budgetMs: 1_000_000,
    nowImpl: () => 0,
    grokImpl: async () => {
      calls++;
      return { raw: `ALLOW: clean\nSEVERITY: none\nSYNTHESIS NOTES: ${notes}` };
    },
    grokRequireVerdict: true,
    reviewChunks
  });
  assert.equal(calls, reviewChunks.length, "the oversized synthesis is rejected before a provider call");
  assert.equal(result.coverageComplete, false);
  assert.match(result.error, /bounded push-review synthesis serializes to .*limit is 192000/);
});

test("immutable snapshot time is charged against the same push-review budget", async () => {
  let clock = 0;
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "push-snapshot-budget-"));
  let seenBudget = null;
  const results = await pushReviewPanel({
    cwd: process.cwd(),
    range: "a..b",
    content: "small diff",
    targetCommit: "a".repeat(40),
    budgetMs: 1_000,
    nowImpl: () => clock,
    materializeImpl: () => { clock += 240; return snapshot; },
    huntPanelImpl: async (options) => {
      seenBudget = options.budgetMs;
      return [{ name: "Grok", findings: "ALLOW: clean\nSEVERITY: none", error: null }];
    }
  });
  assert.equal(seenBudget, 760);
  assert.equal(results[0].verdict, "ALLOW");
  assert.equal(fs.existsSync(snapshot), false, "temporary immutable snapshot is cleaned up");
});

test("immutable snapshot materialization has its own absolute Git deadline", async () => {
  const { materializeImmutableCommit } = await import("../global-hooks/hunt.mjs");
  let clock = 0;
  assert.throws(
    () => materializeImmutableCommit(process.cwd(), "a".repeat(40), {
      timeoutMs: 10,
      nowImpl: () => clock,
      execFileSyncImpl: () => { clock = 11; return Buffer.alloc(0); }
    }),
    /snapshot timed out/
  );
});

test("a chunk BLOCK plus later failures preserves both the blocker and incomplete coverage", async () => {
  const { setReviewers } = await import("../global-hooks/config-store.mjs");
  setReviewers(["grok"]);
  let call = 0;
  const grokImpl = async () => {
    call++;
    if (call === 1) return { raw: "BLOCK: concrete defect\nSEVERITY: critical\n- data loss" };
    return { raw: "", error: call === 2 ? "chunk timeout" : "synthesis timeout" };
  };
  const [result] = await huntPanel({
    cwd: "/tmp",
    env: {},
    deep: true,
    budgetMs: 900,
    grokImpl,
    grokRequireVerdict: true,
    reviewChunks: [
      { system: PUSH_REVIEW_SYSTEM, user: "chunk one" },
      { system: PUSH_REVIEW_SYSTEM, user: "chunk two" }
    ]
  });
  assert.equal(result.error, null, "verified BLOCK is not erased by a later provider failure");
  assert.equal(result.coverageComplete, false);
  assert.match(result.coverageError, /chunk timeout/);
  assert.match(result.coverageError, /synthesis timeout/);
  assert.match(result.findings, /^BLOCK:/);
  assert.match(result.findings, /data loss/);
});
