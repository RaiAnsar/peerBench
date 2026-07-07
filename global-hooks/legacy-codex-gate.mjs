import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CODEX_PLUGIN_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");

function stateRoot({ pluginDataDir, env = process.env } = {}) {
  return path.join(pluginDataDir || env.CLAUDE_PLUGIN_DATA || DEFAULT_CODEX_PLUGIN_DATA, "state");
}

function stateKeyForWorkspace(ws) {
  let canonical = ws;
  try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

// Set config.stopReviewGate to `enabled` in one Codex state file. Only rewrites when it actually
// changes; preserves jobs and every other field. `enabled=false` = disable (bench single-gate mode),
// `enabled=true` = enable (restore the Codex gate to run alongside peerBench).
function setStopReviewGate(file, enabled) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { file, changed: false, reason: "missing-or-invalid" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { file, changed: false, reason: "invalid-state" };
  }
  parsed.config = parsed.config && typeof parsed.config === "object" ? parsed.config : {};
  if (parsed.config.stopReviewGate === enabled) {
    return { file, changed: false, reason: enabled ? "already-enabled" : "already-disabled" };
  }
  parsed.config.stopReviewGate = enabled;
  try {
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (e) {
    return { file, changed: false, reason: `write-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { file, changed: true };
}

const disableStateFile = (file) => setStopReviewGate(file, false);
const enableStateFile = (file) => setStopReviewGate(file, true);

function eachStateFile(opts, fn) {
  const root = stateRoot(opts);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { root, scanned: 0, changed: 0, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    const result = fn(path.join(root, entry.name, "state.json"));
    if (result.changed) files.push(result.file);
  }
  return { root, scanned: entries.length, changed: files.length, files };
}

export function disableLegacyCodexStopGateForWorkspace(ws, opts = {}) {
  if (!ws) return { changed: false, reason: "missing-workspace" };
  const file = path.join(stateRoot(opts), stateKeyForWorkspace(ws), "state.json");
  return disableStateFile(file);
}

export function disableLegacyCodexStopGateStates(opts = {}) {
  return eachStateFile(opts, disableStateFile);
}

// Re-enable the Codex stop-review gate for a workspace / every configured workspace — used to RESTORE
// the gate that single-gate mode turned off, so it runs ALONGSIDE the peerBench panel.
export function enableLegacyCodexStopGateForWorkspace(ws, opts = {}) {
  if (!ws) return { changed: false, reason: "missing-workspace" };
  const file = path.join(stateRoot(opts), stateKeyForWorkspace(ws), "state.json");
  return enableStateFile(file);
}

export function enableLegacyCodexStopGateStates(opts = {}) {
  return eachStateFile(opts, enableStateFile);
}
