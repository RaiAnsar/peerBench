#!/usr/bin/env node
// global-hooks/pre-merge-review.mjs
// PreToolUse(Bash) hook: when Claude runs `git merge <ref>` INTO a protected branch, run a FAST
// content-only panel review of the incoming commits BEFORE the merge is allowed.
//
// DESIGN (why this is NOT the deep repo-aware review): the deep push/spec review can take minutes and
// makes Claude look FROZEN — the exact 30–40-min "is it hung?" experience we're avoiding. So this gate:
//   • is content-only (embed immutable per-commit patches, no repo exploration) → fast (~10-30s),
//   • has a HARD wall-clock cap and FAILS OPEN (allows the merge) on timeout/error → can never hang or wedge a merge,
//   • is VISIBLE — the deploy registers a statusMessage, and every block emits a user-visible systemMessage,
//   • ALSO enqueues a DEEP async panel review (delivered by the deep-review-runner via the rewake, non-blocking)
//     so the thorough pass still happens without you waiting on it.
// A merge is local — a bad merge caught after the fact (deep review / push gate) is fixed forward before it leaves.
//
// Deploy-parity: deployed FLAT in ~/.claude/hooks/ — imports ONLY global-hooks siblings.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput, workspaceStateDir } from "./config-store.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { shellSegments, shellTokenize, gitCommandIndex, commandCwd, createEmitter } from "./pre-push-review.mjs";
import { deepKey } from "./deep-review.mjs";
import { enqueue as defaultEnqueue } from "./deep-queue.mjs";
import { reviewerPanelIdentity, sha256, truthy } from "./plan-gate-state.mjs";

const DEFAULT_MERGE_GATE_BUDGET_MS = 90_000;   // hard cap → the gate can never hang (env-tunable per invocation)
const MAX_MERGE_BLOCK_CYCLES = 3;
const MAX_MERGE_COMMIT_BYTES = 24 * 1024;
const MAX_MERGE_HISTORY_BYTES = 150 * 1024;
const MAX_MERGE_PROMPT_BYTES = 200 * 1024;
const MIN_MERGE_IDENTITY_LOCK_STALE_MS = 10 * 60 * 1000;
// Bump whenever evidence semantics change: the version is part of the exact ALLOW identity, so an
// older clean marker can never survive a stronger object/history inspection contract.
export const MERGE_REVIEW_POLICY_VERSION = "merge-review-v5-exhaustive-cycle3-immutable-raw-history-no-grafts";
// Only gate merges INTO these branches (releasing into main/etc.). Routine "merge main into my feature"
// (current branch not protected) is never gated. Tunable via BENCH_PROTECTED_BRANCHES (comma-separated).
function protectedBranches(env) {
  return (env.BENCH_PROTECTED_BRANCHES || "main,master,production,prod,release,staging")
    .split(",").map((s) => s.trim()).filter(Boolean);
}
// git global options that take a SEPARATE value token (skip the value when scanning for `merge`).
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
// `git merge` options that take a SEPARATE value token — so `-m "msg" staging` yields ref "staging",
// not "msg". Only DEFINITE value-flags (optional-arg flags like -S are left alone to avoid eating a ref).
const MERGE_VALUE_FLAGS = new Set(["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "--into-name", "--cleanup"]);

// Detect `git merge <ref...>` in a shell segment (allow leading env assignments + git global opts).
// Excludes --abort/--continue/--quit (not a NEW merge) and --help. Returns { refs, redirected } or null.
// `redirected` marks repo redirection (`GIT_DIR=/x git merge y`, `git --git-dir=/x merge y`): the gate
// resolves the workspace from the command cwd, so such a merge would be reviewed against the WRONG
// repository — the caller must say UNREVIEWED instead of silently gating the wrong repo.
export function parseMergeSegment(text) {
  const toks = shellTokenize(text).filter(Boolean);
  // COMMAND-position git only (shared rule): `echo git merge x` is not a merge — with escape
  // normalization a fake `echo g\it merge bad-ref` segment could shadow the REAL octopus merge in
  // the next segment and fail the gate open through the unresolvable ref (a stop-gate catch).
  let i = gitCommandIndex(toks);
  if (i < 0) return null;
  const envRedirect = toks.slice(0, i).some((t) => /^GIT_DIR=/.test(t));
  i++;
  let optRedirect = false;
  while (i < toks.length && toks[i].startsWith("-")) {
    const t = toks[i];
    if (t === "--git-dir" || t.startsWith("--git-dir=")) optRedirect = true;
    i++;
    if (GIT_VALUE_OPTS.has(t)) i++;
  }
  if (toks[i] !== "merge") return null;
  const rest = toks.slice(i + 1);
  if (rest.some((t) => ["--help", "-h", "--abort", "--continue", "--quit"].includes(t))) return null;
  // Redirects and control operators are already stripped by shellTokenize (the lexer removes them
  // exactly as the shell does — `git merge a 2>/dev/null b` → [a, b]; `feature>/dev/null` → the
  // ref `feature`), so every remaining token is a real git argv word.
  const refs = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t.startsWith("-")) { if (MERGE_VALUE_FLAGS.has(t)) j++; continue; }   // skip a value-flag's value token
    refs.push(t);
  }
  return { refs, redirected: envRedirect || optRedirect };
}

