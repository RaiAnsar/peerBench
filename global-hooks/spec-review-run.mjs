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
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { specReviewPanel, SPEC_REVIEW_SYSTEM, buildSpecReviewUser, pushReviewPanel, PUSH_REVIEW_SYSTEM, buildPushReviewUser } from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, deepKey, DEEP_REWAKE_SEVERITY, aggregateFindings, shouldRewake } from "./deep-review.mjs";

// A gate can only ALLOW evidence it actually placed in the review prompt. These are exhaustive
// per-section limits, not lossy sampling limits: exceeding one fails closed before reviewers run.
const MAX_PUSH_DIFF_BYTES = 1_000_000;
const MAX_PUSH_LOG_BYTES = 128_000;
const MAX_PUSH_STDERR_BYTES = 8_000;
// A wedged git (dead NFS/fuse) never settles, and the native pre-push path has no outer budget and
// no Git hook timeout — the push would hang indefinitely. Kill the child well below the deep
// runner's per-review budget (default 10 min) so the existing retry/defer handling engages instead.
const GIT_EVIDENCE_TIMEOUT_MS = 5 * 60 * 1000;

const VALID_VERDICTS = new Set(["ALLOW", "BLOCK"]);

// Deep panels are open-ended agentic runs. A provider can return readable prose but omit the
// required ALLOW/BLOCK line; that is an unavailable reviewer, not a clean vote. Normalize every
// invalid/error side before summarizing so malformed output cannot contribute findings/severity or
// acquire a green badge, while preserving the concrete error for traces and retry diagnostics.
function normalizeReviewResults(results) {
  return (Array.isArray(results) ? results : []).map((result) => {
    const verdict = String(result?.verdict ?? "").toUpperCase();
    const error = result?.error || (!VALID_VERDICTS.has(verdict) ? "unparseable verdict" : null);
    if (error) {
      return { ...result, verdict: null, severity: "none", findingCount: 0, error: String(error) };
    }
    return { ...result, verdict, error: null };
  });
}

function unavailableReason(results) {
  if (!results.length) return "no reviewers ran";
  const failures = results
    .map((r) => `${r.name || "reviewer"}: ${r.error || "no verdict"}`)
    .join(" | ")
    .slice(0, 500);
  return `no reviewer verdicts${failures ? ` (${failures})` : ""}`;
}

function reviewOutcome(results) {
  const normalized = normalizeReviewResults(results);
  const hasVerdict = normalized.some((r) => !r.error && VALID_VERDICTS.has(r.verdict));
  return {
    results: normalized,
    retry: !hasVerdict,
    reason: hasVerdict ? null : unavailableReason(normalized)
  };
}

