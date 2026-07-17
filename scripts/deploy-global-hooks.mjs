import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

export function ensurePrivateBackupDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function uniqueSibling(target, label) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${label}-${process.pid}-${crypto.randomUUID()}`);
}

export function capturePathState(target) {
  const stat = lstatOrNull(target);
  if (!stat) return { exists: false };
  if (stat.isSymbolicLink()) {
    return { exists: true, type: "symlink", linkTarget: fs.readlinkSync(target) };
  }
  if (!stat.isFile()) return { exists: true, type: stat.isDirectory() ? "directory" : "other" };
  return {
    exists: true,
    type: "file",
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")
  };
}

export function pathStateMatches(target, expected) {
  if (!expected || typeof expected !== "object") return false;
  const actual = capturePathState(target);
  if (Boolean(actual.exists) !== Boolean(expected.exists)) return false;
  if (!actual.exists) return true;
  if (actual.type !== expected.type) return false;
  if (actual.type === "symlink") return actual.linkTarget === expected.linkTarget;
  if (actual.type === "file") {
    return actual.sha256 === expected.sha256
      && (!Number.isInteger(expected.mode) || actual.mode === expected.mode);
  }
  return true;
}

function assertRegularJsonTarget(pathname, label) {
  const stat = lstatOrNull(pathname);
  if (!stat) return { exists: false };
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink; refusing to follow or overwrite ${pathname}`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${pathname}`);
  return { exists: true, stat };
}

export function readJsonObjectStrict(pathname, { label = "JSON config", missing = {} } = {}) {
  const state = assertRegularJsonTarget(pathname, label);
  if (!state.exists) return missing;
  let raw;
  try { raw = fs.readFileSync(pathname, "utf8"); }
  catch (error) { throw new Error(`${label} is unreadable at ${pathname}: ${error?.message || error}`); }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`${label} contains invalid JSON at ${pathname}: ${error?.message || error}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object: ${pathname}`);
  }
  return value;
}

export function atomicWriteFile(pathname, data, { mode = null, rejectSymlink = false, label = "file" } = {}) {
  const existing = lstatOrNull(pathname);
  if (rejectSymlink && existing?.isSymbolicLink()) {
    throw new Error(`${label} is a symlink; refusing to follow or overwrite ${pathname}`);
  }
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${pathname}`);
  }
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const tmp = uniqueSibling(pathname, "tmp");
  try {
    fs.writeFileSync(tmp, data, { mode: Number.isInteger(mode) ? mode : 0o600, flag: "wx" });
    if (Number.isInteger(mode)) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, pathname);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function atomicCopyFile(source, destination, { mode = null } = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = uniqueSibling(destination, "copy");
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
    const effectiveMode = Number.isInteger(mode) ? mode : (fs.statSync(source).mode & 0o777);
    fs.chmodSync(tmp, effectiveMode);
    fs.renameSync(tmp, destination);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function hardenBackupDirectories(root) {
  let entries = [];
  try {
    fs.chmodSync(root, 0o700);
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    hardenBackupDirectories(path.join(root, entry.name));
  }
}

function copySensitiveSnapshot(source, destination) {
  const stat = lstatOrNull(source);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`refusing to snapshot non-regular or symlinked sensitive file: ${source}`);
  }
  ensurePrivateBackupDir(path.dirname(destination));
  atomicCopyFile(source, destination, { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
}

// ONE-TIME data-dir migration: pre-rename installs kept reviewer config + traces under
// 'grok-companion-shared'; move it to 'bench-shared' once. No-op on fresh installs or after
// migration. MUST run before anything that could create bench-shared (e.g. the snapshot backup
// dir) — otherwise the dir already exists and the real data is orphaned.
export function migrateDataDir({ base = path.join(os.homedir(), ".claude", "plugins", "data") } = {}) {
  const from = path.join(base, "grok-companion-shared");
  const to = path.join(base, "bench-shared");
  // Identify the REAL data by companion.json, not by the dir existing — a prior broken deploy could
  // have pre-created an EMPTY bench-shared (e.g. a snapshot backup dir) while the real config + traces
  // still sit in grok-companion-shared. Keying on the dir alone would skip that and orphan the data.
  const hasConfig = (d) => { try { return fs.existsSync(path.join(d, "companion.json")); } catch { return false; } };
  try {
    if (hasConfig(from) && !hasConfig(to)) {
      if (fs.existsSync(to)) {
        // bench-shared exists but is incomplete — merge the real data over it (legacy wins), then drop legacy.
        fs.cpSync(from, to, { recursive: true, force: true });
        fs.rmSync(from, { recursive: true, force: true });
        return { migrated: true, merged: true, from, to };
      }
      fs.renameSync(from, to);
      return { migrated: true, from, to };
    }
  } catch (e) { return { migrated: false, error: String(e?.message || e) }; }
  return { migrated: false };
}

// Copy every global-hooks/*.mjs FLAT into dest; back up a differing pre-existing file once.
export function deploy({ src, dest }) {
  fs.mkdirSync(dest, { recursive: true });
  const destStat = lstatOrNull(dest);
  if (!destStat?.isDirectory() || destStat.isSymbolicLink()) throw new Error(`hook destination is not a regular directory: ${dest}`);
  const copied = [], backedUp = [], states = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".mjs"))) {
    const from = path.join(src, f), to = path.join(dest, f);
    const targetStat = lstatOrNull(to);
    if (targetStat) {
      const bak = `${to}.pre-panel.bak`;
      if (targetStat.isFile() && !targetStat.isSymbolicLink()
          && !fs.readFileSync(to).equals(fs.readFileSync(from))
          && !lstatOrNull(bak)) {
        atomicCopyFile(to, bak);
        backedUp.push(f);
      }
      if (!targetStat.isFile() && !targetStat.isSymbolicLink()) {
        throw new Error(`refusing to replace non-file hook target: ${to}`);
      }
    }
    atomicCopyFile(from, to);
    copied.push(f);
    states.push({ name: f, state: capturePathState(to) });
  }
  return { copied, backedUp, states };
}

