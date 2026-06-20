#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: reviewer-registry panel review of the plan
// (strict AND-pass). deny -> Claude revises and resubmits. Fails OPEN only
// when ALL reviewers error.
import fs from "node:fs";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled } from "./config-store.mjs";
import { resolveReviewers } from "./reviewers.mjs";
import { writeTrace } from "./trace-store.mjs";
import { execFileSync } from "node:child_process";

function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function decision(permissionDecision, reason, systemMessage) {
  const out = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  emit(out);
}

export function buildPrompt(plan) {
  return {
    system: "You are reviewing an implementation plan from ONLY the text provided. Do not assume filesystem access. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW (minor notes may follow the first line).",
    user: `<plan>\n${plan}\n</plan>`
  };
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch (e) {
    // Malformed stdin → treat as empty, but say so on stderr instead of failing silently (found by the hunt).
    process.stderr.write(`⛩ plan-review: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
  }

  const plan = String(input.tool_input?.plan ?? "").trim();
  if (!plan) {
    decision("allow", "No plan content to review.");
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);              // git top-level — matches where /bench:off writes the marker + the stop/push gates
  if (isBenchDisabled(ws)) process.exit(0);    // bench layer disabled for this workspace
  const { system, user } = buildPrompt(plan);

  const results = await Promise.all(resolveReviewers().map((r) => r.run({ system, user, cwd: ws })));
  const panel = combinePanel(results);

  try {
    writeTrace(ws, {
      gate: "plan",
      ws,
      reviewers: results.map(({ raw, ...m }) => m),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch {
    // trace is best-effort
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

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  decision("allow", `Plan panel errored (${error instanceof Error ? error.message : String(error)}); plan allowed without review.`);
});
