#!/usr/bin/env node
// global-hooks/spec-review-run.mjs
// Explicit spec/range review functions called in-process by bench-runner. Nothing here is an
// automatic Stop hook or background worker.
//
// CRITICAL deploy-parity: deployed hooks live FLAT in ~/.claude/hooks/ — only global-hooks/*.mjs
// are copied there; scripts/ is NEVER deployed. This file imports ONLY global-hooks siblings.
//
// Bounded one-shot review of exact file/push evidence. Each function runs the panel seeded with
// that content, writes a gate:"spec-review"/"push-review" trace, and RETURNS the
// structured result { reviewers, findingCount, maxSeverity, findings, traceId, badge, summary, hash }.
// They do not write a deep-result file or wake an agent; the explicit command prints the result.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { specReviewPanel, SPEC_REVIEW_SYSTEM, buildSpecReviewUser, pushReviewPanel, PUSH_REVIEW_SYSTEM, buildPushReviewUser } from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, deepKey, DEEP_REWAKE_SEVERITY, aggregateFindings, shouldRewake } from "./deep-review.mjs";
import { isMainModule } from "./is-main.mjs";

// Refuse oversized evidence instead of silently reviewing only a prefix and reporting it clean.
const MAX_PUSH_DIFF_BYTES = 200_000;
const usableVerdict = (result) => !result?.error && (result?.verdict === "ALLOW" || result?.verdict === "BLOCK");

export function explicitDecision(results, structured, { requireAll = false } = {}) {
  const usable = results.filter(usableVerdict);
  if (!usable.length) return "unreviewed";
  if (shouldRewake(structured)) return "block";
  if (requireAll && usable.length !== results.length) return "unreviewed";
  return "allow";
}

function explicitSummary(results, structured, { requireAll = false } = {}) {
  const decision = explicitDecision(results, structured, { requireAll });
  if (decision === "unreviewed") {
    const unusable = results.filter((result) => !usableVerdict(result));
    const reasons = unusable.map((result) => `${result.name}: ${result.error || "no usable verdict"}`).join(" | ");
    const label = requireAll && results.some(usableVerdict) ? "strict quorum unavailable" : "unreviewed";
    return `${label} — ${reasons || "reviewers returned no usable verdict"}`;
  }
  const skipped = results.filter((result) => result.error).map((result) => `${result.name} skipped: ${result.error}`);
  const base = structured.findingCount > 0
    ? `${structured.findingCount} finding(s), max severity ${structured.maxSeverity}`
    : "no blocking findings";
  return [base, ...skipped].join(" · ");
}

// Local git helper — keep imports global-hooks-only (deploy-parity). Returns [out, ok].
function git(args, cwd) {
  try {
    const out = execFileSync("git", ["--no-replace-objects", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

export async function runSpecReview(filePath, ws, {
  panelImpl = specReviewPanel,
  writeTraceImpl = writeTrace,
  now = Date.now(),
  sessionKey = null,
  requireAll = false
} = {}) {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch (e) {
    throw new Error(`could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hash = deepKey(filePath, content);   // FULL content — same bytes the panel reviews + the enqueue/retire-check key on
  const results = await panelImpl({ cwd: ws, filePath, content, env: process.env });

  const structured = summarizeSpecReview(results);   // { reviewers, findingCount, maxSeverity }
  const findings = aggregateFindings(results);       // blocking reviewers' findings, joined (NOT via combinePanel)
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
  const decision = explicitDecision(results, structured, { requireAll });
  const summary = explicitSummary(results, structured, { requireAll });

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "spec-review", ws,
      sessionKey,
      reviewers: results.map(({ findings: _findings, ...result }) => result),
      systemPrompt: SPEC_REVIEW_SYSTEM,
      userPrompt: buildSpecReviewUser(filePath, content),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ spec-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, decision, findings, traceId, badge, summary, hash };
}

export async function runPushReview(range, ws, {
  panelImpl = pushReviewPanel,
  writeTraceImpl = writeTrace,
  gitImpl = git,
  now = Date.now(),
  sessionKey = null,
  assistantContext = "",
  requireAll = false
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
  if (Buffer.byteLength(diffRaw) > MAX_PUSH_DIFF_BYTES) {
    process.stderr.write(`⛩ push-review: diff exceeds ${MAX_PUSH_DIFF_BYTES} bytes; split the range and retry.\n`);
    return {
      retry: true,
      reason: "evidence too large",
      reviewers: [],
      findingCount: 0,
      maxSeverity: "none",
      findings: "",
      traceId: null,
      badge: "",
      summary: "push review deferred (evidence too large)",
      hash: null
    };
  }
  const diff = diffRaw;
  const content = [
    "<commits>", commits || "(no commit list available)", "</commits>",
    "", "<diff>", diff || "(no diff available)", "</diff>"
  ].join("\n");

  const [headSha] = gitImpl(["rev-parse", "HEAD"], ws);
  const hash = deepKey(`push:${range}`, headSha);

  const results = await panelImpl({ cwd: ws, range, content, env: process.env, assistantContext });

  const structured = summarizeSpecReview(results);
  const findings = aggregateFindings(results);
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
  const decision = explicitDecision(results, structured, { requireAll });
  const summary = explicitSummary(results, structured, { requireAll });

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "push-review", ws,
      sessionKey,
      reviewers: results.map(({ findings: _findings, ...result }) => result),
      systemPrompt: PUSH_REVIEW_SYSTEM,
      userPrompt: buildPushReviewUser(range, content, { assistantContext }),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ push-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, decision, findings, traceId, badge, summary, hash };
}

// CLI entry (manual use; NOT hook-spawned any more):
//   spec-review-run.mjs <abs-path> --ws <abs-ws>      → runSpecReview
//   spec-review-run.mjs --push <range> --ws <abs-ws>  → runPushReview
// Exits 2 on a blocking finding. Infrastructure failure is advisory (0) unless --strict is passed.
if (isMainModule(import.meta.url)) {
  const rest = process.argv.slice(2);
  let filePath = null, ws = null, pushRange = null, strict = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--strict") { strict = true; continue; }
    if (rest[i] === "--ws" && i + 1 < rest.length) { ws = rest[++i]; continue; }
    if (rest[i] === "--push" && i + 1 < rest.length) { pushRange = rest[++i]; continue; }
    if (!filePath) filePath = rest[i];
  }
  (async () => {
    try {
      let result;
      if (pushRange) {
        if (!ws) ws = process.cwd();
        result = await runPushReview(pushRange, ws, { requireAll: strict });
      } else {
        if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exit(0); }
        if (!ws) ws = path.dirname(filePath);
        result = await runSpecReview(filePath, ws, { requireAll: strict });
      }
      if (result.decision === "block") {
        process.stderr.write(`⛩ deep review found blocking issues:\n\n${result.findings || result.summary}\n`);
        process.exit(2);
      }
      if (result.decision !== "allow") {
        process.stderr.write(`⛩ review unreviewed (advisory${strict ? ", strict mode" : ""}): ${result.summary}\n`);
        process.exit(strict ? 1 : 0);
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write(`⛩ ${pushRange ? "push-review" : "spec-review"}: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(strict ? 1 : 0);
    }
  })();
}
