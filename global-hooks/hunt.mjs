import { resolveConfig, displayName } from "./config-store.mjs";
import { agenticReview } from "./agentic-review.mjs";
import { createReviewTools } from "./review-tools.mjs";
import { withConcurrencyLimit } from "./concurrency-limit.mjs";
import { runGrokTask } from "./panel-lib.mjs";
import { extractVerdict, resolveReviewers, withAvailability } from "./reviewers.mjs";
import { parseSeverity, stripThink } from "./deep-review.mjs";

export const HUNT_SYSTEM =
  "You are an expert bug hunter exploring a repository READ-ONLY via the provided tools. " +
  "Find CONCRETE bugs: for each, give the file:line, the precise mechanism, and a minimal repro or trigger condition. " +
  "Ground every claim in code you actually read with the tools — no speculation, nothing 'on vibes'. " +
  "If given a symptom, trace it to the root cause. Prefer correctness, security, and silent-failure bugs. " +
  "End with a prioritized findings list (most severe first), or state clearly if you found no significant bugs.";

export function buildHuntUser(seed) {
  return seed && String(seed).trim()
    ? `Investigate this (symptom / area / question):\n\n${String(seed).trim()}`
    : "Do a broad bug-hunt sweep across this repository. Pick high-risk areas (auth, state transitions, error handling, money/time math, escalation/alerting) and dig in.";
}

// Debug mode — a SPECIFIC reported failure (error, stack trace, failing test, wrong output),
// not a broad sweep. Reproduce → root cause → minimal fix. Fast tier (thinking off), like hunt.
export const DEBUG_SYSTEM =
  "You are an expert debugger working a SPECIFIC reported failure (a bug, error, stack trace, failing test, or wrong output). " +
  "Explore the repository READ-ONLY via the provided tools. Reproduce the failure from the code, trace it to its ROOT CAUSE " +
  "(give the exact file:line and the precise mechanism), and propose the MINIMAL concrete fix. " +
  "Ground every claim in code you actually read — no speculation. If more than one cause is plausible, rank them by likelihood with the evidence for each. " +
  "End with two lines: `ROOT CAUSE: <file:line — mechanism>` and `FIX: <the minimal change>`.";

export function buildDebugUser(seed) {
  return `Debug this specific failure — trace it to the root cause and propose the minimal fix:\n\n${String(seed ?? "").trim() || "(no failure described)"}`;
}

// Spec-review mode (capability G) — a bounded review of an implementation plan/spec document.
// The exact document is supplied to a one-shot panel. Produces a VERDICT line plus a structured
// findings tail the runner can parse into {findingCount, severity}.
export const SPEC_REVIEW_SYSTEM =
  "You are reviewing an implementation plan/spec document using only the supplied document. Do not use tools or explore the repository. " +
  "Check the plan for concrete internal contradictions, unsafe ordering, missing rollback behavior, or claims that would make the implementation fail. " +
  "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>` — BLOCK only for issues that would cause wrong behavior, " +
  "significant rework, or a broken build if executed as written. " +
  "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
  "Then list each concrete finding on its own line starting with `- ` (file:line + the precise problem). " +
  "Ground every claim in code you actually read — no speculation.";

export function buildSpecReviewUser(filePath, content) {
  return `<plan_document file="${filePath}">\n${String(content ?? "")}\n</plan_document>\n\n` +
    "Review this exact plan/spec content.";
}

// Parse a single reviewer's spec-review output into { verdict, severity, findingCount }.
// Falls back gracefully when the model omits the structured tail.
export function parseSpecFindings(text) {
  const s = stripThink(String(text ?? ""));   // reasoning must not drive verdict/severity/finding-count
  const v = extractVerdict(s);
  const verdict = v?.verdict ?? null;
  let severity = parseSeverity(s, verdict);   // shared severity extractor (deep-review.mjs)
  const bulletCount = (s.match(/^\s*-\s+\S/gm) || []).length;
  // FIX 2 (deep-path consistency): a BLOCK phrased in PROSE (no `- ` bullets) yields
  // bulletCount 0, which would make shouldRewake (it needs findingCount > 0) skip the
  // rewake even at high severity — inconsistent with the fast gate, which blocks. Count a
  // BLOCK verdict as at least one finding so any high BLOCK rewakes on the deep path too.
  const findingCount = Math.max(bulletCount, verdict === "BLOCK" ? 1 : 0);
  if (severity === "none" && findingCount > 0 && verdict !== "BLOCK") severity = "low";
  return { verdict, severity, findingCount };
}