// Local git helper — keep imports global-hooks-only (deploy-parity). Returns [out, ok].
function git(args, cwd) {
  try {
    const out = execFileSync("git", ["-c", "advice.graftFileDeprecated=false", "--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull }
    });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

function promptSafeEvidence(buffer, maxPromptBytes) {
  let utf8 = !buffer.includes(0);
  try { new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { utf8 = false; }
  if (utf8) return { text: buffer.toString("utf8").trim(), encoding: "utf8", renderable: true };
  // --text is required to defeat a committed `-diff` attribute. If that exposes genuine binary
  // bytes, keep ordinary diff headers/source text readable and escape only unsafe bytes. The form
  // is exact and reversible (\xHH per byte). If escaping itself would exceed the same prompt bound,
  // fail closed instead of silently omitting bytes.
  const chunks = ["[raw Git evidence encoded losslessly with \\xHH byte escapes]\n"];
  let renderedBytes = Buffer.byteLength(chunks[0]);
  let printableStart = 0;
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index];
    const printable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
    if (printable) continue;
    if (index > printableStart) {
      const text = buffer.subarray(printableStart, index).toString("ascii");
      chunks.push(text); renderedBytes += Buffer.byteLength(text);
    }
    const escaped = `\\x${byte.toString(16).padStart(2, "0")}`;
    chunks.push(escaped); renderedBytes += escaped.length;
    printableStart = index + 1;
    if (renderedBytes > maxPromptBytes) return { text: "", encoding: "byte-escaped", renderable: false };
  }
  if (printableStart < buffer.length) chunks.push(buffer.subarray(printableStart).toString("ascii"));
  const text = chunks.join("").trim();
  if (Buffer.byteLength(text) > maxPromptBytes) return { text: "", encoding: "byte-escaped", renderable: false };
  return { text, encoding: "byte-escaped", renderable: true };
}

function boundedEvidenceFromBuffer(buffer, maxBytes) {
  const bytes = buffer.length;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (bytes <= maxBytes) {
    const safe = promptSafeEvidence(buffer, maxBytes);
    return { ok: true, ...safe, bytes, sha256, truncated: false, stderr: "" };
  }
  const headBytes = Math.ceil(maxBytes / 2);
  const tailBytes = Math.floor(maxBytes / 2);
  const marker = `\n\n[... ${bytes - maxBytes} bytes omitted; full_sha256=${sha256} ...]\n\n`;
  return {
    ok: true,
    text: `${buffer.subarray(0, headBytes).toString("utf8")}${marker}${buffer.subarray(bytes - tailBytes).toString("utf8")}`.trim(),
    bytes,
    sha256,
    truncated: true,
    renderable: false,
    stderr: ""
  };
}

// Stream arbitrarily large Git output through a full SHA-256 while retaining only bounded head and
// tail evidence for the prompt. This avoids execFileSync's maxBuffer false-block on large text diffs
// and still detects the child exit status exactly.
export function streamGitEvidence(args, cwd, { maxBytes = MAX_PUSH_DIFF_BYTES, timeoutMs = GIT_EVIDENCE_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const headLimit = Math.ceil(maxBytes / 2);
    const tailLimit = Math.floor(maxBytes / 2);
    const headChunks = [], tailChunks = [];
    let headSize = 0, tailSize = 0, bytes = 0;
    let completeChunks = [];
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("git", ["-c", "advice.graftFileDeprecated=false", "--no-replace-objects", ...args], {
      cwd,
      env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull },
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        finish({ ok: false, text: "", bytes, sha256: null, truncated: false, stderr: `git evidence timed out after ${Number(timeoutMs)} ms` });
      }, Number(timeoutMs));
    }

    child.stdout.on("data", (raw) => {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      hash.update(chunk);
      if (completeChunks && bytes <= maxBytes) completeChunks.push(chunk);
      else completeChunks = null;

      if (headSize < headLimit) {
        const take = Math.min(headLimit - headSize, chunk.length);
        if (take) { headChunks.push(chunk.subarray(0, take)); headSize += take; }
      }
      if (tailLimit > 0) {
        tailChunks.push(chunk);
        tailSize += chunk.length;
        while (tailSize > tailLimit && tailChunks.length) {
          const extra = tailSize - tailLimit;
          if (tailChunks[0].length <= extra) tailSize -= tailChunks.shift().length;
          else {
            tailChunks[0] = tailChunks[0].subarray(extra);
            tailSize -= extra;
          }
        }
      }
    });
    child.stderr.on("data", (raw) => {
      if (stderr.length >= MAX_PUSH_STDERR_BYTES) return;
      stderr = Buffer.concat([stderr, Buffer.from(raw).subarray(0, MAX_PUSH_STDERR_BYTES - stderr.length)]);
    });
    child.on("error", (error) => {
      finish({ ok: false, text: "", bytes, sha256: null, truncated: false, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      const sha256 = hash.digest("hex");
      const truncated = bytes > maxBytes;
      let text;
      let encoding = "utf8";
      let renderable = !truncated;
      if (!truncated) {
        const complete = Buffer.concat(completeChunks || []);
        const safe = promptSafeEvidence(complete, maxBytes);
        text = safe.text;
        encoding = safe.encoding;
        renderable = safe.renderable;
      } else {
        const marker = `\n\n[... ${bytes - maxBytes} bytes omitted; full_sha256=${sha256} ...]\n\n`;
        text = `${Buffer.concat(headChunks).toString("utf8")}${marker}${Buffer.concat(tailChunks).toString("utf8")}`.trim();
      }
      finish({
        ok: code === 0,
        text,
        bytes,
        sha256,
        truncated,
        renderable,
        encoding,
        stderr: stderr.toString("utf8").trim() || (code === 0 ? "" : `git exited ${code ?? signal ?? "unknown"}`)
      });
    });
  });
}

