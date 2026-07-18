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
import {
  specReviewPanel,
  SPEC_REVIEW_SYSTEM,
  buildSpecReviewUser,
  pushReviewPanel,
  PUSH_REVIEW_SYSTEM,
  buildPushReviewUser,
  MAX_PUSH_REVIEW_REQUEST_BYTES,
  pushReviewSerializedRequestBytes,
  MAX_AUTO_PUSH_REVIEW_BUDGET_MS,
  pushReviewBudgetMs
} from "./hunt.mjs";
import { panelBadge } from "./panel-lib.mjs";
import { writeTrace } from "./trace-store.mjs";
import { summarizeSpecReview, deepKey, DEEP_REWAKE_SEVERITY, aggregateFindings, shouldRewake } from "./deep-review.mjs";

// A gate can only ALLOW evidence it actually placed in the review prompt. These are exhaustive
// per-section limits, not lossy sampling limits: exceeding one fails closed before reviewers run.
// Large pushes are reviewed as a bounded sequence instead of one provider-hostile monolith. The
// total ceiling remains finite: every byte must fit in one of these chunks or the gate fails closed.
// The request ceiling includes system/user instructions, assistant context, structural context,
// and authenticated boundary overlap. Core evidence is deliberately smaller so the final initial
// provider prompt (before tool history grows) remains below the honest 192 KB request cap.
export const MAX_PUSH_REVIEW_CHUNK_BYTES = MAX_PUSH_REVIEW_REQUEST_BYTES;
export const MAX_PUSH_REVIEW_CHUNKS = 8;
export const MAX_PUSH_REVIEW_PAYLOAD_BYTES = 160_000;
export const PUSH_REVIEW_BOUNDARY_CONTEXT_BYTES = 4_096;
const PUSH_REVIEW_EVIDENCE_VERSION = "push-review-v6-expanded-handoff-bounded";
const MAX_PUSH_DIFF_BYTES = MAX_PUSH_REVIEW_PAYLOAD_BYTES * MAX_PUSH_REVIEW_CHUNKS;
const MAX_PUSH_LOG_BYTES = 128_000;
const MAX_PUSH_STDERR_BYTES = 8_000;
// Metadata resolution and all streamed evidence share this ONE absolute deadline. The panel starts
// only after Git preparation succeeds and receives its own separately bounded budget. Export the
// combined ceiling so the runner and outer hook derive their limits from the same accounting.
export const PUSH_GIT_PREPARATION_BUDGET_MS = 5 * 60 * 1000;
export const MAX_PUSH_REVIEW_END_TO_END_BUDGET_MS =
  PUSH_GIT_PREPARATION_BUDGET_MS + MAX_AUTO_PUSH_REVIEW_BUDGET_MS;

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

function splitUtf8ByBytes(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (!buffer.length) return [""];
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(buffer.length, offset + maxBytes);
    if (end < buffer.length) {
      while (end > offset && (buffer[end] & 0xc0) === 0x80) end--;
      const preferredStart = offset + Math.floor(maxBytes * 0.75);
      const newline = buffer.lastIndexOf(0x0a, end - 1);
      if (newline >= preferredStart) end = newline + 1;
    }
    if (end <= offset) throw new Error("push review chunk limit is too small for one UTF-8 code point");
    chunks.push(buffer.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

function utf8Suffix(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  for (let start = buffer.length - maxBytes; start <= buffer.length; start++) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start)); }
    catch { /* trim a partial code point */ }
  }
  return "";
}

function utf8BufferSlice(buffer, start, end) {
  let safeStart = Math.max(0, Math.min(buffer.length, start));
  let safeEnd = Math.max(safeStart, Math.min(buffer.length, end));
  while (safeStart < safeEnd && (buffer[safeStart] & 0xc0) === 0x80) safeStart++;
  while (safeEnd > safeStart && safeEnd < buffer.length && (buffer[safeEnd] & 0xc0) === 0x80) safeEnd--;
  return buffer.subarray(safeStart, safeEnd).toString("utf8");
}

function duplicatedBoundaryContext(sourceBuffer, start, end, direction) {
  if (end <= start) return "";
  const value = utf8BufferSlice(sourceBuffer, start, end);
  if (!value) return "";
  const bytes = Buffer.from(value, "utf8");
  const actualStart = direction === "before" ? end - bytes.length : start;
  const actualEnd = actualStart + bytes.length;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return [
    `<duplicated_boundary_context direction="${direction}" byte_start="${actualStart}" byte_end="${actualEnd}" bytes="${bytes.length}" sha256="${sha256}" duplicate="true">`,
    value,
    "</duplicated_boundary_context>"
  ].join("\n");
}