// Gate reviews are deliberately single-turn. Multi-turn repository exploration belongs to
// explicit hunt/investigate commands and must never hold a release transaction open.
export const LIGHTWEIGHT_REVIEW_TIMEOUT_MS = 60_000;

export async function lightweightVerdictPanel({
  cwd,
  system,
  user,
  env = process.env,
  cooldownScope,
  resolveReviewersImpl = resolveReviewers,
  timeoutMs = LIGHTWEIGHT_REVIEW_TIMEOUT_MS
} = {}) {
  const reviewers = resolveReviewersImpl({ env });
  const results = await Promise.all(reviewers.map((reviewer) => reviewer.run({
    system,
    user,
    cwd,
    env,
    timeoutMs,
    cooldownScope
  })));
  return results.map((r) => {
    const findings = r.raw || r.findings || r.firstLine || "";
    const parsed = parseSpecFindings(findings);
    return {
      name: r.name,
      verdict: r.error ? null : parsed.verdict,
      severity: r.error ? "none" : parsed.severity,
      findingCount: r.error ? 0 : parsed.findingCount,
      findings,
      error: r.error || null,
      errorKind: r.errorKind || null,
      skipped: r.skipped || null,
      latencyMs: r.latencyMs ?? null,
      cooldownUntil: r.cooldownUntil ?? null
    };
  });
}

export async function specReviewPanel({
  cwd,
  filePath,
  content,
  env = process.env,
  resolveReviewersImpl,
  timeoutMs = LIGHTWEIGHT_REVIEW_TIMEOUT_MS
} = {}) {
  return lightweightVerdictPanel({
    cwd,
    env,
    resolveReviewersImpl,
    timeoutMs,
    cooldownScope: `spec-review:${cwd}`,
    system: SPEC_REVIEW_SYSTEM,
    user: buildSpecReviewUser(filePath, content)
  });
}

// Push-review mode (capability H) — a bounded review of the commits ABOUT TO BE PUSHED, given as
// a commit list + exact diff. Same VERDICT+SEVERITY+findings contract as the spec-review so the
// runner parses it identically via parseSpecFindings.
export const PUSH_REVIEW_SYSTEM =
  "You are reviewing the commits ABOUT TO BE PUSHED using only the supplied commit list and exact diff. Do not use tools or explore the repository. " +
  "Find concrete bugs, regressions, or unsafe changes visible in this evidence. " +
  "If a previous assistant message is provided, treat it as claims and scope clues only, not proof; compare those claims against the supplied commits and diff. " +
  "Pay special attention to claimed coverage that may only be implemented on one of several code paths or data sources. " +
  "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>` — BLOCK only for a concrete bug, regression, security issue, or unsafe change " +
  "that must be fixed before these commits are pushed. " +
  "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
  "Then list each concrete finding on its own line starting with `- ` (file:line + the precise problem). " +
  "Ground every claim in the supplied evidence — no speculation.";

export function buildPushReviewUser(range, content, { assistantContext = "" } = {}) {
  const context = String(assistantContext ?? "").trim();
  const contextBlock = context
    ? `\n\n<previous_assistant_message_context>\n${context}\n</previous_assistant_message_context>`
    : "";
  return `<push range="${range}">\n${String(content ?? "")}\n</push>${contextBlock}\n\n` +
    "Review these exact about-to-be-pushed commits and diff. " +
    "The previous assistant message, when present, is claims/context only; do not treat it as proof.";
}

// Run one bounded panel call on a set of pushed commits, returning per-reviewer
// { name, verdict, severity, findingCount, findings }. The exact commit list and diff are embedded.
// Repository exploration belongs to explicit hunt/investigate commands, never a release gate. The
// shape mirrors specReviewPanel exactly so spec-review-run can reuse the same summarizer.
export async function pushReviewPanel({
  cwd,
  range,
  content,
  env = process.env,
  assistantContext = "",
  resolveReviewersImpl,
  timeoutMs = LIGHTWEIGHT_REVIEW_TIMEOUT_MS
} = {}) {
  return lightweightVerdictPanel({
    cwd,
    env,
    resolveReviewersImpl,
    timeoutMs,
    cooldownScope: `push-review:${cwd}`,
    system: PUSH_REVIEW_SYSTEM,
    user: buildPushReviewUser(range, content, { assistantContext })
  });
}

