// global-hooks/trace-store.mjs
import { randomBytes } from "node:crypto";
import fs from "node:fs"; import path from "node:path";
import { normalizeSessionId, workspaceStateDir, wsKey } from "./config-store.mjs";
const CAP = 64 * 1024;
const cap = (s) => (typeof s === "string" ? s.slice(0, CAP) : s);
export function writeTrace(ws, trace, { now = Date.now() } = {}) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  fs.mkdirSync(dir, { recursive: true });
  const id = `${now}-${randomBytes(6).toString("hex")}`; // 48-bit random suffix: same-ms collision is negligible
  const sessionKey = normalizeSessionId(trace.sessionKey ?? trace.session_id ?? trace.sessionId);
  // Stamp the canonical owning workspace KEY into the record so a surfacing path can verify the
  // trace belongs to the workspace it's being shown for (cross-project mixup guard). `ws` keeps the
  // raw path for display; `wsKey` is the ownership identity that survives symlinks/relative paths.
  const record = { id, ts: new Date(now).toISOString(), gate: trace.gate, ws: trace.ws, wsKey: wsKey(ws), sessionKey: sessionKey || undefined, reviewers: trace.reviewers || [],
    systemPrompt: cap(trace.systemPrompt), userPrompt: cap(trace.userPrompt),
    rawResponses: Object.fromEntries(Object.entries(trace.rawResponses || {}).map(([k, v]) => [k, cap(v)])) };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return id;
}
export function readTrace(ws, id) { try { return JSON.parse(fs.readFileSync(path.join(workspaceStateDir(ws), "traces", `${id}.json`), "utf8")); } catch { return null; } }
export function listTraces(ws, limit = 20) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  files.sort().reverse();
  return files.slice(0, limit).map((f) => {
    const t = readTrace(ws, f.replace(/\.json$/, "")) || {};
    const summary = (t.reviewers || []).map((r) => `${r.name} ${r.verdict || `err(${r.error || "?"})`}`).join(" · ");
    return { id: t.id, ts: t.ts, gate: t.gate, summary };
  });
}
