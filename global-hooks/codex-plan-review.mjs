#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: DUAL Codex+Grok panel review of the plan
// (strict AND-pass). deny -> Claude revises and resubmits. Fails OPEN only
// when BOTH reviewers error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel, runCodexReview, runGrokReview } from "./panel-lib.mjs";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");

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

function latestCodexRoot() {
  let entries;
  try {
    entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d));
  } catch {
    return null;
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function buildPrompt(plan) {
  return [
    "<task>",
    "Review the implementation plan below that Claude Code is about to present to its user for approval.",
    "You have read access to the repository at the current working directory. Verify the plan's claims and file references against the actual code where relevant.",
    "Challenge correctness, completeness, missing edge cases, risky design choices, and anything that would force rework during implementation.",
    "Do NOT implement anything or modify files. This is review only.",
    "</task>",
    "",
    "<compact_output_contract>",
    "Your first line must be exactly one of:",
    "- ALLOW: <short reason>",
    "- BLOCK: <short reason>",
    "Do not put anything before that first line.",
    "If you block, follow the first line with a concise bullet list of the specific problems Claude must fix in the plan.",
    "</compact_output_contract>",
    "",
    "<policy>",
    "Use ALLOW when the plan is sound enough to execute, even if not perfect; mention minor suggestions after the ALLOW line.",
    "Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort if the plan shipped as-is.",
    "</policy>",
    "",
    "<plan>",
    plan,
    "</plan>"
  ].join("\n");
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    // fall through
  }

  const plan = String(input.tool_input?.plan ?? "").trim();
  if (!plan) {
    decision("allow", "No plan content to review.");
    return;
  }

  const codexRoot = latestCodexRoot();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prompt = buildPrompt(plan);

  const codexEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || CODEX_DATA,
    ...(input.session_id ? { CODEX_COMPANION_SESSION_ID: input.session_id } : {})
  };

  const [codex, grok] = await Promise.all([
    codexRoot
      ? runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt, cwd, env: codexEnv })
      : Promise.resolve({ name: "Codex", error: "codex plugin not found" }),
    runGrokReview({ prompt, cwd, env: process.env })
  ]);

  const panel = combinePanel(codex, grok);

  if (panel.decision === "fail-open") {
    decision("allow", `Review panel unavailable (${panel.summary}); plan allowed without review.`, `⛩ plan panel skipped: ${panel.summary.slice(0, 200)}`);
    return;
  }

  if (panel.decision === "block") {
    decision(
      "deny",
      `Review panel found issues that must be fixed before this plan can be presented:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address these findings, then call ExitPlanMode again.`
    );
    return;
  }

  decision("allow", `Review panel approved the plan. ${panel.summary}`);
}

main().catch((error) => {
  decision("allow", `Plan panel errored (${error instanceof Error ? error.message : String(error)}); plan allowed without review.`);
});
