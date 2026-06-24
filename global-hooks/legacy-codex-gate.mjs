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

function disableStateFile(file) {
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
  if (parsed.config.stopReviewGate !== true) {
    return { file, changed: false, reason: "already-disabled" };
  }
  parsed.config.stopReviewGate = false;
  try {
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (e) {
    return { file, changed: false, reason: `write-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { file, changed: true };
}

export function disableLegacyCodexStopGateForWorkspace(ws, opts = {}) {
  if (!ws) return { changed: false, reason: "missing-workspace" };
  const file = path.join(stateRoot(opts), stateKeyForWorkspace(ws), "state.json");
  return disableStateFile(file);
}

export function disableLegacyCodexStopGateStates(opts = {}) {
  const root = stateRoot(opts);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { root, scanned: 0, changed: 0, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    const result = disableStateFile(path.join(root, entry.name, "state.json"));
    if (result.changed) files.push(result.file);
  }
  return { root, scanned: entries.length, changed: files.length, files };
}
