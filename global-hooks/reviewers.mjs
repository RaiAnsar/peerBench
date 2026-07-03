// global-hooks/reviewers.mjs
import { parseVerdict, runCodexReview } from "./panel-lib.mjs";
import { resolveConfig, displayName } from "./config-store.mjs";
import { review as defaultReview } from "./review-client.mjs";
import { withConcurrencyLimit } from "./concurrency-limit.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STRICT = "\n\nIMPORTANT: respond with ONLY a first line of `ALLOW: <reason>` or `BLOCK: <reason>`. No preamble, no code fences.";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
export const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");

export function latestCodexRoot() {
  let entries; try { entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d)); } catch { return null; }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function codexAdapter() {
  return { name: "codex", async run({ system, user, cwd, env = process.env }) {
    const codexRoot = latestCodexRoot();
    if (!codexRoot) return { name: "Codex", error: "codex plugin not found" };
    const codexEnv = { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA || CODEX_DATA };
    return runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt: `${system}\n\n${user}`, cwd, env: codexEnv });
  } };
}

// Scan EVERY line (skip filler / code-fence / blank) for the first ALLOW:/BLOCK: line.
// Lines inside a ``` fence are ignored so model examples can't trigger a false verdict.
export function extractVerdict(text) {
  const s = String(text ?? "").trim();
  // Fast path: the INSTRUCTED format is the verdict on the first line — accept it directly so no
  // code-fence tracking (which can mis-toggle on nested/unbalanced fences) can hide it. Found by the hunt.
  const first = s.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first.startsWith("ALLOW:") || first.startsWith("BLOCK:")) return parseVerdict(s);
  let inFence = false;
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (t.startsWith("ALLOW:") || t.startsWith("BLOCK:")) return parseVerdict(s.slice(s.indexOf(line)));
  }
  return null;
}

// NOTE (v1 limitation): parallel provider calls fail-fast on rate limits; no backoff/retry beyond the one verdict-format retry below.
export function resolveReviewers({ env = process.env, reviewImpl = defaultReview, reviewers } = {}) {
  const cfg = resolveConfig({ env, reviewers });
  return cfg.reviewers.map((name) => {
    if (name === "codex") return codexAdapter();
    const p = cfg.providers[name];
    const display = displayName(name);
    return {
      name,
      async run({ system, user, cwd, env: runEnv }) {
        if (!p.apiKey) return { name: display, error: "no api key" };
        // Bound in-flight calls across ALL gate processes (z.ai per-key concurrency cap) so bursts
        // queue instead of 429-ing — the way OpenCode is naturally serialized. No-op when concurrency=0.
        // Each slot is pinned to one key (slot i → key i % keyCount) so no single key exceeds its cap;
        // when the limiter is off / failed open (slotIdx null) we fall back to the whole pool.
        const pool = p.apiKeys?.length ? p.apiKeys : [p.apiKey];
        const call = (u) => withConcurrencyLimit(
          { name, slots: p.concurrency, staleMs: p.timeoutMs, timeoutMs: p.timeoutMs },
          (slotIdx) => {
            const keys = slotIdx == null ? pool : [pool[slotIdx % pool.length]];
            return reviewImpl({ baseURL: p.baseURL, apiKey: keys[0], apiKeys: keys, model: p.model, system, user: u, temperature: p.temperature, headers: p.headers, timeoutMs: p.timeoutMs, thinking: p.thinking });
          }
        );
        let r = await call(user);
        if (!r.ok) return { name: display, error: `${r.error.kind}: ${r.error.detail}` };
        let v = extractVerdict(r.text), raw = r.text, usage = r.usage;
        if (!v) {
          const r2 = await call(user + STRICT);
          if (!r2.ok) return { name: display, error: `${r2.error.kind}: ${r2.error.detail}` };
          v = extractVerdict(r2.text); raw = r2.text; usage = r2.usage;   // bill the retry, not the first call
        }
        if (!v) return { name: display, error: "unparseable verdict", raw };
        return { name: display, verdict: v.verdict, firstLine: v.firstLine, raw, model: p.model, usage: usage ?? null };
      }
    };
  });
}
