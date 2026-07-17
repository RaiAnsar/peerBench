// global-hooks/config-store.mjs
// Env-INDEPENDENT config + shared dir. Both execution contexts must resolve
// the same paths/config, so nothing here reads CLAUDE_PLUGIN_DATA.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// SINGLE SOURCE OF TRUTH for API-backed reviewers. Adding or swapping a model is ONE entry here
// (+ its <NAME>_API_KEY in .keys, then `node scripts/load-keys.mjs`). Everything downstream —
// KNOWN_REVIEWERS, display names, the keys loaded by load-keys, the provider config — is DERIVED
// from this object, so there are no parallel lists to keep in sync. Disable a model by dropping it
// from the active set (companion.json `reviewers` / `/bench:reviewers`); its config stays here.
const DEFAULTS = {
  // Kimi K3 (launched 2026-07-16; `k3` is the coding-plan endpoint's id for it). K3 rules differ
  // from K2.x: temperature/top_p are FIXED server-side and must be OMITTED from requests
  // (temperature: null = omit), the K2.x `thinking` param is NOT supported (always-thinking model;
  // reasoning arrives separately in reasoning_content, so .content stays clean), and
  // reasoning_effort currently only supports its default "max" (omitted). Slower than K2.6
  // (~28 tok/s, thinking always on) → longer timeout.
  kimi: { displayName: "Kimi", baseURL: "https://api.kimi.com/coding/v1", model: "k3", keyEnv: "KIMI_API_KEY",
          temperature: null, thinking: null, thinkingEnv: "KIMI_THINKING",
          headers: { "User-Agent": "claude-cli/1.0.83 (external, cli)" },
          timeoutMs: 420_000 },  // 7 min
  // MiMo (Xiaomi) — currently DISABLED (token plan exhausted) but kept wired so it's a one-word
  // re-add (`/bench:reviewers ... mimo`). Earned its slot: uniquely caught secret/PII/deploy-hygiene issues.
  mimo: { displayName: "MiMo", baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY",
          temperature: 0, thinking: null, thinkingEnv: "MIMO_THINKING",
          headers: {}, timeoutMs: 180_000 },  // 3 min
  // GLM (z.ai coding plan) — OpenAI-compatible /chat/completions. z.ai sheds 429/1305 above ~3
  // concurrent PER KEY; measured clean at 2-3, but slot release/re-acquire briefly overlaps under
  // continuous churn, so we cap at 2/key for margin (bursts queue instead of 429). Override per key
  // with GLM_CONCURRENCY_PER_KEY or set the total directly with GLM_CONCURRENCY.
  glm: { displayName: "GLM", baseURL: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.2", keyEnv: "GLM_API_KEY",
         temperature: 0.6, thinking: "disabled", thinkingEnv: "GLM_THINKING",
         concurrencyPerKey: 2, headers: {}, timeoutMs: 300_000 },  // 5 min
  // Qwen (Alibaba MaaS token-plan, ap-southeast-1) — OpenAI-compatible /compatible-mode (NOT the
  // /apps/anthropic endpoint; our review-client speaks OpenAI /chat/completions). Override
  // QWEN_BASE_URL / QWEN_MODEL in .keys if your key targets a different plan/workspace or model id.
  qwen: { displayName: "Qwen", baseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", keyEnv: "QWEN_API_KEY",
          temperature: 0.6, thinking: "disabled", thinkingEnv: "QWEN_THINKING",
          headers: {}, timeoutMs: 300_000 },  // 5 min
  // MiniMax (flat coding plan, sk-cp- key). OpenAI-compatible /chat/completions works as a drop-in.
  // M3 is a reasoning model whose thinking can't be disabled and leaks inline as <think>…</think> in
  // content — review-client strips it. Flat plan → thinking tokens are free (better reviews, no cost).
  // Tested clean at 6 concurrent, so no per-key concurrency cap needed. temperature 1.0 per MiniMax's
  // recommended sampling for M-series reasoning models.
  minimax: { displayName: "MiniMax", baseURL: "https://api.minimax.io/v1", model: "MiniMax-M3", keyEnv: "MINIMAX_API_KEY",
             temperature: 1.0, thinking: null, thinkingEnv: "MINIMAX_THINKING",
             headers: {}, timeoutMs: 300_000 }  // 5 min
};
// CLI-backed reviewers have no API-key config, so they live outside DEFAULTS:
//  - codex shells out to the codex-plugin-cc companion (ChatGPT plan billing).
//  - grok shells out to the local Grok Build CLI (`grok`, installed via x.ai/cli/install.sh) —
//    Grok-plan billing, no metered API key. Runs read-only via --permission-mode plan.
const CODEX = "codex";
const GROK = "grok";
export const PROVIDER_NAMES = Object.keys(DEFAULTS);                 // API-backed providers (for load-keys)
export const KNOWN_REVIEWERS = [...PROVIDER_NAMES, CODEX, GROK];
const DISPLAY = { ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.displayName || k])), [CODEX]: "Codex", [GROK]: "Grok" };
export function displayName(name) { return DISPLAY[name] || name; }
// Fallback only — the active set lives in companion.json (currently codex+grok+kimi). The fallback
// stays API-key-only (CLI reviewers need their own installed/authed harness) and must track the
// panel Rai actually runs: GLM was retired for Grok, so a lost companion.json degrades to the two
// keyed API reviewers, never to a retired provider.
const DEFAULT_REVIEWERS = ["kimi", "minimax"];
export function sharedRoot() {
  return process.env.BENCH_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared");
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function hardenSharedDataPermissions({ root = sharedRoot() } = {}) {
  const hardenedDirs = [], hardenedFiles = [];
  const walk = (dir) => {
    let entries = [];
    ensurePrivateDir(dir);
    hardenedDirs.push(dir);
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
    }
  };
  walk(root);
  const companion = path.join(root, "companion.json");
  try {
    if (fs.statSync(companion).isFile()) {
      fs.chmodSync(companion, 0o600);
      hardenedFiles.push(companion);
    }
  } catch { /* companion is absent */ }
  return { root, hardenedDirs, hardenedFiles };
}