// LAYER-3 BACKUP: snapshot the current live hooks + settings BEFORE we mutate them, so rollback.mjs can
// restore exactly. Snapshot EVERY live *.mjs in hooksDir (not a hardcoded list, which silently missed
// newly-added hooks like stop-review/pre-push-review — found by the bench's own hunt).
export const ROLLBACK_METADATA_FILE = "install-metadata.json";

export function writeRollbackMetadata({ backupDir, metadata }) {
  ensurePrivateBackupDir(backupDir);
  const target = path.join(backupDir, ROLLBACK_METADATA_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...metadata }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

function snapshotEntry({ target, backupPath, name = path.basename(target), sensitive = false }) {
  const stat = lstatOrNull(target);
  const entry = {
    name,
    target: path.resolve(target),
    backupPath: path.resolve(backupPath),
    existed: Boolean(stat),
    type: null,
    mode: null,
    linkTarget: null
  };
  if (!stat) return entry;
  if (stat.isSymbolicLink()) {
    entry.type = "symlink";
    entry.linkTarget = fs.readlinkSync(target);
    return entry;
  }
  if (!stat.isFile()) throw new Error(`refusing to snapshot non-file target: ${target}`);
  entry.type = "file";
  entry.mode = stat.mode & 0o777;
  entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (sensitive) copySensitiveSnapshot(target, backupPath);
  else {
    ensurePrivateBackupDir(path.dirname(backupPath));
    atomicCopyFile(target, backupPath, { mode: 0o600 });
  }
  return entry;
}

export function snapshot({ hooksDir, settingsPath, backupDir, statuslinePath = null, fileNames = null }) {
  ensurePrivateBackupDir(backupDir);
  const files = [], entries = [];
  let live = [];
  if (Array.isArray(fileNames)) live = [...new Set(fileNames)].filter((f) => typeof f === "string" && f === path.basename(f) && f.endsWith(".mjs"));
  else try { live = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")); } catch { live = []; }
  for (const f of live) {
    const p = path.join(hooksDir, f);
    const entry = snapshotEntry({ target: p, backupPath: path.join(backupDir, f), name: f });
    entries.push(entry);
    if (entry.existed) files.push(f);
  }
  const settingsEntry = snapshotEntry({
    target: settingsPath,
    backupPath: path.join(backupDir, "settings.json"),
    name: "settings.json",
    sensitive: true
  });
  const statuslineEntry = statuslinePath ? snapshotEntry({
    target: statuslinePath,
    backupPath: path.join(backupDir, "statusline-command.sh"),
    name: "statusline-command.sh"
  }) : null;
  return {
    files,
    entries,
    settingsEntry,
    settingsBackedUp: settingsEntry.existed,
    settingsMode: settingsEntry.mode,
    statuslineEntry,
    statuslineBackedUp: Boolean(statuslineEntry?.existed),
    statuslineMode: statuslineEntry?.mode ?? null,
    backupDir
  };
}

export function snapshotCodex({ hooksDir, hooksPath, backupDir, promptsDir = null, promptNames = null, fileNames = null }) {
  ensurePrivateBackupDir(backupDir);
  const files = [], entries = [];
  let live = [];
  if (Array.isArray(fileNames)) live = [...new Set(fileNames)].filter((f) => typeof f === "string" && f === path.basename(f) && f.endsWith(".mjs"));
  else try { live = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")); } catch { live = []; }
  for (const f of live) {
    const p = path.join(hooksDir, f);
    const entry = snapshotEntry({ target: p, backupPath: path.join(backupDir, f), name: f });
    entries.push(entry);
    if (entry.existed) files.push(f);
  }
  const hooksJsonEntry = snapshotEntry({
    target: hooksPath,
    backupPath: path.join(backupDir, "hooks.json"),
    name: "hooks.json",
    sensitive: true
  });
  const promptFiles = [], promptEntries = [];
  if (promptsDir) {
    const livePrompts = Array.isArray(promptNames)
      ? [...new Set(promptNames)].filter((f) => typeof f === "string" && f === path.basename(f) && f.endsWith(".md"))
      : (() => { try { return fs.readdirSync(promptsDir).filter((f) => f.endsWith(".md")); } catch { return []; } })();
    for (const f of livePrompts) {
      const entry = snapshotEntry({
        target: path.join(promptsDir, f),
        backupPath: path.join(backupDir, "prompts", f),
        name: f
      });
      promptEntries.push(entry);
      if (entry.existed) promptFiles.push(f);
    }
  }
  return {
    files,
    entries,
    hooksJsonEntry,
    hooksJsonBackedUp: hooksJsonEntry.existed,
    hooksJsonMode: hooksJsonEntry.mode,
    promptFiles,
    promptEntries,
    backupDir
  };
}

const STATUSLINE_SESSION_LINE =
  `bench_session_id=$(printf '%s' "$input" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')`;

// Existing user statusline wrappers usually read stdin once (`input=$(cat)`) and then invoke
// statusline-segment.mjs with only the project dir. Patch just that peerBench segment call so the
// wrapper keeps its custom UI but forwards Claude's per-chat session_id as argv3.
export function syncStatuslineSessionArg({
  statuslinePath = path.join(os.homedir(), ".claude", "statusline-command.sh")
} = {}) {
  const stat = lstatOrNull(statuslinePath);
  if (stat?.isSymbolicLink()) throw new Error(`statusline is a symlink; refusing to follow or overwrite ${statuslinePath}`);
  if (stat && !stat.isFile()) throw new Error(`statusline is not a regular file: ${statuslinePath}`);
  let text;
  try { text = fs.readFileSync(statuslinePath, "utf8"); }
  catch { return { statuslinePath, updated: false, reason: "missing" }; }

  if (!text.includes("statusline-segment.mjs")) {
    return { statuslinePath, updated: false, reason: "no peerbench statusline segment" };
  }
  if (/statusline-segment\.mjs[^\n]*bench_session_id/.test(text)) {
    return { statuslinePath, updated: false, reason: "already session-aware" };
  }

  const lines = text.split("\n");
  let inserted = text.includes("bench_session_id=");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("statusline-segment.mjs") && !/^\s*#/.test(lines[i])) {
      if (!inserted) {
        lines.splice(i, 0, STATUSLINE_SESSION_LINE);
        inserted = true;
        i++;
      }
      const before = lines[i];
      lines[i] = lines[i]
        .replace(/"\$gate_dir"(?=\s*(?:2>|\)|$))/, `"$gate_dir" "$bench_session_id"`)
        .replace(/\$gate_dir(?=\s*(?:2>|\)|$))/, `$gate_dir "$bench_session_id"`);
      if (lines[i] !== before) replaced = true;
      break;
    }
  }
  if (!replaced) return { statuslinePath, updated: false, reason: "could not patch segment command" };

  atomicWriteFile(statuslinePath, lines.join("\n"), {
    mode: stat?.mode & 0o777,
    rejectSymlink: true,
    label: "statusline"
  });
  return { statuslinePath, updated: true };
}

