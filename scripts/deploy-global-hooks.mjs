import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../global-hooks/is-main.mjs";

export const RETIRED_RUNTIME_FILES = [
  "deep-queue.mjs",
  "deep-review-runner.mjs",
  "legacy-codex-gate.mjs",
  "native-session-start.mjs",
  "plan-file-review.mjs",
  "plan-review.mjs",
  "pre-merge-review.mjs",
  "pre-push-review.mjs",
  "statusline-segment.mjs"
];

export function ensurePrivateBackupDir(dir) {
  ensureDirectoryPathNoSymlinks(dir, { create: true, label: "backup directory" });
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
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", linkTarget: fs.readlinkSync(target) };
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
  ensureDirectoryPathNoSymlinks(path.dirname(pathname), { create: true, label: `${label} parent directory` });
  const tmp = uniqueSibling(pathname, "tmp");
  try {
    fs.writeFileSync(tmp, data, { mode: Number.isInteger(mode) ? mode : 0o600, flag: "wx" });
    if (Number.isInteger(mode)) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, pathname);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function atomicCopyFile(source, destination, { mode = null } = {}) {
  ensureDirectoryPathNoSymlinks(path.dirname(destination), { create: true, label: "copy destination directory" });
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
  } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) hardenBackupDirectories(path.join(root, entry.name));
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
  for (const [target, label] of [[base, "plugin data root"], [from, "legacy data directory"], [to, "peerBench data directory"]]) {
    const stat = lstatOrNull(target);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
      throw new Error(`${label} is not a regular directory: ${target}`);
    }
  }
  const hasConfig = (directory) => {
    const target = path.join(directory, "companion.json");
    const stat = lstatOrNull(target);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`peerBench config is not a regular file: ${target}`);
    readJsonObjectStrict(target, { label: "peerBench config" });
    return true;
  };
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
  } catch (error) {
    throw new Error(`peerBench data migration failed: ${error?.message || error}`);
  }
  return { migrated: false };
}

// Copy every global-hooks/*.mjs FLAT into dest; back up a differing pre-existing file once.
export function deploy({ src, dest }) {
  const sourceStat = lstatOrNull(src);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`hook source is not a regular directory: ${src}`);
  }
  ensureDirectoryPathNoSymlinks(dest, { create: true, label: "hook destination" });
  const destStat = lstatOrNull(dest);
  if (!destStat?.isDirectory() || destStat.isSymbolicLink()) {
    throw new Error(`hook destination is not a regular directory: ${dest}`);
  }
  const copied = [], backedUp = [], removed = [], states = [];
  for (const file of RETIRED_RUNTIME_FILES) {
    const target = path.join(dest, file);
    const stat = lstatOrNull(target);
    if (stat) {
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`refusing to remove non-file retired hook target: ${target}`);
      }
      fs.rmSync(target, { force: true });
      removed.push(file);
    }
    states.push({ name: file, state: { exists: false } });
  }
  const retired = new Set(RETIRED_RUNTIME_FILES);
  for (const f of fs.readdirSync(src).filter((name) => name.endsWith(".mjs") && !retired.has(name)).sort()) {
    const from = path.join(src, f), to = path.join(dest, f);
    const fromStat = lstatOrNull(from);
    if (!fromStat?.isFile() || fromStat.isSymbolicLink()) {
      throw new Error(`hook source is not a regular file: ${from}`);
    }
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
  return { copied, backedUp, removed, states };
}

// LAYER-3 BACKUP: snapshot the current live hooks + settings BEFORE we mutate them, so rollback.mjs can
// restore exactly. Snapshot EVERY live *.mjs in hooksDir (not a hardcoded list, which silently missed
// newly-added hooks like stop-review/pre-push-review — found by the bench's own hunt).
export const ROLLBACK_METADATA_FILE = "install-metadata.json";

