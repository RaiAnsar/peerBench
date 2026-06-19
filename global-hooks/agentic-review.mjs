import { extractVerdict } from "./reviewers.mjs";

// Parse an OpenAI-compatible SSE chat stream into one assembled message.
// Returns { message: { content, tool_calls }, finish_reason, usage }.
async function readSSE(resp) {
  if (!resp.body) throw new Error("response has no body");   // clear error instead of a cryptic null TypeError (found by Kimi's own hunt)
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", finish = null, usage = null;
  const tc = [];  // tool_calls assembled by index
  const handleEvt = (evt) => {
    for (const line of evt.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === "string") content += d.content;
      if (Array.isArray(d.tool_calls)) {
        for (const td of d.tool_calls) {
          const i = td.index ?? 0;
          tc[i] = tc[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
          if (td.id) tc[i].id = td.id;
          if (td.function?.name) tc[i].function.name = td.function.name;
          if (td.function?.arguments) tc[i].function.arguments += td.function.arguments;
        }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, nl); buf = buf.slice(nl + 2);
        handleEvt(evt);
      }
    }
    // Flush: a final SSE event not terminated by a blank line (truncated/abrupt stream) would
    // otherwise be silently dropped — losing the last content + finish_reason → spurious
    // "no verdict"/timeout on a review that actually finished (found by the bench's own hunt).
    buf += decoder.decode();
    if (buf.trim()) handleEvt(buf);
  } finally { try { reader.releaseLock(); } catch { /* noop */ } }
  return { message: { content, tool_calls: tc.filter(Boolean) }, finish_reason: finish, usage };
}

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NUDGES = 2;
const TOOL_RESULT_CAP = 50_000;
const CONCLUDE_BUDGET = 120_000;   // tool-output bytes after which we force conclusion (kimi over-explores big repos) — conclude round drops the tools array entirely
const MAX_NET_RETRIES = 2;         // retry transient "fetch failed" (connection drops) — NOT genuine timeouts
const RETRY_BACKOFF_MS = 750;
const DEFAULT_ROUND_MS = 90_000;   // per-EXPLORATION-round cap: one runaway thinking round can't eat the whole budget

