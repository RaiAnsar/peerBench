// global-hooks/review-client.mjs
// OpenAI-compatible reviewer. READ-ONLY by omission: body never has tools/tool_choice.
import { allowedTemperatureFromError, isContentInspectionFailure, sanitizeForProviderInspection } from "./provider-compat.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
// Coding-plan endpoints (z.ai, etc.) throttle the bare Node/undici User-Agent with HTTP 429 — they
// expect a coding-client UA. Without this, GLM/Qwen/MiMo (provider headers: {}) 429'd every call
// while Kimi (which sets its own UA) worked. Providers can still override via their headers.
const DEFAULT_USER_AGENT = "claude-cli/1.0.83 (external, cli)";
// HTTP 429/503 here is mostly the z.ai coding-plan CONCURRENCY CAP (~2-3 in-flight per key, code
// 1305): peerbench fires GLM from every gate across every project onto one shared key, so the cap is
// blown constantly. The cure for a concurrency cap is patience — wait for an in-flight call to free a
// slot and retry. Exponential backoff to BACKOFF_CAP_MS with full jitter so the many concurrent gates
// (separate processes, no shared retry state) don't re-collide in lockstep. ponytail: a provider-side
// semaphore would convert 429→wait more cheaply, but it needs cross-process locking; revisit if jitter
// retry proves insufficient. Honors Retry-After when the provider sends one.
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_OVERLOAD_RETRIES = 5;
const BACKOFF_CAP_MS = 16_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// attempt 0→~1s, 1→~2s … capped at ~16s, plus 0–1s jitter (skipped when Retry-After is explicit).
function overloadBackoffMs(attempt, retryAfterSec, jitter = Math.random()) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt) + Math.floor(jitter * 1000);
}
export async function review({ baseURL, apiKey, apiKeys, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, temperature = 0, headers = {}, thinking, fetchImpl, sleepImpl = sleep, keyPick = Math.random }) {
  // Key POOL: a provider may ship several keys (z.ai caps concurrency PER KEY). Pick a random start
  // key so concurrent gates (separate processes) spread across keys, then rotate on each retry so a
  // capped key overflows to the next before we back off. apiKey stays supported for single-key callers.
  const keyPool = (Array.isArray(apiKeys) && apiKeys.length ? apiKeys : (apiKey ? [apiKey] : [])).filter(Boolean);
  if (!keyPool.length) return { ok: false, error: { kind: "nokey", detail: "no api key" } };
  let keyIdx = keyPool.length > 1 ? Math.floor(keyPick() * keyPool.length) : 0;
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const safeHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !["authorization", "content-type"].includes(k.toLowerCase())));
  const makeBody = (systemContent = system, userContent = user, bodyTemperature = temperature) => JSON.stringify({
    model,
    messages: [{ role: "system", content: systemContent }, { role: "user", content: userContent }],
    temperature: bodyTemperature,
    stream: false,
    ...(thinking === "disabled" || thinking === "enabled" ? { thinking: { type: thinking } } : {})
  });
  const rawRequest = (body) => doFetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_USER_AGENT, Authorization: `Bearer ${keyPool[keyIdx % keyPool.length]}`, ...safeHeaders },
    body,
    signal: controller.signal
  });
  // Retry a 429/503: rotate to the next key (overflow), then jittered backoff if it still caps out, so
  // a capped call lands a free slot instead of becoming an error. Stops early if the overall timeout fires.
  const request = async (body) => {
    let r = await rawRequest(body);
    for (let attempt = 0; !r.ok && RETRYABLE_STATUS.has(r.status) && attempt < MAX_OVERLOAD_RETRIES && !controller.signal.aborted; attempt++) {
      keyIdx++;
      await sleepImpl(overloadBackoffMs(attempt, Number(r.headers?.get?.("retry-after"))));
      r = await rawRequest(body);
    }
    return r;
  };
  let resp;
  let activeTemperature = temperature;
  try {
    resp = await request(makeBody(system, user, activeTemperature));
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
  }
  let errorBody = "";
  if (!resp.ok) {
    errorBody = await resp.text().catch(() => "");
    const allowedTemperature = allowedTemperatureFromError(resp.status, errorBody);
    if (allowedTemperature != null && allowedTemperature !== activeTemperature) {
      activeTemperature = allowedTemperature;
      try {
        resp = await request(makeBody(system, user, activeTemperature));
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
      }
      errorBody = resp.ok ? "" : await resp.text().catch(() => "");
    }
  }
  if (!resp.ok) {
    if (isContentInspectionFailure(resp.status, errorBody)) {
      try {
        resp = await request(makeBody(sanitizeForProviderInspection(system), sanitizeForProviderInspection(user), activeTemperature));
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
      }
      if (!resp.ok) {
        const body2 = await resp.text().catch(() => "");
        clearTimeout(timer);
        return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${body2.slice(0, 200)}` } };
      }
    } else {
      clearTimeout(timer);
      return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${errorBody.slice(0, 200)}` } };
    }
  }
  clearTimeout(timer);
  let json;
  try { json = await resp.json(); } catch { return { ok: false, error: { kind: "parse", detail: "non-JSON response" } }; }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return { ok: false, error: { kind: "parse", detail: "no message content" } };
  return { ok: true, text: text.trim(), usage: json.usage ?? null };
}
