#!/usr/bin/env node
// global-hooks/pre-push-review.mjs
// PreToolUse(Bash) hook: when Claude runs `git push`, review the push diff
// (ahead-of-remote commits) with the full panel content-only. On BLOCK: deny
// the Bash tool with findings so Claude fixes first. Fails OPEN everywhere —
// only a real panel BLOCK prevents the push.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { combinePanel } from "./panel-lib.mjs";
import { isGangDisabled as defaultIsGangDisabled } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";

const MAX_DIFF_BYTES = 200_000;

// A regex can't reliably detect `git push` across compound commands: it missed trailing
// operators (`git push;cmd`), git global options (`git -C . push`), and shell control flow
// (`cd /x || git push`). We tokenize into shell segments instead. (Bugs found by the gang's own hunt.)

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

// True if a single segment is a real `git push` (allowing leading env assignments and git
// global options before the `push` subcommand). Excludes `--help`/`-h` and `--dry-run`/`-n`.
export function isGitPushSegment(text) {
  const toks = String(text ?? "").split(/\s+/).filter(Boolean);
  let i = toks.indexOf("git");
  if (i < 0) return false;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
  if (toks[i] !== "push") return false;
  const rest = toks.slice(i + 1);
  if (rest.some((t) => t === "--help" || t === "-h" || t === "--dry-run" || t === "-n")) return false;
  return true;
}

// The first segment that is a real git push, or null.
export function findPushSegment(command) {
  for (const s of shellSegments(command)) if (isGitPushSegment(s.text)) return s;
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

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
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

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function decision(permissionDecision, reason, systemMessage) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason
    }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  emit(out);
}

// Resolve push range (commits ahead of remote). Returns { range, ok, note }.
// ok=false with a note means fail-open (can't determine range).
function resolvePushRange(cwd) {
  // 1. Try @{u} (configured upstream for current branch).
  const [upstreamFull, upOk] = gitTry(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd
  );
  if (upOk && upstreamFull) {
    return { range: "@{u}..HEAD", ok: true };
  }

  // 2. Try origin/HEAD as a fallback remote default.
  const [, headOk] = gitTry(["rev-parse", "--verify", "origin/HEAD"], cwd);
  if (headOk) {
    return { range: "origin/HEAD..HEAD", ok: true };
  }

  // 3. Try origin/main.
  const [, mainOk] = gitTry(["rev-parse", "--verify", "origin/main"], cwd);
  if (mainOk) {
    return { range: "origin/main..HEAD", ok: true };
  }

  return { range: "", ok: false, note: "pre-push: no upstream to diff against; allowed" };
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
  writeTraceImpl = defaultWriteTrace,
  isGangDisabledImpl = defaultIsGangDisabled,
  env = process.env,
  input: inputOverride
} = {}) {
  const input = inputOverride ?? readInput();

  const command = String(input.tool_input?.command ?? "");

  // 1. Only act on a real `git push` (not help/dry-run, not another git command, not a quoted mention).
  if (!findPushSegment(command)) {
    // Not a git push — silent allow.
    return;
  }

  const baseCwd = cdTargetBeforePush(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  const ws = workspaceRoot(baseCwd);

  // 2. Gang disabled check.
  if (isGangDisabledImpl(ws)) {
    process.exit(0);
  }

  // 3. Compute push range — fail OPEN if undeterminable.
  const { range, ok: rangeOk, note: rangeNote } = resolvePushRange(ws);
  if (!rangeOk) {
    decision("allow", rangeNote || "pre-push: no upstream; allowed", rangeNote);
    return;
  }

  // 4. Get commits in range; if nothing to push, allow quietly.
  const commits = git(["log", "--oneline", range], ws).trim();
  if (!commits) {
    decision("allow", "pre-push: nothing to push (no commits ahead of remote); allowed");
    return;
  }

  // 5. Get diff, capped.
  let diff = git(["diff", range], ws);
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";
  }

  // 6. Build content-only prompt and run the full panel.
  const { system, user } = buildPrompt(commits, diff);

  const reviewers = resolveReviewersImpl({ env });
  const results = await Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env })));
  const panel = combinePanel(results);

  // 7. Write trace — best-effort.
  try {
    writeTraceImpl(ws, {
      gate: "push",
      ws,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch {
    // trace is best-effort — never block a push over it
  }

  // 8. Decision.
  if (panel.decision === "fail-open") {
    // All reviewers errored — fail OPEN with a visible note.
    decision(
      "allow",
      `Pre-push panel unavailable (${panel.summary}); push allowed without review.`,
      `⛩ gang pre-push: panel skipped — ${panel.summary.slice(0, 200)}`
    );
    return;
  }

  if (panel.decision === "block") {
    decision(
      "deny",
      `Review panel found issues that must be fixed before pushing:\n\n${panel.findings}\n\n` +
      `${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}` +
      `Fix the issues above, then run git push again.`
    );
    return;
  }

  // allow
  decision("allow", `⛩ gang pre-push: ALLOW — ${panel.summary}`, `⛩ gang pre-push: ALLOW — ${panel.summary.slice(0, 220)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    // Top-level catch → fail OPEN, never wedge a push.
    decision(
      "allow",
      `Pre-push hook errored (${error instanceof Error ? error.message : String(error)}); push allowed.`
    );
  });
}