const LEGACY = ["codex-plan-review.mjs", "codex-plan-file-review.mjs"];
const LEGACY_COMMANDS = [
  ...LEGACY,
  // These belong to the older openai/codex-plugin-cc stop gate. peerBench is now the single
  // review gate; leaving these active makes Claude surface "Codex gate: ALLOW" decisions that
  // are based on the final assistant message instead of peerBench's diff payload.
  "codex-multirepo-gate.mjs",
  "codex-stop-gate-autoenable.mjs"
];
const PEERBENCH_SETTINGS_HOOKS = [
  "native-session-start.mjs",
  "plan-review.mjs",
  "plan-file-review.mjs",
  "pre-push-review.mjs",
  "pre-merge-review.mjs",
  "stop-review.mjs",
  "deep-review-runner.mjs"
];
const PEERBENCH_CODEX_HOOKS = ["native-session-start.mjs", "codex-stop-review.mjs"];
// Register our hook canonically AND de-dupe: remove any existing entries referencing this hook
// FILE (matched by basename, so it catches ANY path form — $HOME, absolute, different quoting),
// then add exactly one absolute-path entry. Idempotent + self-healing against duplicates.
// matcher === undefined → Stop-style (no matcher): scan all blocks, add to the first (keeping
// other Stop hooks like a codex multi-repo gate intact).
function register(list, matcher, absCmd, extra = {}) {
  const base = path.basename(absCmd);
  for (const b of list) {
    if (!Array.isArray(b.hooks)) continue;
    if (matcher !== undefined && b.matcher !== matcher) continue;   // matcher-scoped: only same-matcher blocks
    b.hooks = b.hooks.filter((h) => !commandReferencesHookFile(h.command, base));
  }
  const cmd = { type: "command", command: `node "${absCmd}"`, ...extra };
  if (matcher !== undefined) {
    const block = list.find((b) => b.matcher === matcher);
    if (block) { block.hooks = block.hooks || []; block.hooks.push(cmd); } else list.push({ matcher, hooks: [cmd] });
  } else {
    // matcher-less (Stop-style): only a MATCHER-LESS hooks-block is a valid home — a matcher-scoped
    // block (e.g. {matcher:"SomeTool"}) would bury this hook so it only fires for that tool's events.
    const block = list.find((b) => Array.isArray(b.hooks) && !b.matcher);
    if (block) { block.hooks = block.hooks || []; block.hooks.push(cmd); } else list.push({ hooks: [cmd] });
  }
}

