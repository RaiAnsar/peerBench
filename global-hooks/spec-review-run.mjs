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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { specReviewPanel, SPEC_REVIEW_SYSTEM, buildSpecReviewUser, pushReviewPanel, PUSH_REVIEW_SYSTEM, buildPushReviewUser } from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, writeDeepResult, deepKey } from "./deep-review.mjs";

// Cap the reviewed push diff so a huge changeset doesn't blow up the prompt. Mirrors the
// pre-push gate's MAX_DIFF_BYTES.
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

// Capability H — deep, repo-aware review of the commits ABOUT TO BE PUSHED. Mirrors
// runSpecReview, but the reviewed content is `git log --oneline <range>` + `git diff <range>`
// (diff capped). Writes a gate:"push-review" trace and a deep-result with kind:"push", the
// range, and NO specPath (so surfaceDeepResult skips the file-based stale check). The result
// hash is deepKey(`push:<range>`, headSha) so re-pushing the same HEAD dedupes.
export async function runPushReview(range, ws, {
  panelImpl = pushReviewPanel,
  writeTraceImpl = writeTrace,
  writeDeepResultImpl = writeDeepResult,
  gitImpl = git,
  now = Date.now()
} = {}) {
  if (!range) throw new Error("runPushReview: missing range");

  const [commits] = gitImpl(["log", "--oneline", range], ws);
  let [diff] = gitImpl(["diff", range], ws);
  if (diff.length > MAX_PUSH_DIFF_BYTES) {
    diff = diff.slice(0, MAX_PUSH_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";
  }
  const content = [
    "<commits>",
    commits || "(no commit list available)",
    "</commits>",
    "",
    "<diff>",
    diff || "(no diff available)",
    "</diff>"
  ].join("\n");

  // Dedupe on the pushed HEAD so re-pushing the same HEAD within the window doesn't re-review.
  const [headSha] = gitImpl(["rev-parse", "HEAD"], ws);
  const hash = deepKey(`push:${range}`, headSha);

  const results = await panelImpl({ cwd: ws, range, content, env: process.env });

  const structured = summarizeSpecReview(results);   // { reviewers, findingCount, maxSeverity }
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict })));
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
    process.stderr.write(`⛩ push-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still written.\n`);
  }

  try {
    writeDeepResultImpl(ws, {
      hash, traceId, badge, summary, kind: "push", range, ts: new Date(now).toISOString(),
      reviewers: structured.reviewers, findingCount: structured.findingCount, maxSeverity: structured.maxSeverity
    });
  } catch (e) {
    process.stderr.write(`⛩ push-review: deep-result write failed (${e instanceof Error ? e.message : String(e)}).\n`);
  }

  return { ...structured, traceId, badge, summary, hash };
}

// CLI entry — two modes:
//   spec-review-run.mjs <abs-path> --ws <abs-ws>      → runSpecReview (G2 plan-file launch)
//   spec-review-run.mjs --push <range> --ws <abs-ws>  → runPushReview (H pre-push launch)
// Detached deep pass launched by the plan-file / pre-push gate. Resolves the SAME
// workspaceStateDir as the hook by taking --ws explicitly. Fails OPEN: any error
// is noted on stderr and the process exits 0 (it's detached + unref'd — a non-zero
// exit must never look like a crash the caller has to handle).
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
      if (pushRange) {
        if (!ws) ws = process.cwd();
        await runPushReview(pushRange, ws);
      } else {
        if (!filePath) { process.stderr.write("⛩ spec-review: missing <abs-path>.\n"); process.exit(0); }
        if (!ws) ws = path.dirname(filePath);
        await runSpecReview(filePath, ws);
      }
    } catch (e) {
      process.stderr.write(`⛩ ${pushRange ? "push-review" : "spec-review"}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    process.exit(0);
  })();
}