export function writeRollbackMetadata({ backupDir, metadata }) {
  ensurePrivateBackupDir(backupDir);
  const target = path.join(backupDir, ROLLBACK_METADATA_FILE);
  atomicWriteFile(target, `${JSON.stringify({ schemaVersion: 1, ...metadata }, null, 2)}\n`, {
    mode: 0o600,
    rejectSymlink: true,
    label: "rollback metadata"
  });
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

function flatNames(values, extension) {
  return [...new Set(Array.isArray(values) ? values : [])]
    .filter((name) => typeof name === "string" && name === path.basename(name) && name.endsWith(extension));
}

export function snapshot({ hooksDir, settingsPath, backupDir, statuslinePath = null, fileNames = null }) {
  ensurePrivateBackupDir(backupDir);
  const files = [], entries = [];
  let live = [];
  if (Array.isArray(fileNames)) live = flatNames(fileNames, ".mjs");
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
  if (Array.isArray(fileNames)) live = flatNames(fileNames, ".mjs");
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
    let livePrompts = [];
    if (Array.isArray(promptNames)) livePrompts = flatNames(promptNames, ".md");
    else try { livePrompts = fs.readdirSync(promptsDir).filter((f) => f.endsWith(".md")); } catch { livePrompts = []; }
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

const RETIRED_STATUSLINE_SESSION_LINE =
  `bench_session_id=$(printf '%s' "$input" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')`;

// peerBench 0.4 has no statusline integration. Remove only the retired peerBench process invocation
// from a user's wrapper. An assignment is kept as an empty value so custom fallback expressions such
// as `${gc_gate:-$codex_gate}` and wrappers using `set -u` continue to work unchanged.
export function removePeerBenchStatuslineSegment({
  statuslinePath = path.join(os.homedir(), ".claude", "statusline-command.sh")
} = {}) {
  const stat = lstatOrNull(statuslinePath);
  if (stat?.isSymbolicLink()) throw new Error(`statusline is a symlink; refusing to follow or overwrite ${statuslinePath}`);
  if (stat && !stat.isFile()) throw new Error(`statusline is not a regular file: ${statuslinePath}`);
  let text;
  try { text = fs.readFileSync(statuslinePath, "utf8"); }
  catch { return { statuslinePath, updated: false, reason: "missing" }; }

  const lines = text.split("\n");
  const retiredAssignments = [];
  const unsafe = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("statusline-segment.mjs") || /^\s*#/.test(lines[i])) continue;
    const assignment = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$\((.*statusline-segment\.mjs.*?)\)\s*(#.*)?$/.exec(lines[i]);
    if (!assignment) {
      unsafe.push(i + 1);
      continue;
    }
    const [, indent, variable, , comment] = assignment;
    lines[i] = `${indent}${variable}=""${comment ? ` ${comment}` : ""}`;
    retiredAssignments.push(variable);
  }
  if (unsafe.length) {
    throw new Error(`could not safely remove peerBench statusline invocation at ${statuslinePath}:${unsafe.join(",")}`);
  }
  if (!retiredAssignments.length) {
    return { statuslinePath, updated: false, reason: "no peerbench statusline segment" };
  }

  // This exact helper line was inserted by older peerBench installers. Remove it only when the
  // retired invocation was found and no other active wrapper line still consumes the value.
  const sessionIdStillUsed = lines.some((line) =>
    !/^\s*#/.test(line)
      && line.trim() !== RETIRED_STATUSLINE_SESSION_LINE
      && line.includes("$bench_session_id")
  );
  let removedSessionHelper = false;
  if (!sessionIdStillUsed) {
    const helperIndex = lines.findIndex((line) => line.trim() === RETIRED_STATUSLINE_SESSION_LINE);
    if (helperIndex >= 0) {
      lines.splice(helperIndex, 1);
      removedSessionHelper = true;
    }
  }

  atomicWriteFile(statuslinePath, lines.join("\n"), {
    mode: stat?.mode & 0o777,
    rejectSymlink: true,
    label: "statusline"
  });
  return {
    statuslinePath,
    updated: true,
    removedInvocations: retiredAssignments.length,
    retiredAssignments,
    removedSessionHelper
  };
}

const LEGACY = ["codex-plan-review.mjs", "codex-plan-file-review.mjs"];
// Do not mutate the independent openai/codex-plugin-cc stop gate. Its per-workspace state belongs
// to that plugin, not peerBench; deployment must preserve it byte-for-byte.
const LEGACY_COMMANDS = [...LEGACY];
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
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function commandReferencesBasename(command, basename) {
  const escaped = escapeRegExp(basename);
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_./\\\\-])`).test(String(command || ""));
}

function commandReferencesExactPath(command, pathname) {
  const escaped = escapeRegExp(path.resolve(pathname));
  return new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"';])`).test(String(command || ""));
}

