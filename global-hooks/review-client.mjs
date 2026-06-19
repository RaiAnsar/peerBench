// global-hooks/review-client.mjs
// OpenAI-compatible reviewer. READ-ONLY by omission: body never has tools/tool_choice.
const DEFAULT_TIMEOUT_MS = 90_000;
export async function review({ baseURL, apiKey, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, temperature = 0, headers = {}, thinking, fetchImpl }) {
  if (!apiKey) return { ok: false, error: { kind: "nokey", detail: "no api key" } };
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  const safeHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !["authorization", "content-type"].includes(k.toLowerCase())));
  try {
    resp = await doFetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...safeHeaders },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature, stream: false, ...(thinking === "disabled" || thinking === "enabled" ? { thinking: { type: thinking } } : {}) }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` } };
  }
  let json;
  try { json = await resp.json(); } catch { return { ok: false, error: { kind: "parse", detail: "non-JSON response" } }; }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return { ok: false, error: { kind: "parse", detail: "no message content" } };
  return { ok: true, text: text.trim(), usage: json.usage ?? null };
}
