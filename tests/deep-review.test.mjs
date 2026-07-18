// tests/deep-review.test.mjs
// Pure deep-review helpers + the deep spec/push review functions (now: return-only, no deep-result file).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Isolate BENCH_ROOT before importing anything that uses config-store.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "deep-root-"));

import {
  contentHash, severityRank, summarizeSpecReview, shouldRewake,
  DEEP_REWAKE_SEVERITY, deepKey, parseSeverity, aggregateFindings
} from "../global-hooks/deep-review.mjs";
import { combinePanel } from "../global-hooks/panel-lib.mjs";
import { specReviewCommand } from "../scripts/bench-runner.mjs";
import {
  buildPushReviewChunks,
  buildSerializedPushReviewChunks,
  MAX_PUSH_REVIEW_PAYLOAD_BYTES,
  MAX_PUSH_REVIEW_CHUNKS,
  PUSH_GIT_PREPARATION_BUDGET_MS,
  MAX_PUSH_REVIEW_END_TO_END_BUDGET_MS,
  promptSafeEvidence,
  runSpecReview,
  runPushReview
} from "../global-hooks/spec-review-run.mjs";
import {
  buildPushReviewUser,
  MAX_AUTO_PUSH_REVIEW_BUDGET_MS,
  MAX_PUSH_REVIEW_REQUEST_BYTES,
  PUSH_REVIEW_SYSTEM,
  pushReviewSerializedRequestBytes
} from "../global-hooks/hunt.mjs";
import { listTraces, readTrace } from "../global-hooks/trace-store.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deep-ws-"));
}

// ── pure helpers ──────────────────────────────────────────────────────────────

test("contentHash is stable and content-keyed", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});

test("severityRank orders none<low<medium<high<critical", () => {
  assert.ok(severityRank("none") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("critical"));
  assert.equal(severityRank("bogus"), 0);
});

test("FIX 1: parseSeverity is worst-wins — SEVERITY: low BEFORE SEVERITY: critical → critical", () => {
  const raw = "BLOCK: data loss\nSEVERITY: low\n- a minor note\nSEVERITY: critical\n- drops every row";
  assert.equal(parseSeverity(raw, "BLOCK"), "critical", "an earlier low must NOT downgrade a later critical");
  assert.equal(parseSeverity("SEVERITY: critical\nSEVERITY: low", "BLOCK"), "critical");
  assert.equal(parseSeverity("BLOCK: bad\n- finding", "BLOCK"), "high");
  assert.equal(parseSeverity("ALLOW: ok", "ALLOW"), "none");
});

test("parseSeverity ignores SEVERITY lines inside <think> reasoning", () => {
  // Regression: MiniMax wrote SEVERITY: low as its answer but "Severity: high" in its reasoning,
  // which used to win worst-wins and fire a false block.
  const raw = "<think>\nThis is bad. Severity: high, multiple issues.\n</think>\n\nALLOW: fine\nSEVERITY: low";
  assert.equal(parseSeverity(raw, "ALLOW"), "low", "think-internal severity must not count");
  // BLOCK verdict + only a think-internal critical → falls back to the BLOCK default, not critical
  assert.equal(parseSeverity("<think>SEVERITY: critical</think>\nBLOCK: bug\n- x", "BLOCK"), "high");
});

test("parseSeverity caps a clean ALLOW below the block floor (no severity-only false block)", () => {
  assert.equal(parseSeverity("ALLOW: looks fine\nSEVERITY: critical", "ALLOW"), "medium",
    "an explicit ALLOW cannot self-escalate to a blocking severity");
  assert.equal(parseSeverity("ALLOW: fine\nSEVERITY: high", "ALLOW"), "medium");
  assert.equal(parseSeverity("ALLOW: fine\nSEVERITY: medium", "ALLOW"), "medium", "sub-floor severity is preserved");
  assert.equal(parseSeverity("BLOCK: real\nSEVERITY: critical", "BLOCK"), "critical", "BLOCK is never capped");
});

