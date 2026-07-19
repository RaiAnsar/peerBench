// global-hooks/review-client.mjs
// OpenAI-compatible reviewer. READ-ONLY by omission: body never has tools/tool_choice.
import { allowedTemperatureFromError, isContentInspectionFailure, sanitizeForProviderInspection } from "./provider-compat.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
// MiMo's coding-plan endpoint expects a coding-client User-Agent. Callers may override it.
export const REVIEW_USER_AGENT = "claude-cli/1.0.83 (external, cli)";
// Keep overload recovery bounded. Automatic review paths pass zero retries; explicit manual health
// or review calls may make one retry and honor Retry-After.
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_OVERLOAD_RETRIES = 1;
const BACKOFF_CAP_MS = 16_000;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  let timer;
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  const onAbort = () => {
    clearTimeout(timer);
    cleanup();
    reject(Object.assign(new Error("review timed out"), { name: "AbortError" }));
  };
  if (signal?.aborted) return onAbort();
  timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});
async function abortableSleep(ms, signal, sleepImpl) {
  // The production timer is cancellable, so a long Retry-After cannot keep the Node process alive
  // after the total request deadline. Injected test sleepers retain the generic race below.
  if (sleepImpl === sleep) return sleepImpl(ms, signal);
  if (signal.aborted) throw Object.assign(new Error("review timed out"), { name: "AbortError" });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("review timed out"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([sleepImpl(ms), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
async function readWithAbort(read, signal) {
  if (signal.aborted) throw Object.assign(new Error("review timed out"), { name: "AbortError" });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("review timed out"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(read), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function responseText(resp, signal) {
  try { return await readWithAbort(() => resp.text(), signal); }
  catch (error) {
    if (error?.name === "AbortError") throw error;
    return "";
  }
}
// attempt 0→~1s, 1→~2s … capped at ~16s, plus 0–1s jitter (skipped when Retry-After is explicit).
function overloadBackoffMs(attempt, retryAfterSec, jitter = Math.random()) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt) + Math.floor(jitter * 1000);
}
export function classifyHttpErrorKind(status, body = "") {
  const text = String(body || "");
  if (/\b(quota|usage balance exhausted|insufficient credits?|out of credits|plan limit|credit balance|payment required)\b/i.test(text)) return "quota";
  if (Number(status) === 402) return "quota";
  if (Number(status) === 401 || Number(status) === 403) return "auth";
  if (Number(status) === 429) return "rate";
  if (Number(status) === 503 || /\bservice (?:temporarily )?unavailable\b/i.test(text)) return "network";
  return "http";
}

export async function review({ baseURL, apiKey, apiKeys, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, temperature = 0, headers = {}, thinking, fetchImpl, sleepImpl = sleep, keyPick = Math.random, maxOverloadRetries = MAX_OVERLOAD_RETRIES }) {
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
    headers: { "Content-Type": "application/json", "User-Agent": REVIEW_USER_AGENT, Authorization: `Bearer ${keyPool[keyIdx % keyPool.length]}`, ...safeHeaders },
    body,
    signal: controller.signal
  });
  // Retry a 429/503: rotate to the next key (overflow), then jittered backoff if it still caps out, so
  // a capped call lands a free slot instead of becoming an error. Stops early if the overall timeout fires.
  const request = async (body) => {
    let r = await rawRequest(body);
    for (let attempt = 0; !r.ok && RETRYABLE_STATUS.has(r.status) && attempt < maxOverloadRetries && !controller.signal.aborted; attempt++) {
      keyIdx++;
      await abortableSleep(overloadBackoffMs(attempt, Number(r.headers?.get?.("retry-after"))), controller.signal, sleepImpl);
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
    try { errorBody = await responseText(resp, controller.signal); }
    catch (error) {
      clearTimeout(timer);
      return { ok: false, error: { kind: error?.name === "AbortError" ? "timeout" : "network", detail: String(error?.message || error).slice(0, 300) } };
    }
    const allowedTemperature = allowedTemperatureFromError(resp.status, errorBody);
    if (allowedTemperature != null && allowedTemperature !== activeTemperature) {
      activeTemperature = allowedTemperature;
      try {
        resp = await request(makeBody(system, user, activeTemperature));
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
      }
      if (resp.ok) errorBody = "";
      else {
        try { errorBody = await responseText(resp, controller.signal); }
        catch (error) {
          clearTimeout(timer);
          return { ok: false, error: { kind: error?.name === "AbortError" ? "timeout" : "network", detail: String(error?.message || error).slice(0, 300) } };
        }
      }
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
        let body2 = "";
        try { body2 = await responseText(resp, controller.signal); }
        catch (error) {
          clearTimeout(timer);
          return { ok: false, error: { kind: error?.name === "AbortError" ? "timeout" : "network", detail: String(error?.message || error).slice(0, 300) } };
        }
        clearTimeout(timer);
        return { ok: false, error: { kind: classifyHttpErrorKind(resp.status, body2), detail: `HTTP ${resp.status}: ${body2.slice(0, 200)}` } };
      }
    } else {
      clearTimeout(timer);
      return { ok: false, error: { kind: classifyHttpErrorKind(resp.status, errorBody), detail: `HTTP ${resp.status}: ${errorBody.slice(0, 200)}` } };
    }
  }
  let json;
  try { json = await readWithAbort(() => resp.json(), controller.signal); }
  catch (error) {
    clearTimeout(timer);
    return { ok: false, error: { kind: error?.name === "AbortError" ? "timeout" : "parse", detail: error?.name === "AbortError" ? "review timed out while reading the response" : "non-JSON response" } };
  }
  clearTimeout(timer);
  const raw = json?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return { ok: false, error: { kind: "parse", detail: "no message content" } };
  return { ok: true, text: stripThinking(raw), usage: json.usage ?? null };
}

// Some reasoning models emit thinking inline as
// <think>…</think> before the answer. Strip it so verdict parsing and displayed findings see only
// the real output; keep the original if stripping would leave nothing (e.g. a truncated think block).
function stripThinking(text) {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return stripped || text.trim();
}