// EVERY real git merge segment of the compound command, combined into one ref set: gating only the
// FIRST match let `git merge innocent && git merge blocked-branch` skip the second merge's fast
// review AND its deep-review enqueue — a deterministic bypass of an active deny. A ref-less segment
// merges the upstream (@{u}). Also handles a subshell-wrapped `(git merge x)`.
export function findMergeSegment(command) {
  let refs = null;
  let redirected = false;
  for (const s of shellSegments(command)) {
    let m = parseMergeSegment(s.text);
    if (!m) {
      const stripped = s.text.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
      if (stripped !== s.text) m = parseMergeSegment(stripped);
    }
    if (!m) continue;
    refs = (refs || []).concat(m.refs.length ? m.refs : ["@{u}"]);
    redirected = redirected || m.redirected;
  }
  return refs ? { refs, redirected } : null;
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ pre-merge: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

function immutableGitEnv(env = process.env) {
  return { ...(env || process.env), GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull };
}

function immutableGitArgs(args) {
  return [
    "--no-replace-objects",
    "-c", "advice.graftFileDeprecated=false",
    ...args.filter((arg) => arg !== "--no-replace-objects")
  ];
}

function workspaceRoot(cwd, env = process.env) {
  try {
    return execFileSync("git", immutableGitArgs(["rev-parse", "--show-toplevel"]), {
      cwd,
      encoding: "utf8",
      env: immutableGitEnv(env)
    }).trim();
  }
  catch { return cwd; }
}

function gitTry(args, cwd, env = process.env) {
  try { return [execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env }).trim(), true]; }
  catch { return ["", false]; }
}

// Replacement refs and legacy grafts are local presentation layers, not part of the immutable
// commits about to be merged. Honoring either lets local configuration rewrite the parent graph or
// substitute clean content while the real ref SHA stays unchanged and becomes cache-eligible. Every
// object/history read therefore disables replace objects in argv+env and points GIT_GRAFT_FILE at
// the platform null device. The caller-provided env is preserved only for ordinary Git settings.
function immutableGitTry(args, cwd, env = process.env) {
  return gitTry(immutableGitArgs(args), cwd, immutableGitEnv(env));
}

// Stream potentially huge Git output so the old execFileSync 64 MiB ceiling can never turn a real
// diff into an empty string. We hash the COMPLETE stdout while retaining only a bounded prefix for
// the fast content-only prompt. A caller must treat complete:false as UNREVIEWED, never as ALLOW.
export function captureGitBounded(args, cwd, { maxBytes, timeoutMs = 30_000, env = process.env } = {}) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const chunks = [];
    const stderrChunks = [];
    let kept = 0;
    let stderrKept = 0;
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn("git", immutableGitArgs(args), {
        cwd,
        env: immutableGitEnv(env),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ ok: false, complete: false, text: "", totalBytes: 0, sha256: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); }
        catch (error) {
          finish({ ok: false, complete: false, text: "", totalBytes, sha256: null, error: `git capture timed out and could not be stopped (${error instanceof Error ? error.message : String(error)})` });
        }
      }, Number(timeoutMs));
    }
    child.stdout.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      hash.update(chunk);
      totalBytes += chunk.length;
      if (kept < limit) {
        const slice = chunk.subarray(0, limit - kept);
        chunks.push(slice);
        kept += slice.length;
      }
    });
    child.stderr.on("data", (raw) => {
      if (stderrKept >= 8 * 1024) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const slice = chunk.subarray(0, 8 * 1024 - stderrKept);
      stderrChunks.push(slice);
      stderrKept += slice.length;
    });
    child.once("error", (error) => {
      finish({ ok: false, complete: false, text: "", totalBytes, sha256: null, error: error instanceof Error ? error.message : String(error) });
    });
    child.once("close", (code, signal) => {
      const digest = hash.digest("hex");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      finish({
        ok: !timedOut && code === 0,
        complete: !timedOut && code === 0 && totalBytes <= limit,
        text: Buffer.concat(chunks).toString("utf8").trim(),
        totalBytes,
        sha256: digest,
        error: timedOut ? `git capture timed out after ${Number(timeoutMs)}ms` : (code === 0 ? null : (stderr || `git exited ${code ?? signal ?? "unknown"}`))
      });
    });
  });
}

function mergeStateRoot(ws) {
  return path.join(workspaceStateDir(ws), "merge-gate");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* parent may enforce permissions */ }
  return dir;
}

function safeReadJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function writeJsonAtomic(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function mergeSessionSlug(sessionKey) {
  return String(sessionKey || "session-unscoped").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function mergeCycleDir(ws, sessionKey, generation = "base") {
  const session = mergeSessionSlug(sessionKey);
  const safeGeneration = String(generation || "base").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(mergeStateRoot(ws), `cycle-${session}-${safeGeneration}`);
}

function resetMarkerPath(ws, sessionKey) {
  return path.join(mergeStateRoot(ws), "cycle-active", `${mergeSessionSlug(sessionKey)}.json`);
}

function resetNonce(value) {
  const raw = String(value ?? "").trim();
  return !raw || ["0", "false", "no", "off"].includes(raw.toLowerCase()) ? null : raw;
}

// A reset is a durable one-shot nonce, not a boolean applied on every invocation. Leaving
// BENCH_MERGE_CYCLE_RESET=1 exported therefore changes generation once; setting a NEW nonce (for
// example a timestamp) intentionally starts another fresh cycle. Old unresolved ledgers remain on
// disk and never age into a fresh allowance by themselves.
function resolveMergeCycleGeneration(ws, sessionKey, resetValue) {
  const file = resetMarkerPath(ws, sessionKey);
  const marker = safeReadJson(file);
  const currentGeneration = String(marker?.generation || "base");
  const nonce = resetNonce(resetValue);
  if (!nonce) return { generation: currentGeneration, resetApplied: false };
  const tokenHash = sha256(nonce);
  if (marker?.tokenHash === tokenHash) return { generation: currentGeneration, resetApplied: false };
  const generation = tokenHash.slice(0, 32);
  writeJsonAtomic(file, { schema: 1, tokenHash, generation, ts: Date.now() });
  return { generation, resetApplied: true };
}

export function readMergeCycle(ws, sessionKey, { generation = "base" } = {}) {
  const dir = mergeCycleDir(ws, sessionKey, generation);
  const records = [];
  for (let index = 1; index <= MAX_MERGE_BLOCK_CYCLES; index++) {
    const file = path.join(dir, `block-${index}.json`);
    const record = safeReadJson(file);
    if (record) {
      records.push(record);
      continue;
    }
    // A corrupt slot must still count toward the hard ceiling; ignoring it lets repeated hook
    // crashes buy unlimited repairs. Its mtime preserves a useful diagnostic timestamp.
    try {
      const stat = fs.statSync(file);
      records.push({ schema: 0, ts: stat.mtimeMs, findings: `Cycle ${index} state was unreadable and was counted conservatively.` });
    } catch { /* slot is absent */ }
  }
  const startedAt = records.length ? Math.min(...records.map((record) => Number(record.ts) || Date.now())) : null;
  return { count: records.length, exhausted: records.length >= MAX_MERGE_BLOCK_CYCLES, records, startedAt };
}

function recordMergeBlock(ws, sessionKey, { revision, target, badge, findings, generation = "base", now = Date.now() }) {
  const dir = ensurePrivateDir(mergeCycleDir(ws, sessionKey, generation));
  const record = {
    schema: 1,
    ts: now,
    revision: String(revision || ""),
    target: String(target || "unknown merge"),
    badge: String(badge || ""),
    findings: String(findings || "blocking finding recorded").slice(0, 24_000)
  };
  for (let index = 1; index <= MAX_MERGE_BLOCK_CYCLES; index++) {
    const file = path.join(dir, `block-${index}.json`);
    try {
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { index, record };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  return null;
}

function mergeCycleAdvisory(state) {
  const prior = (state?.records || []).map((record, index) =>
    `Cycle ${index + 1}${record.badge ? ` [${record.badge}]` : ""}: ${String(record.findings || "blocking finding recorded").slice(0, 1200)}`
  ).join("\n\n");
  return (
    `UNREVIEWED — automatic pre-merge review paused after ${MAX_MERGE_BLOCK_CYCLES} blocked repair cycles in this task/session window. ` +
    "This merge target was not re-validated and no further automatic merge denial will run in this window; the native pre-push gate remains authoritative. " +
    "Start a new task/session, or set BENCH_MERGE_CYCLE_RESET to a new one-shot nonce for one explicit fresh cycle." +
    (prior ? `\n\nPrior unresolved findings:\n${prior}` : "")
  );
}

function mergeApprovalIdentity({ branch, headSha, incoming, reviewers }) {
  return sha256(JSON.stringify({
    schema: 4,
    policy: MERGE_REVIEW_POLICY_VERSION,
    severityPolicy: "block-high-critical",
    branch,
    headSha,
    incoming: incoming.map((item) => ({ refSha: item.refSha, range: item.range })).sort((a, b) => a.range.localeCompare(b.range)),
    reviewers: reviewerPanelIdentity(reviewers)
  }));
}

function mergeCachePath(ws, identity) {
  return path.join(mergeStateRoot(ws), "allow-cache", `${identity}.json`);
}

function mergeBlockedIdentityPath(ws, identity) {
  return path.join(mergeStateRoot(ws), "blocked-identities", `${identity}.json`);
}

function mergeIdentityLockDir(ws, identity) {
  return path.join(mergeStateRoot(ws), "identity-locks", `${identity}.lock`);
}

// The fast gate is fail-open, so a duplicate invocation must never wait behind a potentially slow
// provider. An atomic directory lease instead guarantees only one panel can decide a given immutable
// identity at a time; contenders report UNREVIEWED and the native push gate remains authoritative.
// A crashed owner can be reclaimed only after a deliberately generous multiple of the gate budget.
function acquireMergeIdentityLock(ws, identity, { now = Date.now(), staleMs = MIN_MERGE_IDENTITY_LOCK_STALE_MS } = {}) {
  const dir = mergeIdentityLockDir(ws, identity);
  ensurePrivateDir(path.dirname(dir));
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}-${now}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created = true;
      fs.writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({ schema: 1, token, pid: process.pid, ts: now })}\n`, { mode: 0o600 });
      return { dir, token };
    } catch (error) {
      if (created) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort rollback of a half-created lease */ }
      }
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = now - fs.statSync(dir).mtimeMs > staleMs; }
      catch { /* another owner may be creating or releasing the lease */ }
      if (!stale || attempt > 0) return null;
      const retired = `${dir}.stale-${token}`;
      try {
        fs.renameSync(dir, retired);
        fs.rmSync(retired, { recursive: true, force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

function releaseMergeIdentityLock(lock) {
  if (!lock) return;
  try {
    const owner = safeReadJson(path.join(lock.dir, "owner.json"));
    if (owner?.token !== lock.token) return;
    fs.unlinkSync(path.join(lock.dir, "owner.json"));
    fs.rmdirSync(lock.dir);
  } catch { /* a reclaimed/externally removed lease is already released */ }
}

function isMergeIdentityBlocked(ws, identity) {
  const marker = safeReadJson(mergeBlockedIdentityPath(ws, identity));
  return marker?.schema === 1 && marker?.status === "block" && marker?.identity === identity;
}

// BLOCK is monotonic for one immutable identity. A later ALLOW can permit that one local attempt,
// but it may not create a reusable clean cache for bytes that a complete panel already blocked.
// Fixing the findings changes the incoming commit SHA and therefore creates a new identity.
function markMergeIdentityBlocked(ws, identity, marker) {
  writeJsonAtomic(mergeBlockedIdentityPath(ws, identity), {
    schema: 1,
    status: "block",
    identity,
    ts: Date.now(),
    ...marker
  });
  try { fs.unlinkSync(mergeCachePath(ws, identity)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function readMergeAllow(ws, identity) {
  if (isMergeIdentityBlocked(ws, identity)) return null;
  const marker = safeReadJson(mergeCachePath(ws, identity));
  return marker?.schema === 1 && marker?.status === "allow" && marker?.identity === identity ? marker : null;
}

function writeMergeAllow(ws, identity, marker) {
  if (isMergeIdentityBlocked(ws, identity)) return false;
  writeJsonAtomic(mergeCachePath(ws, identity), { schema: 1, status: "allow", identity, ts: Date.now(), ...marker });
  return true;
}

export function buildMergePrompt(incoming) {
  const system =
    "You are reviewing commits about to be merged, using ONLY the complete immutable per-commit evidence in this message. Do not use tools or explore the filesystem. " +
    "Complete ONE exhaustive discovery pass before deciding and never stop after the first blocker. Enumerate every verified independent blocking issue found in that pass, group sibling manifestations under their shared root cause, and impose no finding-count cap. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for a concrete bug, regression, security issue, or unsafe change that must be fixed before merge; otherwise ALLOW. " +
    "Then output `SEVERITY: none|low|medium|high|critical` on its own line. Only high/critical issues block; low/medium notes are advisory.";
  const sections = incoming.map((item) => [
    `## Incoming refs: ${item.refs.join(", ")}`,
    `Immutable range: ${item.range}`,
    `Commit count: ${item.commitCount}`,
    `Commit-summary SHA-256: ${item.commitsEvidence.sha256}`,
    item.commitsEvidence.text || "(no commit subjects)",
    "",
    `Complete per-commit raw patch history SHA-256: ${item.historyEvidence.sha256}`,
    item.historyEvidence.text || "(no per-commit patch output)"
  ].join("\n"));
  return { system, user: `<incoming-merge-evidence>\n${sections.join("\n\n")}\n</incoming-merge-evidence>` };
}

