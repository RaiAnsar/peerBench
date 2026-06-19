import { resolveConfig } from "./config-store.mjs";
import { agenticReview } from "./agentic-review.mjs";
import { createReviewTools } from "./review-tools.mjs";
import { runCodexTask } from "./panel-lib.mjs";
import { latestCodexRoot, CODEX_DATA } from "./reviewers.mjs";
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

// hunt budget is larger than a gate review (open-ended exploration)
const HUNT_MAX_STEPS = 40;
const HUNT_TIMEOUT_MS = 12 * 60 * 1000;

// deep (investigate) budget — thinking ON, more steps, longer timeouts, relaxed per-round watchdog
const INVESTIGATE_MAX_STEPS = 60;
const INVESTIGATE_TIMEOUT_MS = 20 * 60 * 1000;
const INVESTIGATE_ROUND_MS = 240_000;     // thinking rounds are slow ON PURPOSE here; relax the 90s watchdog

export async function huntPanel({ cwd, seed, env = process.env, reviewImpl, codexImpl, deep = false }) {
  const cfg = resolveConfig({ env });
  const system = HUNT_SYSTEM;
  const user = buildHuntUser(seed);
  const debug = !!(env.GANG_DEBUG || env.GROK_DEBUG);

  const runOne = async (name) => {
    try {
      if (name === "codex") {
        const root = latestCodexRoot();
        if (!root) return { name: "Codex", findings: "", error: "codex plugin not found" };
        const codexEnv = { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA || CODEX_DATA };
        // runCodexTask keeps the raw findings (a hunt has no ALLOW/BLOCK verdict to parse)
        const r = await (codexImpl || runCodexTask)({ companionPath: path.join(root, "scripts", "codex-companion.mjs"), prompt: `${system}\n\n${user}`, cwd, env: codexEnv });
        if (debug) console.error(`[hunt codex] raw=${(r.raw || "").length}b error=${r.error || "-"}`);
        return { name: "Codex", findings: r.raw || "", error: r.raw ? null : (r.error || "no output") };
      }
      const p = cfg.providers[name];
      if (!p?.apiKey) return { name, findings: "", error: "no api key" };
      const res = await agenticReview({
        baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, temperature: p.temperature, headers: p.headers,
        system, user, tools: createReviewTools(cwd), mode: "report",
        thinking: deep ? "enabled" : p.thinking,
        maxSteps: deep ? INVESTIGATE_MAX_STEPS : HUNT_MAX_STEPS,
        timeoutMs: Math.max(p.timeoutMs || 0, deep ? INVESTIGATE_TIMEOUT_MS : HUNT_TIMEOUT_MS),
        maxRoundMs: deep ? INVESTIGATE_ROUND_MS : undefined,
        fetchImpl: reviewImpl, debug
      });
      const display = name === "kimi" ? "Kimi" : name === "mimo" ? "MiMo" : name;
      const d = res.diag || {};
      if (debug) console.error(`[hunt ${display}] ok=${res.ok} steps=${d.steps} files=${(d.filesRead || []).length} toolKB=${((d.toolBytes || 0) / 1024) | 0} lastReqKB=${((d.lastReqBytes || 0) / 1024) | 0} err=${res.ok ? "-" : res.error.kind}`);
      return res.ok
        ? { name: display, findings: res.report, steps: res.steps, filesRead: res.filesRead, diag: res.diag, error: null }
        : { name: display, findings: "", diag: res.diag, error: `${res.error.kind}: ${res.error.detail}` };
    } catch (e) {
      return { name, findings: "", error: String(e?.message || e).slice(0, 300) };
    }
  };

  return Promise.all(cfg.reviewers.map(runOne));
}
