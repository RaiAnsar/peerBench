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
  assert.deepEqual(s.reviewers, [{ name: "Kimi", verdict: "ALLOW", severity: "low" }, { name: "MiMo", verdict: "BLOCK", severity: "high" }]);
  assert.equal(s.findingCount, 3);
  assert.equal(s.maxSeverity, "high");
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

test("runPushReview caps the diff at ~200KB", async () => {
  const ws = freshWs();
  const stub = gitStub({ diff: "+x".repeat(300_000) });
  let captured = null;
  const panelImpl = async ({ content }) => { captured = content; return [{ name: "Kimi", verdict: "ALLOW", findings: "ok", findingCount: 0, severity: "none" }]; };
  await runPushReview("@{u}..HEAD", ws, { panelImpl, gitImpl: stub.impl });
  assert.ok(captured.includes("diff truncated"));
  assert.ok(captured.length < 220_000);
});

test("runPushReview throws on a missing range", async () => {
  const ws = freshWs();
  await assert.rejects(() => runPushReview("", ws, { panelImpl: async () => [], gitImpl: gitStub().impl }), /missing range/);
});