// stop-review.mjs is not globally unique. Remove it only when it is under a peerBench-owned
// hooks/cache path (or the exact deploy target); preserve e.g. /other/plugin/stop-review.mjs.
function isPeerBenchHookCommand(command, basename, managedRoots = []) {
  const text = String(command || "");
  if (!commandReferencesBasename(text, basename)) return false;
  for (const root of managedRoots) {
    if (root && commandReferencesExactPath(text, path.join(root, basename))) return true;
  }
  const slashText = text.replaceAll("\\", "/");
  const escaped = escapeRegExp(basename);
  const knownPath = new RegExp(
    `(?:\\$HOME|~|/[^\\s"']*)/(?:\\.claude|\\.codex)/hooks/${escaped}(?=$|[\\s"';])` +
    `|/plugins/cache/(?:aiwithrai|rai-tools|peerbench)/bench/[^/\\s"']+/global-hooks/${escaped}(?=$|[\\s"';])` +
    `|/peerbench(?:/|-[^/]+/)[^\\s"']*global-hooks/${escaped}(?=$|[\\s"';])`
  );
  if (knownPath.test(slashText)) return true;
  return false;
}
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
    b.hooks = b.hooks.filter((h) => !isPeerBenchHookCommand(h.command, base, [path.dirname(absCmd)]));
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

function removeHookCommands(settings, basenames, managedRoots = []) {
  let removedEntries = 0;
  ensureHooksObject(settings, "hook config");
  for (const ev of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[ev]) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((hook) => !basenames.some((file) => isPeerBenchHookCommand(hook.command, file, managedRoots)));
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
  const removedEntries = removeHookCommands(
    s,
    [...PEERBENCH_SETTINGS_HOOKS, ...LEGACY_COMMANDS],
    [path.join(path.dirname(settingsPath), "hooks")]
  );
  writeJsonConfig(settingsPath, s, "Claude settings");
  return { removedEntries, removedFiles: [], pluginManaged: true };
}

export function removeCodexSettingsPeerBenchHooks({ hooksPath }) {
  const s = readJsonObjectStrict(hooksPath, { label: "Codex hooks config" });
  ensureHooksObject(s, "Codex hooks config");
  const removedEntries = removeHookCommands(s, PEERBENCH_CODEX_HOOKS, [path.join(path.dirname(hooksPath), "hooks")]);
  // peerBench OWNS this file, so prune every event left with no blocks. A bare `"Stop": []` reads like
  // a configured-but-broken gate — the live ~/.codex/hooks.json sat at {"hooks":{"Stop":[]}} for days.
  // Scoped here on purpose: Claude's settings.json is shared with other tools and keeps its empty events.
  for (const event of Object.keys(s.hooks)) {
    if (s.hooks[event].length === 0) delete s.hooks[event];
  }
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
    const target = path.join(root, relativePath);
    if (!lstatOrNull(target)) continue;
    const version = readJsonObjectStrict(target, { label: `peerBench ${label}` })?.version;
    if (typeof version === "string" && version.trim()) declarations.push({ label, version: version.trim() });
  }
  return declarations;
}

export function checkoutPluginVersion(repoRoot) {
  const declarations = pluginVersionDeclarations(repoRoot);
  const versions = [...new Set(declarations.map((entry) => entry.version))];
  if (versions.length !== 1) {
    const detail = declarations.length
      ? declarations.map((entry) => `${entry.label}=${entry.version}`).join(", ")
      : "no version declarations found";
    throw new Error(`peerBench checkout version is not coherent (${detail}); refusing to deploy plugin runtime.`);
  }
  return versions[0];
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
      "Upgrade peerBench through Codex's plugin manager; cache versions are never overlaid:",
      "  codex plugin marketplace upgrade aiwithrai",
      "Then fully restart Codex and rerun setup."
    ].join("\n");
  }
  return "Reinstall bench@aiwithrai through its plugin manager, then rerun setup.";
}

export function assertPluginCacheVersionMatch({ repoRoot, pluginRoot, platform = inferredPluginPlatform(pluginRoot) }) {
  const checkoutVersion = checkoutPluginVersion(repoRoot);
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
  pluginId = "bench@aiwithrai",
  expectedVersion = null
} = {}) {
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(installedPath);
  const entries = Array.isArray(installed?.plugins?.[pluginId]) ? installed.plugins[pluginId] : [];
  const scoped = entries.filter((entry) => entry.scope === "user" || entry.scope === "local" || entry.scope === "project");
  const candidates = (scoped.length ? scoped : entries).filter((entry) => {
    if (typeof entry?.installPath !== "string" || !fs.existsSync(entry.installPath)) return false;
    if (!expectedVersion) return true;
    return path.basename(path.resolve(entry.installPath)) === expectedVersion
      && pluginVersionDeclarations(entry.installPath).every((item) => item.version === expectedVersion);
  });
  return candidates.at(-1)?.installPath || null;
}

