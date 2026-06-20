#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: reviewer-registry panel review of the plan
// (strict AND-pass). deny -> Claude revises and resubmits. Fails OPEN only
// when ALL reviewers error.
import fs from "node:fs";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { execFileSync } from "node:child_process";

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST JSON line on stdout, so a
// second emit (e.g. the top-level .catch firing after runMain already decided) is silently dropped.
// MUST be created per runMain invocation — a module-level flag would suppress emits on later
// invocations in the same process and break the suite (H1 — found by the bench's own hunt).
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
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

export function buildPrompt(plan) {
  return {
    system: "You are reviewing an implementation plan from ONLY the text provided. Do not assume filesystem access. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW (minor notes may follow the first line).",
    user: `<plan>\n${plan}\n</plan>`
  };
}

function readInput() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch (e) {
    // Malformed stdin → treat as empty, but say so on stderr instead of failing silently (found by the hunt).
    process.stderr.write(`⛩ plan-review: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
  }
  return input;
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  input: inputOverride,
  emitter = createEmitter()
} = {}) {
  // All decisions route through this invocation's emit-once guard (H1).
  const decision = (permissionDecision, reason, systemMessage) =>
    emitter.emit(decisionPayload(permissionDecision, reason, systemMessage));

  const input = inputOverride ?? readInput();

  const plan = String(input.tool_input?.plan ?? "").trim();
  if (!plan) {
    decision("allow", "No plan content to review.");
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);              // git top-level — matches where /bench:off writes the marker + the stop/push gates
  if (isBenchDisabledImpl(ws)) process.exit(0);    // bench layer disabled for this workspace
  const { system, user } = buildPrompt(plan);

  const results = await Promise.all(resolveReviewersImpl().map((r) => r.run({ system, user, cwd: ws })));
  const panel = combinePanel(results);

  try {
    writeTraceImpl(ws, {
      gate: "plan",
      ws,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — never block over it, but say so instead of swallowing (D3).
    process.stderr.write(`⛩ plan-review: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    decision("allow", `[${panel.badge}] Review panel unavailable (${panel.summary}); plan allowed without review.`, `⛩ plan panel skipped [${panel.badge}]: ${panel.summary.slice(0, 200)}`);
    return;
  }

  if (panel.decision === "block") {
    decision(
      "deny",
      `[${panel.badge}] Review panel found issues that must be fixed before this plan can be presented:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address these findings, then call ExitPlanMode again.`
    );
    return;
  }

  decision("allow", `[${panel.badge}] Review panel approved the plan. ${panel.summary}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = createEmitter();
  runMain({ emitter }).catch((error) => {
    // Top-level catch → fail OPEN, never wedge a plan. Only emit if runMain hasn't already
    // decided — a 2nd stdout line would be dropped by the harness (H1). Else log to stderr.
    const msg = error instanceof Error ? error.message : String(error);
    if (!emitter.hasEmitted()) {
      emitter.emit(decisionPayload("allow", `Plan panel errored (${msg}); plan allowed without review.`));
    } else {
      process.stderr.write(`⛩ plan-review: error after decision already emitted — ${msg}\n`);
    }
  });
}