test("FIX 1: worst-wins severity propagates to combinePanel — low-then-critical BLOCK still blocks", () => {
  const raw = "BLOCK: data loss\nSEVERITY: low\n- echoed lower note\nSEVERITY: critical\n- drops every row";
  const r = combinePanel(
    [{ name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: data loss", raw }],
    { blockMinSeverity: "high" }
  );
  assert.equal(r.decision, "block");
  assert.equal(r.badge, "MiMo✗");
});

test("summarizeSpecReview produces the structured contract", () => {
  const s = summarizeSpecReview([
    { name: "Kimi", verdict: "ALLOW", findingCount: 1, severity: "low" },
    { name: "MiMo", verdict: "BLOCK", findingCount: 2, severity: "high" }
  ]);
  assert.deepEqual(s.reviewers, [
    { name: "Kimi", verdict: "ALLOW", severity: "low", error: null },
    { name: "MiMo", verdict: "BLOCK", severity: "high", error: null }
  ]);
  assert.equal(s.findingCount, 3);
  assert.equal(s.maxSeverity, "high");
});

test("summarizeSpecReview preserves reviewer failures in the structured contract", () => {
  const s = summarizeSpecReview([
    { name: "Kimi", verdict: null, findingCount: 0, severity: "none", error: "timeout" }
  ]);
  assert.deepEqual(s.reviewers, [
    { name: "Kimi", verdict: null, severity: "none", error: "timeout" }
  ]);
});

test("summarizeSpecReview preserves bounded-coverage failures alongside a partial BLOCK", () => {
  const summary = summarizeSpecReview([{
    name: "Grok",
    verdict: "BLOCK",
    severity: "high",
    findingCount: 1,
    error: null,
    coverageComplete: false,
    coverageError: "chunk 2/3 timed out"
  }]);
  assert.deepEqual(summary.reviewers[0], {
    name: "Grok",
    verdict: "BLOCK",
    severity: "high",
    error: null,
    coverageComplete: false,
    coverageError: "chunk 2/3 timed out"
  });
});

test("shouldRewake fires at/above the rewake severity with findings, else not", () => {
  assert.equal(shouldRewake({ maxSeverity: DEEP_REWAKE_SEVERITY, findingCount: 1 }), true);
  assert.equal(shouldRewake({ maxSeverity: "critical", findingCount: 1 }), true);
  assert.equal(shouldRewake({ maxSeverity: "medium", findingCount: 5 }), false);
  assert.equal(shouldRewake({ maxSeverity: "high", findingCount: 0 }), false);
});

test("FIX 4: deepKey keys on (path, content) so byte-identical content in two files does NOT collide", () => {
  const same = "# identical body\n";
  const a = "/repo/specs/a.md";
  const b = "/repo/specs/b.md";
  assert.equal(deepKey(a, same), deepKey(a, same));
  assert.notEqual(deepKey(a, same), deepKey(b, same), "distinct files with identical content must produce distinct keys");
  assert.notEqual(deepKey(a, "# v1\n"), deepKey(a, "# v2\n"));
});

test("aggregateFindings joins ONLY blocking reviewers' findings (not via combinePanel raw)", () => {
  const out = aggregateFindings([
    { name: "Kimi", verdict: "ALLOW", findings: "looks fine" },
    { name: "MiMo", verdict: "BLOCK", findings: "- null deref at line 5" },
    { name: "GLM", verdict: "BLOCK", findings: "- missing await" }
  ]);
  assert.match(out, /\[MiMo\]\n- null deref/);
  assert.match(out, /\[GLM\]\n- missing await/);
  assert.doesNotMatch(out, /looks fine/, "ALLOW reviewers are not included");
  assert.equal(aggregateFindings([{ name: "Kimi", verdict: "ALLOW", findings: "ok" }]), "", "no blockers → empty string");
});

test("aggregateFindings surfaces a severity-only block (ALLOW verdict + SEVERITY: critical)", () => {
  // Regression: a reviewer that blocks via severity but writes `ALLOW: <none>` used to contribute
  // nothing, so the wake delivered a bare count. It must now surface its findings.
  const out = aggregateFindings([
    { name: "MiniMax", verdict: "ALLOW", severity: "critical", findings: "- plan references files that do not exist" },
    { name: "Codex", verdict: "ALLOW", severity: "low", findings: "- minor: mkdir missing" }
  ]);
  assert.match(out, /\[MiniMax\]\n- plan references/, "critical-severity reviewer included despite ALLOW verdict");
  assert.doesNotMatch(out, /minor: mkdir/, "sub-threshold (low) severity stays excluded");
});

// ── deep spec/push review functions (return-only; NO deep-result file) ─────────

test("runSpecReview writes a gate:'spec-review' trace and returns the structured result + findings", async () => {
  const ws = freshWs();
  const planDir = path.join(ws, "specs");
  fs.mkdirSync(planDir, { recursive: true });
  const file = path.join(planDir, "s.md");
  fs.writeFileSync(file, "# Spec\n\nDeep review me.\n");

  const panelImpl = async ({ content }) => {
    assert.match(content, /Deep review me/);
    return [
      { name: "Kimi", verdict: "ALLOW", findings: "no major issues", findingCount: 0, severity: "none" },
      { name: "MiMo", verdict: "BLOCK", findings: "1. ambiguous step", findingCount: 1, severity: "high" }
    ];
  };

  const result = await specReviewCommand(file, ws, { panelImpl });
  assert.equal(result.findingCount, 1);
  assert.equal(result.maxSeverity, "high");
  assert.match(result.findings, /ambiguous step/, "aggregate findings carry the blocking reviewer's text");

  // NO deep-result file is written any more.
  const stateFiles = fs.readdirSync(workspaceStateDir(ws));
  assert.equal(stateFiles.filter((f) => f.startsWith("deep-result-")).length, 0, "no deep-result file is written");

  const [latest] = listTraces(ws, 1);
  assert.equal(latest.gate, "spec-review");
  assert.equal(readTrace(ws, latest.id).gate, "spec-review");
});

function gitStub({ commits = "abc123 add feature", diff = "+const x = 1;", head = "d".repeat(40), base = "a".repeat(40), logOk = true, diffOk = true } = {}) {
  const calls = [];
  const impl = (args) => {
    calls.push(args);
    if (args[0] === "log") return [args.includes("-p") ? diff : commits, logOk];
    if (args[0] === "diff") return [diff, diffOk];
    if (args[0] === "cat-file" && args[1] === "-t") return ["commit", true];
    if (args[0] === "merge-base") return [base, true];
    if (args[0] === "rev-parse") {
      const spec = String(args.at(-1) || "");
      if (spec.includes("HEAD")) return [head, true];
      if (spec.includes("@{u}")) return [base, true];
      if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?\^\{(?:object|commit)\}$/i.test(spec)) return [spec.split("^")[0], true];
    }
    return ["", true];
  };
  return { impl, calls };
}

test("runPushReview shares one absolute Git budget, then gives the panel its separately capped budget", async () => {
  const ws = freshWs();
  const stub = gitStub();
  const observedTimeouts = [];
  let clockMs = 1_000;
  let panelBudgetMs = null;
  const env = {
    ...process.env,
    BENCH_PUSH_REVIEW_BUDGET_MS: String(MAX_AUTO_PUSH_REVIEW_BUDGET_MS * 10)
  };
  const result = await runPushReview("@{u}..HEAD", ws, {
    env,
    nowImpl: () => clockMs,
    gitImpl: (args, cwd, options) => {
      observedTimeouts.push(options.timeoutMs);
      clockMs += 10_000;
      return stub.impl(args, cwd, options);
    },
    writeTraceImpl: () => null,
    panelImpl: async ({ budgetMs }) => {
      panelBudgetMs = budgetMs;
      return [{ name: "Kimi", verdict: "ALLOW", findings: "ALLOW: clean", findingCount: 0, severity: "none" }];
    }
  });

  assert.equal(result.retry, undefined);
  assert.equal(observedTimeouts[0], PUSH_GIT_PREPARATION_BUDGET_MS);
  assert.ok(observedTimeouts.length >= 6, "metadata and evidence calls must all receive a timeout");
  for (let index = 1; index < observedTimeouts.length; index++) {
    assert.ok(observedTimeouts[index] < observedTimeouts[index - 1], "sequential Git calls spend one decreasing deadline");
  }
  assert.equal(panelBudgetMs, MAX_AUTO_PUSH_REVIEW_BUDGET_MS, "an oversized override cannot exceed the panel maximum");
  assert.equal(
    MAX_PUSH_REVIEW_END_TO_END_BUDGET_MS,
    PUSH_GIT_PREPARATION_BUDGET_MS + MAX_AUTO_PUSH_REVIEW_BUDGET_MS
  );
});

test("runPushReview stops metadata when the shared Git deadline is exhausted", async () => {
  const ws = freshWs();
  const stub = gitStub();
  const observedTimeouts = [];
  let clockMs = 0;
  let panelCalled = false;
  const result = await runPushReview("@{u}..HEAD", ws, {
    nowImpl: () => clockMs,
    gitImpl: (args, cwd, options) => {
      observedTimeouts.push(options.timeoutMs);
      clockMs += 100_000;
      return stub.impl(args, cwd, options);
    },
    panelImpl: async () => { panelCalled = true; return []; },
    writeTraceImpl: () => null
  });

  assert.equal(panelCalled, false);
  assert.equal(result.retry, true);
  assert.match(result.reason, /shared absolute deadline/);
  assert.deepEqual(observedTimeouts, [300_000, 200_000, 100_000]);
});

test("runPushReview bounds an evidence implementation that ignores its timeout", { timeout: 5_000 }, async () => {
  const ws = freshWs();
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(ws, "file.txt"), "one\n");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(ws, "file.txt"), "two\n");
  git(["commit", "-qam", "tip"]);

  let evidenceCalls = 0;
  let panelCalled = false;
  const startedAt = Date.now();
  const result = await runPushReview("HEAD^..HEAD", ws, {
    gitPreparationBudgetMs: 1_000,
    gitEvidenceImpl: () => {
      evidenceCalls++;
      return new Promise(() => {});
    },
    panelImpl: async () => { panelCalled = true; return []; },
    writeTraceImpl: () => null
  });

  assert.ok(evidenceCalls >= 2, "commit and delta evidence were launched under the shared deadline");
  assert.equal(panelCalled, false);
  assert.equal(result.retry, true);
  assert.match(result.reason, /shared absolute deadline/);
  assert.ok(Date.now() - startedAt < 2_500, "an injected hanging evidence source cannot outlive the deadline");
});