export function latestCodexBenchPluginRoot({
  home = os.homedir(),
  marketplaceName = "aiwithrai",
  pluginName = "bench",
  expectedVersion = null
} = {}) {
  const cacheDir = path.join(home, ".codex", "plugins", "cache", marketplaceName, pluginName);
  if (expectedVersion) {
    const exact = path.join(cacheDir, expectedVersion);
    const stat = lstatOrNull(exact);
    if (stat?.isDirectory() && !stat.isSymbolicLink()
        && fs.existsSync(path.join(exact, ".codex-plugin", "plugin.json"))) return exact;
    return null;
  }
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

const PLUGIN_RUNTIME_DIRS = ["global-hooks", "scripts", "hooks", "commands", "skills", "codex-prompts"];
const PLUGIN_RUNTIME_FILES = ["hooks.json", "package.json", "README.md", "LICENSE", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

export function deployPluginRuntime({ repoRoot, pluginRoot, platform = inferredPluginPlatform(pluginRoot) }) {
  assertPluginCacheVersionMatch({ repoRoot, pluginRoot, platform });
  const pluginStat = lstatOrNull(pluginRoot);
  if (pluginStat?.isSymbolicLink() || (pluginStat && !pluginStat.isDirectory())) {
    throw new Error(`plugin cache root is not a regular directory: ${pluginRoot}`);
  }
  ensureDirectoryPathNoSymlinks(pluginRoot, { create: true, label: "plugin cache root" });
  const copied = [], removed = [];
  const copyDir = (rel) => {
    const from = path.join(repoRoot, rel);
    const target = path.join(pluginRoot, rel);
    const fromStat = lstatOrNull(from);
    if (!fromStat) {
      if (lstatOrNull(target)) { fs.rmSync(target, { recursive: true, force: true }); removed.push(`${rel}/`); }
      return;
    }
    if (!fromStat.isDirectory() || fromStat.isSymbolicLink()) {
      throw new Error(`plugin runtime source is not a regular directory: ${from}`);
    }
    const staged = uniqueSibling(target, "stage");
    const old = uniqueSibling(target, "old");
    let movedOld = false, preserveOld = false;
    try {
      fs.cpSync(from, staged, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (rel === "global-hooks") {
        for (const retired of RETIRED_RUNTIME_FILES) {
          fs.rmSync(path.join(staged, retired), { recursive: true, force: true });
        }
      }
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
    if (!fromStat.isFile() || fromStat.isSymbolicLink()) {
      throw new Error(`plugin runtime source is not a regular file: ${from}`);
    }
    atomicCopyFile(from, target);
    copied.push(rel);
  };
  for (const rel of PLUGIN_RUNTIME_DIRS) copyDir(rel);
  for (const rel of PLUGIN_RUNTIME_FILES) copyFile(rel);
  return { pluginRoot, copied, removed };
}

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
  atomicWriteFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, pluginRoot: root, existedBefore, entries }, null, 2)}\n`, {
    mode: 0o600,
    rejectSymlink: true,
    label: "plugin runtime snapshot"
  });
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
        if (entry && [...PLUGIN_RUNTIME_DIRS, ...PLUGIN_RUNTIME_FILES].includes(entry.rel)) {
          fs.rmSync(path.join(pluginRoot, entry.rel), { recursive: true, force: true });
        }
      }
      try { fs.rmdirSync(pluginRoot); } catch {}
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
  atomicWriteFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, pluginRoot: root, existedBefore }, null, 2)}\n`, {
    mode: 0o600,
    rejectSymlink: true,
    label: "plugin install snapshot"
  });
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

function pathIsWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

