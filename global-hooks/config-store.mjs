// global-hooks/config-store.mjs
// Env-INDEPENDENT config + shared dir. Both execution contexts must resolve
// the same paths/config, so nothing here reads CLAUDE_PLUGIN_DATA.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULTS = {
  kimi: { baseURL: "https://api.moonshot.ai/v1", model: "kimi-k2.7-code", keyEnv: "MOONSHOT_API_KEY" },
  mimo: { baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY" }
};
const DEFAULT_REVIEWERS = ["kimi", "mimo"];
export function sharedRoot() { return path.join(os.homedir(), ".claude", "plugins", "data", "grok-companion-shared"); }
export function workspaceStateDir(ws) {
  let canonical = ws; try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(sharedRoot(), "state", `${slug}-${hash}`);
}
function readFileConfig() { try { return JSON.parse(fs.readFileSync(path.join(sharedRoot(), "companion.json"), "utf8")); } catch { return {}; } }
export function resolveConfig({ env = process.env } = {}) {
  const file = readFileConfig();
  const providers = {};
  for (const [name, d] of Object.entries(DEFAULTS)) {
    const f = file.providers?.[name] || {};
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model: env[`${name.toUpperCase()}_MODEL`] || f.model || d.model,
      apiKey: env[d.keyEnv] || f.apiKey || ""
    };
  }
  const sel = Array.isArray(file.reviewers) && file.reviewers.length ? file.reviewers : DEFAULT_REVIEWERS;
  const reviewers = sel.filter((n) => n in providers);
  return { reviewers: reviewers.length ? reviewers : DEFAULT_REVIEWERS, providers };
}
