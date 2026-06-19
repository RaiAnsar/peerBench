import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

export function rollback({ backupDir, hooksDir, settingsPath, deployedNames = [] }) {
  const restored = [], removed = [];
  // 1. Restore every snapshotted hook file (e.g. codex-plan-*.mjs that syncSettings deleted, original panel-lib.mjs).
  let backupFiles = [];
  try { backupFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith(".mjs")); } catch { backupFiles = []; }
  for (const f of backupFiles) { fs.copyFileSync(path.join(backupDir, f), path.join(hooksDir, f)); restored.push(f); }
  // 2. Remove deploy-added files that were NOT in the snapshot (the genuinely new modules: review-client, config-store, trace-store, reviewers, and plan-*.mjs on a first deploy).
  for (const f of deployedNames) {
    if (!backupFiles.includes(f)) { const p = path.join(hooksDir, f); if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(f); } }
  }
  // 3. Restore settings.json.
  const sBak = path.join(backupDir, "settings.json");
  let settingsRestored = false;
  if (fs.existsSync(sBak)) { fs.copyFileSync(sBak, settingsPath); settingsRestored = true; }
  return { restored, removed, settingsRestored };
}

// Find the newest backup-* dir under the shared data root.
function latestBackup(sharedRoot) {
  let dirs = [];
  try { dirs = fs.readdirSync(sharedRoot).filter((d) => d.startsWith("backup-")); } catch { return null; }
  dirs.sort();
  return dirs.length ? path.join(sharedRoot, dirs.at(-1)) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hooksDir = path.join(os.homedir(), ".claude", "hooks");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const sharedRoot = path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared");
  const backupDir = process.argv[2] || latestBackup(sharedRoot);
  if (!backupDir) { console.error("No backup dir found; pass one explicitly: node scripts/rollback.mjs <backupDir>"); process.exit(1); }
  let deployedNames = [];
  try { deployedNames = fs.readdirSync(path.join(here, "..", "global-hooks")).filter((f) => f.endsWith(".mjs")); } catch { /* none */ }
  const r = rollback({ backupDir, hooksDir, settingsPath, deployedNames });
  console.log(JSON.stringify({ backupDir, ...r }, null, 2));
  console.log("NOTE: if a git pre-push hook was installed, remove it separately (Phase 3 install-prepush adds an uninstall path).");
}
