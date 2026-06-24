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
  kimi: { displayName: "Kimi", baseURL: "https://api.kimi.com/coding/v1", model: "kimi-k2.6", keyEnv: "KIMI_API_KEY",
          temperature: 0.6, thinking: "disabled", thinkingEnv: "KIMI_THINKING",
          headers: { "User-Agent": "claude-cli/1.0.83 (external, cli)" },
          timeoutMs: 300_000 },  // 5 min
  // MiMo (Xiaomi) — currently DISABLED (token plan exhausted) but kept wired so it's a one-word
  // re-add (`/bench:reviewers ... mimo`). Earned its slot: uniquely caught secret/PII/deploy-hygiene issues.
  mimo: { displayName: "MiMo", baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY",
          temperature: 0, thinking: null, thinkingEnv: "MIMO_THINKING",
          headers: {}, timeoutMs: 180_000 },  // 3 min
  // GLM (z.ai coding plan) — OpenAI-compatible /chat/completions.
  glm: { displayName: "GLM", baseURL: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.2", keyEnv: "GLM_API_KEY",
         temperature: 0.6, thinking: "disabled", thinkingEnv: "GLM_THINKING",
         headers: {}, timeoutMs: 300_000 },  // 5 min
  // Qwen (Alibaba MaaS token-plan, ap-southeast-1) — OpenAI-compatible /compatible-mode (NOT the
  // /apps/anthropic endpoint; our review-client speaks OpenAI /chat/completions). Override
  // QWEN_BASE_URL / QWEN_MODEL in .keys if your key targets a different plan/workspace or model id.
  qwen: { displayName: "Qwen", baseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", keyEnv: "QWEN_API_KEY",
          temperature: 0.6, thinking: "disabled", thinkingEnv: "QWEN_THINKING",
          headers: {}, timeoutMs: 300_000 }  // 5 min
};
// Codex has no API-key config (it shells out to the codex plugin), so it is a valid reviewer but
// lives outside DEFAULTS.
const CODEX = "codex";
export const PROVIDER_NAMES = Object.keys(DEFAULTS);                 // API-backed providers (for load-keys)
export const KNOWN_REVIEWERS = [...PROVIDER_NAMES, CODEX];
const DISPLAY = { ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.displayName || k])), [CODEX]: "Codex" };
export function displayName(name) { return DISPLAY[name] || name; }
const DEFAULT_REVIEWERS = ["kimi", "glm"];   // fallback only (mimo disabled); the active set lives in companion.json
export function sharedRoot() {
  return process.env.BENCH_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared");
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
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "companion.json");
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cur = {}; }
  cur.reviewers = reviewers;
  const tmp = path.join(root, `companion.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return reviewers;
}
const GLOBAL_DISABLE = (root) => path.join(root || sharedRoot(), "disabled-global");
const WS_DISABLE = (ws) => path.join(workspaceStateDir(ws), "disabled");

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model,
      apiKey: env[d.keyEnv] || f.apiKey || "",
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
