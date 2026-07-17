#!/usr/bin/env node
// global-hooks/pre-merge-review.mjs
// PreToolUse(Bash) hook: when Claude runs `git merge <ref>` INTO a protected branch, run a FAST
// content-only panel review of the incoming commits BEFORE the merge is allowed.
//
// DESIGN (why this is NOT the deep repo-aware review): the deep push/spec review can take minutes and
// makes Claude look FROZEN — the exact 30–40-min "is it hung?" experience we're avoiding. So this gate:
//   • is content-only (embed the diff, no repo exploration) → fast (~10-30s),
//   • has a HARD wall-clock cap and FAILS OPEN (allows the merge) on timeout/error → can never hang or wedge a merge,
//   • is VISIBLE — the deploy registers a statusMessage, and every block emits a user-visible systemMessage,
//   • ALSO enqueues a DEEP async MiMo review (delivered by the deep-review-runner via the rewake, non-blocking)
//     so the thorough pass still happens without you waiting on it.
// A merge is local — a bad merge caught after the fact (deep review / push gate) is fixed forward before it leaves.
//
// Deploy-parity: deployed FLAT in ~/.claude/hooks/ — imports ONLY global-hooks siblings.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput } from "./config-store.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { buildPrompt, shellSegments, shellTokenize, commandCwd, createEmitter, assistantContextFromInput } from "./pre-push-review.mjs";
import { deepKey } from "./deep-review.mjs";
import { enqueue as defaultEnqueue } from "./deep-queue.mjs";

const DEFAULT_MERGE_GATE_BUDGET_MS = 90_000;   // hard cap → the gate can never hang (env-tunable per invocation)
const MAX_MERGE_DIFF_BYTES = 200_000;
// Only gate merges INTO these branches (releasing into main/etc.). Routine "merge main into my feature"
// (current branch not protected) is never gated. Tunable via BENCH_PROTECTED_BRANCHES (comma-separated).
const PROTECTED_BRANCHES = (process.env.BENCH_PROTECTED_BRANCHES || "main,master,production,prod,release,staging")
  .split(",").map((s) => s.trim()).filter(Boolean);
