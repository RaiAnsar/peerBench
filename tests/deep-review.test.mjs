// tests/deep-review.test.mjs
// Pure deep-review helpers + the deep spec/push review functions (now: return-only, no deep-result file).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate BENCH_ROOT before importing anything that uses config-store.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "deep-root-"));

import {
  contentHash, severityRank, summarizeSpecReview, shouldRewake,
  DEEP_REWAKE_SEVERITY, deepKey, parseSeverity, aggregateFindings
} from "../global-hooks/deep-review.mjs";
import { combinePanel } from "../global-hooks/panel-lib.mjs";
import { specReviewCommand } from "../scripts/bench-runner.mjs";
import { runSpecReview, runPushReview } from "../global-hooks/spec-review-run.mjs";
import { buildPushReviewUser } from "../global-hooks/hunt.mjs";
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
  // A reviewer may write SEVERITY: low as its answer but "Severity: high" in its reasoning,
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
    { name: "Grok", verdict: "ALLOW", findingCount: 1, severity: "low" },
    { name: "MiMo", verdict: "BLOCK", findingCount: 2, severity: "high" }
  ]);
  assert.deepEqual(s.reviewers, [{ name: "Grok", verdict: "ALLOW", severity: "low" }, { name: "MiMo", verdict: "BLOCK", severity: "high" }]);
  assert.equal(s.findingCount, 3);
  assert.equal(s.maxSeverity, "high");
});

test("manual deep review crosses the blocking threshold only with severe findings", () => {
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
    { name: "Grok", verdict: "ALLOW", findings: "looks fine" },
    { name: "MiMo", verdict: "BLOCK", findings: "- null deref at line 5" }
  ]);
  assert.match(out, /\[MiMo\]\n- null deref/);
  assert.doesNotMatch(out, /looks fine/, "ALLOW reviewers are not included");
  assert.equal(aggregateFindings([{ name: "Grok", verdict: "ALLOW", findings: "ok" }]), "", "no blockers → empty string");
});

test("aggregateFindings surfaces a severity-only block (ALLOW verdict + SEVERITY: critical)", () => {
  // Regression: a reviewer that blocks via severity but writes `ALLOW: <none>` used to contribute
  // nothing, so the wake delivered a bare count. It must now surface its findings.
  const out = aggregateFindings([
    { name: "Grok", verdict: "ALLOW", severity: "critical", findings: "- plan references files that do not exist" },
    { name: "MiMo", verdict: "ALLOW", severity: "low", findings: "- minor: mkdir missing" }
  ]);
  assert.match(out, /\[Grok\]\n- plan references/, "critical-severity reviewer included despite ALLOW verdict");
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
      { name: "Grok", verdict: "ALLOW", findings: "no major issues", findingCount: 0, severity: "none" },
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

function gitStub({ commits = "abc123 add feature", diff = "+const x = 1;", head = "deadbeefcafef00d", logOk = true, diffOk = true } = {}) {
  const calls = [];
  const impl = (args) => {
    calls.push(args);
    if (args[0] === "log") return [commits, logOk];
    if (args[0] === "diff") return [diff, diffOk];
    if (args[0] === "rev-parse" && args[1] === "HEAD") return [head, true];
    return ["", true];
  };
  return { impl, calls };
}

test("runPushReview writes a gate:'push-review' trace and returns result + findings", async () => {
  const ws = freshWs();
  const stub = gitStub({ commits: "c1 first\nc2 second", diff: "+broken();" });
  let seeded = null;
  const panelImpl = async ({ cwd, range: r, content }) => {
    seeded = { cwd, range: r, content };
    return [
      { name: "Grok", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" },
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
});

test("runPushReview seeds and traces previous assistant context as claims, not proof", async () => {
  const ws = freshWs();
  const stub = gitStub({ commits: "c3 pushed", diff: "+quantity_on_order: null" });
  let seeded = null;
  const panelImpl = async ({ cwd, range: r, content, assistantContext }) => {
    seeded = { cwd, range: r, content, assistantContext };
    return [{ name: "Grok", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }];
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

test("runPushReview signals retry when git log/diff report ok=false", async () => {
  const ws = freshWs();
  const stub = gitStub({ logOk: false });
  let panelCalled = false;
  const panelImpl = async () => { panelCalled = true; return [{ name: "Grok", verdict: "BLOCK", findings: "x", findingCount: 1, severity: "high" }]; };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.equal(panelCalled, false, "git error → panel not run");
  assert.equal(result.retry, true, "git error must be requeued, not reported clean");
  assert.equal(result.reason, "git error");
  assert.match(result.summary, /deferred.*git error/i);
  assert.equal(result.hash, null);
  assert.equal(result.traceId, null);
  assert.equal(result.findingCount, 0);
  assert.equal(result.maxSeverity, "none");
  assert.equal(result.findings, "");
});

test("runPushReview rejects oversized evidence without truncating or invoking the panel", async () => {
  const ws = freshWs();
  const stub = gitStub({ diff: "+x".repeat(300_000) });
  let panelCalled = false;
  const panelImpl = async () => { panelCalled = true; return [{ name: "Grok", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }]; };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.equal(panelCalled, false, "partial evidence must never reach the panel");
  assert.equal(result.retry, true, "oversized evidence must be retried in smaller ranges");
  assert.equal(result.reason, "evidence too large");
  assert.match(result.summary, /deferred.*evidence too large/i);
  assert.doesNotMatch(result.summary, /clean|no blocking/i, "oversized evidence must not be described as clean");
  assert.equal(result.hash, null);
  assert.equal(result.traceId, null);
});

test("runPushReview sends complete under-limit evidence to the panel", async () => {
  const ws = freshWs();
  const diff = `${"+x\n".repeat(60_000)}+TAIL_MARKER\n`;
  const stub = gitStub({ diff });
  let captured = null;
  const panelImpl = async ({ content }) => {
    captured = content;
    return [{ name: "MiMo", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }];
  };
  const result = await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.equal(result.retry, undefined);
  assert.match(captured, /\+TAIL_MARKER/);
  assert.doesNotMatch(captured, /truncated/i);
});

test("runPushReview throws on a missing range", async () => {
  const ws = freshWs();
  await assert.rejects(() => runPushReview("", ws, { panelImpl: async () => [], gitImpl: gitStub().impl }), /missing range/);
});