// Wrap exact, non-overlapping UTF-8 slices with immutable range metadata. Concatenating payloads
// reproduces `content` byte-for-byte; wrappers add identity, ordering, and tamper-evident hashes but
// never replace source evidence. Callers fail closed when the bounded chunk count would be exceeded.
export function buildPushReviewChunks(content, {
  maxChunkBytes = MAX_PUSH_REVIEW_PAYLOAD_BYTES,
  maxChunks = MAX_PUSH_REVIEW_CHUNKS,
  base = "",
  tip = "",
  range = ""
} = {}) {
  const chunkBytes = Number(maxChunkBytes);
  const chunkLimit = Number(maxChunks);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 4 || !Number.isInteger(chunkLimit) || chunkLimit < 1) {
    throw new Error("invalid push review chunk bounds");
  }
  const source = String(content ?? "");
  const sourceBuffer = Buffer.from(source, "utf8");
  const payloads = splitUtf8ByBytes(source, chunkBytes);
  const sha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  if (payloads.length > chunkLimit) {
    return {
      ok: false,
      payloads,
      bytes: sourceBuffer.length,
      sha256,
      reason: `push evidence requires ${payloads.length} bounded chunks at ${chunkBytes} bytes; limit is ${chunkLimit}; no omitted evidence can produce an ALLOW`
    };
  }
  let byteStart = 0;
  let priorText = "";
  const manifest = [];
  const chunks = payloads.map((payload, index) => {
    const payloadBuffer = Buffer.from(payload, "utf8");
    const byteEnd = byteStart + payloadBuffer.length;
    const chunkSha256 = createHash("sha256").update(payloadBuffer).digest("hex");
    const contextLines = [];
    for (const pattern of [
      /^commit [0-9a-f]{40,64}.*$/gim,
      /^<(?:commits|per_commit_deltas|net_tree_diff)\b.*>$/gim,
      /^diff --git .*$/gim,
      /^@@ .*@@.*$/gm
    ]) {
      const matches = [...priorText.matchAll(pattern)];
      if (matches.length) contextLines.push(matches.at(-1)[0]);
    }
    const repeatedContext = contextLines.length
      ? `<repeated_non_authoritative_context>\n${utf8Suffix(contextLines.join("\n"), 4_096)}\n</repeated_non_authoritative_context>\n`
      : "";
    const beforeBoundary = index > 0
      ? duplicatedBoundaryContext(sourceBuffer, Math.max(0, byteStart - PUSH_REVIEW_BOUNDARY_CONTEXT_BYTES), byteStart, "before")
      : "";
    const afterBoundary = index + 1 < payloads.length
      ? duplicatedBoundaryContext(sourceBuffer, byteEnd, Math.min(sourceBuffer.length, byteEnd + PUSH_REVIEW_BOUNDARY_CONTEXT_BYTES), "after")
      : "";
    const rendered = [
      `<immutable_push_review_chunk index="${index + 1}" total="${payloads.length}" base="${base}" tip="${tip}" range="${range}" full_bytes="${sourceBuffer.length}" full_sha256="${sha256}">`,
      repeatedContext.trimEnd(),
      beforeBoundary,
      `<chunk_payload byte_start="${byteStart}" byte_end="${byteEnd}" bytes="${payloadBuffer.length}" sha256="${chunkSha256}">`,
      payload,
      "</chunk_payload>",
      afterBoundary,
      "</immutable_push_review_chunk>"
    ].filter(Boolean).join("\n");
    manifest.push({
      index: index + 1,
      total: payloads.length,
      byteStart,
      byteEnd,
      bytes: payloadBuffer.length,
      sha256: chunkSha256,
      boundaryBeforeBytes: Buffer.byteLength(beforeBoundary),
      boundaryAfterBytes: Buffer.byteLength(afterBoundary)
    });
    byteStart = byteEnd;
    priorText += payload;
    return rendered;
  });
  return { ok: true, chunks, payloads, manifest, bytes: sourceBuffer.length, sha256 };
}

