#!/usr/bin/env node
// PostToolUse hook on Write|Edit: plan/spec markdown -> reviewer-registry panel
// review (strict AND-pass). Preserves: path filter, revision dedupe lock,
// single-Write revision instruction. ALLOW skip is CONTENT-keyed: only a save
// whose content hash equals the last APPROVED hash skips review. Fails OPEN
// only when ALL reviewers error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { deepKey, parseSeverity } from "./deep-review.mjs";
import { enqueue } from "./deep-queue.mjs";
import { execFileSync } from "node:child_process";
import {
  PLAN_FILE_REVIEW_POLICY_VERSION,
  beginPlanReview,
  completePlanReview,
  planApprovalIdentity,
  planCycleAdvisory,
  readPlanCycle,
  truthy,
  waitForPlanReview
} from "./plan-gate-state.mjs";

const HOOK_KIND = "plan-file-panel";

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

// After a fast ALLOW, ENQUEUE a deep spec-review job for the asyncRewake Stop runner
// (deep-review-runner.mjs). No detached spawn, no inline review — enqueue dedupes by the contentKey
// so an identical re-save doesn't double-queue. Callers may pass either the FULL decoded content or
// a `contentKey` computed by readPlanSnapshot's full streamed decoder; both exactly match
// deep-queue.currentContentKey's recompute and the bytes the deep review evaluates. Never throws.
export function enqueueDeepReview(ws, filePath, content, { sessionKey = null, contentKey = null } = {}) {
  try {
    const enqueued = enqueue(ws, {
      kind: "spec",
      specPath: filePath,
      contentKey: contentKey || deepKey(filePath, content)
    }, { sessionKey });
    return { ok: true, enqueued };
  } catch (e) {
    process.stderr.write(`⛩ plan gate: deep-review enqueue failed (${e instanceof Error ? e.message : String(e)}); fast review stands.\n`);
    return { ok: false, enqueued: false };
  }
}

const MAX_PLAN_BYTES = 64 * 1024;
export const PLAN_PATH_RE = /(^|\/)(plans|specs)\/[^/]*\.md$/i;

function appendTail(chunks, chunk, maxBytes) {
  if (maxBytes <= 0) return;
  chunks.push(chunk);
  let size = chunks.reduce((total, item) => total + item.length, 0);
  while (size > maxBytes && chunks.length) {
    const extra = size - maxBytes;
    if (chunks[0].length <= extra) size -= chunks.shift().length;
    else {
      chunks[0] = chunks[0].subarray(extra);
      size -= extra;
    }
  }
}

// Stream the complete file once. Identity hashes cover every byte, while the fast prompt retains a
// bounded head+tail. The deep content key is computed with the exact same UTF-8 decoding contract as
// deepKey(filePath, fs.readFileSync(filePath, "utf8")), so queue dedupe/retirement stays consistent.
export async function readPlanSnapshot(filePath, { maxBytes = MAX_PLAN_BYTES } = {}) {
  const before = fs.statSync(filePath);
  if (!before.isFile()) throw new Error("plan path is not a regular file");

  const rawHash = createHash("sha256");
  const deepHash = createHash("sha256").update(`${String(filePath)} `);
  const decoder = new StringDecoder("utf8");
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = Math.floor(maxBytes / 2);
  const headChunks = [];
  const tailChunks = [];
  const fullTextChunks = [];
  let headBytes = 0;
  let totalBytes = 0;
  let nonWhitespace = false;
  let keepFullText = true;

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (raw) => {
      const chunk = Buffer.from(raw);
      totalBytes += chunk.length;
      rawHash.update(chunk);

      const decoded = decoder.write(chunk);
      deepHash.update(decoded);
      if (/\S/.test(decoded)) nonWhitespace = true;
      if (keepFullText && totalBytes <= maxBytes) fullTextChunks.push(decoded);
      else keepFullText = false;

      if (headBytes < headLimit) {
        const take = Math.min(headLimit - headBytes, chunk.length);
        if (take) { headChunks.push(chunk.subarray(0, take)); headBytes += take; }
      }
      appendTail(tailChunks, chunk, tailLimit);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });

  const finalText = decoder.end();
  deepHash.update(finalText);
  if (/\S/.test(finalText)) nonWhitespace = true;
  if (keepFullText) fullTextChunks.push(finalText);

  const after = fs.statSync(filePath);
  const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && totalBytes === after.size;
  const sha256 = rawHash.digest("hex");
  const coverageComplete = totalBytes <= maxBytes;
  const text = coverageComplete
    ? fullTextChunks.join("")
    : `${Buffer.concat(headChunks).toString("utf8")}\n\n[... ${totalBytes - maxBytes} bytes omitted from the bounded fast pass; full_sha256=${sha256} ...]\n\n${Buffer.concat(tailChunks).toString("utf8")}`;

  return {
    stable,
    text,
    totalBytes,
    sha256,
    deepContentKey: deepHash.digest("hex").slice(0, 16),
    coverageComplete,
    nonWhitespace,
    before,
    after
  };
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST line on stdout, so a second
// emit (e.g. the shim's failOpen firing after runMain already emitted) is silently dropped. MUST be
// created per runMain invocation — a module-level flag would suppress later invocations in the same
// process and break the suite (H1/A4 pattern — found by the bench's own hunt).
export function createEmitter() {
  let emitted = false;
  return {
    hasEmitted: () => emitted,
    emit(payload) {
      if (emitted) return false;
      emitted = true;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return true;
    }
  };
}

