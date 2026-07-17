import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { NATIVE_HOOK_MARKER, uninstallNativePrePushHook } from "../global-hooks/native-git-hook.mjs";
import {
  atomicWriteFile,
  capturePathState,
  pathStateMatches,
  ROLLBACK_METADATA_FILE,
  restorePluginInstallRoot,
  restorePluginRuntime
} from "./deploy-global-hooks.mjs";

function readMetadata(backupDir) {
  const target = path.join(backupDir, ROLLBACK_METADATA_FILE);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`rollback metadata is unreadable: ${error?.message || error}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("rollback metadata is not a regular file");
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return value;
  } catch (error) {
    throw new Error(`rollback metadata is invalid: ${error?.message || error}`);
  }
}

function backupNames(dir, extension) {
  try {
    return fs.readdirSync(dir).filter((name) => {
      if (!name.endsWith(extension)) return false;
      const stat = fs.lstatSync(path.join(dir, name));
      return stat.isFile() && !stat.isSymbolicLink();
    });
  }
  catch { return []; }
}

function safeFlatName(name, extension) {
  return typeof name === "string" && name === path.basename(name) && name.endsWith(extension);
}

function stateFromSnapshot(entry) {
  if (!entry?.existed) return { exists: false };
  if (entry.type === "symlink") return { exists: true, type: "symlink", linkTarget: entry.linkTarget };
  return null;
}

function safeTargetEntry(entry, backupDir) {
  if (!entry || typeof entry !== "object" || typeof entry.target !== "string") return { ok: false, reason: "snapshot entry is incomplete" };
  const backupRoot = path.resolve(backupDir);
  if (entry.existed && entry.type === "file") {
    if (typeof entry.backupPath !== "string") return { ok: false, reason: "snapshot backup path is missing" };
    const backupPath = path.resolve(entry.backupPath);
    if (backupPath !== backupRoot && !backupPath.startsWith(`${backupRoot}${path.sep}`)) {
      return { ok: false, reason: "snapshot backup is outside the selected backup" };
    }
    let stat;
    try { stat = fs.lstatSync(backupPath); } catch { return { ok: false, reason: "snapshot backup file is missing" }; }
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: "snapshot backup is not a regular file" };
  }
  if (entry.existed && !["file", "symlink"].includes(entry.type)) return { ok: false, reason: "snapshot target type is invalid" };
  return { ok: true };
}

function restoreSnapshotEntry({ entry, expectedState = null, backupDir }) {
  const valid = safeTargetEntry(entry, backupDir);
  const target = entry?.target;
  if (!valid.ok) return { ok: false, restored: false, removed: false, target, reason: valid.reason };
  const beforeState = stateFromSnapshot(entry);
  if (beforeState && pathStateMatches(target, beforeState)) {
    return { ok: true, restored: false, removed: false, unchanged: true, target };
  }
  if (entry.existed && entry.type === "file") {
    const current = capturePathState(target);
    if (current.exists && current.type === "file" && pathStateMatches(target, {
      exists: true,
      type: "file",
      mode: entry.mode,
      sha256: entry.sha256
    })) {
      return { ok: true, restored: false, removed: false, unchanged: true, target };
    }
  }
  if (expectedState && !pathStateMatches(target, expectedState)) {
    return { ok: false, restored: false, removed: false, target, reason: "target changed after install; preserving user changes" };
  }
  try {
    const current = capturePathState(target);
    if (current.exists && !["file", "symlink"].includes(current.type)) {
      return { ok: false, restored: false, removed: false, target, reason: "refusing to replace a non-file target" };
    }
    if (!entry.existed) {
      if (current.exists) fs.rmSync(target, { force: true });
      return { ok: true, restored: false, removed: current.exists, target };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.type === "symlink") {
      const tmp = path.join(path.dirname(target), `.${path.basename(target)}.rollback-${process.pid}-${crypto.randomUUID()}`);
      try {
        fs.symlinkSync(entry.linkTarget, tmp);
        fs.renameSync(tmp, target);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch {}
      }
    } else {
      atomicWriteFile(target, fs.readFileSync(entry.backupPath), { mode: entry.mode, label: "rollback target" });
    }
    return { ok: true, restored: true, removed: false, target };
  } catch (error) {
    return { ok: false, restored: false, removed: false, target, reason: error?.message || String(error) };
  }
}

function restoreFiles({ backupDir, destination, extension, deployedNames = [], restoreNames = null, snapshots = null, expectedStates = null }) {
  const restored = [], removed = [], failures = [], results = [];
  const originals = backupNames(backupDir, extension).filter((name) => safeFlatName(name, extension));
  deployedNames = (Array.isArray(deployedNames) ? deployedNames : []).filter((name) => safeFlatName(name, extension));
  if (Array.isArray(restoreNames)) restoreNames = restoreNames.filter((name) => safeFlatName(name, extension));
  if (Array.isArray(snapshots)) {
    const wanted = new Set(Array.isArray(restoreNames) ? restoreNames : deployedNames);
    const expected = new Map((Array.isArray(expectedStates) ? expectedStates : []).map((item) => [item?.name, item?.state]));
    for (const snapshot of snapshots) {
      if (!safeFlatName(snapshot?.name, extension) || (wanted.size && !wanted.has(snapshot.name))) continue;
      const boundedSnapshot = { ...snapshot, target: path.join(destination, snapshot.name) };
      const result = restoreSnapshotEntry({ entry: boundedSnapshot, expectedState: expected.get(snapshot.name) || null, backupDir });
      results.push({ name: snapshot.name, ...result });
      if (!result.ok) failures.push(`${snapshot.name}: ${result.reason}`);
      if (result.restored) restored.push(snapshot.name);
      if (result.removed) removed.push(snapshot.name);
    }
    return { ok: failures.length === 0, restored, removed, originals, failures, results };
  }
  const originalsToRestore = Array.isArray(restoreNames)
    ? originals.filter((name) => restoreNames.includes(name))
    : originals;
  if (originalsToRestore.length) fs.mkdirSync(destination, { recursive: true });
  for (const name of originalsToRestore) {
    atomicWriteFile(path.join(destination, name), fs.readFileSync(path.join(backupDir, name)), { label: "rollback hook" });
    restored.push(name);
  }
  for (const name of deployedNames) {
    if (originals.includes(name)) continue;
    const target = path.join(destination, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(name);
    }
  }
  return { ok: true, restored, removed, originals, failures, results };
}

function restoreSingle({ backupPath, destination, knownAbsent = false, mode = null, snapshot = null, expectedState = null, backupDir = null }) {
  if (!destination) return { ok: true, restored: false, removed: false };
  if (snapshot) return restoreSnapshotEntry({ entry: { ...snapshot, target: destination }, expectedState, backupDir });
  let backupStat = null;
  try { backupStat = fs.lstatSync(backupPath); } catch {}
  if (backupStat) {
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      return { ok: false, restored: false, removed: false, reason: "rollback backup is not a regular file" };
    }
    try {
      atomicWriteFile(destination, fs.readFileSync(backupPath), { mode, label: "rollback target" });
      return { ok: true, restored: true, removed: false };
    } catch (error) { return { ok: false, restored: false, removed: false, reason: error?.message || String(error) }; }
  }
  if (knownAbsent && fs.existsSync(destination)) {
    try { fs.rmSync(destination, { force: true }); return { ok: true, restored: false, removed: true }; }
    catch (error) { return { ok: false, restored: false, removed: false, reason: error?.message || String(error) }; }
  }
  return { ok: true, restored: false, removed: false };
}

function restorePluginSnapshots(entries, backupDir) {
  if (!Array.isArray(entries)) return [];
  const backupRoot = path.resolve(backupDir);
  return entries.map((entry) => {
    const snapshotDir = typeof entry?.backupDir === "string" ? path.resolve(entry.backupDir) : "";
    if (!snapshotDir || (snapshotDir !== backupRoot && !snapshotDir.startsWith(`${backupRoot}${path.sep}`))) {
      return { ok: false, changed: false, reason: "plugin runtime snapshot is outside the selected backup" };
    }
    return restorePluginRuntime({ backupDir: snapshotDir });
  });
}

function restorePluginInstallSnapshots(entries, backupDir) {
  if (!Array.isArray(entries)) return [];
  const backupRoot = path.resolve(backupDir);
  return entries.map((entry) => {
    const snapshotDir = typeof entry?.backupDir === "string" ? path.resolve(entry.backupDir) : "";
    if (!entry?.pluginRoot || !snapshotDir || (snapshotDir !== backupRoot && !snapshotDir.startsWith(`${backupRoot}${path.sep}`))) {
      return { ok: false, changed: false, reason: "plugin install snapshot is outside the selected backup" };
    }
    return restorePluginInstallRoot({ backupDir: snapshotDir, expectedPluginRoot: entry.pluginRoot });
  });
}

function restoreRecordedFiles(entries, backupDir) {
  if (!Array.isArray(entries)) return [];
  const backupRoot = path.resolve(backupDir);
  return entries.map((entry) => {
    const backupPath = typeof entry?.backupPath === "string" ? path.resolve(entry.backupPath) : "";
    if (!entry?.target || !backupPath || (backupPath !== backupRoot && !backupPath.startsWith(`${backupRoot}${path.sep}`))) {
      return { restored: false, removed: false, reason: "recorded backup file is outside the selected backup" };
    }
    return restoreSingle({
      backupPath,
      destination: path.resolve(entry.target),
      knownAbsent: entry.existed === false,
      mode: entry.mode,
      snapshot: entry.type ? entry : null,
      expectedState: entry.expectedAfter || null,
      backupDir
    });
  });
}

function restoreNativePrePushSnapshot(snapshot, backupDir) {
  if (!snapshot?.captured || !snapshot.hookPath || !snapshot.localPath) {
    return { ok: false, changed: false, reason: "native pre-push snapshot is incomplete" };
  }
  if (path.basename(snapshot.hookPath) !== "pre-push" || path.basename(snapshot.localPath) !== "pre-push.local") {
    return { ok: false, changed: false, reason: "native pre-push snapshot has invalid hook paths" };
  }
  const backupRoot = path.resolve(backupDir);
  const pathEntryExists = (target) => {
    try { fs.lstatSync(target); return true; } catch { return false; }
  };
  const validBackup = (entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.existed && entry.type === "symlink") return typeof entry.linkTarget === "string";
    if (typeof entry.backupPath !== "string") return false;
    const candidate = path.resolve(entry.backupPath);
    return candidate === backupRoot || candidate.startsWith(`${backupRoot}${path.sep}`);
  };
  if (!validBackup(snapshot.hook) || !validBackup(snapshot.local)) {
    return { ok: false, changed: false, reason: "native pre-push snapshot is outside the selected backup" };
  }
  for (const entry of [snapshot.hook, snapshot.local]) {
    if (entry.existed && entry.type !== "symlink" && !fs.existsSync(entry.backupPath)) {
      return { ok: false, changed: false, reason: "native pre-push backup file is missing" };
    }
  }

  let changed = false;
  const capturedMatches = (entry, target) => {
    if (!entry?.existed) return !pathEntryExists(target);
    let stat;
    try { stat = fs.lstatSync(target); } catch { return false; }
    if (entry.type === "symlink") {
      return stat.isSymbolicLink() && fs.readlinkSync(target) === entry.linkTarget;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    try {
      const sameBytes = fs.readFileSync(target).equals(fs.readFileSync(entry.backupPath));
      const sameMode = !Number.isInteger(entry.mode) || (stat.mode & 0o777) === entry.mode;
      return sameBytes && sameMode;
    } catch { return false; }
  };
  const restoreCaptured = (entry, target) => {
    if (capturedMatches(entry, target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.type === "symlink") {
      fs.symlinkSync(entry.linkTarget, target);
      return true;
    }
    fs.copyFileSync(entry.backupPath, target);
    if (Number.isInteger(entry.mode)) fs.chmodSync(target, entry.mode);
    return true;
  };
  if (snapshot.hook.existed) {
    changed = restoreCaptured(snapshot.hook, snapshot.hookPath) || changed;
  } else if (pathEntryExists(snapshot.hookPath)) {
    let managed = false;
    try {
      const stat = fs.lstatSync(snapshot.hookPath);
      managed = stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(snapshot.hookPath, "utf8").includes(NATIVE_HOOK_MARKER);
    } catch {}
    if (!managed) return { ok: false, changed: false, reason: "native pre-push hook was replaced after install; preserving it" };
    fs.rmSync(snapshot.hookPath, { force: true });
    changed = true;
  }

  if (snapshot.local.existed) {
    changed = restoreCaptured(snapshot.local, snapshot.localPath) || changed;
  } else if (pathEntryExists(snapshot.localPath) && !snapshot.managedBefore && snapshot.hook.existed) {
    // ensureNativePrePushHook created this path by moving the old unmanaged hook. Remove it only if
    // its bytes still match the captured original; preserve post-install user edits on conflict.
    if (capturedMatches(snapshot.hook, snapshot.localPath)) {
      fs.rmSync(snapshot.localPath, { force: true });
      changed = true;
    }
  }
  return { ok: true, changed, restored: snapshot.hook.existed };
}

export function rollback({
  backupDir,
  hooksDir,
  settingsPath,
  statuslinePath,
  deployedNames,
  codexHooksDir,
  codexHooksPath,
  codexPromptsDir,
  codexDeployedNames,
  codexPromptNames,
  metadata: suppliedMetadata,
  uninstallNative = uninstallNativePrePushHook
}) {
  const metadata = suppliedMetadata === undefined ? readMetadata(backupDir) : suppliedMetadata;
  const hasMetadata = metadata !== null && metadata !== undefined;
  const claudeEnabled = !hasMetadata || metadata.claude !== null;
  const codexEnabled = !hasMetadata || metadata.codex !== null;
  const claude = claudeEnabled ? (metadata?.claude || {}) : {};
  const codex = codexEnabled ? (metadata?.codex || {}) : {};

  const effectiveHooksDir = claudeEnabled ? (metadata?.claude ? (claude.hooksDir || null) : hooksDir) : null;
  const effectiveSettingsPath = claudeEnabled ? (metadata?.claude ? (claude.settingsPath || null) : settingsPath) : null;
  const effectiveStatuslinePath = claudeEnabled ? (metadata?.claude ? (claude.statuslinePath || null) : statuslinePath) : null;
  const effectiveDeployedNames = claude.deployedNames || deployedNames || [];
  const claudeFiles = effectiveHooksDir
    ? restoreFiles({
      backupDir,
      destination: effectiveHooksDir,
      extension: ".mjs",
      deployedNames: effectiveDeployedNames,
      restoreNames: metadata?.claude ? (claude.restoreNames || effectiveDeployedNames) : null,
      snapshots: claude.fileSnapshots,
      expectedStates: claude.hookAfterStates
    })
    : { ok: true, restored: [], removed: [], failures: [] };
  const settings = restoreSingle({
    backupPath: path.join(backupDir, "settings.json"),
    destination: effectiveSettingsPath,
    knownAbsent: Boolean(metadata?.claude && claude.settingsBackedUp === false),
    mode: claude.settingsMode,
    snapshot: claude.settingsSnapshot,
    expectedState: claude.settingsAfterState,
    backupDir
  });
  const statusline = !claudeEnabled || (metadata?.claude && claude.statuslineUpdated !== true)
    ? { ok: true, restored: false, removed: false }
    : restoreSingle({
      backupPath: path.join(backupDir, "statusline-command.sh"),
      destination: effectiveStatuslinePath,
      // syncStatuslineSessionArg never creates a missing statusline, so there is nothing to remove.
      knownAbsent: false,
      mode: claude.statuslineMode,
      snapshot: claude.statuslineSnapshot,
      expectedState: claude.statuslineAfterState,
      backupDir
    });

  const codexBackupDir = path.join(backupDir, "codex");
  const effectiveCodexHooksDir = codexEnabled ? (metadata?.codex ? (codex.hooksDir || null) : codexHooksDir) : null;
  const effectiveCodexHooksPath = codexEnabled ? (metadata?.codex ? (codex.hooksPath || null) : codexHooksPath) : null;
  const effectiveCodexPromptsDir = codexEnabled ? (metadata?.codex ? (codex.promptsDir || null) : codexPromptsDir) : null;
  const effectiveCodexDeployedNames = codex.deployedNames || codexDeployedNames || [];
  const effectiveCodexPromptNames = codex.promptNames || codexPromptNames || [];
  const codexFiles = effectiveCodexHooksDir
    ? restoreFiles({
      backupDir: codexBackupDir,
      destination: effectiveCodexHooksDir,
      extension: ".mjs",
      deployedNames: effectiveCodexDeployedNames,
      restoreNames: metadata?.codex ? (codex.restoreNames || effectiveCodexDeployedNames) : null,
      snapshots: codex.fileSnapshots,
      expectedStates: codex.hookAfterStates
    })
    : { ok: true, restored: [], removed: [], failures: [] };
  const codexConfig = restoreSingle({
    backupPath: path.join(codexBackupDir, "hooks.json"),
    destination: effectiveCodexHooksPath,
    knownAbsent: Boolean(metadata?.codex && codex.hooksJsonBackedUp === false),
    mode: codex.hooksJsonMode,
    snapshot: codex.hooksJsonSnapshot,
    expectedState: codex.hooksJsonAfterState,
    backupDir: codexBackupDir
  });
  const codexPrompts = effectiveCodexPromptsDir
    ? restoreFiles({
      backupDir: path.join(codexBackupDir, "prompts"),
      destination: effectiveCodexPromptsDir,
      extension: ".md",
      deployedNames: effectiveCodexPromptNames,
      restoreNames: metadata?.codex ? effectiveCodexPromptNames : null,
      snapshots: codex.promptSnapshots,
      expectedStates: codex.promptAfterStates
    })
    : { ok: true, restored: [], removed: [], failures: [] };
  const claudePluginRuntime = claudeEnabled
    ? restorePluginSnapshots(claude.pluginRuntimeSnapshots, backupDir)
    : [];
  const claudePluginInstalls = claudeEnabled && claude.pluginMutationStarted !== false
    ? restorePluginInstallSnapshots(claude.pluginInstallSnapshots, backupDir)
    : [];
  const claudePluginRegistry = claudeEnabled
    ? restoreRecordedFiles(claude.pluginRegistryFiles, backupDir)
    : [];
  const codexPluginRuntime = codexEnabled
    ? restorePluginSnapshots(codex.pluginRuntimeSnapshots, backupDir)
    : [];

  const native = metadata?.nativePrePush;
  const nativePrePush = native?.changed && native?.snapshot?.captured
    ? restoreNativePrePushSnapshot(native.snapshot, backupDir)
    : (native?.repoRoot && native.installed && !native.installedBefore
      ? uninstallNative(native.repoRoot)
      : { ok: true, changed: false, reason: native?.installedBefore ? "pre-existing managed hook was unchanged" : "not installed by this backup" });

  const failures = [];
  for (const [label, value] of [
    ["Claude hooks", claudeFiles],
    ["Claude settings", settings],
    ["Claude statusline", statusline],
    ["Codex hooks", codexFiles],
    ["Codex hooks config", codexConfig],
    ["Codex prompts", codexPrompts],
    ["native pre-push", nativePrePush]
  ]) {
    if (value?.failures?.length) {
      for (const failure of value.failures) failures.push(`${label}: ${failure}`);
    } else if (value?.ok === false) {
      failures.push(`${label}: ${value.reason || "restore failed"}`);
    }
  }
  for (const [label, values] of [
    ["Claude plugin runtime", claudePluginRuntime],
    ["Claude plugin install", claudePluginInstalls],
    ["Claude plugin registry", claudePluginRegistry],
    ["Codex plugin runtime", codexPluginRuntime]
  ]) {
    for (const value of values) if (value?.ok === false) failures.push(`${label}: ${value.reason || "restore failed"}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    restored: claudeFiles.restored,
    removed: claudeFiles.removed,
    settingsRestored: settings.restored,
    settingsRemoved: settings.removed,
    statuslineRestored: statusline.restored,
    pluginRuntime: claudePluginRuntime,
    pluginInstalls: claudePluginInstalls,
    pluginRegistry: claudePluginRegistry,
    codex: {
      restored: codexFiles.restored,
      removed: codexFiles.removed,
      hooksJsonRestored: codexConfig.restored,
      hooksJsonRemoved: codexConfig.removed,
      promptsRestored: codexPrompts.restored,
      promptsRemoved: codexPrompts.removed,
      pluginRuntime: codexPluginRuntime
    },
    nativePrePush,
    metadataFound: hasMetadata
  };
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
  const home = os.homedir();
  const sharedRoot = path.join(home, ".claude", "plugins", "data", "bench-shared");
  const backupDir = process.argv[2] || latestBackup(sharedRoot);
  if (!backupDir) {
    console.error("No backup dir found; pass one explicitly: node scripts/rollback.mjs <backupDir>");
    process.exit(1);
  }
  let deployedNames = [];
  try { deployedNames = fs.readdirSync(path.join(here, "..", "global-hooks")).filter((f) => f.endsWith(".mjs")); } catch { /* none */ }
  try {
    const r = rollback({
      backupDir,
      hooksDir: path.join(home, ".claude", "hooks"),
      settingsPath: path.join(home, ".claude", "settings.json"),
      statuslinePath: path.join(home, ".claude", "statusline-command.sh"),
      deployedNames,
      codexHooksDir: path.join(home, ".codex", "hooks"),
      codexHooksPath: path.join(home, ".codex", "hooks.json"),
      codexPromptsDir: path.join(home, ".codex", "prompts"),
      codexDeployedNames: deployedNames
    });
    console.log(JSON.stringify({ backupDir, ...r }, null, 2));
    if (!r.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