// Find the largest core size whose REAL serialized initial request fits every configured provider.
// JSON-heavy evidence can expand close to 2x, so rejecting an oversized 160KB candidate would make
// an otherwise-reviewable push permanently unavailable. Binary search re-splits it while retaining
// the same eight-chunk hard ceiling and exact non-overlapping authoritative cores.
export function buildSerializedPushReviewChunks(content, {
  maxPayloadBytes = MAX_PUSH_REVIEW_PAYLOAD_BYTES,
  maxChunks = MAX_PUSH_REVIEW_CHUNKS,
  maxRequestBytes = MAX_PUSH_REVIEW_REQUEST_BYTES,
  base = "",
  tip = "",
  range = "",
  assistantContext = "",
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const requestBytesFor = (plan) => plan.chunks.map((chunkContent, chunkIndex) => {
    const user = buildPushReviewUser(range, chunkContent, {
      assistantContext,
      chunkIndex,
      chunkCount: plan.chunks.length
    });
    return pushReviewSerializedRequestBytes(PUSH_REVIEW_SYSTEM, user, {
      cwd,
      treeish: tip || null,
      env
    });
  });

  let low = 4;
  let high = Math.max(low, Math.floor(Number(maxPayloadBytes) || MAX_PUSH_REVIEW_PAYLOAD_BYTES));
  let best = null;
  let identity = null;
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const plan = buildPushReviewChunks(content, {
      maxChunkBytes: candidateBytes,
      maxChunks,
      base,
      tip,
      range
    });
    identity ||= { bytes: plan.bytes, sha256: plan.sha256 };
    if (!plan.ok) {
      low = candidateBytes + 1; // too many raw chunks: each core must grow
      continue;
    }
    const requestBytes = requestBytesFor(plan);
    if (requestBytes.every((bytes) => bytes <= maxRequestBytes)) {
      best = { ...plan, maxPayloadBytes: candidateBytes, requestBytes };
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1; // JSON/tool envelope is too large: split cores more finely
    }
  }
  if (best) return best;
  return {
    ok: false,
    bytes: identity?.bytes ?? Buffer.byteLength(String(content ?? ""), "utf8"),
    sha256: identity?.sha256 ?? createHash("sha256").update(String(content ?? ""), "utf8").digest("hex"),
    reason: `push evidence cannot fit in ${maxChunks} bounded serialized requests of at most ${maxRequestBytes} bytes; no omitted evidence can produce an ALLOW`
  };
}

// Local git helper — keep imports global-hooks-only (deploy-parity). Returns [out, ok]. Every
// production synchronous invocation has a hard SIGKILL timeout; callers normally pass the
// remaining duration from the shared push-Git deadline.
function git(args, cwd, { timeoutMs = PUSH_GIT_PREPARATION_BUDGET_MS, env = process.env } = {}) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.max(1, Math.ceil(Number(timeoutMs)))
    : PUSH_GIT_PREPARATION_BUDGET_MS;
  try {
    const out = execFileSync("git", ["-c", "advice.graftFileDeprecated=false", "--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: boundedTimeoutMs,
      killSignal: "SIGKILL",
      env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull }
    });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