test("runPushReview hard-kills a wedged synchronous Git metadata process", { timeout: 5_000 }, async () => {
  const ws = freshWs();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "deep-git-bin-"));
  const fakeGit = path.join(bin, "git");
  fs.writeFileSync(fakeGit, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  let panelCalled = false;
  const startedAt = Date.now();
  const result = await runPushReview("a..b", ws, {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` },
    gitPreparationBudgetMs: 100,
    panelImpl: async () => { panelCalled = true; return []; },
    writeTraceImpl: () => null
  });

  assert.equal(panelCalled, false);
  assert.equal(result.retry, true);
  assert.ok(Date.now() - startedAt < 2_000, "synchronous Git must not be able to hang the push review");
});

test("runPushReview writes a gate:'push-review' trace and returns result + findings", async () => {
  const ws = freshWs();
  const stub = gitStub({ commits: "c1 first\nc2 second", diff: "+broken();" });
  let seeded = null;
  const panelImpl = async ({ cwd, range: r, content }) => {
    seeded = { cwd, range: r, content };
    return [
      { name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" },
      { name: "MiMo", verdict: "BLOCK", findings: "- cross-file regression", findingCount: 1, severity: "high" }
    ];
  };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.match(seeded.content, /c1 first/);
  assert.match(seeded.content, /\+broken\(\)/);
  assert.equal(result.findingCount, 1);
  assert.equal(result.maxSeverity, "high");
  assert.match(result.findings, /cross-file regression/);
  const [latest] = listTraces(ws, 1);
  assert.equal(latest.gate, "push-review");
  const trace = readTrace(ws, latest.id);
  assert.equal(trace.chunkManifest.length, 1);
  assert.match(trace.chunkManifest[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(trace.evidenceHashes.rendered, /^[0-9a-f]{64}$/);
});

test("spec/push deep review panels receive the caller's explicit environment", async () => {
  const ws = freshWs();
  const file = path.join(ws, "spec.md");
  fs.writeFileSync(file, "# Spec\n");
  const explicitEnv = { BENCH_SUPPRESS_CODEX_REVIEWER: "1", BENCH_DEEP_REVIEW_BUDGET_MS: "1234" };
  const seen = [];
  const panelImpl = async ({ env }) => {
    seen.push(env);
    return [{ name: "Kimi", verdict: "ALLOW", findings: "ALLOW: clean", findingCount: 0, severity: "none" }];
  };

  await runSpecReview(file, ws, { panelImpl, writeTraceImpl: () => null, env: explicitEnv });
  await runPushReview("@{u}..HEAD", ws, {
    panelImpl,
    writeTraceImpl: () => null,
    gitImpl: gitStub().impl,
    env: explicitEnv
  });

  assert.deepEqual(seen, [explicitEnv, explicitEnv]);
});

test("runSpecReview returns retry and preserves errors when no reviewer produced a verdict", async () => {
  const ws = freshWs();
  const file = path.join(ws, "spec.md");
  fs.writeFileSync(file, "# Spec\n");
  const result = await runSpecReview(file, ws, {
    panelImpl: async () => [
      { name: "Kimi", verdict: null, findings: "", findingCount: 0, severity: "none", error: "timeout" },
      { name: "Grok", verdict: null, findings: "", findingCount: 0, severity: "none", error: "auth" }
    ],
    writeTraceImpl: () => null
  });
  assert.equal(result.retry, true);
  assert.match(result.reason, /Kimi: timeout/);
  assert.deepEqual(result.reviewers.map((r) => r.error), ["timeout", "auth"]);
  assert.doesNotMatch(result.summary, /no blocking findings/);
});

test("runPushReview treats malformed no-verdict prose as retry, never a clean result", async () => {
  const ws = freshWs();
  const stub = gitStub();
  const result = await runPushReview("@{u}..HEAD", ws, {
    gitImpl: stub.impl,
    panelImpl: async () => [
      { name: "Kimi", verdict: null, findings: "Looks fine but omitted the contract", findingCount: 0, severity: "none", error: null }
    ],
    writeTraceImpl: () => null
  });
  assert.equal(result.retry, true);
  assert.match(result.reason, /unparseable verdict/);
  assert.equal(result.reviewers[0].error, "unparseable verdict");
  assert.equal(result.reviewers[0].verdict, null);
  assert.equal(result.badge, "Kimi!");
});

test("a malformed reviewer is skipped when another reviewer has a valid verdict", async () => {
  const ws = freshWs();
  const result = await runPushReview("@{u}..HEAD", ws, {
    gitImpl: gitStub().impl,
    panelImpl: async () => [
      { name: "Kimi", verdict: "ALLOW", findings: "ALLOW: clean", findingCount: 0, severity: "none" },
      { name: "Grok", verdict: null, findings: "narration only", findingCount: 2, severity: "high" }
    ],
    writeTraceImpl: () => null
  });
  assert.equal(result.retry, undefined, "one valid verdict is sufficient for the panel outcome");
  assert.equal(result.reviewers[1].error, "unparseable verdict");
  assert.equal(result.findingCount, 0, "malformed output cannot contribute blocking findings");
  assert.equal(result.maxSeverity, "none", "malformed output cannot contribute severity");
  assert.equal(result.badge, "Kimi✓ Grok!");
});

test("runPushReview seeds and traces previous assistant context as claims, not proof", async () => {
  const ws = freshWs();
  const stub = gitStub({ commits: "c3 pushed", diff: "+quantity_on_order: null" });
  let seeded = null;
  const panelImpl = async ({ cwd, range: r, content, assistantContext }) => {
    seeded = { cwd, range: r, content, assistantContext };
    return [{ name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }];
  };
  const context = "I populated quantity_on_order for approvals and all paths are covered.";
  await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl, assistantContext: context, now: Date.now() + 1 });

  assert.match(seeded.assistantContext, /quantity_on_order/);
  const [latest] = listTraces(ws, 1);
  assert.equal(latest.gate, "push-review");
  const trace = readTrace(ws, latest.id);
  assert.match(trace.userPrompt, /<previous_assistant_message_context>/);
  assert.match(trace.userPrompt, /quantity_on_order/);
  assert.match(trace.userPrompt, /claims\/context only|not proof/i);
});

test("buildPushReviewUser keeps push evidence before assistant context", () => {
  const user = buildPushReviewUser("base..head", "<commits>\nc1\n</commits>", {
    assistantContext: "claimed all data paths were covered"
  });
  assert.ok(user.indexOf("<push") < user.indexOf("<previous_assistant_message_context>"));
  assert.match(user, /claims\/context only|not proof/i);
});

test("bounded push chunks are deterministic, UTF-8 safe, contiguous, and exhaustive", () => {
  const source = [
    "<immutable_push>",
    "commit " + "a".repeat(40),
    "diff --git a/nested/emoji.js b/nested/emoji.js",
    "@@ -1 +1 @@",
    `-${"old".repeat(30)}🙂`,
    `+${"new".repeat(90)}🚀`,
    "</immutable_push>\n"
  ].join("\n");
  const options = { maxChunkBytes: 73, maxChunks: 100, base: "b".repeat(40), tip: "c".repeat(40), range: `${"b".repeat(40)}..${"c".repeat(40)}` };
  const first = buildPushReviewChunks(source, options);
  const second = buildPushReviewChunks(source, options);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second, "same immutable evidence produces byte-identical chunks and hashes");
  assert.equal(first.payloads.join(""), source, "core payloads reproduce every rendered evidence byte exactly once");
  assert.equal(first.manifest[0].byteStart, 0);
  assert.equal(first.manifest.at(-1).byteEnd, Buffer.byteLength(source));
  for (let index = 0; index < first.manifest.length; index++) {
    assert.ok(first.manifest[index].bytes <= 73);
    if (index) assert.equal(first.manifest[index - 1].byteEnd, first.manifest[index].byteStart);
    assert.doesNotMatch(first.payloads[index], /�/, "no chunk splits a UTF-8 code point");
  }
  assert.ok(first.chunks.slice(1).some((chunk) => /repeated_non_authoritative_context/.test(chunk)), "later mid-record chunks repeat labelled diff context");
});

test("bounded push chunks duplicate edge context so a token split across core payloads stays reviewable", () => {
  const source = `${"a".repeat(96)}BLOCKER_TOKEN${"z".repeat(120)}`;
  const chunks = buildPushReviewChunks(source, { maxChunkBytes: 100, maxChunks: 10 });
  assert.equal(chunks.ok, true);
  assert.equal(chunks.payloads.join(""), source, "authoritative cores remain exact and non-overlapping");
  assert.equal(chunks.payloads.some((payload) => payload.includes("BLOCKER_TOKEN")), false, "the core boundary really splits the token");
  assert.equal(chunks.chunks.some((chunk) => chunk.includes("BLOCKER_TOKEN")), true, "authenticated overlap restores semantic continuity");
  assert.match(chunks.chunks[0], /duplicated_boundary_context direction="after"/);
  assert.match(chunks.chunks[1], /duplicated_boundary_context direction="before"/);
});

test("the serialized initial push request stays below the real cap for a full ordinary core plus context", () => {
  const header = `diff --git a/${"p".repeat(3500)} b/${"p".repeat(3500)}\n@@ -1 +1 @@\n`;
  const plan = buildPushReviewChunks(`${header}${"x".repeat(MAX_PUSH_REVIEW_PAYLOAD_BYTES * 2)}`, {
    base: "b".repeat(40), tip: "c".repeat(40), range: `${"b".repeat(40)}..${"c".repeat(40)}`
  });
  assert.equal(plan.ok, true);
  for (let index = 0; index < plan.chunks.length; index++) {
    const user = buildPushReviewUser("b..c", plan.chunks[index], {
      assistantContext: 'claim "with quotes" and \\slashes\n'.repeat(200),
      chunkIndex: index,
      chunkCount: plan.chunks.length
    });
    assert.ok(
      pushReviewSerializedRequestBytes(PUSH_REVIEW_SYSTEM, user, { cwd: process.cwd() }) <= MAX_PUSH_REVIEW_REQUEST_BYTES,
      `chunk ${index + 1} must include JSON escaping and tool schemas inside the ${MAX_PUSH_REVIEW_REQUEST_BYTES}-byte cap`
    );
  }
});

test("JSON-heavy evidence is adaptively re-split instead of rejected after raw-byte chunking", () => {
  const source = "\\".repeat(MAX_PUSH_REVIEW_PAYLOAD_BYTES);
  const plan = buildSerializedPushReviewChunks(source, {
    base: "b".repeat(40),
    tip: "c".repeat(40),
    range: `${"b".repeat(40)}..${"c".repeat(40)}`,
    assistantContext: "context",
    cwd: process.cwd(),
    env: {}
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.chunks.length > 1, "JSON escaping forces a smaller core size");
  assert.ok(plan.chunks.length <= MAX_PUSH_REVIEW_CHUNKS);
  assert.equal(plan.payloads.join(""), source);
  assert.ok(plan.requestBytes.every((bytes) => bytes <= MAX_PUSH_REVIEW_REQUEST_BYTES));
});

test("binary prompt encoding is unambiguous all-byte hex", () => {
  const a = Buffer.concat([Buffer.from([0xff]), Buffer.from("\\x00"), Buffer.from([0x00])]);
  const b = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("\\x00")]);
  const encodedA = promptSafeEvidence(a, 10_000);
  const encodedB = promptSafeEvidence(b, 10_000);
  assert.equal(encodedA.renderable, true);
  assert.equal(encodedA.encoding, "all-byte-hex");
  assert.notEqual(encodedA.text, encodedB.text, "distinct raw bytes cannot collide through literal backslashes");
  assert.match(encodedA.text, /\\xff\\x5c\\x78\\x30\\x30\\x00/);
});

test("bounded push chunks fail closed when combined rendered evidence exceeds the chunk ceiling", () => {
  const result = buildPushReviewChunks("x".repeat(101), { maxChunkBytes: 10, maxChunks: 10 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires 11 bounded chunks/);
  assert.match(result.reason, /no omitted evidence can produce an ALLOW/);
});

test("runPushReview signals retry when git log/diff report ok=false", async () => {
  const ws = freshWs();
  const stub = gitStub({ logOk: false });
  let panelCalled = false;
  const panelImpl = async () => { panelCalled = true; return [{ name: "Kimi", verdict: "BLOCK", findings: "x", findingCount: 1, severity: "high" }]; };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.equal(panelCalled, false, "git error → panel not run");
  assert.equal(result.findingCount, 0, "git error → no-block result");
  assert.equal(result.maxSeverity, "none");
  assert.equal(result.findings, "");
});

test("runPushReview maps a diff above the old 200KB limit into bounded exhaustive chunks", async () => {
  const ws = freshWs();
  const stub = gitStub({ diff: "+x".repeat(300_000) });
  let captured = null;
  const panelImpl = async (input) => { captured = input; return [{ name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none", coverageComplete: true }]; };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.equal(result.coverageBlocked, undefined);
  assert.ok(captured.contents.length > 1, "large evidence is not sent as one monolithic request");
  assert.ok(captured.contents.length <= MAX_PUSH_REVIEW_CHUNKS);
  assert.match(captured.contents[0], /<per_commit_deltas[^>]+bytes="600000"[^>]+truncated="false"/);
  assert.doesNotMatch(captured.contents.join("\n"), /bytes omitted/);
  assert.match(captured.contents.at(-1), /\+x\+x\+x\+x/, "the diff tail is present in the final core chunk");
  assert.match(captured.contents.at(-1), /<\/immutable_push>/, "the evidence stream closes after the retained tail");
});

test("a legacy panel that only reviews the first bounded chunk cannot authorize a large push", async () => {
  const ws = freshWs();
  const result = await runPushReview("@{u}..HEAD", ws, {
    gitImpl: gitStub({ diff: "+x".repeat(300_000) }).impl,
    writeTraceImpl: () => null,
    panelImpl: async () => [{
      name: "Kimi",
      verdict: "ALLOW",
      findings: "ALLOW: first chunk looked clean",
      findingCount: 0,
      severity: "none"
    }]
  });
  assert.equal(result.retry, true);
  assert.match(result.reason, /did not acknowledge complete coverage/);
  assert.equal(result.reviewers[0].coverageComplete, false);
});

test("runPushReview caches a deterministic coverage BLOCK when evidence exceeds all bounded chunks", async () => {
  const ws = freshWs();
  const stub = gitStub({ diff: "+x".repeat(800_000) });
  let panelCalled = false;
  const result = await runPushReview("@{u}..HEAD", ws, {
    panelImpl: async () => { panelCalled = true; return []; },
    gitImpl: stub.impl
  });
  assert.equal(panelCalled, false, "omitted bytes must never reach an ALLOW-capable panel");
  assert.equal(result.coverageBlocked, true);
  assert.equal(result.maxSeverity, "high");
  assert.match(result.reason, /no omitted or lossy-decoded bytes can produce an ALLOW|no omitted evidence can produce an ALLOW/);
  assert.match(result.hash, /^[0-9a-f]{16}$/);
});

test("runPushReview streams a text diff larger than 64 MiB into bounded evidence", { timeout: 30_000 }, async () => {
  const ws = freshWs();
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(ws, "large.txt"), "small\n");
  git(["add", "large.txt"]);
  git(["commit", "-q", "-m", "base"]);

  const file = path.join(ws, "large.txt");
  const fd = fs.openSync(file, "w");
  const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
  try {
    for (let i = 0; i < 65; i++) fs.writeSync(fd, oneMiB);
    fs.writeSync(fd, Buffer.from("\n"));
  } finally {
    fs.closeSync(fd);
  }
  git(["add", "large.txt"]);
  git(["commit", "-q", "-m", "large text"]);

  let panelCalled = false;
  const result = await runPushReview("HEAD^..HEAD", ws, {
    env: process.env,
    writeTraceImpl: () => null,
    panelImpl: async () => {
      panelCalled = true;
      return [{ name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }];
    }
  });
  assert.equal(panelCalled, false);
  assert.equal(result.coverageBlocked, true);
  assert.match(result.reason, /681\d{5,}|cannot be rendered exhaustively/);
  assert.match(result.hash, /^[0-9a-f]{16}$/);
});

test("runPushReview throws on a missing range", async () => {
  const ws = freshWs();
  await assert.rejects(() => runPushReview("", ws, { panelImpl: async () => [], gitImpl: gitStub().impl }), /missing range/);
});
