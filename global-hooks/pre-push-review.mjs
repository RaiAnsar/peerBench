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

// Matches `git push` as a command token (with optional leading env/chain glue),
// but not as a substring of another word.
const GIT_PUSH_RE = /(^|[\s;&|(])git\s+push(\s|$)/;
// git push --help / -h → ignore (user is just reading the manual)
const HELP_FLAG_RE = /git\s+push\b.*\s(--help|-h)(\s|$)/;

// Derive the effective working directory from a `cd <path>` that appears BEFORE
// the `git push` token in a compound command (handles umbrella/multi-repo setups
// where Claude does `cd subrepo && git push`). Uses the LAST cd before git push.
export function cdTargetBeforePush(command, fallbackCwd) {
  const pushIdx = command.search(/(^|[\s;&|(])git\s+push(\s|$)/);
  const head = pushIdx >= 0 ? command.slice(0, pushIdx) : command;
  const re = /(?:^|&&|;|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m, last = null;
  while ((m = re.exec(head)) !== null) last = m[1] || m[2] || m[3];
  if (!last) return fallbackCwd;
  return path.isAbsolute(last) ? last : path.resolve(fallbackCwd, last);
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

  // 1. Only act on a real `git push` (not help, not another git command).
  if (!GIT_PUSH_RE.test(command) || HELP_FLAG_RE.test(command)) {
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