export async function agenticReview({
  baseURL, apiKey, model, system, user,
  temperature = 0, headers = {}, tools, thinking,
  mode = "verdict",
  maxSteps = DEFAULT_MAX_STEPS, timeoutMs = DEFAULT_TIMEOUT_MS, maxRoundMs = DEFAULT_ROUND_MS, fetchImpl, debug = false
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
  let nudges = 0, toolBytes = 0, lastReqBytes = 0, stepsRun = 0, concludeNudged = false, roundConclude = false;
  const dlog = (...a) => { if (debug) console.error(`[agentic ${model}]`, ...a); };
  const diag = () => ({ steps: stepsRun, filesRead: filesRead.slice(), toolBytes, lastReqBytes, rounds: rounds.slice() });

  try {
    for (let step = 0; step < maxSteps; step++) {
      stepsRun = step + 1;
      // Force conclusion once enough context is gathered or we're near the cap — otherwise some
      // models (kimi) read files forever and hit maxSteps with no output. tool_choice:"none" makes it answer.
      const force = roundConclude || toolBytes > CONCLUDE_BUDGET || step >= maxSteps - 2;
      if (force && !concludeNudged) {
        concludeNudged = true;
        messages.push({ role: "user", content: mode === "report"
          ? "You have gathered enough context. Do NOT call any more tools — write your final findings now, each with file:line."
          : "You have gathered enough context. Do NOT call any more tools — give your verdict now: the first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`." });
      }
      // On conclude (force): OMIT the tools array entirely — a model can't call tools that aren't
      // offered, so it MUST produce content. (tool_choice:"none" alone is ignored by some models,
      // e.g. kimi-k2.6, which then reads until maxSteps and drops out with "no verdict".)
      const body = JSON.stringify({ model, messages, temperature, stream: true,
        ...(force ? {} : { tools: tools.schemas, tool_choice: "auto" }),
        ...(thinking === "enabled" || thinking === "disabled" ? { thinking: { type: thinking } } : {}) });
      lastReqBytes = body.length;
      dlog(`step ${step}: reqKB=${(lastReqBytes / 1024) | 0} toolKB=${(toolBytes / 1024) | 0} msgs=${messages.length}${force ? " [conclude]" : ""}`);
      const t0 = Date.now();
      // Per-round watchdog on EXPLORATION rounds only — the conclude round gets the full remaining budget to synthesize.
      const useWatchdog = !force;
      const roundController = new AbortController();
      const roundTimer = useWatchdog ? setTimeout(() => roundController.abort(), maxRoundMs) : null;
      const signal = useWatchdog ? AbortSignal.any([controller.signal, roundController.signal]) : controller.signal;
      let resp, parsed, netErr = null;
      try {
        for (let attempt = 0; attempt <= MAX_NET_RETRIES; attempt++) {
          try {
            resp = await doFetch(`${baseURL}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...safeHeaders },
              body, signal
            });
            netErr = null; break;
          } catch (e) {
            netErr = e;
            if (e?.name === "AbortError") break;                // timeout (round or total) — don't retry
            if (attempt < MAX_NET_RETRIES) {
              dlog(`step ${step}: net attempt ${attempt + 1} failed (${e?.cause?.code || e?.message}); retry in ${RETRY_BACKOFF_MS}ms`);
              await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
            }
          }
        }
        if (!netErr && resp.ok) parsed = await readSSE(resp);   // may throw on mid-stream abort
      } catch (e) {
        netErr = e;
      } finally {
        if (roundTimer) clearTimeout(roundTimer);
      }
      // Watchdog tripped on THIS round (too slow) but total budget remains → force conclusion next round.
      if (netErr?.name === "AbortError" && roundController.signal.aborted && !controller.signal.aborted) {
        dlog(`step ${step}: ROUND EXCEEDED ${(maxRoundMs / 1000) | 0}s (${Date.now() - t0}ms) — forcing conclusion`);
        rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, error: `round-timeout >${(maxRoundMs / 1000) | 0}s` });
        roundConclude = true;
        continue;
      }
      if (netErr) {
        const kind = netErr?.name === "AbortError" ? "timeout" : "network";
        const cause = netErr?.cause ? ` cause=${netErr.cause.code || netErr.cause.message || String(netErr.cause).slice(0, 80)}` : "";
        dlog(`step ${step}: FETCH ${kind.toUpperCase()} after ${Date.now() - t0}ms reqKB=${(lastReqBytes / 1024) | 0}: ${netErr?.message}${cause}`);
        rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, error: `${kind}: ${netErr?.message}${cause}` });
        return { ok: false, error: { kind, detail: `${String(netErr?.message || netErr).slice(0, 200)}${cause}` }, diag: diag() };
      }
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        dlog(`step ${step}: HTTP ${resp.status} reqKB=${(lastReqBytes / 1024) | 0}`);
        rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, error: `http ${resp.status}` });
        return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${b.slice(0, 200)}` }, diag: diag() };
      }
      const msg = parsed.message;

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const toolNames = toolCalls.map((t) => t.function?.name).join(",") || "-";
      dlog(`step ${step}: ${Date.now() - t0}ms finish=${parsed.finish_reason} tools=${toolNames} reqKB=${(lastReqBytes / 1024) | 0}`);
      rounds.push({ step, ms: Date.now() - t0, reqBytes: lastReqBytes, finish: parsed.finish_reason, tools: toolNames });

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
        return { ok: true, report: content, steps: stepsRun, filesRead, usage: parsed.usage ?? null, diag: diag() };
      }
      const v = extractVerdict(content);
      if (v) {
        return { ok: true, verdict: v.verdict, firstLine: v.firstLine, raw: content, steps: stepsRun, filesRead, usage: parsed.usage ?? null, diag: diag() };
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
