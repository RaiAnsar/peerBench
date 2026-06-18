// global-hooks/config-store.mjs
// Env-INDEPENDENT config + shared dir. Both execution contexts must resolve
// the same paths/config, so nothing here reads CLAUDE_PLUGIN_DATA.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULTS = {
  kimi: { baseURL: "https://api.kimi.com/coding/v1", model: "kimi-for-coding", keyEnv: "KIMI_API_KEY",
          temperature: 1, headers: { "User-Agent": "claude-cli/1.0.83 (external, cli)" } },
  mimo: { baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY",
          temperature: 0, headers: {} }
};
const DEFAULT_REVIEWERS = ["kimi", "mimo"];
export const KNOWN_REVIEWERS = ["kimi", "mimo", "codex", "grok"];
export function sharedRoot() { return path.join(os.homedir(), ".claude", "plugins", "data", "grok-companion-shared"); }
export function workspaceStateDir(ws) {
  let canonical = ws; try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(sharedRoot(), "state", `${slug}-${hash}`);
}
function readFileConfig() { try { return JSON.parse(fs.readFileSync(path.join(sharedRoot(), "companion.json"), "utf8")); } catch { return {}; } }
// Persist the active reviewer selection to the env-independent companion.json (atomic).
export function setReviewers(list, { root = sharedRoot() } = {}) {
  const reviewers = (Array.isArray(list) ? list : []).filter((n) => KNOWN_REVIEWERS.includes(n));
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
export function resolveConfig({ env = process.env, reviewers: reviewersOverride } = {}) {
  const file = readFileConfig();
  const providers = {};
  for (const [name, d] of Object.entries(DEFAULTS)) {
    const f = file.providers?.[name] || {};
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model: env[`${name.toUpperCase()}_MODEL`] || f.model || d.model,
      apiKey: env[d.keyEnv] !== undefined ? env[d.keyEnv] : (f.apiKey || ""),
      temperature: typeof f.temperature === "number" ? f.temperature : (d.temperature ?? 0),
      headers: { ...(d.headers || {}), ...(f.headers || {}) }
    };
  }
  // If an explicit override is provided (non-empty array), use it; otherwise fall back to file/default.
  const sel = Array.isArray(reviewersOverride) && reviewersOverride.length
    ? reviewersOverride
    : (Array.isArray(file.reviewers) && file.reviewers.length ? file.reviewers : DEFAULT_REVIEWERS);
  const reviewers = sel.filter((n) => KNOWN_REVIEWERS.includes(n));
  return { reviewers: reviewers.length ? reviewers : DEFAULT_REVIEWERS, providers };
}
