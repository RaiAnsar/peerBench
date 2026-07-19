// global-hooks/config-store.mjs
// Env-INDEPENDENT config + shared dir. Both execution contexts must resolve
// the same paths/config, so nothing here reads CLAUDE_PLUGIN_DATA.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactProviderFailure, secretHeaderValues } from "./provider-error-redaction.mjs";

// Deliberately small reviewer registry. Expired plans do not remain selectable and cannot be
// resurrected by a stale companion.json. Grok is CLI-backed; MiMo is the only API-backed reviewer.
const DEFAULTS = {
  mimo: { displayName: "MiMo", baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY",
          temperature: 0, thinking: null, thinkingEnv: "MIMO_THINKING",
          headers: {}, timeoutMs: 45_000 }
};
const GROK = "grok";
export const PROVIDER_NAMES = Object.keys(DEFAULTS);
export const KNOWN_REVIEWERS = [GROK, ...PROVIDER_NAMES];
const DISPLAY = { grok: "Grok", mimo: "MiMo" };
export function displayName(name) { return DISPLAY[name] || name; }
const DEFAULT_REVIEWERS = ["grok", "mimo"];
export function sharedRoot() {
  return process.env.BENCH_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared");
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
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

function readFileConfig(root = sharedRoot()) { try { return JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8")); } catch { return {}; } }

const SECRET_ENV_NAME = /(?:^|_)(?:api_?key|access_?token|refresh_?token|authorization|auth|token|secret|password)$/i;
const SECRET_FIELD_NAME = /^(?:api_?key|apiKeys|access_?token|refresh_?token|authorization|auth|token|secret|password)$/i;

function addSecret(out, value, { commaSeparated = false } = {}) {
  if (typeof value !== "string" || !value) return;
  out.add(value);
  if (commaSeparated) for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) out.add(part);
  try {
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node)) {
        if (SECRET_FIELD_NAME.test(key)) {
          if (typeof child === "string") addSecret(out, child);
          else if (Array.isArray(child)) for (const entry of child) addSecret(out, entry);
        }
        if (child && typeof child === "object") visit(child);
      }
    };
    visit(JSON.parse(value));
  } catch { /* scalar credential */ }
}

export function configuredProviderSecrets({ env = process.env, root = sharedRoot() } = {}) {
  const values = new Set();
  const file = readFileConfig(root);
  for (const [name, defaults] of Object.entries(DEFAULTS)) {
    addSecret(values, env?.[defaults.keyEnv], { commaSeparated: true });
    const provider = file.providers?.[name] || {};
    addSecret(values, provider.apiKey);
    for (const key of Array.isArray(provider.apiKeys) ? provider.apiKeys : []) addSecret(values, key);
    for (const header of secretHeaderValues(provider.headers)) addSecret(values, header);
  }
  for (const [name, value] of Object.entries(env || {})) {
    if (SECRET_ENV_NAME.test(name)) addSecret(values, value, { commaSeparated: /API_?KEY$/i.test(name) });
  }
  return [...values];
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

const COOLDOWNS = (root) => path.join(root || sharedRoot(), "reviewer-cooldowns.json");
const COOLDOWN_TTL_MS = {
  quota: 24 * 60 * 60_000,
  auth: 24 * 60 * 60_000,
  rate: 15 * 60_000,
  timeout: 5 * 60_000,
  network: 2 * 60_000
};

function readCooldownMap(root) {
  try { return JSON.parse(fs.readFileSync(COOLDOWNS(root), "utf8")) || {}; } catch { return {}; }
}

function sanitizedCooldownMap(root, env, secrets = []) {
  const exact = [...configuredProviderSecrets({ root: root || sharedRoot(), env }), ...(Array.isArray(secrets) ? secrets : [secrets])];
  const source = readCooldownMap(root);
  const map = {};
  let changed = false;
  for (const [name, entry] of Object.entries(source && typeof source === "object" ? source : {})) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const detail = redactProviderFailure(entry.detail || "", { secrets: exact });
    map[name] = { ...entry, detail };
    if (detail !== entry.detail) changed = true;
  }
  return { map, exact, changed };
}

function persistCooldownMap(map, root) {
  writePrivateFileAtomic(COOLDOWNS(root), `${JSON.stringify(map, null, 2)}\n`);
}

export function readReviewerCooldown(name, { root, now = Date.now(), env = process.env, secrets = [] } = {}) {
  const safe = sanitizedCooldownMap(root, env, secrets);
  if (safe.changed) try { persistCooldownMap(safe.map, root); } catch { /* best effort migration */ }
  const entry = safe.map[name];
  return entry && Number(entry.until) > now ? entry : null;
}

export function recordReviewerCooldown(name, kind, detail, { root, now = Date.now(), ttlMs, retryAfterMs, env = process.env, secrets = [] } = {}) {
  const safe = sanitizedCooldownMap(root, env, secrets);
  const ttl = Math.max(1, Number(retryAfterMs) || Number(ttlMs) || COOLDOWN_TTL_MS[kind] || COOLDOWN_TTL_MS.rate);
  safe.map[name] = {
    kind,
    detail: redactProviderFailure(detail, { secrets: safe.exact }).slice(0, 200),
    until: now + ttl,
    ts: now
  };
  for (const [key, value] of Object.entries(safe.map)) if (!(Number(value?.until) > now)) delete safe.map[key];
  try { persistCooldownMap(safe.map, root); } catch { /* best effort */ }
  return safe.map[name];
}

export function clearReviewerCooldowns({ root, name } = {}) {
  if (!name) {
    try { fs.rmSync(COOLDOWNS(root), { force: true }); } catch { /* already absent */ }
    return;
  }
  const map = readCooldownMap(root);
  delete map[name];
  try { persistCooldownMap(map, root); } catch { /* best effort */ }
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
  try { fs.mkdirSync(workspaceStateDir(ws), { recursive: true }); fs.writeFileSync(REVIEWED_HEAD(ws), `${sha}\n`); } catch { /* best-effort marker */ }
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
    const temperature = typeof f.temperature === "number" ? f.temperature : (d.temperature ?? 0);
    // Key POOL: env var (comma-separated) > companion apiKeys[] > companion single apiKey. apiKey
    // stays the first key for back-compat; review-client rotates the pool on a 429 (per-key cap).
    const envKey = env[d.keyEnv];
    const apiKeys = (envKey ? envKey.split(",").map((s) => s.trim()).filter(Boolean) : null)
      || (Array.isArray(f.apiKeys) && f.apiKeys.length ? f.apiKeys : null)
      || (f.apiKey ? [f.apiKey] : []);
    // Total in-flight cap = keys × per-key cap. Zero means unlimited.
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
  const reviewers = [...new Set(sel.filter((n) => KNOWN_REVIEWERS.includes(n)))];
  return { reviewers: reviewers.length ? reviewers : DEFAULT_REVIEWERS, providers };
}