// hunt budget is larger than a gate review (open-ended exploration)
const HUNT_MAX_STEPS = 40;
const HUNT_TIMEOUT_MS = 8 * 60 * 1000;

// deep (investigate) budget — thinking ON, more steps, longer timeouts, relaxed per-round watchdog
const INVESTIGATE_MAX_STEPS = 60;
const INVESTIGATE_TIMEOUT_MS = 15 * 60 * 1000;
const INVESTIGATE_ROUND_MS = 240_000;     // thinking rounds are slow ON PURPOSE here; relax the 90s watchdog

export async function huntPanel({ cwd, seed, env = process.env, reviewImpl, grokImpl, deep = false, budgetMs, cooldownScope = `hunt:${cwd}`, system = HUNT_SYSTEM, user }) {
  const cfg = resolveConfig({ env });
  const userMsg = user || buildHuntUser(seed);
  const debug = !!env.BENCH_DEBUG;

  const runOne = async (name) => {
    const display = displayName(name);
    try {
      if (name === "grok") {
        // Grok Build CLI — its agentic harness explores the repo under peerBench's OS write sandbox.
        const r = await (grokImpl || runGrokTask)({ prompt: `${system}\n\n${userMsg}`, cwd, env, ...(budgetMs ? { timeoutMs: budgetMs } : {}) });
        if (debug) console.error(`[hunt grok] raw=${(r.raw || "").length}b error=${r.error || "-"}`);
        return { name: "Grok", findings: r.raw || "", error: r.raw ? null : (r.error || "no output") };
      }
      const p = cfg.providers[name];
      if (!p?.apiKey) return { name: display, findings: "", error: "no api key" };
      // budgetMs (gate path) is a HARD cap that overrides the long deep/hunt budgets so the review lands
      // in time; without it, hunt/investigate keep their full budgets (Math.max floor of the provider default).
      const apiTimeout = budgetMs || Math.max(p.timeoutMs || 0, deep ? INVESTIGATE_TIMEOUT_MS : HUNT_TIMEOUT_MS);
      const pool = p.apiKeys?.length ? p.apiKeys : [p.apiKey];
      // Bound in-flight AGENTIC calls across ALL processes (hunts + gates across projects) so bursts queue
      // instead of 429-ing z.ai's per-key cap — the protection the simple stop-gate path already had, now on
      // the agentic path too (this path used to bypass it). Slot pins one key. No heartbeat, so staleMs must
      // exceed the full review; the slot-wait is capped at 90s so the gate stays prompt (429 retry is the net).
      const res = await withConcurrencyLimit(
        { name, slots: p.concurrency, staleMs: apiTimeout + 120_000, timeoutMs: Math.min(apiTimeout, 90_000) },
        (slotIdx) => agenticReview({
          baseURL: p.baseURL, apiKey: slotIdx == null ? pool[0] : pool[slotIdx % pool.length], model: p.model,
          temperature: p.temperature, headers: p.headers,
          system, user: userMsg, tools: createReviewTools(cwd), mode: "report",
          thinking: deep ? "enabled" : p.thinking,
          maxSteps: deep ? INVESTIGATE_MAX_STEPS : HUNT_MAX_STEPS,
          timeoutMs: apiTimeout,
          maxRoundMs: deep ? INVESTIGATE_ROUND_MS : undefined,
          fetchImpl: reviewImpl, debug
        })
      );
      const d = res.diag || {};
      if (debug) console.error(`[hunt ${display}] ok=${res.ok} steps=${d.steps} files=${(d.filesRead || []).length} toolKB=${((d.toolBytes || 0) / 1024) | 0} lastReqKB=${((d.lastReqBytes || 0) / 1024) | 0} err=${res.ok ? "-" : res.error.kind}`);
      return res.ok
        ? { name: display, findings: res.report, steps: res.steps, filesRead: res.filesRead, diag: res.diag, error: null }
        : { name: display, findings: "", diag: res.diag, error: `${res.error.kind}: ${res.error.detail}` };
    } catch (e) {
      return { name: display, findings: "", error: String(e?.message || e).slice(0, 300) };
    }
  };

  return Promise.all(cfg.reviewers.map((name) => withAvailability(
    name,
    displayName(name),
    () => runOne(name),
    { env }
  )({ cwd, cooldownScope })));
}
