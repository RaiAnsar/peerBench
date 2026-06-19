import { extractVerdict } from "./reviewers.mjs";

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NUDGES = 2;
const TOOL_RESULT_CAP = 50_000;

export async function agenticReview({
  baseURL, apiKey, model, system, user,
  temperature = 0, headers = {}, tools,
  maxSteps = DEFAULT_MAX_STEPS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl
}) {
  if (!apiKey) return { ok: false, error: { kind: "nokey", detail: "no api key" } };
  if (!tools?.schemas || typeof tools.execute !== "function") {
    return { ok: false, error: { kind: "config", detail: "tools {schemas, execute} required" } };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const filesRead = [];
  let nudges = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      let resp;
      try {
        resp = await doFetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...headers },
          body: JSON.stringify({ model, messages, tools: tools.schemas, tool_choice: "auto", temperature, stream: false }),
          signal: controller.signal
        });
      } catch (e) {
        return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` } };
      }
      let json;
      try { json = await resp.json(); } catch { return { ok: false, error: { kind: "parse", detail: "non-JSON response" } }; }
      const msg = json?.choices?.[0]?.message;
      if (!msg) return { ok: false, error: { kind: "parse", detail: "no message in response" } };

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const name = tc.function?.name;
          let args = {};
          try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave args = {} */ }
          let result;
          try {
            result = await tools.execute(name, args);
            if (name === "read_file" && args?.path) filesRead.push(args.path);
          } catch (e) {
            result = `Error: ${String(e?.message || e).slice(0, 300)}`;
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, TOOL_RESULT_CAP) });
        }
        continue;
      }

      // No tool calls → the model should have given a verdict.
      const content = msg.content ?? "";
      const v = extractVerdict(content);
      if (v) {
        return { ok: true, verdict: v.verdict, firstLine: v.firstLine, raw: content, steps: step + 1, filesRead, usage: json.usage ?? null };
      }
      if (nudges < MAX_NUDGES) {
        nudges++;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "Finish now: your reply's first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`." });
        continue;
      }
      return { ok: false, error: { kind: "parse", detail: "no verdict after nudges" }, raw: content };
    }
    return { ok: false, error: { kind: "maxsteps", detail: `no verdict within ${maxSteps} steps` } };
  } finally {
    clearTimeout(timer);
  }
}