async function collectGitEvidence(args, cwd, { maxBytes, gitImpl, gitEvidenceImpl, env }) {
  if (gitImpl) {
    const [out, ok] = gitImpl(args, cwd);
    const evidence = boundedEvidenceFromBuffer(Buffer.from(String(out || "")), maxBytes);
    return { ...evidence, ok, stderr: ok ? "" : "injected git failure" };
  }
  return gitEvidenceImpl(args, cwd, { maxBytes, env });
}

const isOid = (value) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(value || ""));

function splitTwoDotRange(range) {
  const value = String(range || "");
  const at = value.indexOf("..");
  if (at <= 0 || at + 2 >= value.length || value.slice(at + 2).includes("..")) return null;
  return [value.slice(0, at), value.slice(at + 2)];
}

function exactPushRange(range, ws, { targetCommit, baseCommit, gitImpl }) {
  const parts = splitTwoDotRange(range);
  if (!parts) return { ok: false, reason: `unsupported push range ${range}; expected base..tip` };
  const invoke = gitImpl || git;
  const resolve = (value, suffix) => {
    const [out, ok] = invoke(["rev-parse", "--verify", "--quiet", `${value}${suffix}`], ws);
    const oid = String(out || "").trim().toLowerCase();
    return ok && isOid(oid) ? oid : null;
  };
  const rangeBase = resolve(parts[0], "^{object}");
  const rangeTip = resolve(parts[1], "^{commit}");
  if (!rangeBase || !rangeTip) return { ok: false, reason: `could not resolve immutable objects for ${range}` };

  const suppliedTip = targetCommit ? resolve(targetCommit, "^{commit}") : rangeTip;
  const suppliedBase = baseCommit ? resolve(baseCommit, "^{object}") : rangeBase;
  if (!suppliedTip || !suppliedBase) return { ok: false, reason: "supplied pushed tip/base is unavailable" };
  if (suppliedTip !== rangeTip || suppliedBase !== rangeBase) {
    return { ok: false, reason: "pushed tip/base does not match the reviewed range" };
  }
  return { ok: true, base: rangeBase, tip: rangeTip, range: `${rangeBase}..${rangeTip}` };
}

function incompleteEvidenceReason(sections) {
  const incomplete = sections.filter(([, evidence]) => evidence.truncated || evidence.renderable === false);
  if (!incomplete.length) return null;
  return `push evidence cannot be rendered exhaustively (${incomplete
    .map(([name, evidence]) => `${name}: ${evidence.bytes} bytes${evidence.truncated ? " exceeds limit" : " contains non-text bytes"}`)
    .join(", ")}); no omitted or lossy-decoded bytes can produce an ALLOW`;
}

function needsNetTreeDiff(exact, ws, gitImpl) {
  const invoke = gitImpl || git;
  const [baseType, typeOk] = invoke(["cat-file", "-t", exact.base], ws);
  // A new ref uses the empty tree as its base. Per-commit --root deltas already cover its complete
  // published history, so duplicating the whole snapshot would only inflate the prompt.
  if (typeOk && String(baseType).trim() === "tree") return false;
  const [mergeBase, mergeOk] = invoke(["merge-base", exact.base, exact.tip], ws);
  // A normal fast-forward's per-commit deltas completely describe the update. A rewind/divergence
  // needs the additional old-base→new-tip tree effect even when no forward commits are reachable.
  return !mergeOk || String(mergeBase).trim().toLowerCase() !== exact.base;
}

