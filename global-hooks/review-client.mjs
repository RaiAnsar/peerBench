// global-hooks/review-client.mjs
// OpenAI-compatible reviewer. READ-ONLY by omission: body never has tools/tool_choice.
import { allowedTemperatureFromError, isContentInspectionFailure, sanitizeForProviderInspection } from "./provider-compat.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
export async function review({ baseURL, apiKey, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, temperature = 0, headers = {}, thinking, fetchImpl }) {
  if (!apiKey) return { ok: false, error: { kind: "nokey", detail: "no api key" } };
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
  const request = (body) => doFetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...safeHeaders },
    body,
    signal: controller.signal
  });
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
