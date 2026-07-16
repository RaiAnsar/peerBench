import { resolveConfig, displayName } from "./config-store.mjs";
import { agenticReview } from "./agentic-review.mjs";
import { createReviewTools } from "./review-tools.mjs";
import { withConcurrencyLimit } from "./concurrency-limit.mjs";
import { runCodexTask, runGrokTask } from "./panel-lib.mjs";
import { latestCodexRoot, CODEX_DATA, extractVerdict } from "./reviewers.mjs";
import { parseSeverity, stripThink } from "./deep-review.mjs";
import path from "node:path";

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

// Spec-review mode (capability G) — a DEEP, repo-aware review of an implementation
// plan/spec document. Unlike the fast content-only plan-file gate, the reviewer may
// read the repo to judge the plan against the real code. Produces a VERDICT line plus
// a structured findings tail the runner can parse into {findingCount, severity}.
export const SPEC_REVIEW_SYSTEM =
  "You are reviewing an implementation plan/spec document AGAINST the real repository, READ-ONLY, via the provided tools. " +
  "Verify the plan's claims (file paths, function names, behaviors, dependencies, ordering) against the actual code. " +
  "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>` — BLOCK only for issues that would cause wrong behavior, " +
  "significant rework, or a broken build if executed as written. " +
  "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
  "Then list each concrete finding on its own line starting with `- ` (file:line + the precise problem). " +
  "Ground every claim in code you actually read — no speculation.";

