#!/usr/bin/env node
// PostToolUse hook on Write|Edit: plan/spec markdown -> reviewer-registry panel
// review (strict AND-pass). Preserves: path filter, revision dedupe lock,
// single-Write revision instruction. ALLOW skip is CONTENT-keyed: only a save
// whose content hash equals the last APPROVED hash skips review. Fails OPEN
// only when ALL reviewers error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { contentHash, isDeepDebounced, markDeepDebounce } from "./deep-review.mjs";
import { execFileSync, spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

// Resolve the bench-runner CLI relative to this hook file (works both in-repo and
// in the deployed ~/.claude/hooks copy, where bench-runner.mjs is alongside).
function resolveBenchRunner() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "scripts", "bench-runner.mjs"),   // in-repo layout
    path.resolve(here, "bench-runner.mjs")                       // deployed alongside the hooks
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ } }
  return candidates[0];
}

// G2/G3 — after a fast ALLOW (NOT a dedup-hit), launch the deep spec-review pass
// detached + unref'd, debounced on the content hash so an identical re-save within
// the interval does not relaunch. Never throws — the fast gate has already allowed.
export function launchDeepReview(ws, filePath, content, { spawnImpl = defaultSpawn, now = Date.now() } = {}) {
  try {
    const hash = contentHash(content);
    if (isDeepDebounced(ws, hash, { now })) return false;   // a deep pass for this exact content ran/launched recently
    markDeepDebounce(ws, hash, { now });
    const runner = resolveBenchRunner();
    const child = spawnImpl(process.execPath, [runner, "spec-review", filePath, "--ws", ws], { detached: true, stdio: "ignore" });
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch (e) {
    process.stderr.write(`⛩ plan gate: deep spec-review launch failed (${e instanceof Error ? e.message : String(e)}); fast review stands.\n`);
    return false;
  }
}

const MAX_PLAN_BYTES = 64 * 1024;
export const PLAN_PATH_RE = /(^|\/)(plans|specs)\/[^/]*\.md$/i;

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

export function buildPrompt(filePath, content) {
  return {
    system: "You are reviewing an implementation plan/spec document from ONLY the text provided. Do not assume filesystem access. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW.",
    user: `<plan_document file="${filePath}">\n${content}\n</plan_document>`
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
  spawnImpl = defaultSpawn,
  input: inputOverride,
  emitter = createEmitter()
} = {}) {
  // All stdout emits route through this invocation's emit-once guard (H1).
  const emit = (obj) => emitter.emit(obj);
  const failOpen = (note) => emit({ systemMessage: `⛩ plan gate: review skipped — ${String(note).slice(0, 250)}` });

  const input = inputOverride ?? readInput();

  const rawFilePath = String(input.tool_input?.file_path ?? "");
  if (!PLAN_PATH_RE.test(rawFilePath)) {
    return;
  }

  // Resolve a non-absolute file_path against the hook's workspace BEFORE
  // stat/read and before computing the approval-key path context — a relative
  // path is otherwise read against the hook process cwd and silently fails.
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const filePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(cwd, rawFilePath);

  let content = "";
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
    content = fs.readFileSync(filePath, "utf8").slice(0, MAX_PLAN_BYTES);
  } catch {
    return;
  }
  if (!content.trim()) {
    return;
  }

  const ws = workspaceRoot(cwd);              // git top-level — matches /bench:off marker + the other gates
  if (isBenchDisabledImpl(ws)) return;         // bench layer disabled — no-op before any lock/review

  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  // Context-complete approval key: identical plan text must NOT skip review
  // when the review CONTEXT differs (different file path/workspace, hook kind,
  // or review policy/prompt version). Bump POLICY_VERSION whenever the review
  // prompt or panel logic changes so all prior approvals re-review.
  const POLICY_VERSION = "2026-06-19.kimi-mimo.1";
  const HOOK_KIND = "plan-file-panel";
  const approvalKey = createHash("sha256")
    .update(POLICY_VERSION).update("\0")
    .update(HOOK_KIND).update("\0")
    .update(filePath).update("\0")
    .update(content)
    .digest("hex");
  const fileKey = createHash("sha1").update(filePath).digest("hex");
  const allowMarker = path.join(locksRoot, `allow-${fileKey}`);

  // ALLOW skip: only an identical approval key (same content AND same context)
  // skips. ANY content change, or a policy/hook/path change, re-reviews.
  try {
    const approved = fs.readFileSync(allowMarker, "utf8").trim();
    if (approved === approvalKey) {
      emit({
        systemMessage: "⛩ plan gate: save not re-reviewed (content identical to the last approved version)."
      });
      return;
    }
  } catch {
    // no marker — proceed
  }

  const lockKey = createHash("sha1").update(`${filePath}|${mtimeMs}`).digest("hex");
  const lockDir = path.join(locksRoot, lockKey);
  const LOCK_TTL_MS = 5 * 60 * 1000;
  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.mkdirSync(lockDir);
  } catch {
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_TTL_MS;
    } catch {
      stale = true;
    }
    if (!stale) {
      return;
    }
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    } catch {
      return;
    }
  }

  const { system, user } = buildPrompt(filePath, content);

  const results = await Promise.all(resolveReviewersImpl().map((r) => r.run({ system, user, cwd: ws })));
  const panel = combinePanel(results);

  try {
    writeTraceImpl(ws, {
      gate: "plan-file",
      ws,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — but say so on stderr instead of swallowing (D3).
    process.stderr.write(`⛩ plan-file-review: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    failOpen(`[${panel.badge}] ${panel.summary}`);
    return;
  }

  if (panel.decision === "block") {
    try {
      fs.rmSync(allowMarker, { force: true });
    } catch {
      // best-effort
    }
    // asyncRewake: write findings to STDERR and exit 2 so the harness WAKES
    // Claude with them (exit-2 blocking feedback is read from stderr, not
    // stdout) instead of blocking the turn.
    process.stderr.write(`[${panel.badge}] Review panel blocked the plan file ${filePath}:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address ALL findings, then save it as ONE complete rewrite using a single Write call. Do NOT apply fixes as multiple incremental Edits — each save triggers another background review.`);
    process.exit(2);
  }

  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.writeFileSync(allowMarker, approvalKey);
  } catch {
    // skip-marker is best-effort
  }
  // G2/G3 — fast ALLOW (and NOT a dedup-hit: that path returned above): launch the
  // detached, debounced deep spec-review against the real repo. Never blocks the save.
  launchDeepReview(ws, filePath, content, { spawnImpl });
  emit({ systemMessage: `⛩ plan panel: ALLOW [${panel.badge}] — ${panel.summary.slice(0, 220)}` });
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
