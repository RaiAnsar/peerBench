// State layout copies codex-companion's envelope shape so debug habits and
// statusline parsing carry over. Key difference: config.panelStops.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FALLBACK_ROOT = path.join(os.homedir(), ".claude", "plugins", "data", "grok-companion-fallback");

function defaultState() {
  return { version: 1, config: { panelStops: false }, jobs: [] };
}

export function resolveStateDir(workspaceRoot, { env = process.env } = {}) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dataRoot = env.CLAUDE_PLUGIN_DATA || FALLBACK_ROOT;
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function loadState(workspaceRoot, opts = {}) {
  const file = path.join(resolveStateDir(workspaceRoot, opts), "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // Preserve every other config key (e.g. codex-companion's stopReviewGate) —
    // grok and codex share one state.json, so reducing config to just panelStops
    // here silently wiped codex's gate flag on every grok load→save cycle.
    const parsedConfig = parsed?.config && typeof parsed.config === "object" ? parsed.config : {};
    return {
      version: 1,
      config: { ...parsedConfig, panelStops: Boolean(parsed?.config?.panelStops) },
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(workspaceRoot, state, opts = {}) {
  const dir = resolveStateDir(workspaceRoot, opts);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function appendJob(workspaceRoot, job, opts = {}) {
  const state = loadState(workspaceRoot, opts);
  state.jobs = [...state.jobs.filter((j) => j.id !== job.id), job].slice(-50);
  saveState(workspaceRoot, state, opts);
  const dir = resolveStateDir(workspaceRoot, opts);
  fs.writeFileSync(path.join(dir, "jobs", `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}