export function buildSpecReviewUser(filePath, content) {
  return `<plan_document file="${filePath}">\n${String(content ?? "")}\n</plan_document>\n\n` +
    "Review this plan/spec against the repository. Read whatever files you need to verify it.";
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

// Run the full configured panel deep on a spec, returning per-reviewer
// { name, verdict, severity, findingCount, findings }. Repo-aware (uses huntPanel's
// agentic tools) but seeded with the spec text and a verdict-producing system prompt.
export async function specReviewPanel({ cwd, filePath, content, env = process.env, deep = true } = {}) {
  const results = await huntPanel({
    cwd, env, deep, budgetMs: DEEP_REVIEW_BUDGET_MS,
    system: SPEC_REVIEW_SYSTEM,
    user: buildSpecReviewUser(filePath, content)
  });
  return results.map((r) => {
    const parsed = parseSpecFindings(r.findings);
    return {
      name: r.name,
      verdict: r.error ? null : parsed.verdict,
      severity: r.error ? "none" : parsed.severity,
      findingCount: r.error ? 0 : parsed.findingCount,
      findings: r.findings || "",
      error: r.error || null
    };
  });
}

// Push-review mode (capability H) — a DEEP, repo-aware review of the commits ABOUT TO BE
// PUSHED, given as a commit list + diff. Unlike the fast content-only pre-push gate, the
// reviewer may read the repo READ-ONLY to catch cross-file bugs / regressions these commits
// introduce. Same VERDICT+SEVERITY+findings contract as the spec-review so the runner parses
// it identically via parseSpecFindings.
export const PUSH_REVIEW_SYSTEM =
  "You are reviewing the commits ABOUT TO BE PUSHED, provided as a commit list + diff, AGAINST the real repository, READ-ONLY, via the provided tools. " +
  "Scour the repo for cross-file bugs, regressions, or unsafe changes these commits introduce — read whatever files you need to confirm a claim. " +
  "If a previous assistant message is provided, treat it as claims and scope clues only, not proof; compare those claims against the pushed commits and repository. " +
  "Pay special attention to claimed coverage that may only be implemented on one of several code paths or data sources. " +
  "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>` — BLOCK only for a concrete bug, regression, security issue, or unsafe change " +
  "that must be fixed before these commits are pushed. " +
  "Then, on its own line, output `SEVERITY: none|low|medium|high|critical` (the worst issue you found; `none` if clean). " +
  "Then list each concrete finding on its own line starting with `- ` (file:line + the precise problem). " +
  "Ground every claim in code you actually read — no speculation.";

export function buildPushReviewUser(range, content, { assistantContext = "" } = {}) {
  const context = String(assistantContext ?? "").trim();
  const contextBlock = context
    ? `\n\n<previous_assistant_message_context>\n${context}\n</previous_assistant_message_context>`
    : "";
  return `<push range="${range}">\n${String(content ?? "")}\n</push>${contextBlock}\n\n` +
    "Review these about-to-be-pushed commits against the repository. Read whatever files you need to verify them. " +
    "The previous assistant message, when present, is claims/context only; do not treat it as proof.";
}

// Run the full configured panel deep on a set of pushed commits, returning per-reviewer
// { name, verdict, severity, findingCount, findings }. Repo-aware (huntPanel's agentic tools)
// but seeded with the commit list + diff and the push verdict-producing system prompt. The
// shape mirrors specReviewPanel exactly so spec-review-run can reuse the same summarizer.
export async function pushReviewPanel({ cwd, range, content, env = process.env, deep = true, assistantContext = "" } = {}) {
  const results = await huntPanel({
    cwd, env, deep, budgetMs: DEEP_REVIEW_BUDGET_MS,
    system: PUSH_REVIEW_SYSTEM,
    user: buildPushReviewUser(range, content, { assistantContext })
  });
  return results.map((r) => {
    const parsed = parseSpecFindings(r.findings);
    return {
      name: r.name,
      verdict: r.error ? null : parsed.verdict,
      severity: r.error ? "none" : parsed.severity,
      findingCount: r.error ? 0 : parsed.findingCount,
      findings: r.findings || "",
      error: r.error || null
    };
  });
}

// hunt budget is larger than a gate review (open-ended exploration)
const HUNT_MAX_STEPS = 40;
const HUNT_TIMEOUT_MS = 12 * 60 * 1000;

// deep (investigate) budget — thinking ON, more steps, longer timeouts, relaxed per-round watchdog
const INVESTIGATE_MAX_STEPS = 60;
const INVESTIGATE_TIMEOUT_MS = 20 * 60 * 1000;
const INVESTIGATE_ROUND_MS = 240_000;     // thinking rounds are slow ON PURPOSE here; relax the 90s watchdog

// deep-review GATE budget (spec/push review on Stop). Distinct from hunt/investigate: a gate must land
// PROMPTLY or Claude has already moved on and the block is skipped. This is a HARD wall-clock cap on
// BOTH the codex and API reviewers — deep exploration still happens, just time-boxed. Env-tunable.
// hunt/investigate never pass budgetMs, so their full 12/20/25-min budgets are untouched.
const DEEP_REVIEW_BUDGET_MS = Number(process.env.BENCH_DEEP_REVIEW_BUDGET_MS) || 10 * 60 * 1000;

export async function huntPanel({ cwd, seed, env = process.env, reviewImpl, codexImpl, grokImpl, deep = false, budgetMs, system = HUNT_SYSTEM, user }) {
  const cfg = resolveConfig({ env });
  const userMsg = user || buildHuntUser(seed);
  const debug = !!env.BENCH_DEBUG;

  const runOne = async (name) => {
    const display = displayName(name);
    try {
      if (name === "codex") {
        const root = latestCodexRoot();
        if (!root) return { name: "Codex", findings: "", error: "codex plugin not found" };
        const codexEnv = { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA || CODEX_DATA };
        // runCodexTask keeps the raw findings (a hunt has no ALLOW/BLOCK verdict to parse).
        // budgetMs (gate path only) hard-caps codex's agentic wall-clock; omitted for hunt/investigate.
        const r = await (codexImpl || runCodexTask)({ companionPath: path.join(root, "scripts", "codex-companion.mjs"), prompt: `${system}\n\n${userMsg}`, cwd, env: codexEnv, ...(budgetMs ? { timeoutMs: budgetMs } : {}) });
        if (debug) console.error(`[hunt codex] raw=${(r.raw || "").length}b error=${r.error || "-"}`);
        return { name: "Codex", findings: r.raw || "", error: r.raw ? null : (r.error || "no output") };
      }
      if (name === "grok") {
        // Grok Build CLI — its own agentic harness explores the repo read-only (plan mode), plan-billed.
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
          // Deep reviews flip thinking ON — but ONLY for providers whose thinking param is a live
          // toggle (disabled↔enabled, e.g. GLM/Qwen). A provider with thinking:null (K3 — the param
          // is unsupported; MiMo/MiniMax — always-on) must STAY omitted, or the deep/agentic path
          // reintroduces a field the fast path correctly drops → K3 rejects it and every deep gate
          // for kimi hard-fails (all three reviewers caught this on the panel's first run).
          thinking: deep ? (p.thinking == null ? null : "enabled") : p.thinking,
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

  return Promise.all(cfg.reviewers.map(runOne));
}