export function writePrivateFileAtomic(file, content) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}
// The canonical per-workspace KEY (`<slug>-<hash>`) — the ownership identity of a workspace's
// state. Slug AND hash both come from the CANONICAL path, so a workspace reached via a
// differently-named symlink resolves to the same key (otherwise the slug differed while the hash
// matched → split). Exported so surfacing paths (the statusline) can VERIFY a trace/finding belongs
// to the workspace it's being shown for, instead of trusting the directory it was read from — the
// guard against cross-project finding mixups.
export function wsKey(ws) {
  let canonical = ws; try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(canonical) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}
export function workspaceStateDir(ws) {
  return path.join(sharedRoot(), "state", wsKey(ws));
}

export function normalizeSessionId(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "null" || raw === "undefined") return null;
  if (/^session-[0-9a-f]{16}$/i.test(raw)) return raw.toLowerCase();
  return `session-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

export function sessionKeyFromInput(input = {}, env = process.env) {
  // Session identity comes ONLY from this invocation's input (the hook JSON's session_id, or the
  // statusline stdin). Do NOT fall back to AMBIENT env session vars (CLAUDE_SESSION_ID /
  // CODEX_COMPANION_SESSION_ID): those are inherited from whatever parent runtime launched the
  // process, so they (a) collapse two distinct chats under one runtime onto the SAME key — defeating
  // the very per-chat isolation this enables — and (b) make behavior non-deterministic (the suite
  // dies when run inside a Codex/Claude session). `env` is kept only as an explicit opt-in override
  // via BENCH_SESSION_ID (peerBench's own var, never ambient), useful for manual/test pinning.
  return normalizeSessionId(
    input?.session_id
      ?? input?.sessionId
      ?? input?.session?.id
      ?? input?.workspace?.session_id
      ?? input?.workspace?.sessionId
      ?? env?.BENCH_SESSION_ID
  );
}

function readFileConfig() { try { return JSON.parse(fs.readFileSync(path.join(sharedRoot(), "companion.json"), "utf8")); } catch { return {}; } }

function truthy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// Persist the active reviewer selection to the env-independent companion.json (atomic).
export function setReviewers(list, { root = sharedRoot() } = {}) {
  const reviewers = [...new Set((Array.isArray(list) ? list : []).filter((n) => KNOWN_REVIEWERS.includes(n)))];
  if (!reviewers.length) throw new Error(`no valid reviewers in [${list}]; known: ${KNOWN_REVIEWERS.join(", ")}`);
  ensurePrivateDir(root);
  const file = path.join(root, "companion.json");
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cur = {}; }
  cur.reviewers = reviewers;
  writePrivateFileAtomic(file, `${JSON.stringify(cur, null, 2)}\n`);
  return reviewers;
}
const GLOBAL_DISABLE = (root) => path.join(root || sharedRoot(), "disabled-global");
const WS_DISABLE = (ws) => path.join(workspaceStateDir(ws), "disabled");

// --- reviewer availability cooldowns -----------------------------------------------------------
// When a reviewer fails with a QUOTA (402/429-exhausted/credit keywords) or AUTH (401/403) error,
// every gate in every session would otherwise re-run the same doomed call — burning its full retry
// backoff and timeout per gate, per stop, until the plan resets. Record a short global cooldown so
// later gates skip the reviewer INSTANTLY with a clear "out of quota — skipped" note instead.
// TTLs are deliberately short: quota state is re-probed within minutes of a plan reset/top-up, and
// a mis-classified transient (e.g. a saturated concurrency cap) costs at most one quiet window.
const COOLDOWN_TTL_MS = { quota: 5 * 60_000, auth: 10 * 60_000 };
const COOLDOWNS = (root) => path.join(root || sharedRoot(), "reviewer-cooldowns.json");

function readCooldownMap(root) {
  try { return JSON.parse(fs.readFileSync(COOLDOWNS(root), "utf8")) || {}; } catch { return {}; }
}

export function readReviewerCooldown(name, { root, now = Date.now() } = {}) {
  const entry = readCooldownMap(root)[name];
  return entry && Number(entry.until) > now ? entry : null;
}

export function recordReviewerCooldown(name, kind, detail, { root, now = Date.now(), ttlMs } = {}) {
  const ttl = Number(ttlMs) || COOLDOWN_TTL_MS[kind] || COOLDOWN_TTL_MS.quota;
  const map = readCooldownMap(root);
  map[name] = { kind, detail: String(detail || "").slice(0, 200), until: now + ttl, ts: now };
  for (const [key, value] of Object.entries(map)) {
    if (!(Number(value?.until) > now)) delete map[key];
  }
  try { writePrivateFileAtomic(COOLDOWNS(root), `${JSON.stringify(map, null, 2)}\n`); } catch { /* best-effort cache */ }
  return map[name];
}

export function clearReviewerCooldowns({ root, name } = {}) {
  if (!name) {
    try { fs.rmSync(COOLDOWNS(root), { force: true }); } catch { /* best-effort */ }
    return;
  }
  const map = readCooldownMap(root);
  if (!(name in map)) return;
  delete map[name];
  try { writePrivateFileAtomic(COOLDOWNS(root), `${JSON.stringify(map, null, 2)}\n`); } catch { /* best-effort */ }
}

// reviewed-head marker: the last HEAD the stop gate reviewed up to. Shared by the stop gate
// (advances it on a clean ALLOW; diffs HEAD against it) AND the pre-push gate (bootstraps it on
// the first `git` command of a session, BEFORE any commit — so committed-and-pushed work is still
// reviewed on the first stop, where `@{upstream}` would already have advanced past it).
const REVIEWED_HEAD = (ws) => path.join(workspaceStateDir(ws), "reviewed-head");
export function readReviewedHead(ws) {
  try { return fs.readFileSync(REVIEWED_HEAD(ws), "utf8").trim() || null; } catch { return null; }
}
export function writeReviewedHead(ws, sha) {
  if (!sha) return;
  try {
    ensurePrivateDir(sharedRoot());
    ensurePrivateDir(workspaceStateDir(ws));
    fs.writeFileSync(REVIEWED_HEAD(ws), `${sha}\n`);
  } catch { /* best-effort marker */ }
}

// Disabled if the global marker exists OR this workspace's marker exists.
export function isBenchDisabled(ws, { root } = {}) {
  try { if (fs.existsSync(GLOBAL_DISABLE(root))) return true; }
  catch (err) { process.stderr.write(`⛩ bench: could not check disable marker (${err.code || err}); treating as enabled.\n`); }
  try { if (ws && fs.existsSync(WS_DISABLE(ws))) return true; }
  catch (err) { process.stderr.write(`⛩ bench: could not check disable marker (${err.code || err}); treating as enabled.\n`); }
  return false;
}

// scope: "global" writes/removes the global marker; otherwise the workspace marker.
export function setBenchDisabled(ws, disabled, { scope = "workspace", root } = {}) {
  const file = scope === "global" ? GLOBAL_DISABLE(root) : WS_DISABLE(ws);
  ensurePrivateDir(root || sharedRoot());
  ensurePrivateDir(path.dirname(file));
  if (disabled) fs.writeFileSync(file, `disabled ${scope}\n`);
  else { try { fs.rmSync(file); } catch { /* already gone */ } }
  return { scope, disabled, file };
}

export function resolveConfig({ env = process.env, reviewers: reviewersOverride } = {}) {
  const file = readFileConfig();
  const providers = {};
  for (const [name, d] of Object.entries(DEFAULTS)) {
    const f = file.providers?.[name] || {};
    const envThinking = d.thinkingEnv && d.thinkingEnv in env ? env[d.thinkingEnv] : undefined;
    const rawThinking = f.thinking !== undefined ? f.thinking : (envThinking !== undefined ? envThinking : (d.thinking || null));
    const thinking = rawThinking === "" ? null : rawThinking;
    const model = env[`${name.toUpperCase()}_MODEL`] || f.model || d.model;
    // null is MEANINGFUL (omit temperature from requests — K3 fixes it server-side); only an
    // absent/undefined default falls back to 0.
    const temperature = typeof f.temperature === "number" || f.temperature === null
      ? f.temperature
      : (d.temperature !== undefined ? d.temperature : 0);
    // Key POOL: env var (comma-separated) > companion apiKeys[] > companion single apiKey. apiKey
    // stays the first key for back-compat; review-client rotates the pool on a 429 (per-key cap).
    const envKey = env[d.keyEnv];
    const apiKeys = (envKey ? envKey.split(",").map((s) => s.trim()).filter(Boolean) : null)
      || (Array.isArray(f.apiKeys) && f.apiKeys.length ? f.apiKeys : null)
      || (f.apiKey ? [f.apiKey] : []);
    // Total in-flight cap = keys × per-key cap (env GLM_CONCURRENCY overrides). 0 → unlimited.
    const perKey = Number(env[`${name.toUpperCase()}_CONCURRENCY_PER_KEY`]) || f.concurrencyPerKey || d.concurrencyPerKey || 0;
    const concurrency = Number(env[`${name.toUpperCase()}_CONCURRENCY`]) || (perKey ? Math.max(1, apiKeys.length) * perKey : 0);
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model,
      apiKey: apiKeys[0] || "",
      apiKeys,
      concurrency,
      temperature,
      headers: { ...(d.headers || {}), ...(f.headers || {}) },
      timeoutMs: typeof f.timeoutMs === "number" ? f.timeoutMs : (d.timeoutMs ?? 90_000),
      thinking
    };
  }
  // If an explicit override is provided (non-empty array), use it; otherwise fall back to file/default.
  const sel = Array.isArray(reviewersOverride) && reviewersOverride.length
    ? reviewersOverride
    : (Array.isArray(file.reviewers) && file.reviewers.length ? file.reviewers : DEFAULT_REVIEWERS);
  const suppressCodexReviewer = truthy(env.BENCH_SUPPRESS_CODEX_REVIEWER) || truthy(env.PEERBENCH_SUPPRESS_CODEX_REVIEWER);
  const reviewers = [...new Set(sel.filter((n) => KNOWN_REVIEWERS.includes(n)))]
    .filter((n) => !(suppressCodexReviewer && n === CODEX));
  return { reviewers: reviewers.length ? reviewers : DEFAULT_REVIEWERS, providers };
}
