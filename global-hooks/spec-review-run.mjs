#!/usr/bin/env node
// global-hooks/spec-review-run.mjs
// The deep spec/push review functions, called IN-PROCESS by the deep-review-runner (Stop hook).
//
// CRITICAL deploy-parity: deployed hooks live FLAT in ~/.claude/hooks/ — only global-hooks/*.mjs
// are copied there; scripts/ is NEVER deployed. This file imports ONLY global-hooks siblings.
//
// Deep, repo-aware review against the real repo (read-only). Each function runs the panel seeded
// with the file/push content, writes a gate:"spec-review"/"push-review" trace, and RETURNS the
// structured result { reviewers, findingCount, maxSeverity, findings, traceId, badge, summary, hash }.
// They do NOT write a deep-result file — delivery is the runner's exit-2 wake (see the spec).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { specReviewPanel, SPEC_REVIEW_SYSTEM, buildSpecReviewUser, pushReviewPanel, PUSH_REVIEW_SYSTEM, buildPushReviewUser } from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, deepKey, DEEP_REWAKE_SEVERITY, aggregateFindings, shouldRewake } from "./deep-review.mjs";

// Cap the reviewed push diff so a huge changeset doesn't blow up the prompt. Mirrors the pre-push gate.
const MAX_PUSH_DIFF_BYTES = 200_000;

// Local git helper — keep imports global-hooks-only (deploy-parity). Returns [out, ok].
function git(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

export async function runSpecReview(filePath, ws, {
  panelImpl = specReviewPanel,
  writeTraceImpl = writeTrace,
  now = Date.now()
} = {}) {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch (e) {
    throw new Error(`could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hash = deepKey(filePath, content);
  const results = await panelImpl({ cwd: ws, filePath, content, env: process.env });

  const structured = summarizeSpecReview(results);   // { reviewers, findingCount, maxSeverity }
  const findings = aggregateFindings(results);       // blocking reviewers' findings, joined (NOT via combinePanel)
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
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
    process.stderr.write(`⛩ spec-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, findings, traceId, badge, summary, hash };
}

export async function runPushReview(range, ws, {
  panelImpl = pushReviewPanel,
  writeTraceImpl = writeTrace,
  gitImpl = git,
  now = Date.now()
} = {}) {
  if (!range) throw new Error("runPushReview: missing range");

  // Git errors return a RETRY signal — NOT a clean no-block result. A transient `git log`/`git diff`
  // failure must make the runner REQUEUE the job (bounded), never treat it as clean and delete it
  // (that would lose the queued review — the never-lose guarantee). `retry:true` is distinct from a
  // real no-block result (which has retry undefined).
  const [commits, commitsOk] = gitImpl(["log", "--oneline", range], ws);
  const [diffRaw, diffOk] = gitImpl(["diff", range], ws);
  if (!commitsOk || !diffOk) {
    process.stderr.write(`⛩ push-review: git failed for ${range}; signalling retry (not cleared).\n`);
    return { retry: true, reason: "git error", reviewers: [], findingCount: 0, maxSeverity: "none", findings: "", traceId: null, badge: "", summary: "push review deferred (git error)", hash: null };
  }
  let diff = diffRaw;
  if (diff.length > MAX_PUSH_DIFF_BYTES) {
    diff = diff.slice(0, MAX_PUSH_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";
  }
  const content = [
    "<commits>", commits || "(no commit list available)", "</commits>",
    "", "<diff>", diff || "(no diff available)", "</diff>"
  ].join("\n");

  const [headSha] = gitImpl(["rev-parse", "HEAD"], ws);
  const hash = deepKey(`push:${range}`, headSha);

  const results = await panelImpl({ cwd: ws, range, content, env: process.env });

  const structured = summarizeSpecReview(results);
  const findings = aggregateFindings(results);
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
  const summary = structured.findingCount > 0
    ? `${structured.findingCount} finding(s), max severity ${structured.maxSeverity}`
    : "no blocking findings";

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "push-review", ws,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null, severity: r.severity, findingCount: r.findingCount })),
      systemPrompt: PUSH_REVIEW_SYSTEM,
      userPrompt: buildPushReviewUser(range, content),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ push-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, findings, traceId, badge, summary, hash };
}

// CLI entry (manual use; NOT hook-spawned any more):
//   spec-review-run.mjs <abs-path> --ws <abs-ws>      → runSpecReview
//   spec-review-run.mjs --push <range> --ws <abs-ws>  → runPushReview
// Exits 2 on a HIGH block (so a manual run surfaces it), 0 otherwise. Fails OPEN: any error → exit 0.
if (import.meta.url === `file://${process.argv[1]}`) {
  const rest = process.argv.slice(2);
  let filePath = null, ws = null, pushRange = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ws" && i + 1 < rest.length) { ws = rest[++i]; continue; }
    if (rest[i] === "--push" && i + 1 < rest.length) { pushRange = rest[++i]; continue; }
    if (!filePath) filePath = rest[i];
  }
  (async () => {
    try {
      let result;
      if (pushRange) {
        if (!ws) ws = process.cwd();
        result = await runPushReview(pushRange, ws);
      } else {
        if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exit(0); }
        if (!ws) ws = path.dirname(filePath);
        result = await runSpecReview(filePath, ws);
      }
      if (shouldRewake({ maxSeverity: result.maxSeverity, findingCount: result.findingCount })) {
        process.stderr.write(`⛩ deep review found blocking issues:\n\n${result.findings || result.summary}\n`);
        process.exit(2);
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write(`⛩ ${pushRange ? "push-review" : "spec-review"}: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(0);
    }
  })();
}
