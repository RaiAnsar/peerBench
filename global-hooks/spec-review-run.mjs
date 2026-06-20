#!/usr/bin/env node
// global-hooks/spec-review-run.mjs
// Capability G — the deploy-safe deep spec-review WORKER.
//
// CRITICAL deploy-parity: deployed hooks live FLAT in ~/.claude/hooks/ — only
// global-hooks/*.mjs are copied there; scripts/ is NEVER deployed. So a deployed
// hook (plan-file-review.mjs) can only spawn SIBLING global-hooks/*.mjs files.
// This worker therefore imports ONLY global-hooks siblings — never anything under
// scripts/ — so that `node spec-review-run.mjs …` resolves in a real install.
//
// G1/G4 — deep spec/plan review against the real repo. Runs the panel (repo-aware,
// read-only) seeded with the file content, writes a gate:"spec-review" trace, and
// writes deep-result-<hash>.json ON COMPLETION (G4 — absence means "not done yet").
// Returns the structured result { reviewers:[{name,verdict}], findingCount, maxSeverity }.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { specReviewPanel, SPEC_REVIEW_SYSTEM, buildSpecReviewUser } from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, writeDeepResult, deepKey } from "./deep-review.mjs";

export async function runSpecReview(filePath, ws, {
  panelImpl = specReviewPanel,
  writeTraceImpl = writeTrace,
  writeDeepResultImpl = writeDeepResult,
  now = Date.now()
} = {}) {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch (e) {
    throw new Error(`could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hash = deepKey(filePath, content);   // FIX 4: key on (path, content) — distinct files with identical content do not collide
  const results = await panelImpl({ cwd: ws, filePath, content, env: process.env });

  const structured = summarizeSpecReview(results);   // { reviewers, findingCount, maxSeverity }
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict })));
  const summary = structured.findingCount > 0
    ? `${structured.findingCount} finding(s), max severity ${structured.maxSeverity}`
    : "no blocking findings";

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "spec-review", ws,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null, severity: r.severity, findingCount: r.findingCount })),
      systemPrompt: SPEC_REVIEW_SYSTEM,
      userPrompt: buildSpecReviewUser(filePath, content),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ spec-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still written.\n`);
  }

  try {
    writeDeepResultImpl(ws, {
      hash, traceId, badge, summary, specPath: filePath, ts: new Date(now).toISOString(),
      reviewers: structured.reviewers, findingCount: structured.findingCount, maxSeverity: structured.maxSeverity
    });
  } catch (e) {
    process.stderr.write(`⛩ spec-review: deep-result write failed (${e instanceof Error ? e.message : String(e)}).\n`);
  }

  return { ...structured, traceId, badge, summary, hash };
}

// CLI entry — usage: spec-review-run.mjs <abs-path> --ws <abs-ws>
// Detached deep pass launched by the plan-file gate (G2). Resolves the SAME
// workspaceStateDir as the hook by taking --ws explicitly. Fails OPEN: any error
// is noted on stderr and the process exits 0 (it's detached + unref'd — a non-zero
// exit must never look like a crash the caller has to handle).
if (import.meta.url === `file://${process.argv[1]}`) {
  const rest = process.argv.slice(2);
  let filePath = null, ws = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ws" && i + 1 < rest.length) { ws = rest[++i]; continue; }
    if (!filePath) filePath = rest[i];
  }
  (async () => {
    if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exit(0); }
    if (!ws) ws = path.dirname(filePath);
    try {
      await runSpecReview(filePath, ws);
    } catch (e) {
      process.stderr.write(`⛩ spec-review: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    process.exit(0);
  })();
}