export function buildPrompt(filePath, content, { totalBytes = Buffer.byteLength(String(content ?? "")), sha256 = "", coverageComplete = true } = {}) {
  return {
    system: "You are reviewing an implementation plan/spec document from ONLY the text provided. Do not assume filesystem access. " +
      "Complete ONE exhaustive discovery pass over all provided evidence before deciding, and never stop after the first blocker. Enumerate every verified independent blocking issue from that pass; group sibling manifestations under their shared root cause and do not impose a finding-count cap. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW. " +
      "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
      "Only high/critical issues block the save — medium/low are advisory. " +
      (coverageComplete ? "The complete plan is present." : "The fast pass contains only a bounded head+tail; do not claim the omitted middle was reviewed."),
    user: `<plan_document file="${filePath}" bytes="${totalBytes}" sha256="${sha256}" coverage_complete="${coverageComplete}">\n${content}\n</plan_document>`
  };
}

function readInput() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`⛩ plan-file-review: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
  return input;
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  enqueueDeepReviewImpl = enqueueDeepReview,
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  blockHandler = null
} = {}) {
  // All stdout emits route through this invocation's emit-once guard (H1).
  const emit = (obj) => emitter.emit(obj);
  const failOpen = (note) => emit({ systemMessage: `⛩ plan gate: review skipped — ${String(note).slice(0, 250)}` });

  const input = inputOverride ?? readInput();
  const sessionKey = sessionKeyFromInput(input, env);

  const rawFilePath = String(input.tool_input?.file_path ?? "");
  if (!PLAN_PATH_RE.test(rawFilePath)) return;

  // Resolve a non-absolute file_path against the hook's workspace BEFORE
  // stat/read and before computing the approval-key path context — a relative
  // path is otherwise read against the hook process cwd and silently fails.
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const filePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(cwd, rawFilePath);
  const ws = workspaceRoot(cwd);              // git top-level — matches /bench:off marker + the other gates
  if (isBenchDisabledImpl(ws)) return;

  let snapshot;
  try { snapshot = await readPlanSnapshot(filePath); }
  catch (error) {
    emit({ systemMessage: `⛩ plan gate: UNREVIEWED / coverage incomplete — could not read ${filePath}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
    return;
  }
  if (!snapshot.stable) {
    emit({ systemMessage: "⛩ plan gate: UNREVIEWED / coverage incomplete — the plan changed while it was being streamed; save the complete revision once more." });
    return;
  }
  if (!snapshot.nonWhitespace) return;

  let reviewers;
  try { reviewers = resolveReviewersImpl({ env }); }
  catch (error) {
    failOpen(`reviewer configuration failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const approvalKey = planApprovalIdentity({
    policy: PLAN_FILE_REVIEW_POLICY_VERSION,
    hookKind: HOOK_KIND,
    target: filePath,
    contentDigest: `${snapshot.sha256}:${snapshot.totalBytes}`,
    reviewers
  });

  const requestDeepReview = () => {
    try {
      const result = enqueueDeepReviewImpl(ws, filePath, null, { sessionKey, contentKey: snapshot.deepContentKey });
      return result && typeof result === "object" && "ok" in result ? result : { ok: true, enqueued: Boolean(result) };
    } catch (error) {
      process.stderr.write(`⛩ plan gate: deep-review enqueue failed (${error instanceof Error ? error.message : String(error)}); fast result remains visible.\n`);
      return { ok: false, enqueued: false };
    }
  };

  const emitCompleted = (completed, { joined = false } = {}) => {
    const outcome = completed?.outcome;
    const payload = completed?.payload || {};
    if (outcome === "allow") {
      const deep = requestDeepReview();
      emit({ systemMessage: joined
        ? `⛩ plan gate: exact revision approved by the shared single-flight review; full deep review ${deep.ok ? "queued or already pending" : "could not be queued"}.`
        : (payload.systemMessage || `⛩ plan panel: ALLOW [${payload.badge || "review✓"}] — ${String(payload.summary || "approved").slice(0, 220)}`) });
      return true;
    }
    if (outcome === "coverage-incomplete") {
      const deep = requestDeepReview();
      emit({ systemMessage: `⛩ plan gate: UNREVIEWED / fast coverage incomplete — this exact ${snapshot.totalBytes}-byte revision exceeds the ${MAX_PLAN_BYTES}-byte fast limit; full deep review ${deep.ok ? "queued or already pending" : "could not be queued"}.` });
      return true;
    }
    if (outcome === "block" && joined) {
      emit({ systemMessage:
        `⛩ plan gate: this exact revision was already blocked by the shared exhaustive review (cycle ${Number(payload.cycle) || 1}/3); no duplicate panel or wake was started.\n${String(payload.detail || payload.summary || "").slice(0, 2200)}` });
      return true;
    }
    if (outcome === "advisory") {
      emit({ systemMessage: `⛩ bench plan-file: ${planCycleAdvisory(readPlanCycle(ws, sessionKey)).slice(0, 3500)}` });
      return true;
    }
    if (outcome === "superseded") {
      emit({ systemMessage: "⛩ plan gate: UNREVIEWED — this review was superseded by a newer file revision or cycle reset; its ALLOW/BLOCK result was discarded and no cycle slot was changed." });
      return true;
    }
    if (outcome === "fail-open") {
      failOpen(payload.note || "review panel unavailable");
      return true;
    }
    return false;
  };

  let flight;
  for (;;) {
    flight = beginPlanReview(ws, sessionKey, {
      hookKind: HOOK_KIND,
      target: filePath,
      identity: approvalKey,
      refresh: truthy(env.BENCH_PLAN_REVIEW_REFRESH),
      resetNonce: env.BENCH_PLAN_CYCLE_RESET
    });
    if (flight.role !== "follower") break;
    const joined = await waitForPlanReview(ws, sessionKey, flight.flight);
    if (joined.role === "retry") continue;
    flight = joined;
    break;
  }

  if (flight.role === "cached-allow") {
    const remaining = readPlanCycle(ws, sessionKey);
    if (remaining.exhausted) {
      emit({ systemMessage: `⛩ bench plan-file: ${planCycleAdvisory(remaining).slice(0, 3500)}` });
      return;
    }
    const deep = requestDeepReview();
    emit({ systemMessage: `⛩ plan gate: exact revision already approved by this reviewer/model/policy configuration; full deep review ${deep.ok ? "queued or already pending" : "could not be queued"}.` });
    return;
  }
  if (flight.role === "cached-coverage") {
    const deep = requestDeepReview();
    emit({ systemMessage: `⛩ plan gate: UNREVIEWED / fast coverage incomplete — this exact ${snapshot.totalBytes}-byte revision exceeds the ${MAX_PLAN_BYTES}-byte fast limit; full deep review ${deep.ok ? "queued or already pending" : "could not be queued"}.` });
    return;
  }
  if (flight.role === "exhausted") {
    emit({ systemMessage: `⛩ bench plan-file: ${planCycleAdvisory(flight.cycle.state).slice(0, 3500)}` });
    return;
  }
  if (flight.role === "completed") {
    if (!emitCompleted(flight.result, { joined: true })) {
      emit({ systemMessage: "⛩ plan gate: prior exact review produced no reusable result; save the complete revision once more." });
    }
    return;
  }
  const reviewTicket = flight.ticket;

  const { system, user } = buildPrompt(filePath, snapshot.text, snapshot);
  let results;
  try {
    results = await Promise.all(reviewers.map(async (reviewer) => {
      try { return await reviewer.run({ system, user, cwd: ws, env }); }
      catch (error) {
        return { name: reviewer.name || "reviewer", error: error instanceof Error ? error.message : String(error) };
      }
    }));
  } catch (error) {
    completePlanReview(ws, sessionKey, reviewTicket, {
      status: "fail-open",
      payload: { note: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
  // Severity-gate the plan/spec save: block (rewake) only on HIGH+ findings; medium/low/none
  // are advisory — they allow the save and surface as a note (a design doc never converges to
  // zero, so blocking on every medium nit causes endless churn).
  const panel = combinePanel(results, { blockMinSeverity: "high" });

  try {
    writeTraceImpl(ws, {
      gate: "plan-file",
      ws,
      sessionKey,
      // FIX 3: attach the parsed severity so the statusline can render a sub-threshold
      // plan-file BLOCK as `~` (advisory) rather than `✗` (mirrors spec-review-run's trace).
      reviewers: results.map(({ raw, ...m }) => ({ ...m, severity: parseSeverity(raw, m.verdict) })),
      systemPrompt: system,
      userPrompt: user,
      coverage: { complete: snapshot.coverageComplete, bytes: snapshot.totalBytes, sha256: snapshot.sha256 },
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — but say so on stderr instead of swallowing (D3).
    process.stderr.write(`⛩ plan-file-review: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    const note = `[${panel.badge}] ${panel.summary}`;
    const completed = completePlanReview(ws, sessionKey, reviewTicket, {
      status: "fail-open",
      payload: { note }
    });
    if (!emitCompleted(completed)) failOpen(note);
    return;
  }

  // The reviewer evaluated immutable bytes. Re-read the full identity before committing so a slow
  // ALLOW/BLOCK for revision A cannot mutate state after the file has advanced to revision B, even
  // if B's own hook has not reached its panel yet.
  let currentSnapshot;
  try { currentSnapshot = await readPlanSnapshot(filePath); }
  catch { currentSnapshot = null; }
  if (!currentSnapshot?.stable || currentSnapshot.sha256 !== snapshot.sha256 || currentSnapshot.totalBytes !== snapshot.totalBytes) {
    const completed = completePlanReview(ws, sessionKey, reviewTicket, {
      status: "superseded",
      payload: { reason: "file-revision-changed" }
    });
    emitCompleted(completed);
    return;
  }

  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    const completed = completePlanReview(ws, sessionKey, reviewTicket, {
      status: "block",
      badge: panel.badge,
      findings: detail,
      payload: { badge: panel.badge, detail, summary: panel.summary, skipNotes: panel.skipNotes }
    });
    if (completed.outcome !== "block") {
      emitCompleted(completed);
      return;
    }
    // asyncRewake: write findings to STDERR and exit 2 so the harness WAKES
    // Claude with them (exit-2 blocking feedback is read from stderr, not
    // stdout) instead of blocking the turn.
    const cycle = Number(completed.payload?.cycle) || 1;
    const message = `[${panel.badge}] Exhaustive review pass blocked the plan file ${filePath} (automatic repair cycle ${cycle}/3):\n\n${detail}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address ALL findings, then save it as ONE complete rewrite using a single Write call. Do NOT apply fixes as multiple incremental Edits — each save triggers another background review.`;
    if (blockHandler) {
      await blockHandler({ panel, message, cycle });
      return;
    }
    process.stderr.write(message);
    process.exit(2);
    return;
  }

  const advisoryNote = panel.advisories && panel.advisories.length
    ? ` — advisories (not blocking): ${panel.advisories.join(" · ").slice(0, 220)}`
    : ` — ${panel.summary.slice(0, 220)}`;
  const completed = completePlanReview(ws, sessionKey, reviewTicket, {
    status: snapshot.coverageComplete ? "allow" : "coverage-incomplete",
    payload: {
      badge: panel.badge,
      summary: panel.summary,
      systemMessage: `⛩ plan panel: ALLOW [${panel.badge}]${advisoryNote}`
    }
  });
  if (!["allow", "coverage-incomplete"].includes(completed.outcome)) {
    emitCompleted(completed);
    return;
  }
  const deep = requestDeepReview();

  if (!snapshot.coverageComplete) {
    emit({
      systemMessage:
        `⛩ plan gate: UNREVIEWED / fast coverage incomplete — the file is ${snapshot.totalBytes} bytes and the bounded fast pass covered head+tail only. ` +
        `Full deep review ${deep.ok ? "queued or already pending" : "could not be queued"}; no fast ALLOW marker was recorded.`
    });
    return;
  }
  // Sub-threshold BLOCKs (medium/low) allow the save but surface as advisories, not a block.
  emit({ systemMessage: `⛩ plan panel: ALLOW [${panel.badge}]${advisoryNote}` });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = createEmitter();
  runMain({ emitter }).catch((error) => {
    // Top-level catch → fail OPEN with a visible note. Only emit if runMain hasn't already
    // emitted — a 2nd stdout line would be dropped by the harness (H1). Else log to stderr.
    const msg = error instanceof Error ? error.message : String(error);
    if (!emitter.hasEmitted()) {
      emitter.emit({ systemMessage: `⛩ plan gate: review skipped — ${msg.slice(0, 250)}` });
    } else {
      process.stderr.write(`⛩ plan-file-review: error after emit already done — ${msg}\n`);
    }
  });
}
