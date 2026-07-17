// global-hooks/reviewers.mjs
import { parseVerdict, runCodexReview, runGrokReview } from "./panel-lib.mjs";
import { resolveConfig, displayName, readReviewerCooldown, recordReviewerCooldown } from "./config-store.mjs";
import { review as defaultReview } from "./review-client.mjs";
import { withConcurrencyLimit } from "./concurrency-limit.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- reviewer availability -----------------------------------------------------------------
// A reviewer that is out of quota/credits or auth-broken must FAIL FAST AND SAY SO — never make
// every gate re-run the same doomed call (each one burning its retry backoff + timeout) until the
// plan resets. On a classified quota/auth failure we record a short global cooldown
// (config-store); while it lasts, the reviewer is skipped instantly with an explicit note.
const COOLDOWN_KINDS = new Set(["quota", "auth"]);

const unavailableLabel = (kind) => (kind === "auth" ? "auth failed (re-auth needed)" : "out of quota/credits");

// CLI reviewers (codex/grok) fail with free-text spawn errors, not HTTP statuses. Sniff those
// into the same quota/auth taxonomy — conservative word-boundary matches only.
export function classifyReviewerFailureText(text) {
  const s = String(text || "");
  if (/\b(quota|usage limit|rate.?limit|insufficient credits?|out of credits|plan limit|credit balance)\b/i.test(s)) return "quota";
  if (/\b(401|unauthorized|invalid_grant|not logged in|logged out|sign-?in required|login required|re-?authenticate)\b/i.test(s)) return "auth";
  return null;
}

function withAvailability(name, display, runImpl, { now = Date.now } = {}) {
  return async (args) => {
    const cooldown = readReviewerCooldown(name, { now: now() });
    if (cooldown) {
      const minutesLeft = Math.max(1, Math.ceil((Number(cooldown.until) - now()) / 60_000));
      return {
        name: display,
        error: `${unavailableLabel(cooldown.kind)} — skipped without retry (cooldown ${minutesLeft} min left; ${cooldown.detail})`,
        errorKind: cooldown.kind,
        skipped: "cooldown"
      };
    }
    const result = await runImpl(args);
    if (result?.error) {
      const kind = result.errorKind || classifyReviewerFailureText(result.error);
      if (COOLDOWN_KINDS.has(kind)) {
        recordReviewerCooldown(name, kind, result.error, { now: now() });
        return { ...result, error: `${unavailableLabel(kind)} — ${result.error}`, errorKind: kind };
      }
    }
    return result;
  };
}

const STRICT = "\n\nIMPORTANT: respond with ONLY a first line of `ALLOW: <reason>` or `BLOCK: <reason>`. No preamble, no code fences.";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
export const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");

export function latestCodexRoot() {
  let entries; try { entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d)); } catch { return null; }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function codexAdapter(env = process.env) {
  return { name: "codex", reviewIdentity: { kind: "codex-cli", model: readCodexCliModel(env) }, async run({ system, user, cwd, env = process.env }) {
    const codexRoot = latestCodexRoot();
    if (!codexRoot) return { name: "Codex", error: "codex plugin not found" };
    const codexEnv = { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA || CODEX_DATA };
    return runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt: `${system}\n\n${user}`, cwd, env: codexEnv });
  } };
}

// CLI reviewers have no API model/baseURL to key a cached ALLOW on, but the reviewer still changes
// underneath the cache. Track it with PLAIN FILE READS ONLY — never a spawn on the gate hot path:
//  • codex: the companion inherits the gate's CODEX_HOME, so the review model is the top-level
//    `model = "…"` in $CODEX_HOME/config.toml.
//  • grok: reviews run with GROK_HOME redirected to an ephemeral tmpdir (no config file applies),
//    so the review model is the CLI build's built-in default — the installed build's version.json
//    is the cheap proxy; a model change rides along with a build change.
// The signal rides in `model` so every consumer invalidates on it (plan gates hash the whole
// reviewIdentity; the stop gate fingerprints .model). "" when nothing is cheaply readable.
function readCodexCliModel(env) {
  try {
    const toml = fs.readFileSync(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"), "utf8");
    return (toml.match(/^model\s*=\s*"([^"]+)"/m) || [])[1] || "";
  } catch { return ""; }
}

function readGrokCliVersion(env) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(env.GROK_HOME || path.join(os.homedir(), ".grok"), "version.json"), "utf8"))?.version;
    return typeof v === "string" && v ? `grok-cli@${v}` : "";
  } catch { return ""; }
}

// Grok Build CLI (local x.ai harness, plan-billed — no API key). Same shape as codexAdapter:
// spawn headless, read-only (plan mode), parse the ALLOW/BLOCK verdict from stdout.
function grokAdapter(env = process.env) {
  return { name: "grok", reviewIdentity: { kind: "grok-cli", model: readGrokCliVersion(env) }, async run({ system, user, cwd, env = process.env }) {
    return runGrokReview({ prompt: `${system}\n\n${user}`, cwd, env });
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
export function resolveReviewers({ env = process.env, reviewImpl = defaultReview, reviewers, now } = {}) {
  const cfg = resolveConfig({ env, reviewers });
  // Every adapter (API and CLI) goes through the availability wrapper: cooldown pre-check first
  // (instant skip with a clear out-of-quota/auth note), classified-failure recording after.
  const wrap = (adapter) => ({
    ...adapter,
    run: withAvailability(adapter.name, displayName(adapter.name), adapter.run, now ? { now } : {})
  });
  return cfg.reviewers.map((name) => {
    if (name === "codex") return wrap(codexAdapter(env));
    if (name === "grok") return wrap(grokAdapter(env));
    const p = cfg.providers[name];
    const display = displayName(name);
    return wrap({
      name,
      // Non-secret cache identity for gates that remember an ALLOW. A reviewer name alone is not
      // enough: changing the model or endpoint must invalidate an earlier decision for unchanged
      // bytes. Keep credentials/headers out of this public metadata.
      reviewIdentity: {
        kind: "api",
        model: p.model || "",
        baseURL: p.baseURL || "",
        thinking: p.thinking ?? null,
        temperature: p.temperature ?? null
      },
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
        if (!r.ok) return { name: display, error: `${r.error.kind}: ${r.error.detail}`, errorKind: r.error.kind };
        let v = extractVerdict(r.text), raw = r.text, usage = r.usage;
        if (!v) {
          const r2 = await call(user + STRICT);
          if (!r2.ok) return { name: display, error: `${r2.error.kind}: ${r2.error.detail}`, errorKind: r2.error.kind };
          v = extractVerdict(r2.text); raw = r2.text; usage = r2.usage;   // bill the retry, not the first call
        }
        if (!v) return { name: display, error: "unparseable verdict", raw };
        return { name: display, verdict: v.verdict, firstLine: v.firstLine, raw, model: p.model, usage: usage ?? null };
      }
    });
  });
}