function commandReferencesHookFile(command, basename) {
  const escaped = String(basename).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_./\\\\-])`).test(String(command || ""));
}

function removeHookCommands(settings, basenames) {
  let removedEntries = 0;
  settings.hooks = settings.hooks || {};
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) continue;
    for (const entry of settings.hooks[ev]) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !basenames.some((f) => commandReferencesHookFile(h.command, f)));
      removedEntries += before - entry.hooks.length;
    }
    settings.hooks[ev] = settings.hooks[ev].filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  }
  return removedEntries;
}

function ensureHooksObject(settings, label) {
  if (settings.hooks === undefined) settings.hooks = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error(`${label} has an invalid hooks value; expected a JSON object`);
  }
  for (const [event, blocks] of Object.entries(settings.hooks)) {
    if (!Array.isArray(blocks)) throw new Error(`${label} has an invalid hooks.${event} value; expected an array`);
  }
  return settings.hooks;
}

function writeJsonConfig(pathname, value, label) {
  atomicWriteFile(pathname, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    rejectSymlink: true,
    label
  });
}

export function removeClaudeSettingsPeerBenchHooks({ settingsPath }) {
  const s = readJsonObjectStrict(settingsPath, { label: "Claude settings" });
  ensureHooksObject(s, "Claude settings");
  const removedEntries = removeHookCommands(s, [...PEERBENCH_SETTINGS_HOOKS, ...LEGACY_COMMANDS]);
  writeJsonConfig(settingsPath, s, "Claude settings");
  return { removedEntries, removedFiles: [], pluginManaged: true };
}

export function removeCodexSettingsPeerBenchHooks({ hooksPath }) {
  const s = readJsonObjectStrict(hooksPath, { label: "Codex hooks config" });
  ensureHooksObject(s, "Codex hooks config");
  const removedEntries = removeHookCommands(s, PEERBENCH_CODEX_HOOKS);
  writeJsonConfig(hooksPath, s, "Codex hooks config");
  return { removedEntries, pluginManaged: true };
}

function readJson(pathname) {
  try { return JSON.parse(fs.readFileSync(pathname, "utf8")); }
  catch { return null; }
}

const PLUGIN_VERSION_FILES = [
  ["package.json", "package.json"],
  [".claude-plugin/plugin.json", "Claude manifest"],
  [".codex-plugin/plugin.json", "Codex manifest"]
];

function pluginVersionDeclarations(root) {
  const declarations = [];
  for (const [relativePath, label] of PLUGIN_VERSION_FILES) {
    const version = readJson(path.join(root, relativePath))?.version;
    if (typeof version === "string" && version.trim()) {
      declarations.push({ label, version: version.trim() });
    }
  }
  return declarations;
}

function inferredPluginPlatform(pluginRoot) {
  const resolved = path.resolve(pluginRoot);
  if (resolved.includes(`${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`)) return "claude";
  if (resolved.includes(`${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`)) return "codex";
  return "plugin";
}

function pluginRefreshInstruction(platform) {
  if (platform === "claude") {
    return [
      "Refresh it through Claude's plugin manager, then rerun setup:",
      "  claude plugin remove bench@aiwithrai --keep-data -s user",
      "  claude plugin install bench@aiwithrai"
    ].join("\n");
  }
  if (platform === "codex") {
    return [
      "After publishing this checkout, refresh it through Codex's plugin manager:",
      "  codex plugin marketplace upgrade aiwithrai",
      "  codex plugin add bench@aiwithrai",
      "Then fully restart Codex and rerun setup."
    ].join("\n");
  }
  return "Reinstall bench@aiwithrai through its plugin manager, then rerun setup.";
}

// Plugin cache directories are immutable versioned installs. Overlaying a different checkout
// version into one leaves the manager's cache identity/provenance stale, so refuse before copying
// even if a previous unsafe overlay already rewrote the cached manifests.
export function assertPluginCacheVersionMatch({ repoRoot, pluginRoot, platform = inferredPluginPlatform(pluginRoot) }) {
  const checkoutDeclarations = pluginVersionDeclarations(repoRoot);
  const checkoutVersions = [...new Set(checkoutDeclarations.map((entry) => entry.version))];
  if (checkoutVersions.length !== 1) {
    const detail = checkoutDeclarations.length
      ? checkoutDeclarations.map((entry) => `${entry.label}=${entry.version}`).join(", ")
      : "no version declarations found";
    throw new Error(`peerBench checkout version is not coherent (${detail}); refusing to deploy plugin runtime.`);
  }

  const checkoutVersion = checkoutVersions[0];
  const cacheDeclarations = pluginVersionDeclarations(pluginRoot);
  const cacheMarker = platform === "claude"
    ? `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`
    : platform === "codex"
      ? `${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`
      : null;
  if (cacheMarker && path.resolve(pluginRoot).includes(cacheMarker)) {
    cacheDeclarations.push({ label: "cache directory", version: path.basename(path.resolve(pluginRoot)) });
  }
  const mismatches = cacheDeclarations.filter((entry) => entry.version !== checkoutVersion);
  if (cacheDeclarations.length === 0 || mismatches.length > 0) {
    const cacheDetail = cacheDeclarations.length
      ? cacheDeclarations.map((entry) => `${entry.label}=${entry.version}`).join(", ")
      : "no cache version declarations found";
    const label = platform === "claude" ? "Claude" : platform === "codex" ? "Codex" : "plugin";
    throw new Error([
      `peerBench ${label} plugin cache version mismatch: checkout=${checkoutVersion}; cache=${cacheDetail}.`,
      `Refusing to overwrite ${path.resolve(pluginRoot)} in place.`,
      pluginRefreshInstruction(platform)
    ].join("\n"));
  }
  return { ok: true, platform, checkoutVersion, cacheVersion: checkoutVersion, pluginRoot: path.resolve(pluginRoot) };
}

export function latestClaudeBenchPluginRoot({
  home = os.homedir(),
  pluginId = "bench@aiwithrai"
} = {}) {
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(installedPath);
  const entries = Array.isArray(installed?.plugins?.[pluginId]) ? installed.plugins[pluginId] : [];
  const scoped = entries.filter((entry) => entry.scope === "user" || entry.scope === "local" || entry.scope === "project");
  const latest = (scoped.length ? scoped : entries).at(-1);
  return typeof latest?.installPath === "string" && fs.existsSync(latest.installPath) ? latest.installPath : null;
}

export function latestCodexBenchPluginRoot({
  home = os.homedir(),
  marketplaceName = "aiwithrai",
  pluginName = "bench"
} = {}) {
  const cacheDir = path.join(home, ".codex", "plugins", "cache", marketplaceName, pluginName);
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const pluginRoot = path.join(cacheDir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(pluginRoot).mtimeMs; } catch {}
        return { pluginRoot, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (fs.existsSync(path.join(entry.pluginRoot, ".codex-plugin", "plugin.json"))) return entry.pluginRoot;
  }
  return null;
}

export function deployPluginRuntime({ repoRoot, pluginRoot, platform = inferredPluginPlatform(pluginRoot) }) {
  assertPluginCacheVersionMatch({ repoRoot, pluginRoot, platform });
  const pluginStat = lstatOrNull(pluginRoot);
  if (pluginStat?.isSymbolicLink() || (pluginStat && !pluginStat.isDirectory())) {
    throw new Error(`plugin cache root is not a regular directory: ${pluginRoot}`);
  }
  fs.mkdirSync(pluginRoot, { recursive: true });
  const copied = [], removed = [];
  const copyDir = (rel) => {
    const from = path.join(repoRoot, rel);
    const target = path.join(pluginRoot, rel);
    const fromStat = lstatOrNull(from);
    if (!fromStat) {
      if (lstatOrNull(target)) { fs.rmSync(target, { recursive: true, force: true }); removed.push(`${rel}/`); }
      return;
    }
    if (!fromStat.isDirectory() || fromStat.isSymbolicLink()) throw new Error(`plugin runtime source is not a regular directory: ${from}`);
    const staged = uniqueSibling(target, "stage");
    const old = uniqueSibling(target, "old");
    let movedOld = false, preserveOld = false;
    try {
      fs.cpSync(from, staged, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (lstatOrNull(target)) { fs.renameSync(target, old); movedOld = true; }
      fs.renameSync(staged, target);
      if (movedOld) fs.rmSync(old, { recursive: true, force: true });
    } catch (error) {
      if (!lstatOrNull(target) && movedOld && lstatOrNull(old)) {
        try { fs.renameSync(old, target); movedOld = false; }
        catch { preserveOld = true; }
      }
      throw error;
    } finally {
      try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
      if (!preserveOld) try { fs.rmSync(old, { recursive: true, force: true }); } catch {}
    }
    copied.push(`${rel}/`);
  };
  const copyFile = (rel) => {
    const from = path.join(repoRoot, rel);
    const target = path.join(pluginRoot, rel);
    const fromStat = lstatOrNull(from);
    if (!fromStat) {
      if (lstatOrNull(target)) { fs.rmSync(target, { recursive: true, force: true }); removed.push(rel); }
      return;
    }
    if (!fromStat.isFile() || fromStat.isSymbolicLink()) throw new Error(`plugin runtime source is not a regular file: ${from}`);
    atomicCopyFile(from, target);
    copied.push(rel);
  };
  for (const rel of PLUGIN_RUNTIME_DIRS) copyDir(rel);
  for (const rel of PLUGIN_RUNTIME_FILES) copyFile(rel);
  return { pluginRoot, copied, removed };
}

const PLUGIN_RUNTIME_DIRS = ["global-hooks", "scripts", "hooks", "commands", "skills", "codex-prompts"];
const PLUGIN_RUNTIME_FILES = ["hooks.json", "package.json", "README.md", "LICENSE", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

// Snapshot only paths deployPluginRuntime can mutate. This keeps rollback exact without copying
// provider data, logs, or other plugin-cache state that peerBench does not own.
export function snapshotPluginRuntime({ pluginRoot, backupDir, existedBefore = fs.existsSync(pluginRoot) }) {
  if (!pluginRoot) return null;
  const root = path.resolve(pluginRoot);
  const rootStat = lstatOrNull(root);
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) {
    throw new Error(`plugin cache root is not a regular directory: ${root}`);
  }
  const contentDir = path.join(backupDir, "content");
  const entries = [];
  for (const rel of [...PLUGIN_RUNTIME_DIRS, ...PLUGIN_RUNTIME_FILES]) {
    const source = path.join(root, rel);
    const existed = Boolean(existedBefore && lstatOrNull(source));
    entries.push({ rel, existed });
    if (!existed) continue;
    const destination = path.join(contentDir, rel);
    ensurePrivateBackupDir(path.dirname(destination));
    fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
    if (fs.lstatSync(destination).isDirectory()) hardenBackupDirectories(destination);
  }
  ensurePrivateBackupDir(backupDir);
  const manifestPath = path.join(backupDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, pluginRoot: root, existedBefore, entries }, null, 2)}\n`, { mode: 0o600 });
  return { pluginRoot: root, backupDir, existedBefore, manifestPath };
}

export function restorePluginRuntime({ backupDir }) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")); }
  catch { return { ok: false, changed: false, reason: "plugin runtime snapshot is missing or invalid" }; }
  if (!manifest?.pluginRoot || !Array.isArray(manifest.entries)) {
    return { ok: false, changed: false, reason: "plugin runtime snapshot is incomplete" };
  }
  const pluginRoot = path.resolve(manifest.pluginRoot);
  try {
    for (const entry of manifest.entries) {
      if (!entry?.existed || ![...PLUGIN_RUNTIME_DIRS, ...PLUGIN_RUNTIME_FILES].includes(entry.rel)) continue;
      if (!lstatOrNull(path.join(backupDir, "content", entry.rel))) {
        return { ok: false, changed: false, pluginRoot, reason: `plugin runtime backup is missing ${entry.rel}` };
      }
    }
    if (manifest.existedBefore === false) {
      for (const entry of manifest.entries) {
        if (!entry || ![...PLUGIN_RUNTIME_DIRS, ...PLUGIN_RUNTIME_FILES].includes(entry.rel)) continue;
        fs.rmSync(path.join(pluginRoot, entry.rel), { recursive: true, force: true });
      }
      try { fs.rmdirSync(pluginRoot); } catch { /* preserve any cache state not owned by deployPluginRuntime */ }
      return { ok: true, changed: true, pluginRoot, removed: true };
    }
    for (const entry of manifest.entries) {
      if (!entry || ![...PLUGIN_RUNTIME_DIRS, ...PLUGIN_RUNTIME_FILES].includes(entry.rel)) continue;
      const target = path.join(pluginRoot, entry.rel);
      fs.rmSync(target, { recursive: true, force: true });
      if (entry.existed) {
        const source = path.join(backupDir, "content", entry.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(source, target, { recursive: true, force: true, verbatimSymlinks: true });
      }
    }
    return { ok: true, changed: true, pluginRoot, removed: false };
  } catch (error) {
    return { ok: false, changed: true, pluginRoot, reason: error?.message || String(error) };
  }
}

export function isSensitivePluginCachePath(source) {
  const name = path.basename(source).toLowerCase();
  const explicitTemplate = /\.(?:example|sample|template|dist)$/.test(name);
  if (explicitTemplate && (name.startsWith(".env") || name.startsWith(".keys"))) return false;
  return name === ".keys"
    || name.endsWith(".keys")
    || name.startsWith(".keys")
    || name === ".env"
    || name.endsWith(".env")
    || name.startsWith(".env")
    || name.endsWith(".log")
    || name === "resultsofhunt.txt";
}

// Claude's plugin CLI can remove and recreate an entire install root, not just the runtime paths
// deployPluginRuntime owns. Snapshot the complete managed package for that destructive path while
// deliberately excluding secret-like cache files that must never be propagated into backups.
export function snapshotPluginInstallRoot({ pluginRoot, backupDir, existedBefore = fs.existsSync(pluginRoot) }) {
  if (!pluginRoot) return null;
  const root = path.resolve(pluginRoot);
  const rootStat = lstatOrNull(root);
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) {
    throw new Error(`Claude plugin install root is not a regular directory: ${root}`);
  }
  const contentDir = path.join(backupDir, "content");
  if (existedBefore) {
    ensurePrivateBackupDir(path.dirname(contentDir));
    fs.cpSync(root, contentDir, {
      recursive: true,
      force: true,
      filter: (source) => !isSensitivePluginCachePath(source)
    });
    hardenBackupDirectories(contentDir);
  }
  ensurePrivateBackupDir(backupDir);
  const manifestPath = path.join(backupDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, pluginRoot: root, existedBefore }, null, 2)}\n`, { mode: 0o600 });
  return { pluginRoot: root, backupDir, existedBefore, manifestPath };
}

export function restorePluginInstallRoot({ backupDir, expectedPluginRoot = null }) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")); }
  catch { return { ok: false, changed: false, reason: "plugin install snapshot is missing or invalid" }; }
  if (!manifest?.pluginRoot || typeof manifest.existedBefore !== "boolean") {
    return { ok: false, changed: false, reason: "plugin install snapshot is incomplete" };
  }
  const pluginRoot = path.resolve(manifest.pluginRoot);
  if (expectedPluginRoot && pluginRoot !== path.resolve(expectedPluginRoot)) {
    return { ok: false, changed: false, reason: "plugin install snapshot target does not match metadata" };
  }
  const cacheMarker = `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`;
  if (!pluginRoot.includes(cacheMarker)) {
    return { ok: false, changed: false, reason: "refusing to restore a plugin install outside the Claude cache" };
  }
  try {
    const source = path.join(backupDir, "content");
    if (manifest.existedBefore && !lstatOrNull(source)) {
      return { ok: false, changed: false, reason: "plugin install backup content is missing" };
    }
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    if (manifest.existedBefore) {
      fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
      fs.cpSync(source, pluginRoot, { recursive: true, force: true, verbatimSymlinks: true });
    }
    return { ok: true, changed: true, pluginRoot, removed: !manifest.existedBefore };
  } catch (error) {
    return { ok: false, changed: true, pluginRoot, reason: error?.message || String(error) };
  }
}

// Remove ONLY the matching legacy hook COMMANDS (not whole entries unless they become empty); register the new plan-*.mjs with ABSOLUTE paths.
export function syncSettings({ hooksDir, settingsPath }) {
  const s = readJsonObjectStrict(settingsPath, { label: "Claude settings" });
  ensureHooksObject(s, "Claude settings");
  const removedFiles = [];
  for (const f of LEGACY) {
    const p = path.join(hooksDir, f);
    if (lstatOrNull(p)) { fs.rmSync(p, { force: true }); removedFiles.push(f); }
  }
  s.hooks.SessionStart = Array.isArray(s.hooks.SessionStart) ? s.hooks.SessionStart : [];
  const removedEntries = removeHookCommands(s, LEGACY_COMMANDS);
  s.hooks.PreToolUse = s.hooks.PreToolUse || [];
  s.hooks.PostToolUse = s.hooks.PostToolUse || [];
  s.hooks.Stop = s.hooks.Stop || [];
  register(s.hooks.SessionStart, undefined, path.join(hooksDir, "native-session-start.mjs"), {
    timeout: 30,
    statusMessage: "⛩ bench: arming native push gate…"
  });
  // statusMessage → the gate is VISIBLE in the spinner while it runs (~30–60s panel), so it never
  // looks like "nothing happened". ABSOLUTE homedir paths (no ~).
  register(s.hooks.PreToolUse, "ExitPlanMode", path.join(hooksDir, "plan-review.mjs"), {
    statusMessage: "⛩ bench: reviewing plan…"
  });
  register(s.hooks.PostToolUse, "Write|Edit", path.join(hooksDir, "plan-file-review.mjs"), {
    statusMessage: "⛩ bench: reviewing plan/spec…"
  });
  register(s.hooks.PreToolUse, "Bash", path.join(hooksDir, "pre-push-review.mjs"), {
    statusMessage: "⛩ bench: arming native push gate…",
    timeout: 30,
    // Perf: only spawn on git commands instead of EVERY Bash. The `if` permission rule checks
    // subcommands and FAILS OPEN (runs the hook anyway) if it can't parse. This hook only installs
    // Git's native pre-push dispatcher; the actual review happens later from Git's exact ref tuples.
    if: "Bash(git *)"
  });
  // Pre-MERGE gate: a FAST, content-only, VISIBLE review of the incoming commits before a merge INTO a
  // protected branch. statusMessage → visible in the spinner while it runs; timeout 150s > the hook's own
  // 90s hard cap so it fails open cleanly rather than being SIGKILLed. Unlike the push gate this never
  // does the deep (minutes-long) review inline — it enqueues that async — so a merge never looks hung.
  register(s.hooks.PreToolUse, "Bash", path.join(hooksDir, "pre-merge-review.mjs"), {
    statusMessage: "⛩ bench: reviewing merge…",
    timeout: 150,
    if: "Bash(git merge*)"
  });
  register(s.hooks.Stop, undefined, path.join(hooksDir, "stop-review.mjs"), {
    timeout: 900, asyncRewake: true,
    statusMessage: "⛩ bench: reviewing turn…",
    rewakeMessage: "⛩ bench stop gate found issues in this turn's code changes. Fix them, then stop again to re-review:",
    rewakeSummary: "⛩ bench stop"
  });
  // The deep-review runner: a SECOND matcher-less Stop entry (register appends it alongside
  // stop-review, each entry keeping its own opts). asyncRewake + exit 2 delivers a HIGH deep-review
  // block even to an idle agent. timeout 720s = the 10-min gate budget (DEEP_REVIEW_BUDGET_MS) + ~2 min
  // overhead, so a hung reviewer can't blow past 12 min; the block lands while it's still relevant.
  // Runs concurrently with stop-review.
  register(s.hooks.Stop, undefined, path.join(hooksDir, "deep-review-runner.mjs"), {
    timeout: 720, asyncRewake: true,
    statusMessage: "⛩ bench: deep review…",
    rewakeMessage: "⛩ bench deep review found blocking issues. Address them, then continue:",
    rewakeSummary: "⛩ bench deep review"
  });
  // Drop any blocks left empty by de-duping.
  for (const ev of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
    s.hooks[ev] = (s.hooks[ev] || []).filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  }
  writeJsonConfig(settingsPath, s, "Claude settings");
  return { removedFiles, removedEntries, state: capturePathState(settingsPath) };
}

export function syncCodexHooks({
  hooksDir,
  hooksPath = path.join(os.homedir(), ".codex", "hooks.json")
}) {
  const s = readJsonObjectStrict(hooksPath, { label: "Codex hooks config" });
  ensureHooksObject(s, "Codex hooks config");
  s.hooks.SessionStart = Array.isArray(s.hooks.SessionStart) ? s.hooks.SessionStart : [];
  s.hooks.Stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  register(s.hooks.SessionStart, undefined, path.join(hooksDir, "native-session-start.mjs"), {
    timeout: 30,
    statusMessage: "⛩ bench: arming native push gate…"
  });
  register(s.hooks.Stop, undefined, path.join(hooksDir, "codex-stop-review.mjs"), {
    timeout: 900,
    statusMessage: "⛩ bench: reviewing turn…"
  });
  s.hooks.Stop = s.hooks.Stop.filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  writeJsonConfig(hooksPath, s, "Codex hooks config");
  return {
    hooksPath,
    sessionStartHook: path.join(hooksDir, "native-session-start.mjs"),
    stopHook: path.join(hooksDir, "codex-stop-review.mjs"),
    state: capturePathState(hooksPath)
  };
}

export function syncCodexPrompts({
  srcDir,
  promptsDir = path.join(os.homedir(), ".codex", "prompts"),
  benchRunnerPath
}) {
  if (!benchRunnerPath) throw new Error("syncCodexPrompts requires benchRunnerPath");
  fs.mkdirSync(promptsDir, { recursive: true });
  const promptDirStat = lstatOrNull(promptsDir);
  if (!promptDirStat?.isDirectory() || promptDirStat.isSymbolicLink()) throw new Error(`Codex prompts destination is not a regular directory: ${promptsDir}`);
  const copied = [], backedUp = [], states = [];
  let files = [];
  try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md")).sort(); } catch { files = []; }
  for (const f of files) {
    const from = path.join(srcDir, f);
    const to = path.join(promptsDir, f);
    const rendered = fs.readFileSync(from, "utf8").replaceAll("{{BENCH_RUNNER}}", benchRunnerPath);
    const targetStat = lstatOrNull(to);
    if (targetStat && !targetStat.isFile() && !targetStat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-file Codex prompt target: ${to}`);
    }
    if (targetStat?.isFile() && !targetStat.isSymbolicLink() && fs.readFileSync(to, "utf8") !== rendered) {
      const bak = `${to}.pre-peerbench.bak`;
      if (!lstatOrNull(bak)) { atomicCopyFile(to, bak); backedUp.push(f); }
    }
    atomicWriteFile(to, rendered, { mode: 0o644, label: "Codex prompt" });
    copied.push(f);
    states.push({ name: f, state: capturePathState(to) });
  }
  return { promptsDir, copied, backedUp, states };
}