export async function runSpecReview(filePath, ws, {
  panelImpl = specReviewPanel,
  writeTraceImpl = writeTrace,
  now = Date.now(),
  sessionKey = null,
  env = process.env
} = {}) {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch (e) {
    throw new Error(`could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hash = deepKey(filePath, content);   // FULL content — same bytes the panel reviews + the enqueue/retire-check key on
  const panelResults = await panelImpl({ cwd: ws, filePath, content, env });
  const { results, retry, reason } = reviewOutcome(panelResults);

  const structured = summarizeSpecReview(results);   // { reviewers, findingCount, maxSeverity }
  const findings = aggregateFindings(results);       // blocking reviewers' findings, joined (NOT via combinePanel)
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
  const summary = retry
    ? `spec review unavailable (${reason})`
    : structured.findingCount > 0
    ? `${structured.findingCount} finding(s), max severity ${structured.maxSeverity}`
    : "no blocking findings";

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "spec-review", ws,
      sessionKey,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null, severity: r.severity, findingCount: r.findingCount })),
      systemPrompt: SPEC_REVIEW_SYSTEM,
      userPrompt: buildSpecReviewUser(filePath, content),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ spec-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, findings, traceId, badge, summary, hash, ...(retry ? { retry: true, reason } : {}) };
}

export async function runPushReview(range, ws, {
  panelImpl = pushReviewPanel,
  writeTraceImpl = writeTrace,
  gitImpl = null,
  gitEvidenceImpl = streamGitEvidence,
  now = Date.now(),
  sessionKey = null,
  assistantContext = "",
  targetCommit = null,
  baseCommit = null,
  env = process.env
} = {}) {
  if (!range) throw new Error("runPushReview: missing range");

  const exact = exactPushRange(range, ws, { targetCommit, baseCommit, gitImpl });
  if (!exact.ok) {
    return {
      retry: true,
      reason: exact.reason,
      reviewers: [], findingCount: 0, maxSeverity: "none", findings: "",
      traceId: null, badge: "", summary: `push review deferred (${exact.reason})`, hash: null
    };
  }

  // Raw, deterministic evidence. Every reachable pushed commit is shown with its own parent delta;
  // -m includes every merge parent, --root includes root commits, and the separate base→tip net diff
  // covers force rewinds whose forward commit set is empty. Repository diff drivers, external diff,
  // textconv, binary attributes, and replacement refs cannot hide bytes from this evidence.
  const rawDiffFlags = [
    "--no-ext-diff", "--no-textconv", "--text", "--binary", "--no-renames",
    "--full-index", "--no-color", "--ignore-submodules=none"
  ];
  const commitArgs = [
    "log", "--reverse", "--topo-order",
    "--format=commit %H%nparents %P%nauthor %an <%ae>%nauthor-date %aI%ncommitter-date %cI%nsubject %s%nmessage%n%B%n",
    exact.range
  ];
  const deltaArgs = [
    "log", "--reverse", "--topo-order", "--root", "-m",
    "--format=commit %H%nparents %P%nsubject %s%n", "-p", ...rawDiffFlags,
    exact.range
  ];
  const includeNetTreeDiff = needsNetTreeDiff(exact, ws, gitImpl);
  const netDiffArgs = ["diff", ...rawDiffFlags, exact.base, exact.tip, "--"];

  // Git errors return a RETRY signal — NOT a clean no-block result. A transient `git log`/`git diff`
  // failure must make the runner REQUEUE the job (bounded), never treat it as clean and delete it
  // (that would lose the queued review — the never-lose guarantee). `retry:true` is distinct from a
  // real no-block result (which has retry undefined).
  const [commitEvidence, deltaEvidence, netDiffEvidence] = await Promise.all([
    collectGitEvidence(commitArgs, ws, { maxBytes: MAX_PUSH_LOG_BYTES, gitImpl, gitEvidenceImpl, env }),
    collectGitEvidence(deltaArgs, ws, { maxBytes: MAX_PUSH_DIFF_BYTES, gitImpl, gitEvidenceImpl, env }),
    includeNetTreeDiff
      ? collectGitEvidence(netDiffArgs, ws, { maxBytes: MAX_PUSH_DIFF_BYTES, gitImpl, gitEvidenceImpl, env })
      : Promise.resolve({
        ok: true,
        text: "",
        bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        truncated: false,
        renderable: true,
        stderr: ""
      })
  ]);
  if (!commitEvidence.ok || !deltaEvidence.ok || !netDiffEvidence.ok) {
    process.stderr.write(`⛩ push-review: git failed for ${exact.range}; signalling retry (not cleared).\n`);
    return { retry: true, reason: "git error", reviewers: [], findingCount: 0, maxSeverity: "none", findings: "", traceId: null, badge: "", summary: "push review deferred (git error)", hash: null };
  }
  const incompleteReason = incompleteEvidenceReason([
    ["commit list", commitEvidence],
    ["per-commit deltas", deltaEvidence],
    ["net tree diff", netDiffEvidence]
  ]);
  if (incompleteReason) {
    process.stderr.write(`⛩ push-review: ${incompleteReason}.\n`);
    const hash = deepKey(
      `push:${exact.range}:coverage-block`,
      [exact.base, exact.tip, commitEvidence.sha256, deltaEvidence.sha256, netDiffEvidence.sha256].join("\n")
    );
    return {
      coverageBlocked: true,
      reason: incompleteReason,
      reviewers: [], findingCount: 1, maxSeverity: "high", findings: incompleteReason,
      traceId: null, badge: "Evidence✗", summary: `push review blocked: ${incompleteReason}`, hash,
      coverageIncomplete: true
    };
  }
  const content = [
    `<immutable_push base="${exact.base}" tip="${exact.tip}">`,
    `<commits bytes="${commitEvidence.bytes}" sha256="${commitEvidence.sha256}" encoding="${commitEvidence.encoding || "utf8"}" truncated="false">`,
    commitEvidence.text || "(no commit list available)",
    "</commits>",
    "",
    `<per_commit_deltas bytes="${deltaEvidence.bytes}" sha256="${deltaEvidence.sha256}" encoding="${deltaEvidence.encoding || "utf8"}" truncated="false">`,
    deltaEvidence.text || "(no forward commit deltas; this may be a rewind)",
    "</per_commit_deltas>",
    "",
    ...(includeNetTreeDiff ? [
      `<net_tree_diff bytes="${netDiffEvidence.bytes}" sha256="${netDiffEvidence.sha256}" encoding="${netDiffEvidence.encoding || "utf8"}" truncated="false">`,
      netDiffEvidence.text || "(base and tip trees are identical)",
      "</net_tree_diff>"
    ] : ["<net_tree_diff omitted=\"true\">normal fast-forward/new-ref; completely covered by per-commit deltas</net_tree_diff>"]),
    "</immutable_push>"
  ].join("\n");

  const hash = deepKey(
    `push:${exact.range}`,
    [exact.base, exact.tip, commitEvidence.sha256, deltaEvidence.sha256, netDiffEvidence.sha256].join("\n")
  );

  const panelResults = await panelImpl({
    cwd: ws,
    range: exact.range,
    content,
    env,
    assistantContext,
    targetCommit: exact.tip
  });
  const { results, retry, reason } = reviewOutcome(panelResults);

  const structured = summarizeSpecReview(results);
  const findings = aggregateFindings(results);
  const badge = panelBadge(results.map((r) => ({ name: r.name, error: r.error, verdict: r.verdict, severity: r.severity })), { blockMinSeverity: DEEP_REWAKE_SEVERITY });
  const summary = retry
    ? `push review unavailable (${reason})`
    : structured.findingCount > 0
    ? `${structured.findingCount} finding(s), max severity ${structured.maxSeverity}`
    : "no blocking findings";

  let traceId = null;
  try {
    traceId = writeTraceImpl(ws, {
      gate: "push-review", ws,
      sessionKey,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null, severity: r.severity, findingCount: r.findingCount })),
      systemPrompt: PUSH_REVIEW_SYSTEM,
      userPrompt: buildPushReviewUser(exact.range, content, { assistantContext }),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.findings || `(no findings: ${r.error || "empty"})`]))
    }, { now });
  } catch (e) {
    process.stderr.write(`⛩ push-review: trace write failed (${e instanceof Error ? e.message : String(e)}); result still returned.\n`);
  }

  return { ...structured, findings, traceId, badge, summary, hash, ...(retry ? { retry: true, reason } : {}) };
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
