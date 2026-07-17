#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: reviewer-registry panel review of the plan
// (strict AND-pass). deny -> Claude revises and resubmits. Fails OPEN only
// when ALL reviewers error.
import fs from "node:fs";
import { combinePanel } from "./panel-lib.mjs";
import { isBenchDisabled as defaultIsBenchDisabled, sessionKeyFromInput } from "./config-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { parseSeverity } from "./deep-review.mjs";
import { execFileSync } from "node:child_process";
import {
  PLAN_REVIEW_POLICY_VERSION,
  beginPlanReview,
  completePlanReview,
  planApprovalIdentity,
  planCycleAdvisory,
  readPlanCycle,
  sha256,
  truthy,
  waitForPlanReview
} from "./plan-gate-state.mjs";

const HOOK_KIND = "exit-plan-mode";
const PLAN_TARGET = "inline-plan";

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
      "Complete ONE exhaustive discovery pass before deciding, and never stop after the first blocker. Enumerate every verified independent blocking issue from that pass; group sibling manifestations under their shared root cause and do not impose a finding-count cap. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW (minor notes may follow the first line). " +
      "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
      "Only high/critical issues block the plan — medium/low are advisory.",
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
  env = process.env,
  input: inputOverride,
  emitter = createEmitter()
} = {}) {
  // All decisions route through this invocation's emit-once guard (H1).
  const decision = (permissionDecision, reason, systemMessage) =>
    emitter.emit(decisionPayload(permissionDecision, reason, systemMessage));

  const input = inputOverride ?? readInput();
  const sessionKey = sessionKeyFromInput(input, env);

  const plan = String(input.tool_input?.plan ?? "").trim();
  if (!plan) {
    decision("allow", "No plan content to review.");
    return;
  }

  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const ws = workspaceRoot(cwd);              // git top-level — matches where /bench:off writes the marker + the stop/push gates
  if (isBenchDisabledImpl(ws)) return;         // bench layer disabled for this workspace

  let reviewers;
  try { reviewers = resolveReviewersImpl({ env }); }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    decision("allow", `Plan panel unavailable (${msg}); plan allowed without review.`, `⛩ plan panel skipped: ${msg.slice(0, 250)}`);
    return;
  }
  const approvalKey = planApprovalIdentity({
    policy: PLAN_REVIEW_POLICY_VERSION,
    hookKind: HOOK_KIND,
    target: PLAN_TARGET,
    contentDigest: sha256(plan),
    reviewers
  });
  const emitCompleted = (completed) => {
    const outcome = completed?.outcome;
    const payload = completed?.payload || {};
    if (outcome === "block") {
      const detail = payload.detail || payload.summary || "(no details)";
      const cycle = Number(payload.cycle) || 1;
      decision(
        "deny",
        `[${payload.badge || "review✗"}] Exhaustive review pass found issues that must be fixed before this plan can be presented (automatic repair cycle ${cycle}/3):\n\n${detail}\n\n${payload.skipNotes?.length ? `${payload.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address ALL findings in one complete update, then call ExitPlanMode again.`,
        `⛩ bench plan-review BLOCKED — cycle ${cycle}/3 [${payload.badge || "review✗"}]\n${String(detail).slice(0, 1200)}`
      );
      return true;
    }
    if (outcome === "advisory") {
      const advisory = planCycleAdvisory(readPlanCycle(ws, sessionKey));
      decision("allow", advisory, `⛩ bench plan-review: ${advisory.slice(0, 1800)}`);
      return true;
    }
    if (outcome === "superseded") {
      decision(
        "deny",
        "This plan review was superseded by a newer plan revision or reset before it could commit. Submit the current complete plan once more; no repair-cycle slot was consumed.",
        "⛩ bench plan-review: stale review discarded; resubmit the current complete plan."
      );
      return true;
    }
    if (outcome === "fail-open") {
      decision("allow", payload.reason || "Plan panel unavailable; plan allowed without review.", payload.systemMessage);
      return true;
    }
    if (outcome === "allow") {
      decision("allow", payload.reason || "Exact plan revision approved by the review panel.", payload.systemMessage);
      return true;
    }
    return false;
  };

  let flight;
  for (;;) {
    flight = beginPlanReview(ws, sessionKey, {
      hookKind: HOOK_KIND,
      target: PLAN_TARGET,
      identity: approvalKey,
      refresh: truthy(env.BENCH_PLAN_REVIEW_REFRESH),
      resetNonce: env.BENCH_PLAN_CYCLE_RESET,
      sessionScoped: true
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
      const advisory = planCycleAdvisory(remaining);
      decision("allow", advisory, `⛩ bench plan-review: ${advisory.slice(0, 1800)}`);
      return;
    }
    decision("allow", "Exact plan revision already approved by this reviewer/model/policy configuration.");
    return;
  }
  if (flight.role === "exhausted") {
    const advisory = planCycleAdvisory(flight.cycle.state);
    decision("allow", advisory, `⛩ bench plan-review: ${advisory.slice(0, 1800)}`);
    return;
  }
  if (flight.role === "completed") {
    if (emitCompleted(flight.result)) return;
    decision("allow", "Plan review completed without a reusable result; submit again to re-validate.");
    return;
  }
  const reviewTicket = flight.ticket;

  const { system, user } = buildPrompt(plan);

  const results = await Promise.all(reviewers.map(async (reviewer) => {
    try { return await reviewer.run({ system, user, cwd: ws, env }); }
    catch (error) {
      return { name: reviewer.name || "reviewer", error: error instanceof Error ? error.message : String(error) };
    }
  }));
  // Severity-gate the plan gate: block only on HIGH+ findings; medium/low/none are advisory.
  const panel = combinePanel(results, { blockMinSeverity: "high" });

  try {
    writeTraceImpl(ws, {
      gate: "plan",
      ws,
      sessionKey,
      // FIX 3: attach the parsed severity so the statusline can render a sub-threshold
      // plan BLOCK as `~` (advisory) rather than `✗` (mirrors spec-review-run's trace).
      reviewers: results.map(({ raw, ...m }) => ({ ...m, severity: parseSeverity(raw, m.verdict) })),
      systemPrompt: system,
      userPrompt: user,
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""]))
    });
  } catch (e) {
    // trace is best-effort — never block over it, but say so instead of swallowing (D3).
    process.stderr.write(`⛩ plan-review: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  if (panel.decision === "fail-open") {
    const reason = `[${panel.badge}] Review panel unavailable (${panel.summary}); plan allowed without review.`;
    const systemMessage = `⛩ plan panel skipped [${panel.badge}]: ${panel.summary.slice(0, 200)}`;
    const completed = completePlanReview(ws, sessionKey, reviewTicket, {
      status: "fail-open",
      payload: { reason, systemMessage }
    });
    if (!emitCompleted(completed)) decision("allow", reason, systemMessage);
    return;
  }

  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    const completed = completePlanReview(ws, sessionKey, reviewTicket, {
      status: "block",
      badge: panel.badge,
      findings: detail,
      payload: {
        badge: panel.badge,
        detail,
        summary: panel.summary,
        skipNotes: panel.skipNotes
      }
    });
    emitCompleted(completed);
    return;
  }

  // ALLOW — but if any sub-threshold BLOCKs were carried as advisories, surface them as a
  // note (they did NOT block: medium/low findings are advisory under severity-gating).
  let allowReason;
  let allowSystemMessage;
  if (panel.advisories && panel.advisories.length) {
    allowReason = `[${panel.badge}] Review panel approved the plan (advisories below are NOT blocking). ${panel.summary}`;
    allowSystemMessage = `⛩ plan panel: ALLOW [${panel.badge}] — advisories (not blocking): ${panel.advisories.join(" · ").slice(0, 220)}`;
  } else {
    allowReason = `[${panel.badge}] Review panel approved the plan. ${panel.summary}`;
  }
  const completed = completePlanReview(ws, sessionKey, reviewTicket, {
    status: "allow",
    payload: { reason: allowReason, systemMessage: allowSystemMessage }
  });
  emitCompleted(completed);
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
