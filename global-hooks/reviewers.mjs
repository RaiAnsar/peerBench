import { parseVerdict, runGrokReview } from "./panel-lib.mjs";
import {
  configuredProviderSecrets,
  displayName,
  readReviewerCooldown,
  recordReviewerCooldown,
  resolveConfig
} from "./config-store.mjs";
import { review as defaultReview } from "./review-client.mjs";
import { redactProviderFailureData } from "./provider-error-redaction.mjs";

const STRICT = "\n\nRespond with only `ALLOW: <reason>` or `BLOCK: <reason>` on the first line.";
const COOLDOWN_KINDS = new Set(["quota", "auth", "rate", "timeout", "network"]);

export function classifyReviewerFailureText(text) {
  const value = String(text || "");
  if (/\b(402|payment required|usage balance exhausted|insufficient credits?|out of credits|plan limit|credit balance|quota exhausted)\b/i.test(value)) return "quota";
  if (/\b(401|403|unauthorized|forbidden|invalid_grant|not logged in|logged out|sign-?in required|login required|re-?authenticate)\b/i.test(value)) return "auth";
  if (/\b(429|rate.?limit|too many requests)\b/i.test(value)) return "rate";
  if (/\b(timed? out|timeout|operation aborted|deadline exceeded)\b/i.test(value)) return "timeout";
  if (/\b(503|service (?:temporarily )?unavailable|fetch failed|network(?: error| unavailable)?|connection (?:failed|reset|refused)|dns)\b/i.test(value)) return "network";
  return null;
}

const unavailableLabel = (kind) => ({
  auth: "authentication unavailable",
  quota: "quota exhausted",
  rate: "temporarily rate-limited",
  timeout: "timed out recently",
  network: "network unavailable"
}[kind] || "temporarily unavailable");

export function withAvailability(name, display, runImpl, { now = Date.now, env = process.env } = {}) {
  return async (args) => {
    const secrets = configuredProviderSecrets({ env });
    const at = now();
    const cooldown = readReviewerCooldown(name, { now: at, env, secrets });
    if (cooldown) {
      const minutesLeft = Math.max(1, Math.ceil((Number(cooldown.until) - at) / 60_000));
      return {
        name: display,
        error: `${unavailableLabel(cooldown.kind)} — skipped without a model call (${minutesLeft} min remaining)`,
        errorKind: cooldown.kind,
        skipped: "cooldown"
      };
    }

    let rawResult;
    try {
      rawResult = await runImpl(args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rawResult = { name: display, error: detail, errorKind: classifyReviewerFailureText(detail) || "runtime" };
    }
    const result = redactProviderFailureData(rawResult, { secrets });
    if (!result?.error) return result;
    const kind = COOLDOWN_KINDS.has(result.errorKind)
      ? result.errorKind
      : (classifyReviewerFailureText(result.error) || result.errorKind);
    if (COOLDOWN_KINDS.has(kind)) {
      recordReviewerCooldown(name, kind, result.error, { now: at, env, secrets });
      return { ...result, error: `${unavailableLabel(kind)} — ${result.error}`, errorKind: kind };
    }
    return result;
  };
}

export function extractVerdict(text) {
  const value = String(text ?? "").trim();
  const first = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first.startsWith("ALLOW:") || first.startsWith("BLOCK:")) return parseVerdict(value);
  let inFence = false;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) { inFence = !inFence; continue; }
    if (!inFence && (trimmed.startsWith("ALLOW:") || trimmed.startsWith("BLOCK:"))) {
      return parseVerdict(value.slice(value.indexOf(line)));
    }
  }
  return null;
}

function grokAdapter(env) {
  return {
    name: "grok",
    reviewIdentity: { kind: "grok-cli", model: "grok-build" },
    async run({ system, user, cwd, env: runEnv = env, timeoutMs = 45_000 }) {
      return runGrokReview({ prompt: `${system}\n\n${user}`, cwd, env: runEnv, timeoutMs });
    }
  };
}

function mimoAdapter(provider, reviewImpl) {
  const display = displayName("mimo");
  return {
    name: "mimo",
    reviewIdentity: { kind: "api", model: provider.model || "", baseURL: provider.baseURL || "" },
    async run({ system, user, timeoutMs = 45_000 }) {
      if (!provider.apiKey) return { name: display, error: "no API key", errorKind: "auth" };
      const budget = Math.max(1, Math.min(provider.timeoutMs || timeoutMs, timeoutMs));
      const deadline = Date.now() + budget;
      const call = async (prompt) => reviewImpl({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        apiKeys: provider.apiKeys,
        model: provider.model,
        system,
        user: prompt,
        temperature: provider.temperature,
        headers: provider.headers,
        timeoutMs: Math.max(1, deadline - Date.now()),
        thinking: provider.thinking,
        maxOverloadRetries: 0
      });
      let response = await call(user);
      if (!response.ok) return { name: display, error: `${response.error.kind}: ${response.error.detail}`, errorKind: response.error.kind };
      let verdict = extractVerdict(response.text);
      if (!verdict) {
        if (Date.now() >= deadline) return { name: display, error: "timeout: verdict-format retry budget exhausted", errorKind: "timeout" };
        response = await call(user + STRICT);
        if (!response.ok) return { name: display, error: `${response.error.kind}: ${response.error.detail}`, errorKind: response.error.kind };
        verdict = extractVerdict(response.text);
      }
      if (!verdict) return { name: display, error: "unparseable verdict" };
      return { name: display, ...verdict, model: provider.model, usage: response.usage ?? null };
    }
  };
}

export function resolveReviewers({ env = process.env, reviewImpl = defaultReview, reviewers, now } = {}) {
  const cfg = resolveConfig({ env, reviewers });
  const wrap = (adapter) => ({
    ...adapter,
    run: withAvailability(adapter.name, displayName(adapter.name), adapter.run, { env, ...(now ? { now } : {}) })
  });
  return cfg.reviewers.map((name) => name === "grok"
    ? wrap(grokAdapter(env))
    : wrap(mimoAdapter(cfg.providers.mimo, reviewImpl)));
}
