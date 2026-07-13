#!/usr/bin/env node
// global-hooks/pre-push-review.mjs
// PreToolUse(Bash) hook: when Claude runs `git push`, run the full repo-aware
// push review against the ahead-of-remote commits before the push is allowed.
// On a high/critical BLOCK: deny the Bash tool with findings so Claude fixes first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isBenchDisabled as defaultIsBenchDisabled, readReviewedHead, sessionKeyFromInput, writeReviewedHead } from "./config-store.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { deepKey, shouldRewake } from "./deep-review.mjs";
import { enqueue as defaultEnqueue } from "./deep-queue.mjs";
import { runPushReview as defaultRunPushReview } from "./spec-review-run.mjs";

const DEFAULT_PUSH_GATE_BUDGET_MS = 90_000;   // hard cap on the INLINE gate → it can never freeze the session (env-tunable per invocation)
const MAX_PUSH_DIFF_BYTES = 200_000;

// Enqueue the DEEP async push review. Pins symbolic ranges to SHAs so a queued job survives the
// remote-tracking ref advancing after the push lands. runMain calls this so the thorough panel pass
// runs in the BACKGROUND (delivered by the deep-review-runner rewake) instead of freezing the push.
export function launchPushReview(ws, range, { gitImpl = gitTry, now = Date.now(), sessionKey = null, enqueueImpl = defaultEnqueue } = {}) {
  try {
    const [headSha] = gitImpl(["rev-parse", "HEAD"], ws);
    let reviewRange = range;
    const dd = range.indexOf("..");
    if (dd > 0) {
      const [baseSha, baseOk] = gitImpl(["rev-parse", range.slice(0, dd)], ws);
      const [srcSha, srcOk] = gitImpl(["rev-parse", range.slice(dd + 2)], ws);
      if (baseOk && srcOk && baseSha && srcSha) reviewRange = `${baseSha}..${srcSha}`;
    }
    const contentKey = deepKey(`push:${reviewRange}`, headSha);
    return enqueueImpl(ws, { kind: "push", range: reviewRange, contentKey }, { now, sessionKey });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: deep push-review enqueue failed (${e instanceof Error ? e.message : String(e)}); fast review stands.\n`);
    return false;
  }
}

// A regex can't reliably detect `git push` across compound commands: it missed trailing
// operators (`git push;cmd`), git global options (`git -C . push`), and shell control flow
// (`cd /x || git push`). We tokenize into shell segments instead. (Bugs found by the bench's own hunt.)

// Git global options that take a SEPARATE value token (so we skip the value when scanning for `push`).
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

// Split a compound command into segments on top-level shell operators (; && || | &),
// honoring single/double quotes so operators inside strings don't split. Each segment carries
// the `joiner` operator that PRECEDED it ("" for the first) — needed to reason about control flow.
export function shellSegments(command) {
  const segs = []; let cur = "", quote = null, joiner = "";
  const cmd = String(command ?? "");
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], next = cmd[i + 1];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) { segs.push({ text: cur, joiner }); joiner = c + next; cur = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") { segs.push({ text: cur, joiner }); joiner = c; cur = ""; continue; }
    cur += c;
  }
  segs.push({ text: cur, joiner });
  return segs.map((s) => ({ text: s.text.trim(), joiner: s.joiner })).filter((s) => s.text);
}

// Tokenize a single shell segment honoring single/double quotes and STRIPPING the quote chars,
// splitting on unquoted whitespace. `git -C "/a b/r" push` → ["git","-C","/a b/r","push"]. A
// split(/\s+/) would break a quoted path with spaces in two, derailing the `-C` value-skip so it
// never sees `push` (A1 — found by the bench's own hunt). Strips quotes so values are clean.
export function shellTokenize(text) {
  const s = String(text ?? "");
  const toks = [];
  let cur = "", quote = null, started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else cur += c; started = true; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (started) { toks.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += c; started = true;
  }
  if (started) toks.push(cur);
  return toks;
}

// True if a single segment is a real `git push` (allowing leading env assignments and git
// global options before the `push` subcommand). Excludes `--help`/`-h` and `--dry-run`/`-n`.
export function isGitPushSegment(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = toks.indexOf("git");
  if (i < 0) return false;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
  if (toks[i] !== "push") return false;
  const rest = toks.slice(i + 1);
  if (rest.some((t) => t === "--help" || t === "-h" || t === "--dry-run" || t === "-n")) return false;
  return true;
}

// Parse a git push segment into { remote, refspecs[], flags[] }. Remote defaults to "origin".
// Positional non-flag tokens after `push`: the first is the remote, the rest are refspecs.
// Used by resolvePushRange (A2) to compute the correct <base>..<source> range.
export function parsePushCommand(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = toks.indexOf("git");
  const flags = [];
  const positionals = [];
  if (i >= 0) {
    i++;
    // skip git global options (and their value tokens) up to `push`
    while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
    if (toks[i] === "push") {
      i++;
      for (; i < toks.length; i++) {
        const t = toks[i];
        if (t.startsWith("-")) flags.push(t);
        else positionals.push(t);
      }
    }
  }
  const remote = positionals.length > 0 ? positionals[0] : "origin";
  const refspecs = positionals.slice(1);
  return { remote, refspecs, flags };
}

// Extract -C target directories (in order) from a push segment, for review-cwd resolution (A1).
function dashCTargets(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = toks.indexOf("git");
  const targets = [];
  if (i < 0) return targets;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) {
    const t = toks[i];
    if (t === "-C" && i + 1 < toks.length) { targets.push(toks[i + 1]); i += 2; continue; }
    i++;
    if (GIT_VALUE_OPTS.has(t)) i++;
  }
  return targets;
}

// The first segment that is a real git push, or null. Also detects a subshell-wrapped push
// (`(git push)`) by stripping a balanced leading `(` / trailing `)` and re-checking (A3).
export function findPushSegment(command) {
  for (const s of shellSegments(command)) {
    if (isGitPushSegment(s.text)) return s;
    const stripped = s.text.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    if (stripped !== s.text && isGitPushSegment(stripped)) return { text: stripped, joiner: s.joiner };
  }
  return null;
}

// Derive the effective working directory of the push from `cd` segments before it (umbrella/multi-repo
// `cd subrepo && git push`). A `cd` is only honored if the NEXT segment isn't joined by `||` — i.e. the
// `cd` succeeded; `cd /missing || git push` runs the push in the ORIGINAL dir, so we must NOT use /missing.
export function cdTargetBeforePush(command, fallbackCwd) {
  const segs = shellSegments(command);
  let cwd = fallbackCwd;
  for (let k = 0; k < segs.length; k++) {
    if (isGitPushSegment(segs[k].text)) return cwd;
    const m = segs[k].text.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    if (m) {
      const target = m[1] || m[2] || m[3];
      const next = segs[k + 1];
      if (!(next && next.joiner === "||")) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    }
  }
  return cwd;
}

// Resolve the repo a git command actually OPERATES in: follow `cd` segments up to the FIRST git
// segment, then apply that segment's `git -C <dir>` targets. Mirrors the push path's cwd resolution
// but generalized to any git subcommand, so the reviewed-head bootstrap marks the repo the command
// TOUCHES (`git -C /other commit`, `cd /other && git add`) — not a stale input.cwd (the wrong repo).
//
// We deliberately do NOT follow GIT_DIR / GIT_WORK_TREE env redirects: the stop gate runs plain git
// in its cwd and doesn't follow them either, so honoring them here would bootstrap a workspace the
// stop gate never reviews — and `git rev-parse` run WITHOUT those vars can't resolve such a detached
// work tree anyway (wrong repo, or none). Env prefixes are skipped only so the git INVOCATION (and
// its `-C`) is still recognized; their values are ignored.
export function commandCwd(command, fallbackCwd) {
  const segs = shellSegments(command);
  let cwd = fallbackCwd;
  for (let k = 0; k < segs.length; k++) {
    const toks = shellTokenize(segs[k].text).filter(Boolean);
    // Skip leading `NAME=value` env-assignment prefixes so `FOO=bar git …` is still recognized as a
    // git invocation (matches how isGitPushSegment/dashCTargets locate git via indexOf).
    let g = 0;
    while (g < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[g])) g++;
    if (toks[g] === "git") {
      for (const target of dashCTargets(segs[k].text)) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      return cwd;                                  // resolve to the first git segment (where work lands)
    }
    const m = segs[k].text.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    if (m) {
      const target = m[1] || m[2] || m[3];
      const next = segs[k + 1];
      if (!(next && next.joiner === "||")) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    }
  }
  return cwd;
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ pre-push: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

const MAX_ASSISTANT_CONTEXT_CHARS = 8000;

export function assistantContextFromInput(input) {
  const value =
    input?.last_assistant_message
    ?? input?.lastAssistantMessage
    ?? input?.assistant?.last_message
    ?? input?.assistant?.lastMessage
    ?? input?.transcript?.last_assistant_message
    ?? input?.transcript?.lastAssistantMessage
    ?? "";
  return typeof value === "string" ? value.trim().slice(0, MAX_ASSISTANT_CONTEXT_CHARS) : "";
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function gitTry(args, cwd) {
  // Returns [output, ok] — ok=false means the command exited non-zero or threw.
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST JSON line on stdout, so a
// second emit (e.g. the top-level .catch firing after runMain already decided) is silently dropped.
// MUST be created per runMain invocation — a module-level flag would suppress emits on later
// invocations in the same process and break the suite (A4 — found by the bench's own hunt).
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

function decisionPayload(permissionDecision, reason, systemMessage) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason
    }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

function hasReviewerVerdict(review) {
  return Array.isArray(review?.reviewers) && review.reviewers.some((r) => {
    const verdict = String(r?.verdict || "").toUpperCase();
    return verdict === "ALLOW" || verdict === "BLOCK";
  });
}

function refExists(ref, cwd) {
  const [, ok] = gitTry(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return ok;
}

// Resolve push range (commits ahead of remote) from the PARSED push command. Returns
// { range, ok, note, deleteOnly }. ok=false means no reviewable range. Delete-only pushes are
// clean no-ops; other unresolved ranges are denied by runMain so commits are not pushed unreviewed.
//
//  - <src>:<dst>  → source = local <src> (HEAD if <src>=="HEAD"); base = <remote>/<dst> if it exists
//                   (else the base-chain below). Explicit refspecs take precedence over @{u}.
//  - bare <ref>   → src = dst = <ref> → <remote>/<ref>..<ref>
//  - :<dst>       → delete → no commits → clean allow (deleteOnly).
//  - no refspec   → source = HEAD; base chain: @{u} → <remote>/<branch> → <remote>/HEAD →
//                   <remote>/main → <remote>/master → <remote>/master..HEAD as last resort.
//  - --all/--tags/--mirror, or >1 refspec → can't scope an EXACT range, so review the current
//    branch's ahead-commits (fallbackRange) as a best effort rather than skipping review.
export function resolvePushRange(cwd, parsed) {
  const { remote = "origin", refspecs = [], flags = [] } = parsed || {};

  // A single delete refspec (:<dst>) pushes no commits → clean allow, no review.
  if (refspecs.length === 1 && refspecs[0].startsWith(":")) {
    return { range: "", ok: false, deleteOnly: true };
  }

  // Cases where an EXACT push range can't be scoped — multiple refspecs (`git push beta main develop`,
  // a common deploy form) or whole-ref flags (--all/--tags/--mirror). Previously these SKIPPED review
  // entirely, which left real deploy pushes unreviewed. Instead fall back to reviewing the current
  // branch's ahead-commits — always review SOMETHING; only truly skip if even that can't resolve.
  const wholeRefFlag = ["--all", "--tags", "--mirror"].find((f) => flags.includes(f));
  if (wholeRefFlag || refspecs.length > 1) {
    const why = wholeRefFlag ? `${wholeRefFlag} pushes multiple refs` : `${refspecs.length} refspecs`;
    const fb = fallbackRange(cwd, remote);
    if (fb.ok) return { ...fb, note: `⛩ pre-push: ${why} — reviewing current-branch commits (${fb.range}); exact push set not range-resolved.` };
    return { range: "", ok: false, note: `⛩ pre-push: ${why} and no branch base resolved; push blocked until peerBench can review a commit range.` };
  }

  // Single explicit refspec.
  if (refspecs.length === 1) {
    const spec = refspecs[0];
    const colon = spec.indexOf(":");
    if (colon >= 0) {
      const src = spec.slice(0, colon);
      const dst = spec.slice(colon + 1);
      const source = src === "HEAD" ? "HEAD" : src;
      const baseRef = `${remote}/${dst}`;
      if (refExists(baseRef, cwd)) return { range: `${baseRef}..${source}`, ok: true };
      // No remote-tracking ref for the dst — keep the explicit source against a guessed base, else fall back.
      const chain = baseChain(cwd, remote);
      if (chain) return { range: `${chain}..${source}`, ok: true, note: `pre-push: guessed base ${chain} for ${spec}` };
      const fb = fallbackRange(cwd, remote);
      return fb.ok
        ? { ...fb, note: `⛩ pre-push: could not resolve a base for ${spec} — reviewing current-branch commits (${fb.range}).` }
        : { range: "", ok: false, note: `⛩ pre-push: could not resolve a base for ${spec}; push blocked until peerBench can review a commit range.` };
    }
    // bare <ref> → src = dst = <ref>
    const baseRef = `${remote}/${spec}`;
    if (refExists(baseRef, cwd)) return { range: `${baseRef}..${spec}`, ok: true };
    const chain = baseChain(cwd, remote);
    if (chain) return { range: `${chain}..${spec}`, ok: true, note: `pre-push: guessed base ${chain} for ${spec}` };
    const fb = fallbackRange(cwd, remote);
    return fb.ok
      ? { ...fb, note: `⛩ pre-push: no remote-tracking ref for ${spec} — reviewing current-branch commits (${fb.range}).` }
      : { range: "", ok: false, note: `⛩ pre-push: no remote-tracking ref for ${spec}; push blocked until peerBench can review a commit range.` };
  }

  // No explicit refspec → review the current branch's ahead-commits.
  const fb = fallbackRange(cwd, remote);
  return fb.ok ? fb : { range: "", ok: false, note: "⛩ pre-push: no upstream to diff against; push blocked until peerBench can review a commit range." };
}

// Current branch's ahead-commits: @{u}..HEAD, else <remote>/<branch|HEAD|main|master>..HEAD.
// The always-available best-effort review range when an EXACT push range can't be scoped — these
// are the committed-but-unpushed commits a push will transmit (NOT uncommitted work, which a push
// never carries and which the stop gate already reviews).
function fallbackRange(cwd, remote) {
  const [upstreamFull, upOk] = gitTry(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  if (upOk && upstreamFull) return { range: "@{u}..HEAD", ok: true };
  const chain = baseChain(cwd, remote);
  if (chain) return { range: `${chain}..HEAD`, ok: true, note: `pre-push: guessed base ${chain} (no @{u})` };
  return { range: "", ok: false };
}

// Base-ref precedence for a named remote with no explicit refspec / no @{u}:
// <remote>/<current-branch> → <remote>/HEAD → <remote>/main → <remote>/master. null if none.
function baseChain(cwd, remote) {
  const [branch, brOk] = gitTry(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const candidates = [];
  if (brOk && branch && branch !== "HEAD") candidates.push(`${remote}/${branch}`);
  candidates.push(`${remote}/HEAD`, `${remote}/main`, `${remote}/master`);
  for (const c of candidates) if (refExists(c, cwd)) return c;
  return null;
}

export function buildPrompt(commits, diff) {
  const system =
    "You are reviewing a set of commits about to be pushed. Review based ONLY on the content " +
    "provided in this message. Do NOT use any tools or explore the filesystem. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. " +
    "BLOCK only if there is a concrete bug, regression, security issue, or unsafe change " +
    "that must be fixed before these commits are pushed; otherwise ALLOW " +
    "(minor notes may follow the first line).";
  const user = [
    "<commits>",
    commits || "(no commit list available)",
    "</commits>",
    "",
    "<diff>",
    diff || "(no diff available)",
    "</diff>"
  ].join("\n");
  return { system, user };
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  pushReviewImpl = defaultRunPushReview,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  enqueueImpl = defaultEnqueue,
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  exit = (code) => process.exit(code)
} = {}) {
  // All decisions route through this invocation's emit-once guard (A4).
  const decision = (permissionDecision, reason, systemMessage) =>
    emitter.emit(decisionPayload(permissionDecision, reason, systemMessage));

  const input = inputOverride ?? readInput();
  const sessionKey = sessionKeyFromInput(input, env);
  const assistantContext = assistantContextFromInput(input);   // used by the blocking-mode deep review

  const command = String(input.tool_input?.command ?? "");

  // 0. Bootstrap the stop gate's reviewed-head baseline on the FIRST `git` command of a session
  // (this hook fires on every `git *` via its matcher), BEFORE any commit lands — so that
  // committed-AND-pushed work is still reviewed on the first stop, where `@{upstream}` would
  // already have advanced past it. Resolve the repo the command actually TOUCHES (cd + `git -C`),
  // not a stale input.cwd. Only WRITES when the marker is missing; best-effort, never affects the
  // git command itself.
  try {
    const bootWs = workspaceRoot(commandCwd(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (!isBenchDisabledImpl(bootWs) && !readReviewedHead(bootWs)) {
      const [head, ok] = gitTry(["rev-parse", "HEAD"], bootWs);
      if (ok && head.trim()) writeReviewedHead(bootWs, head.trim());
    }
  } catch { /* baseline bootstrap is best-effort — must not affect the push gate */ }

  // 1. Only act on a real `git push` (not help/dry-run, not another git command, not a quoted mention).
  const pushSeg = findPushSegment(command);
  if (!pushSeg) {
    // Not a git push — silent allow.
    return;
  }

  // Resolve the review cwd: shell `cd` segments first, then `git -C <dir>` targets applied in order
  // like git itself (A1) — so `git -C "/path with space/repo" push` reviews THAT repo.
  let baseCwd = cdTargetBeforePush(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  for (const target of dashCTargets(pushSeg.text)) {
    baseCwd = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
  }
  const ws = workspaceRoot(baseCwd);

  // 2. Bench disabled check.
  if (isBenchDisabledImpl(ws)) {
    return exit(0);
  }

  // 3. Compute push range from the PARSED command. If a real push might transmit commits but
  // peerBench cannot resolve a review range, fail closed instead of allowing an unreviewed push.
  const parsed = parsePushCommand(pushSeg.text);
  const { range, ok: rangeOk, note: rangeNote, deleteOnly } = resolvePushRange(ws, parsed);
  if (!rangeOk) {
    if (deleteOnly) {
      // delete refspec → pushes no commits → clean allow, no review, no noisy note.
      return;
    }
    const note = rangeNote || "⛩ pre-push: no reviewable commit range; push blocked.";
    decision(
      "deny",
      `${note} Retry after setting an upstream/remote tracking ref, or run /bench:off if you intentionally need to bypass peerBench.`,
      note
    );
    return;
  }

  // 4. Get commits in range; if nothing to push, allow quietly. Use gitTry so a git ERROR
  //    (not "no commits") is distinguishable and surfaced as a ⛩ note (A2).
  const [commits, commitsOk] = gitTry(["log", "--oneline", range], ws);
  if (!commitsOk) {
    decision(
      "deny",
      `⛩ pre-push: git log ${range} failed; push blocked because peerBench could not inspect the commits. Retry, or run /bench:off if you intentionally need to bypass peerBench.`,
      `⛩ pre-push: git log ${range} failed; push blocked.`
    );
    return;
  }
  if (!commits.trim()) {
    decision("allow", "pre-push: nothing to push (no commits ahead of remote); allowed");
    return;
  }

  const rangeNoteSuffix = rangeNote ? ` (${rangeNote})` : "";
  const mode = String(env.BENCH_PUSH_GATE_MODE || "fast").toLowerCase();

  // REVERT SWITCH — BENCH_PUSH_GATE_MODE=blocking restores the ORIGINAL gate: a full repo-aware review
  // runs INLINE and the push is BLOCKED until it finishes (fail-closed on error/timeout/no-verdict).
  // Stronger guarantee, but it freezes the session for the WHOLE review (no Ctrl+B / no input) — the
  // reason "fast" is the default. Flip back any time with BENCH_PUSH_GATE_MODE=blocking.
  if (mode === "blocking") {
    let review;
    try {
      review = await pushReviewImpl(range, ws, { sessionKey, writeTraceImpl, assistantContext });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      decision("deny", `⛩ bench pre-push: full push review errored (${msg}); push blocked. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review errored; push blocked.`);
      return;
    }
    if (review?.retry) {
      decision("deny", `⛩ bench pre-push: full push review could not inspect ${range} (${review.reason || "retry requested"}); push blocked. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review unavailable; push blocked.`);
      return;
    }
    if (!hasReviewerVerdict(review)) {
      decision("deny", `⛩ bench pre-push: full push review produced no reviewer verdicts; push blocked so commits do not leave unreviewed. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review unavailable; push blocked.`);
      return;
    }
    if (shouldRewake(review)) {
      const detail = review.findings || review.summary || "(no details)";
      decision("deny", `[${review.badge || "push-review"}] Full push review found issues that must be fixed before pushing:\n\n${detail}\n\nFix the issues above, then run git push again.`, `⛩ bench pre-push BLOCKED [${review.badge || "push-review"}]${rangeNoteSuffix}\n${detail.slice(0, 1200)}${review.traceId ? `\n\n↳ full findings: /bench:show ${review.traceId}` : ""}`);
      return;
    }
    decision("allow", `⛩ bench pre-push: ALLOW [${review.badge || "push-review"}] — ${review.summary || "full push review passed"}${rangeNoteSuffix}`, `⛩ bench pre-push: ALLOW [${review.badge || "push-review"}] — ${(review.summary || "full push review passed").slice(0, 220)}`);
    return;
  }

  // ── FAST mode (default) ──────────────────────────────────────────────────────────────────────
  // 5. Enqueue the DEEP async panel review FIRST (best-effort). The thorough repo-aware Codex/Grok/MiMo
  // pass now runs in the BACKGROUND — delivered by the deep-review-runner via the visible rewake at the
  // next stop (non-blocking, backgroundable). This is what lets the inline gate below stay FAST: the slow
  // exhaustive review no longer runs INSIDE this PreToolUse hook, so it can't freeze the session.
  // (History: pushes were full-reviewed inline here — a 15–20 min block with no way to Ctrl+B or send
  // input while Codex/Grok/MiMo churned. The fast-inline-cap + async-panel split fixes exactly that.)
  try {
    launchPushReview(ws, range, { sessionKey, enqueueImpl });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: deep review enqueue failed (${e instanceof Error ? e.message : String(e)}); fast gate stands.\n`);
  }

  // 6. Fast content-only inline review, HARD-capped. On timeout/error/no-verdict → FAIL OPEN (allow):
  // the deep review is already queued, so a slow review can never wedge the push or freeze the session.
  // A fast, confident high/critical finding still BLOCKS — obvious problems stop before the push leaves.
  const budgetMs = Number(env.BENCH_PUSH_GATE_BUDGET_MS) || DEFAULT_PUSH_GATE_BUDGET_MS;
  let diff = gitTry(["diff", range], ws)[0] || "";
  if (diff.length > MAX_PUSH_DIFF_BYTES) diff = diff.slice(0, MAX_PUSH_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";
  const { system, user } = buildPrompt(commits, diff);

  let results = null;
  let budgetTimer = null;
  try {
    const reviewers = resolveReviewersImpl({ env });
    const reviewPromise = Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env })));
    const timeout = new Promise((resolve) => { budgetTimer = setTimeout(() => resolve("TIMEOUT"), budgetMs); });
    results = await Promise.race([reviewPromise, timeout]);
  } catch {
    results = null;
  } finally {
    // CRITICAL: clear the budget timer the instant the panel returns. A pending setTimeout is a REF'd
    // handle that keeps the hook PROCESS alive until it fires — so on a fast ALLOW the hook would linger
    // the full budget and Claude Code (which waits for the hook to EXIT) freezes ~90s on EVERY push,
    // defeating the whole fast-mode point (caught by the Codex gate). On the timeout branch the timer has
    // already fired; the LOSING reviewer promise still holds sockets open, so that path exit(0)s below.
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (results === "TIMEOUT" || !Array.isArray(results) || !hasReviewerVerdict({ reviewers: results })) {
    const why = results === "TIMEOUT" ? `fast review didn't finish in ${(budgetMs / 1000) | 0}s` : "fast review unavailable";
    decision(
      "allow",
      `⛩ bench pre-push: ${why}; push allowed — a deep review is queued (delivered at the next stop). Run /bench:review ${range} for a full pass now.${rangeNoteSuffix}`,
      `⛩ bench pre-push: ${why} (${range}); push allowed — deep review queued.`
    );
    return exit(0);   // reviewers lost the race but their sockets are still open — force-exit
  }

  const panel = combinePanel(results, { blockMinSeverity: "high" });
  try {
    writeTraceImpl(ws, {
      gate: "push-review", ws, sessionKey,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null })),
      systemPrompt: system, userPrompt: user.slice(0, 2000),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || r.error || ""]))
    });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  // 7. Decision. High/critical findings block (fast); lower severity is advisory (shared threshold
  // with plan/spec). The thorough deep pass is already queued regardless.
  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    decision(
      "deny",
      `[${panel.badge}] Fast pre-push review found issues that must be fixed before pushing:\n\n${detail}\n\n` +
      `Fix the issues above, then run git push again. (A deep review is also queued.)`,
      // USER-VISIBLE: a pre-push block is never "off the eyes" — surface the badge + trimmed findings.
      `⛩ bench pre-push BLOCKED [${panel.badge}]${rangeNoteSuffix}\n${detail.slice(0, 1200)}`
    );
    return;
  }

  decision(
    "allow",
    `⛩ bench pre-push: ALLOW [${panel.badge}] — ${panel.summary || "fast push review passed"} (a deep review is queued for the thorough pass)${rangeNoteSuffix}`,
    `⛩ bench pre-push: ALLOW [${panel.badge}] — ${(panel.summary || "push review passed").slice(0, 200)}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = createEmitter();
  runMain({ emitter }).catch((error) => {
    // Top-level catch → fail closed. Only emit if runMain hasn't already decided — a 2nd stdout
    // line would be dropped by the harness (A4). Else log to stderr.
    const msg = error instanceof Error ? error.message : String(error);
    if (!emitter.hasEmitted()) {
      emitter.emit(decisionPayload(
        "deny",
        `⛩ pre-push: hook errored (${msg}); push blocked so commits do not leave unreviewed. Retry, or run /bench:off if you intentionally need to bypass peerBench.`
      ));
    } else {
      process.stderr.write(`⛩ pre-push: error after decision already emitted — ${msg}\n`);
    }
  });
}
