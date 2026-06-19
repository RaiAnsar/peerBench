import { extractVerdict } from "./reviewers.mjs";

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NUDGES = 2;
const TOOL_RESULT_CAP = 50_000;

export async function agenticReview({
  baseURL, apiKey, model, system, user,
  temperature = 0, headers = {}, tools,
  mode = "verdict",
  maxSteps = DEFAULT_MAX_STEPS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, debug = false
}) {
  const zeroDiag = { steps: 0, filesRead: [], toolBytes: 0, lastReqBytes: 0, rounds: [] };
  if (!apiKey) return { ok: false, error: { kind: "nokey", detail: "no api key" }, diag: zeroDiag };
  if (!tools?.schemas || typeof tools.execute !== "function") {
    return { ok: false, error: { kind: "config", detail: "tools {schemas, execute} required" }, diag: zeroDiag };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const safeHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !["authorization", "content-type"].includes(k.toLowerCase())));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const filesRead = [];
  const rounds = [];                              // per-round diagnostics
  let nudges = 0, toolBytes = 0, lastReqBytes = 0, stepsRun = 0;
  const dlog = (...a) => { if (debug) console.error(`[agentic ${model}]`, ...a); };
  const diag = () => ({ steps: stepsRun, filesRead: filesRead.slice(), toolBytes, lastReqBytes, rounds: rounds.slice() });

  try {
    for (let step = 0; step < maxSteps; step++) {
      stepsRun = step + 1;
      const body = JSON.stringify({ model, messages, tools: tools.schemas, tool_choice: "auto", temperature, stream: false });
      lastReqBytes = body.length;
      dlog(`step ${step}: reqKB=${(lastReqBytes / 1024) | 0} toolKB=${(toolBytes / 1024) | 0} msgs=${messages.length}`);
      let resp;
      const t0 = Date.now();
      try {
        resp = await doFetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...safeHeaders },
          body, signal: controller.signal
        });
      } catch (e) {
        const kind = e?.name === "AbortError" ? "timeout" : "network";
        dlog(`step ${step}: FETCH ${kind.toUpperCase()} after ${Date.now() - t0}ms reqKB=${(lastReqBytes / 1024) | 0}: ${e?.message}`);
        rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, error: `${kind}: ${e?.message}` });
        return { ok: false, error: { kind, detail: String(e?.message || e).slice(0, 300) }, diag: diag() };
      }
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        dlog(`step ${step}: HTTP ${resp.status} reqKB=${(lastReqBytes / 1024) | 0}`);
        rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, error: `http ${resp.status}` });
        return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${b.slice(0, 200)}` }, diag: diag() };
      }
      let json;
      try { json = await resp.json(); } catch { return { ok: false, error: { kind: "parse", detail: "non-JSON response" }, diag: diag() }; }
      const msg = json?.choices?.[0]?.message;
      if (!msg) return { ok: false, error: { kind: "parse", detail: "no message in response" }, diag: diag() };

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const toolNames = toolCalls.map((t) => t.function?.name).join(",") || "-";
      dlog(`step ${step}: ${Date.now() - t0}ms finish=${json?.choices?.[0]?.finish_reason} tools=${toolNames} reqKB=${(lastReqBytes / 1024) | 0}`);
      rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, finish: json?.choices?.[0]?.finish_reason, tools: toolNames });

      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
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
          const capped = String(result).slice(0, TOOL_RESULT_CAP);
          toolBytes += capped.length;
          messages.push({ role: "tool", tool_call_id: tc.id, content: capped });
        }
        continue;
      }

      // No tool calls → check mode before verdict logic.
      const content = msg.content ?? "";
      if (mode === "report") {
        return { ok: true, report: content, steps: stepsRun, filesRead, usage: json.usage ?? null, diag: diag() };
      }
      const v = extractVerdict(content);
      if (v) {
        return { ok: true, verdict: v.verdict, firstLine: v.firstLine, raw: content, steps: stepsRun, filesRead, usage: json.usage ?? null, diag: diag() };
      }
      if (nudges < MAX_NUDGES) {
        nudges++;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "Finish now: your reply's first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`." });
        continue;
      }
      return { ok: false, error: { kind: "parse", detail: "no verdict after nudges" }, raw: content, diag: diag() };
    }
    return { ok: false, error: { kind: "maxsteps", detail: `no verdict within ${maxSteps} steps` }, diag: diag() };
  } finally {
    clearTimeout(timer);
  }
}