function gitOrNull(args, cwd, { timeout = 0 } = {}) {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...(timeout > 0 ? { timeout } : {})
    }).trim();
  }
  catch { return null; }
}

export function compareLocalWithOrigin({ cwd, remote = "origin", branch, lsRemoteTimeoutMs = 15_000 } = {}) {
  const repo = gitOrNull(["rev-parse", "--show-toplevel"], cwd);
  if (!repo) return { ok: false, reason: "not a git repository" };
  const localHead = gitOrNull(["rev-parse", "HEAD"], repo);
  const currentBranch = branch || gitOrNull(["branch", "--show-current"], repo);
  if (!localHead || !currentBranch) return { ok: false, repo, reason: "could not resolve local branch/head" };
  // ls-remote touches the network and the installer runs this inside the install lock: keep it
  // bounded so a blackholed origin degrades to a soft skip instead of stalling the install.
  const remoteLine = gitOrNull(["ls-remote", "--heads", remote, currentBranch], repo, { timeout: lsRemoteTimeoutMs });
  if (!remoteLine) return { ok: false, repo, branch: currentBranch, localHead, reason: `could not resolve ${remote}/${currentBranch}` };
  const remoteHead = remoteLine.split(/\s+/)[0] || "";
  const status = gitOrNull(["status", "--short"], repo) || "";
  const dirty = status.split(/\r?\n/).filter(Boolean).length;
  const same = localHead === remoteHead;
  return {
    ok: true,
    repo,
    remote,
    branch: currentBranch,
    localHead,
    remoteHead,
    dirty,
    status: same ? (dirty ? "same-as-origin-with-local-changes" : "same-as-origin") : "differs-from-origin"
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Keep the legacy entrypoint, but route it through the same all-or-nothing transaction as the
  // supported installer. Use a child process rather than a top-level dynamic import: install.mjs
  // statically imports this module, so awaiting that cycle can deadlock module evaluation.
  const installScript = path.join(path.dirname(process.argv[1]), "install.mjs");
  const child = spawnSync(process.execPath, [installScript, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env
  });
  if (child.error) {
    process.stderr.write(`${child.error.message || child.error}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = Number.isInteger(child.status) ? child.status : 1;
  }
}