// Reject symlinks one component at a time below a trusted home/temp root. Recursive mkdir by itself
// follows an intermediate link and can redirect an install into an unrelated tree.
export function ensureDirectoryPathNoSymlinks(targetDir, {
  create = false,
  label = "directory",
  trustedRoots = [os.homedir(), os.tmpdir()]
} = {}) {
  const target = path.resolve(targetDir);
  const candidates = trustedRoots
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => pathIsWithin(candidate, target))
    .sort((a, b) => b.length - a.length);
  const trustedRoot = candidates[0] || path.parse(target).root;
  const rootStat = fs.statSync(trustedRoot);
  if (!rootStat.isDirectory()) throw new Error(`${label} trusted root is not a directory: ${trustedRoot}`);
  let cursor = trustedRoot;
  const rel = path.relative(trustedRoot, target);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat = lstatOrNull(cursor);
    if (!stat) {
      if (!create) return false;
      try { fs.mkdirSync(cursor, { mode: 0o755 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      stat = lstatOrNull(cursor);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink or non-directory component: ${cursor}`);
    }
  }
  return true;
}

// Remove every older peerBench auto-hook, then install only the lightweight Stop
// review. Git's native pre-push hook is managed separately; Claude settings must
// not spawn plan/file/merge/push/deep reviews on ordinary tool use.
export function syncSettings({ hooksDir, settingsPath }) {
  const removedFiles = [];
  for (const f of LEGACY) {
    const target = path.join(hooksDir, f);
    const stat = lstatOrNull(target);
    if (stat) {
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`refusing to remove non-file legacy hook: ${target}`);
      fs.rmSync(target, { force: true });
      removedFiles.push(f);
    }
  }
  const s = readJsonObjectStrict(settingsPath, { label: "Claude settings" });
  ensureHooksObject(s, "Claude settings");
  const removedEntries = removeHookCommands(s, [...PEERBENCH_SETTINGS_HOOKS, ...LEGACY_COMMANDS], [hooksDir]);
  s.hooks.Stop = s.hooks.Stop || [];
  register(s.hooks.Stop, undefined, path.join(hooksDir, "stop-review.mjs"), {
    timeout: 20,
    statusMessage: "⛩ bench: quick MiMo advisory…"
  });
  s.hooks.Stop = s.hooks.Stop.filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  writeJsonConfig(settingsPath, s, "Claude settings");
  return { removedFiles, removedEntries, state: capturePathState(settingsPath) };
}

export function syncCodexHooks({
  hooksDir,
  hooksPath = path.join(os.homedir(), ".codex", "hooks.json")
}) {
  const s = readJsonObjectStrict(hooksPath, { label: "Codex hooks config" });
  ensureHooksObject(s, "Codex hooks config");
  removeHookCommands(s, PEERBENCH_CODEX_HOOKS, [hooksDir]);
  s.hooks.Stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  register(s.hooks.Stop, undefined, path.join(hooksDir, "codex-stop-review.mjs"), {
    timeout: 20,
    statusMessage: "⛩ bench: quick MiMo advisory…"
  });
  s.hooks.Stop = s.hooks.Stop.filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  writeJsonConfig(hooksPath, s, "Codex hooks config");
  return { hooksPath, stopHook: path.join(hooksDir, "codex-stop-review.mjs"), state: capturePathState(hooksPath) };
}

export function syncCodexPrompts({
  srcDir,
  promptsDir = path.join(os.homedir(), ".codex", "prompts"),
  benchRunnerPath
}) {
  if (!benchRunnerPath) throw new Error("syncCodexPrompts requires benchRunnerPath");
  const promptDirStat = lstatOrNull(promptsDir);
  if (promptDirStat?.isSymbolicLink() || (promptDirStat && !promptDirStat.isDirectory())) {
    throw new Error(`Codex prompts destination is not a regular directory: ${promptsDir}`);
  }
  if (!promptDirStat) ensureDirectoryPathNoSymlinks(promptsDir, { create: true, label: "Codex prompts destination" });
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

const INSTALLER_SYNC_GIT_TIMEOUT_MS = 30_000;

function gitOrNull(args, cwd, { timeout = INSTALLER_SYNC_GIT_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      killSignal: "SIGKILL"
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

export function isDeployEntrypoint(metaUrl, argv1 = process.argv[1]) {
  return isMainModule(metaUrl, argv1);
}

export function runDeployEntrypoint({ argv = process.argv.slice(2), env = process.env, spawnImpl = spawnSync } = {}) {
  // Keep the legacy command, but route it through the same all-or-nothing transaction as install.mjs.
  // A child avoids a circular top-level import: install.mjs imports this module for deploy helpers.
  const modulePath = fs.realpathSync.native(fileURLToPath(import.meta.url));
  const installScript = path.join(path.dirname(modulePath), "install.mjs");
  const child = spawnImpl(process.execPath, [installScript, ...argv], { stdio: "inherit", env });
  if (child.error) {
    process.stderr.write(`${child.error.message || child.error}\n`);
    return 1;
  }
  return Number.isInteger(child.status) ? child.status : 1;
}

if (isDeployEntrypoint(import.meta.url)) {
  process.exitCode = runDeployEntrypoint();
}