export function promptSafeEvidence(buffer, maxPromptBytes) {
  let utf8 = !buffer.includes(0);
  try { new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { utf8 = false; }
  if (utf8) return { text: buffer.toString("utf8"), encoding: "utf8", renderable: true };
  // --text is required to defeat a committed `-diff` attribute. If it exposes binary bytes, encode
  // EVERY byte as \xHH. Mixing literal backslashes with escaped unsafe bytes is ambiguous (two
  // distinct inputs can render identically), whereas all-byte hex is exactly reversible.
  const prefix = "[raw Git evidence encoded losslessly; every source byte is one \\xHH token]\n";
  if (Buffer.byteLength(prefix) + buffer.length * 4 > maxPromptBytes) {
    return { text: "", encoding: "all-byte-hex", renderable: false };
  }
  const chunks = [prefix];
  const batchBytes = 16_384;
  for (let start = 0; start < buffer.length; start += batchBytes) {
    let encoded = "";
    for (const byte of buffer.subarray(start, start + batchBytes)) {
      encoded += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
    chunks.push(encoded);
  }
  return { text: chunks.join(""), encoding: "all-byte-hex", renderable: true };
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
export function streamGitEvidence(args, cwd, { maxBytes = MAX_PUSH_DIFF_BYTES, timeoutMs = PUSH_GIT_PREPARATION_BUDGET_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.max(1, Math.ceil(Number(timeoutMs)))
      : PUSH_GIT_PREPARATION_BUDGET_MS;
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
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ ok: false, text: "", bytes, sha256: null, truncated: false, stderr: `git evidence timed out after ${boundedTimeoutMs} ms` });
    }, boundedTimeoutMs);

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

async function collectGitEvidence(args, cwd, { maxBytes, gitImpl, gitEvidenceImpl, timeoutMs, env }) {
  if (gitImpl) {
    const [out, ok] = gitImpl(args, cwd, { timeoutMs, env });
    const evidence = boundedEvidenceFromBuffer(Buffer.from(String(out || "")), maxBytes);
    return { ...evidence, ok, stderr: ok ? "" : "injected git failure" };
  }
  return gitEvidenceImpl(args, cwd, { maxBytes, timeoutMs, env });
}

class PushGitDeadlineError extends Error {
  constructor() {
    super("push Git preparation exceeded its shared absolute deadline");
    this.name = "PushGitDeadlineError";
  }
}

function remainingPushGitBudgetMs(deadlineMs, nowImpl) {
  const remaining = deadlineMs - Number(nowImpl());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new PushGitDeadlineError();
  return Math.max(1, Math.ceil(remaining));
}

async function withinPushGitDeadline(promise, deadlineMs, nowImpl) {
  const remainingMs = remainingPushGitBudgetMs(deadlineMs, nowImpl);
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PushGitDeadlineError()), remainingMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  nowImpl = Date.now,
  gitPreparationBudgetMs = PUSH_GIT_PREPARATION_BUDGET_MS,
  sessionKey = null,
  assistantContext = "",
  targetCommit = null,
  baseCommit = null,
  env = process.env
} = {}) {
  if (!range) throw new Error("runPushReview: missing range");

  const requestedGitBudgetMs = Number(gitPreparationBudgetMs);
  const effectiveGitBudgetMs = Number.isFinite(requestedGitBudgetMs) && requestedGitBudgetMs > 0
    ? Math.min(PUSH_GIT_PREPARATION_BUDGET_MS, requestedGitBudgetMs)
    : PUSH_GIT_PREPARATION_BUDGET_MS;
  const gitDeadlineMs = Number(nowImpl()) + effectiveGitBudgetMs;
  // Injected Git is retained for deterministic tests, but production metadata always reaches the
  // bounded synchronous helper. Re-check after each call so sequential metadata cannot reset the
  // clock even when the child exits just as its per-call timeout expires.
  const invokeMetadataGit = gitImpl || git;
  const deadlineGit = (args, cwd) => {
    const timeoutMs = remainingPushGitBudgetMs(gitDeadlineMs, nowImpl);
    const result = invokeMetadataGit(args, cwd, { timeoutMs, env });
    remainingPushGitBudgetMs(gitDeadlineMs, nowImpl);
    return result;
  };

  let exact;
  try {
    exact = exactPushRange(range, ws, { targetCommit, baseCommit, gitImpl: deadlineGit });
  } catch (error) {
    if (error instanceof PushGitDeadlineError) {
      const reason = error.message;
      return {
        retry: true, reason,
        reviewers: [], findingCount: 0, maxSeverity: "none", findings: "",
        traceId: null, badge: "", summary: `push review deferred (${reason})`, hash: null
      };
    }
    throw error;
  }
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
  const netDiffArgs = ["diff", ...rawDiffFlags, exact.base, exact.tip, "--"];

  // Git errors return a RETRY signal — NOT a clean no-block result. A transient `git log`/`git diff`
  // failure must make the runner REQUEUE the job (bounded), never treat it as clean and delete it
  // (that would lose the queued review — the never-lose guarantee). `retry:true` is distinct from a
  // real no-block result (which has retry undefined).
  let includeNetTreeDiff;
  let commitEvidence, deltaEvidence, netDiffEvidence;
  try {
    includeNetTreeDiff = needsNetTreeDiff(exact, ws, deadlineGit);
    const evidenceGitImpl = gitImpl ? deadlineGit : null;
    const evidenceTimeoutMs = remainingPushGitBudgetMs(gitDeadlineMs, nowImpl);
    const evidencePromise = Promise.all([
      collectGitEvidence(commitArgs, ws, {
        maxBytes: MAX_PUSH_LOG_BYTES, gitImpl: evidenceGitImpl, gitEvidenceImpl,
        timeoutMs: evidenceTimeoutMs, env
      }),
      collectGitEvidence(deltaArgs, ws, {
        maxBytes: MAX_PUSH_DIFF_BYTES, gitImpl: evidenceGitImpl, gitEvidenceImpl,
        timeoutMs: evidenceTimeoutMs, env
      }),
      includeNetTreeDiff
        ? collectGitEvidence(netDiffArgs, ws, {
          maxBytes: MAX_PUSH_DIFF_BYTES, gitImpl: evidenceGitImpl, gitEvidenceImpl,
          timeoutMs: evidenceTimeoutMs, env
        })
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
    [commitEvidence, deltaEvidence, netDiffEvidence] = await withinPushGitDeadline(
      evidencePromise,
      gitDeadlineMs,
      nowImpl
    );
    remainingPushGitBudgetMs(gitDeadlineMs, nowImpl);
  } catch (error) {
    if (error instanceof PushGitDeadlineError) {
      const reason = error.message;
      process.stderr.write(`⛩ push-review: ${reason}; signalling retry (not cleared).\n`);
      return {
        retry: true, reason,
        reviewers: [], findingCount: 0, maxSeverity: "none", findings: "",
        traceId: null, badge: "", summary: `push review deferred (${reason})`, hash: null
      };
    }
    throw error;
  }
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
      `push:${exact.range}:${PUSH_REVIEW_EVIDENCE_VERSION}:coverage-block`,
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
    `push:${exact.range}:${PUSH_REVIEW_EVIDENCE_VERSION}`,
    [exact.base, exact.tip, commitEvidence.sha256, deltaEvidence.sha256, netDiffEvidence.sha256].join("\n")
  );

  const chunkPlan = buildSerializedPushReviewChunks(content, {
    base: exact.base,
    tip: exact.tip,
    range: exact.range,
    assistantContext,
    cwd: ws,
    env
  });
  if (!chunkPlan.ok) {
    process.stderr.write(`⛩ push-review: ${chunkPlan.reason}.\n`);
    const coverageHash = deepKey(
      `push:${exact.range}:${PUSH_REVIEW_EVIDENCE_VERSION}:coverage-block`,
      [exact.base, exact.tip, commitEvidence.sha256, deltaEvidence.sha256, netDiffEvidence.sha256].join("\n")
    );
    return {
      coverageBlocked: true,
      reason: chunkPlan.reason,
      reviewers: [], findingCount: 1, maxSeverity: "high", findings: chunkPlan.reason,
      traceId: null, badge: "Evidence✗", summary: `push review blocked: ${chunkPlan.reason}`,
      hash: coverageHash, coverageIncomplete: true
    };
  }

  // The panel owns reviewer-local sequencing: reviewers run in parallel, but each reviewer maps all
  // chunks plus one bounded synthesis under a single absolute budget and returns exactly one row.
  // That keeps the immutable snapshot alive once and prevents partial coverage from forming quorum.
  const panelBudgetMs = Math.min(
    MAX_AUTO_PUSH_REVIEW_BUDGET_MS,
    pushReviewBudgetMs(env, chunkPlan.chunks.length)
  );
  let panelResults = await panelImpl({
    cwd: ws,
    range: exact.range,
    content: chunkPlan.chunks[0],
    contents: chunkPlan.chunks,
    env,
    assistantContext,
    targetCommit: exact.tip,
    fullContentSha256: chunkPlan.sha256,
    budgetMs: panelBudgetMs
  });
  if (chunkPlan.chunks.length > 1) {
    panelResults = (Array.isArray(panelResults) ? panelResults : []).map((result) => {
      if (result?.coverageComplete === true || result?.coverageComplete === false) return result;
      const coverageError = `panel did not acknowledge complete coverage of all ${chunkPlan.chunks.length} bounded chunks`;
      if (String(result?.verdict || "").toUpperCase() === "BLOCK" && !result?.error) {
        return { ...result, coverageComplete: false, coverageError };
      }
      return { ...result, error: result?.error || coverageError, coverageComplete: false, coverageError };
    });
  }
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
      reviewers: results.map((r) => ({
        name: r.name,
        verdict: r.verdict || null,
        error: r.error || null,
        severity: r.severity,
        findingCount: r.findingCount,
        ...(r.coverageComplete === false ? { coverageComplete: false, coverageError: r.coverageError || null } : {}),
        ...(Array.isArray(r.chunkResults) ? { chunks: r.chunkResults } : {})
      })),
      systemPrompt: PUSH_REVIEW_SYSTEM,
      userPrompt: chunkPlan.chunks.map((chunkContent, chunkIndex) =>
        buildPushReviewUser(exact.range, chunkContent, {
          assistantContext,
          chunkIndex,
          chunkCount: chunkPlan.chunks.length
        })
      ).join("\n\n--- next bounded push-review call ---\n\n"),
      chunkManifest: chunkPlan.manifest,
      evidenceHashes: {
        base: exact.base,
        tip: exact.tip,
        commits: commitEvidence.sha256,
        perCommitDeltas: deltaEvidence.sha256,
        netTreeDiff: netDiffEvidence.sha256,
        rendered: chunkPlan.sha256
      },
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
