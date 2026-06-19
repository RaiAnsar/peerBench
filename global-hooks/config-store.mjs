// global-hooks/config-store.mjs
// Env-INDEPENDENT config + shared dir. Both execution contexts must resolve
// the same paths/config, so nothing here reads CLAUDE_PLUGIN_DATA.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULTS = {
  kimi: { baseURL: "https://api.kimi.com/coding/v1", model: "kimi-k2.6", keyEnv: "KIMI_API_KEY",
          temperature: 0.6, thinking: "disabled", thinkingEnv: "KIMI_THINKING",
          headers: { "User-Agent": "claude-cli/1.0.83 (external, cli)" },
          timeoutMs: 300_000 },  // 5 min
  mimo: { baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY",
          temperature: 0, thinking: null, thinkingEnv: "MIMO_THINKING",
          headers: {}, timeoutMs: 180_000 },  // 3 min
  // GLM (z.ai coding plan) — OpenAI-compatible /chat/completions.
  glm: { baseURL: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.2", keyEnv: "GLM_API_KEY",
         temperature: 0.6, thinking: "disabled", thinkingEnv: "GLM_THINKING",
         headers: {}, timeoutMs: 300_000 }  // 5 min
};
const DEFAULT_REVIEWERS = ["kimi", "mimo"];
export const KNOWN_REVIEWERS = ["kimi", "mimo", "codex", "glm"];
export function sharedRoot() {
  return process.env.GROK_COMPANION_ROOT
    || path.join(os.homedir(), ".claude", "plugins", "data", "grok-companion-shared");
}
export function workspaceStateDir(ws) {
  let canonical = ws; try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(sharedRoot(), "state", `${slug}-${hash}`);
}
function readFileConfig() { try { return JSON.parse(fs.readFileSync(path.join(sharedRoot(), "companion.json"), "utf8")); } catch { return {}; } }
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

// Disabled if the global marker exists OR this workspace's marker exists.
export function isGangDisabled(ws, { root } = {}) {
  try { if (fs.existsSync(GLOBAL_DISABLE(root))) return true; } catch { /* noop */ }
  try { if (ws && fs.existsSync(WS_DISABLE(ws))) return true; } catch { /* noop */ }
  return false;
}

// scope: "global" writes/removes the global marker; otherwise the workspace marker.
export function setGangDisabled(ws, disabled, { scope = "workspace", root } = {}) {
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
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model: env[`${name.toUpperCase()}_MODEL`] || f.model || d.model,
      apiKey: env[d.keyEnv] || f.apiKey || "",
      temperature: typeof f.temperature === "number" ? f.temperature : (d.temperature ?? 0),
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