// git global options that take a SEPARATE value token (skip the value when scanning for `merge`).
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
// `git merge` options that take a SEPARATE value token — so `-m "msg" staging` yields ref "staging",
// not "msg". Only DEFINITE value-flags (optional-arg flags like -S are left alone to avoid eating a ref).
const MERGE_VALUE_FLAGS = new Set(["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "--into-name"]);

// Detect `git merge <ref...>` in a shell segment (allow leading env assignments + git global opts).
// Excludes --abort/--continue/--quit (not a NEW merge) and --help. Returns { refs } or null.
export function parseMergeSegment(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = toks.indexOf("git");
  if (i < 0) return null;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
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
  return { refs };
}

// The first segment that is a real git merge, or null. Also handles a subshell-wrapped `(git merge x)`.
export function findMergeSegment(command) {
  for (const s of shellSegments(command)) {
    const m = parseMergeSegment(s.text);
    if (m) return m;
    const stripped = s.text.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    if (stripped !== s.text) { const m2 = parseMergeSegment(stripped); if (m2) return m2; }
  }
  return null;
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

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

function gitTry(args, cwd) {
  try { return [execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim(), true]; }
  catch { return ["", false]; }
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

  const ws = workspaceRoot(commandCwd(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()));
  if (isBenchDisabledImpl(ws)) return exit(0);

  // 2. Only gate merges INTO a protected branch (the "releasing into main" moment).
  const [branch] = gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ws);
  if (!PROTECTED_BRANCHES.includes(branch)) return;   // silent allow — routine feature-branch merge

  // 3. Incoming commits per ref. `git merge` with no ref merges the upstream (@{u}); an octopus
  // merge (`git merge a b`) lists several refs — EVERY ref's commits are incoming, so every ref is
  // gathered (reviewing only refs[0] let the rest bypass the gate — a push-gate catch). Ranges are
  // pinned to SHAs (`<headSha>..<refSha>`), never symbolic `HEAD..ref`: the queued deep review runs
  // AFTER the merge advances HEAD, where a symbolic range is empty (ff) or wrong (non-ff).
  const refNames = merge.refs.length ? merge.refs : ["@{u}"];
  const [headSha, headOk] = gitTry(["rev-parse", "HEAD"], ws);
  if (!headOk || !headSha) return;   // unresolvable HEAD → FAIL OPEN (weird repo state; never wedge a merge)
  const incoming = [];
  for (const ref of refNames) {
    const [refSha, refOk] = gitTry(["rev-parse", ref], ws);
    if (!refOk || !refSha) return;   // can't resolve a ref → FAIL OPEN (never block a merge over a parse miss)
    const range = `${headSha}..${refSha}`;
    const [commits, commitsOk] = gitTry(["log", "--oneline", range], ws);
    if (!commitsOk) return;          // fail open
    if (commits.trim()) incoming.push({ ref, refSha, range, commits });
  }
  const refsLabel = refNames.join(", ");
  if (!incoming.length) { decision("allow", `⛩ bench merge: nothing to merge from ${refsLabel} into ${branch} (up to date).`); return; }

  const commits = incoming.map((i) => (incoming.length > 1 ? `# incoming from ${i.ref}\n${i.commits}` : i.commits)).join("\n");
  let diff = incoming.map((i) => gitTry(["diff", i.range], ws)[0] || "").join("\n");
  if (diff.length > MAX_MERGE_DIFF_BYTES) diff = diff.slice(0, MAX_MERGE_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";

  const sessionKey = sessionKeyFromInput(input, env);

  // 4. Enqueue the DEEP async reviews FIRST (best-effort), one per ref — delivered by the
  // deep-review-runner via the visible rewake, non-blocking, so the thorough repo-aware pass happens
  // even if the fast gate below times out or crashes. kind:"merge" (not "push"): the runner reviews
  // it through the same range machinery, but its durable-block identity is recomputed as
  // `merge:<range>` (deep-queue currentContentKey) — reusing kind:"push" made every recompute
  // `push:<range>`-keyed, so a durable merge block was always "changed" and retired at the next Stop.
  for (const i of incoming) {
    try {
      enqueueImpl(ws, { kind: "merge", range: i.range, contentKey: deepKey(`merge:${i.range}`, i.refSha) }, { sessionKey });
    } catch (e) {
      process.stderr.write(`⛩ pre-merge: deep review enqueue failed for ${i.ref} (${e instanceof Error ? e.message : String(e)}); fast gate stands.\n`);
    }
  }

  // 5. Fast content-only review, HARD-capped. On timeout/error → FAIL OPEN (deep review already queued;
  // the push gate is the hard stop). This is the guarantee that a merge never leaves Claude looking hung.
  const budgetMs = Number(env.BENCH_MERGE_GATE_BUDGET_MS) || DEFAULT_MERGE_GATE_BUDGET_MS;
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
    // Clear the budget timer the instant the panel returns — a pending setTimeout keeps the hook process
    // alive for the whole budget, freezing a fast merge for ~90s (same class of bug the Codex gate caught
    // on the push gate). The timeout branch already fired the timer and exit(0)s below on the dangling promise.
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (results === "TIMEOUT" || results === null || !Array.isArray(results)) {
    decision(
      "allow",
      `⛩ bench merge: fast review didn't finish in ${(budgetMs / 1000) | 0}s; merge allowed (a deep review is queued). Run \`/bench:review ${incoming[0].range}\` for a full pass.`,
      `⛩ bench merge: fast review timed out (${refsLabel} → ${branch}); merge allowed — deep review queued.`
    );
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

  // 6. Decision — high/critical blocks; lower severity is advisory (shared threshold with plan/spec).
  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    decision(
      "deny",
      `[${panel.badge}] Pre-merge review found issues that should be fixed before merging ${refsLabel} into ${branch}:\n\n${detail}\n\nFix these, then run git merge again.`,
      // USER-VISIBLE — a merge block is never "off the eyes".
      `⛩ bench merge BLOCKED [${panel.badge}] (${refsLabel} → ${branch})\n${detail.slice(0, 1200)}`
    );
    return;
  }

  decision(
    "allow",
    `⛩ bench merge: ALLOW [${panel.badge}] — ${panel.summary} (a deep review is queued for the thorough pass)`,
    `⛩ bench merge: ALLOW [${panel.badge}] — ${(panel.summary || "merge review passed").slice(0, 180)}`
  );
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
