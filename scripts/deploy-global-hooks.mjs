import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

// Copy every global-hooks/*.mjs FLAT into dest; back up a differing pre-existing file once.
export function deploy({ src, dest }) {
  fs.mkdirSync(dest, { recursive: true });
  const copied = [], backedUp = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".mjs"))) {
    const from = path.join(src, f), to = path.join(dest, f);
    if (fs.existsSync(to)) {
      const bak = `${to}.pre-panel.bak`;
      if (fs.readFileSync(to, "utf8") !== fs.readFileSync(from, "utf8") && !fs.existsSync(bak)) { fs.copyFileSync(to, bak); backedUp.push(f); }
    }
    fs.copyFileSync(from, to); copied.push(f);
  }
  return { copied, backedUp };
}

// LAYER-3 BACKUP: snapshot the current live hooks + settings BEFORE we mutate them, so rollback.mjs can restore exactly.
const SNAPSHOT_FILES = ["codex-plan-review.mjs", "codex-plan-file-review.mjs", "plan-review.mjs", "plan-file-review.mjs", "panel-lib.mjs"];
export function snapshot({ hooksDir, settingsPath, backupDir }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  for (const f of SNAPSHOT_FILES) {
    const p = path.join(hooksDir, f);
    if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(backupDir, f)); files.push(f); }
  }
  let settingsBackedUp = false;
  if (fs.existsSync(settingsPath)) { fs.copyFileSync(settingsPath, path.join(backupDir, "settings.json")); settingsBackedUp = true; }
  return { files, settingsBackedUp, backupDir };
}

const LEGACY = ["codex-plan-review.mjs", "codex-plan-file-review.mjs"];
function ensure(list, matcher, absCmd) {
  const has = list.some((e) => e.matcher === matcher && (e.hooks || []).some((h) => String(h.command).includes(absCmd)));
  if (!has) list.push({ matcher, hooks: [{ type: "command", command: `node "${absCmd}"` }] });
}
// Remove ONLY the matching legacy hook COMMANDS (not whole entries unless they become empty); register the new plan-*.mjs with ABSOLUTE paths.
export function syncSettings({ hooksDir, settingsPath }) {
  const removedFiles = [];
  for (const f of LEGACY) { const p = path.join(hooksDir, f); if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removedFiles.push(f); } }
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { s = {}; }
  s.hooks = s.hooks || {};
  let removedEntries = 0;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    for (const entry of s.hooks[ev]) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !LEGACY.some((f) => String(h.command || "").includes(f)));
      removedEntries += before - entry.hooks.length;
    }
    s.hooks[ev] = s.hooks[ev].filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0); // drop now-empty entries
  }
  s.hooks.PreToolUse = s.hooks.PreToolUse || [];
  s.hooks.PostToolUse = s.hooks.PostToolUse || [];
  ensure(s.hooks.PreToolUse, "ExitPlanMode", path.join(hooksDir, "plan-review.mjs"));   // ABSOLUTE homedir path (no ~)
  ensure(s.hooks.PostToolUse, "Write|Edit", path.join(hooksDir, "plan-file-review.mjs"));
  fs.writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`);
  return { removedFiles, removedEntries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hooksDir = path.join(os.homedir(), ".claude", "hooks");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const backupDir = path.join(os.homedir(), ".claude", "plugins", "data", "grok-companion-shared", `backup-${Date.now()}`);
  const snap = snapshot({ hooksDir, settingsPath, backupDir });
  const dep = deploy({ src: path.join(here, "..", "global-hooks"), dest: hooksDir });
  const sync = syncSettings({ hooksDir, settingsPath });
  console.log(JSON.stringify({ snapshot: snap, deploy: dep, sync }, null, 2));
}