function decisionPayload(permissionDecision, reason, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  enqueueImpl = defaultEnqueue,
  captureGitImpl = captureGitBounded,
  nowImpl = () => Date.now(),
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  exit = (code) => process.exit(code)
} = {}) {
  const decision = (d, reason, systemMessage) => emitter.emit(decisionPayload(d, reason, systemMessage));

  const input = inputOverride ?? readInput();
  const command = String(input.tool_input?.command ?? "");

  // 1. Only act on a real `git merge` (not --abort/--continue, not another git command).
  const merge = findMergeSegment(command);
  if (!merge) return;   // silent allow

  const ws = workspaceRoot(commandCwd(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()), env);
  if (isBenchDisabledImpl(ws)) return exit(0);

  // A merge whose repository is redirected away from the command cwd (`git --git-dir=/x merge y`,
  // `GIT_DIR=/x git merge y`) cannot be gated from here: every gate Git op and the state dir would
  // target the WRONG repo. Say UNREVIEWED visibly instead of silently reviewing the wrong repository.
  if (merge.redirected) {
    decision(
      "allow",
      "UNREVIEWED — pre-merge gate cannot review a merge whose repository is redirected by --git-dir/GIT_DIR; merge allowed locally and the native pre-push gate remains authoritative.",
      "⛩ bench merge: UNREVIEWED — repository redirected via --git-dir/GIT_DIR; native push gate remains authoritative."
    );
    return;
  }

  // 2. Only gate merges INTO a protected branch (the "releasing into main" moment).
  const [branch, branchOk] = immutableGitTry(["rev-parse", "--abbrev-ref", "HEAD"], ws, env);
  if (!branchOk || !branch) {
    decision("allow", "UNREVIEWED — pre-merge gate could not determine the current branch; merge allowed locally and the native pre-push gate remains authoritative.", "⛩ bench merge: UNREVIEWED — current branch could not be resolved; native push gate remains authoritative.");
    return;
  }
  if (!protectedBranches(env).includes(branch)) return;   // silent allow — routine feature-branch merge

  const sessionKey = sessionKeyFromInput(input, env);

  // 3. Incoming commits per ref. `git merge` with no ref merges the upstream (@{u}); an octopus
  // merge (`git merge a b`) — and EVERY merge segment of a compound command — lists several refs, so
  // EVERY ref's commits are incoming and every ref is gathered (reviewing only refs[0] let the rest
  // bypass the gate — a push-gate catch). Ranges are
  // pinned to SHAs (`<headSha>..<refSha>`), never symbolic `HEAD..ref`: the queued deep review runs
  // AFTER the merge advances HEAD, where a symbolic range is empty (ff) or wrong (non-ff).
  const refNames = [...new Set(merge.refs)];
  const refsLabel = refNames.join(", ");
  const [headSha, headOk] = immutableGitTry(["rev-parse", "--verify", "HEAD^{commit}"], ws, env);
  if (!headOk || !headSha) {
    decision("allow", `UNREVIEWED — pre-merge gate could not resolve HEAD while inspecting ${refsLabel}; merge allowed locally and the native pre-push gate remains authoritative.`, `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — HEAD could not be resolved.`);
    return;
  }
  const incomingByRange = new Map();
  for (const ref of refNames) {
    // Peel annotated tags to the commit Git would merge. This makes the identity immutable and avoids
    // reviewing the tag object while silently missing its target commit.
    const [refSha, refOk] = immutableGitTry(["rev-parse", "--verify", `${ref}^{commit}`], ws, env);
    if (!refOk || !refSha) {
      decision("allow", `UNREVIEWED — pre-merge gate could not resolve incoming ref ${ref}; merge allowed locally and the native pre-push gate remains authoritative.`, `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — ${ref} could not be inspected.`);
      return;
    }
    const range = `${headSha}..${refSha}`;
    const existing = incomingByRange.get(range);
    if (existing) {
      existing.refs.push(ref);
      continue;
    }
    const [countRaw, countOk] = immutableGitTry(["rev-list", "--count", range], ws, env);
    if (!countOk || !/^\d+$/.test(countRaw)) {
      decision("allow", `UNREVIEWED — pre-merge gate could not enumerate ${range} for ${ref}; merge allowed locally and the native pre-push gate remains authoritative.`, `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — incoming commits could not be enumerated.`);
      return;
    }
    const commitCount = Number(countRaw);
    if (commitCount > 0) incomingByRange.set(range, { refs: [ref], refSha, range, commitCount });
  }
  const incoming = [...incomingByRange.values()].sort((a, b) => a.range.localeCompare(b.range));
  if (!incoming.length) { decision("allow", `⛩ bench merge: nothing to merge from ${refsLabel} into ${branch} (up to date).`); return; }

  let reviewers = null;
  let reviewerResolveError = null;
  try { reviewers = resolveReviewersImpl({ env }); }
  catch (error) { reviewerResolveError = error instanceof Error ? error.message : String(error); }
  const hasReviewers = Array.isArray(reviewers) && reviewers.length > 0;
  const approvalIdentity = hasReviewers ? mergeApprovalIdentity({ branch, headSha, incoming, reviewers }) : null;

  let identityLock = null;
  if (approvalIdentity) {
    const configuredBudgetMs = Number(env.BENCH_MERGE_GATE_BUDGET_MS) || DEFAULT_MERGE_GATE_BUDGET_MS;
    try {
      identityLock = acquireMergeIdentityLock(ws, approvalIdentity, {
        staleMs: Math.max(MIN_MERGE_IDENTITY_LOCK_STALE_MS, configuredBudgetMs * 3)
      });
    } catch (error) {
      decision(
        "allow",
        `UNREVIEWED — pre-merge identity coordination failed (${error instanceof Error ? error.message : String(error)}); merge allowed locally and the native pre-push gate remains authoritative.`,
        `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — identity coordination unavailable.`
      );
      return;
    }
    if (!identityLock) {
      decision(
        "allow",
        "UNREVIEWED — an identical immutable pre-merge review is already in progress. This duplicate did not run or cache a competing panel; merge allowed locally and the native pre-push gate remains authoritative.",
        `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — identical review already in progress.`
      );
      return;
    }
  }

  try {
  // Exact-cache, cycle-generation, review, and final outcome now share the per-identity lease. This
  // prevents a delayed ALLOW from racing an identical BLOCK into a reusable false-clean marker.
  const cycleContext = resolveMergeCycleGeneration(ws, sessionKey, env.BENCH_MERGE_CYCLE_RESET);
  const cycleReset = cycleContext.resetApplied;
  const cycle = readMergeCycle(ws, sessionKey, { generation: cycleContext.generation });
  const refresh = cycleReset || truthy(env.BENCH_MERGE_REVIEW_REFRESH);
  const cached = (!refresh && approvalIdentity) ? readMergeAllow(ws, approvalIdentity) : null;
  if (cached) {
    decision(
      "allow",
      `⛩ bench merge: cached exact ALLOW [${cached.badge || "merge-review"}] for the unchanged immutable incoming range set and reviewer/model/policy configuration. ${cached.summary || "Review passed."}`,
      `⛩ bench merge: ALLOW (cached exact ranges) [${cached.badge || "merge-review"}] — ${String(cached.summary || "review passed").slice(0, 180)}`
    );
    return;
  }

  // 4. Enqueue the DEEP async reviews FIRST (best-effort), one per UNIQUE immutable range — delivered by the
  // deep-review-runner via the visible rewake, non-blocking, so the thorough repo-aware pass happens
  // even if the fast gate below times out or crashes, and even when the repair-cycle ceiling pauses
  // the fast gate (an exhausted cycle must not leave a changed target with zero async coverage).
  // kind:"merge" (not "push"): the runner reviews
  // it through the same range machinery, but its durable-block identity is recomputed as
  // `merge:<range>` (deep-queue currentContentKey) — reusing kind:"push" made every recompute
  // `push:<range>`-keyed, so a durable merge block was always "changed" and retired at the next Stop.
  for (const i of incoming) {
    try {
      enqueueImpl(ws, { kind: "merge", range: i.range, contentKey: deepKey(`merge:${i.range}`, i.refSha) }, { sessionKey });
    } catch (e) {
      process.stderr.write(`⛩ pre-merge: deep review enqueue failed for ${i.refs.join(", ")} (${e instanceof Error ? e.message : String(e)}); fast gate stands.\n`);
    }
  }

  // A completed immutable ALLOW above is always safe to replay without spending another cycle. For
  // every not-yet-approved target, however, the task/session ceiling is absolute and non-waking.
  if (cycle.exhausted) {
    const advisory = mergeCycleAdvisory(cycle);
    decision("allow", advisory, `⛩ bench merge: ${advisory.slice(0, 1800)}`);
    return;
  }

  if (reviewerResolveError) {
    decision("allow", `UNREVIEWED — pre-merge reviewer panel could not be resolved (${reviewerResolveError}); merge allowed locally, deep review queued, and the native pre-push gate remains authoritative.`, `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — reviewer panel unavailable.`);
    return;
  }
  if (!hasReviewers) {
    decision("allow", "UNREVIEWED — no pre-merge reviewers are configured; merge allowed locally, deep review queued, and the native pre-push gate remains authoritative.", `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — no reviewers configured.`);
    return;
  }

  // 5. Stream and hash every unique octopus range. The second stream is the COMPLETE PER-COMMIT
  // patch history, not only the final tree diff: a commit that adds a credential/backdoor and a
  // later commit removes it is still shipped in Git history and must be visible to review. All
  // object reads bypass refs/replace; patch output disables external diff/textconv and forces raw
  // text so a committed `.gitattributes -diff` rule cannot collapse malicious content to
  // "Binary files differ". The gate only runs when EVERY byte fits its bounded prompt; otherwise
  // it says UNREVIEWED visibly and relies on deep/native push.
  const budgetMs = Number(env.BENCH_MERGE_GATE_BUDGET_MS) || DEFAULT_MERGE_GATE_BUDGET_MS;
  const gateDeadline = Date.now() + budgetMs;
  let commitBytesLeft = MAX_MERGE_COMMIT_BYTES;
  let historyBytesLeft = MAX_MERGE_HISTORY_BYTES;
  const coverageProblems = [];
  for (const item of incoming) {
    let remainingMs = gateDeadline - Date.now();
    if (remainingMs <= 0) {
      coverageProblems.push(`${item.refs.join("/")} evidence was not streamed before the ${budgetMs}ms overall merge-gate deadline`);
      continue;
    }
    item.commitsEvidence = await captureGitImpl([
      "--no-replace-objects",
      "log",
      "--format=%H %P %s",
      "--no-decorate",
      "--no-show-signature",
      item.range
    ], ws, { maxBytes: commitBytesLeft, timeoutMs: remainingMs, env: immutableGitEnv(env) });
    commitBytesLeft = Math.max(0, commitBytesLeft - Math.min(commitBytesLeft, Number(item.commitsEvidence.totalBytes) || 0));
    remainingMs = gateDeadline - Date.now();
    if (remainingMs <= 0) {
      coverageProblems.push(`${item.refs.join("/")} per-commit patch history was not streamed before the ${budgetMs}ms overall merge-gate deadline`);
      continue;
    }
    item.historyEvidence = await captureGitImpl([
      "--no-replace-objects",
      "log",
      "--format=fuller",
      "--date=iso-strict",
      "--no-decorate",
      "--no-color",
      "--no-show-signature",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--full-diff",
      "--full-index",
      "--no-renames",
      "--ignore-submodules=none",
      "-m",
      "-p",
      item.range
    ], ws, { maxBytes: historyBytesLeft, timeoutMs: remainingMs, env: immutableGitEnv(env) });
    historyBytesLeft = Math.max(0, historyBytesLeft - Math.min(historyBytesLeft, Number(item.historyEvidence.totalBytes) || 0));
    for (const [kind, evidence] of [["commit summary", item.commitsEvidence], ["per-commit raw patch history", item.historyEvidence]]) {
      if (!evidence?.ok) {
        coverageProblems.push(`${item.refs.join("/")} ${kind} failed (${evidence?.error || "unknown Git error"})`);
      } else if (!evidence.complete) {
        coverageProblems.push(`${item.refs.join("/")} ${kind} is ${evidence.totalBytes} bytes (sha256 ${evidence.sha256}); bounded fast evidence is incomplete`);
      }
    }
  }
  if (coverageProblems.length) {
    const detail = coverageProblems.join("; ");
    decision(
      "allow",
      `UNREVIEWED / coverage incomplete — ${detail}. No clean pre-merge verdict was recorded. Merge allowed locally; a deep review is queued and the native pre-push gate remains authoritative.`,
      `⛩ bench merge: UNREVIEWED / coverage incomplete (${refsLabel} → ${branch}) — ${detail.slice(0, 1200)}`
    );
    return;
  }

  const { system, user } = buildMergePrompt(incoming);
  if (Buffer.byteLength(system) + Buffer.byteLength(user) > MAX_MERGE_PROMPT_BYTES) {
    decision(
      "allow",
      `UNREVIEWED / coverage incomplete — complete merge evidence and immutable range metadata exceed the ${MAX_MERGE_PROMPT_BYTES}-byte fast-review prompt budget. No clean verdict was recorded. Merge allowed locally; a deep review is queued and the native pre-push gate remains authoritative.`,
      `⛩ bench merge: UNREVIEWED / coverage incomplete (${refsLabel} → ${branch}) — prompt budget exceeded.`
    );
    return;
  }

  // Fast content-only review, HARD-capped. On timeout/error → FAIL OPEN (deep review already queued;
  // the native push gate is the hard stop). This guarantees a merge never leaves Claude looking hung.
  const reviewBudgetMs = gateDeadline - Date.now();
  if (reviewBudgetMs <= 0) {
    decision(
      "allow",
      `UNREVIEWED — complete evidence collection consumed the ${budgetMs}ms overall merge-gate budget; merge allowed locally, a deep review is queued, and the native pre-push gate remains authoritative.`,
      `⛩ bench merge: UNREVIEWED (${refsLabel} → ${branch}) — overall fast-review deadline reached.`
    );
    return;
  }
  let results = null;
  let budgetTimer = null;
  try {
    const reviewPromise = Promise.all(reviewers.map(async (reviewer) => {
      try { return await reviewer.run({ system, user, cwd: ws, env }); }
      catch (error) { return { name: reviewer.name || "reviewer", error: error instanceof Error ? error.message : String(error) }; }
    }));
    const timeout = new Promise((resolve) => { budgetTimer = setTimeout(() => resolve("TIMEOUT"), reviewBudgetMs); });
    results = await Promise.race([reviewPromise, timeout]);
  } catch {
    results = null;
  } finally {
    // Clear the budget timer the instant the panel returns — a pending setTimeout keeps the hook process
    // alive for the whole budget, freezing a fast merge for ~90s (same class of bug the Codex gate caught
    // on the push gate). The timeout branch already fired the timer and exit(0)s below on the dangling promise.
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (results === "TIMEOUT" || results === null || !Array.isArray(results)) {
    decision(
      "allow",
      `UNREVIEWED — fast merge review didn't finish in ${(budgetMs / 1000) | 0}s; merge allowed locally, a deep review is queued, and the native pre-push gate remains authoritative. Run \`/bench:review ${incoming[0].range}\` for a full pass.`,
      `⛩ bench merge: UNREVIEWED — fast review timed out (${refsLabel} → ${branch}); deep/native push review remains.`
    );
    // process.exit() does not run JavaScript finally blocks. Release explicitly before the hard
    // exit so a timed-out provider cannot leave every identical merge UNREVIEWED for the stale TTL.
    releaseMergeIdentityLock(identityLock);
    identityLock = null;
    return exit(0);   // don't linger on a dangling reviewer promise
  }

  const panel = combinePanel(results, { blockMinSeverity: "high" });
  try {
    writeTraceImpl(ws, {
      gate: "merge-review", ws, sessionKey,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null })),
      systemPrompt: system, userPrompt: user.slice(0, 2000),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || r.error || ""]))
    });
  } catch (e) {
    process.stderr.write(`⛩ pre-merge: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    decision(
      "allow",
      `UNREVIEWED — merge panel unavailable (${panel.summary}); merge allowed locally, a deep review is queued, and the native pre-push gate remains authoritative.`,
      `⛩ bench merge: UNREVIEWED [${panel.badge}] (${refsLabel} → ${branch}) — ${String(panel.summary || "panel unavailable").slice(0, 220)}`
    );
    return;
  }

  // 6. Decision — high/critical blocks; lower severity is advisory (shared threshold with plan/spec).
  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    try {
      markMergeIdentityBlocked(ws, approvalIdentity, {
        badge: panel.badge,
        findings: detail.slice(0, 24_000)
      });
    } catch (error) {
      process.stderr.write(`⛩ pre-merge: blocked-identity marker write failed (${error instanceof Error ? error.message : String(error)}); current BLOCK still stands.\n`);
    }
    const slot = recordMergeBlock(ws, sessionKey, {
      revision: approvalIdentity,
      target: `${refsLabel} → ${branch}`,
      badge: panel.badge,
      findings: detail,
      generation: cycleContext.generation,
      now: nowImpl()
    });
    if (!slot) {
      const advisory = mergeCycleAdvisory(readMergeCycle(ws, sessionKey, { generation: cycleContext.generation }));
      decision("allow", advisory, `⛩ bench merge: ${advisory.slice(0, 1800)}`);
      return;
    }
    decision(
      "deny",
      `[${panel.badge}] Exhaustive pre-merge review found issues that should be fixed before merging ${refsLabel} into ${branch} (automatic repair cycle ${slot.index}/${MAX_MERGE_BLOCK_CYCLES}):\n\n${detail}\n\nAddress ALL grouped findings in one repair, then run git merge again.`,
      // USER-VISIBLE — a merge block is never "off the eyes".
      `⛩ bench merge BLOCKED — cycle ${slot.index}/${MAX_MERGE_BLOCK_CYCLES} [${panel.badge}] (${refsLabel} → ${branch})\n${detail.slice(0, 1200)}`
    );
    return;
  }

  const completePanel = results.length === reviewers.length && results.every((result) =>
    result && !result.error && (result.verdict === "ALLOW" || result.verdict === "BLOCK")
  );
  if (!completePanel) {
    decision(
      "allow",
      `UNREVIEWED / partial panel — [${panel.badge}] ${panel.summary}. No clean pre-merge verdict was cached because at least one configured reviewer failed. Merge allowed locally; deep/native push review remains authoritative.`,
      `⛩ bench merge: UNREVIEWED / partial panel [${panel.badge}] (${refsLabel} → ${branch}) — ${String(panel.summary || "reviewer unavailable").slice(0, 220)}`
    );
    return;
  }

  let cacheWritten = false;
  let cacheWriteFailed = false;
  try {
    cacheWritten = writeMergeAllow(ws, approvalIdentity, {
      badge: panel.badge,
      summary: panel.summary || "merge review passed",
      advisories: panel.advisories || []
    });
  } catch (error) {
    cacheWriteFailed = true;
    process.stderr.write(`⛩ pre-merge: exact ALLOW cache write failed (${error instanceof Error ? error.message : String(error)}); current review still allows.\n`);
  }
  const cacheNote = cacheWritten ? "exact clean result cached"
    : cacheWriteFailed ? "not cached because the exact ALLOW cache write failed"
    : "not cached because this immutable identity was previously blocked";
  decision(
    "allow",
    `⛩ bench merge: exact ALLOW [${panel.badge}] — ${panel.summary} (complete evidence; ${cacheNote}; a deep review is queued for the thorough pass)`,
    `⛩ bench merge: ALLOW [${panel.badge}] — ${(panel.summary || "merge review passed").slice(0, 180)}`
  );
  } finally {
    releaseMergeIdentityLock(identityLock);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = createEmitter();
  runMain({ emitter }).catch((error) => {
    // Top-level catch → FAIL OPEN (a merge is local; never wedge it over a hook error). Only emit if
    // runMain hasn't already decided (a 2nd stdout line is dropped by the harness).
    const msg = error instanceof Error ? error.message : String(error);
    if (!emitter.hasEmitted()) {
      emitter.emit(decisionPayload("allow", `⛩ pre-merge: hook errored (${msg}); merge allowed without review.`, `⛩ bench merge: review errored (${msg.slice(0, 120)}); merge allowed.`));
    } else {
      process.stderr.write(`⛩ pre-merge: error after decision already emitted — ${msg}\n`);
    }
  });
}
