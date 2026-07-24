#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../global-hooks/is-main.mjs";
import {
  compareLocalWithOrigin,
  atomicWriteFile,
  capturePathState,
  checkoutPluginVersion,
  deploy,
  ensureDirectoryPathNoSymlinks,
  ensurePrivateBackupDir,
  migrateDataDir,
  snapshot,
  snapshotCodex,
  writeRollbackMetadata,
  syncCodexHooks,
  syncCodexPrompts,
  assertPluginCacheVersionMatch,
  deployPluginRuntime,
  latestCodexBenchPluginRoot,
  isSensitivePluginCachePath,
  snapshotPluginInstallRoot,
  snapshotPluginRuntime,
  removeClaudeSettingsPeerBenchHooks,
  removeCodexSettingsPeerBenchHooks,
  readJsonObjectStrict,
  RETIRED_RUNTIME_FILES,
  syncSettings,
  removePeerBenchStatuslineSegment
} from "./deploy-global-hooks.mjs";
import { rollback } from "./rollback.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_CLAUDE_MARKETPLACE = "aiwithrai";
export const LEGACY_CLAUDE_MARKETPLACES = ["rai-tools", "peerbench"];
export const CLAUDE_PLUGIN_NAME = "bench";

function readJson(pathname) {
  return readJsonObjectStrict(pathname, { label: `JSON config ${pathname}` });
}

function expandHome(value, home = os.homedir()) {
  const raw = String(value || "");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return raw;
}

function sameDirectory(a, b, home = os.homedir()) {
  if (!a || !b) return false;
  const left = path.resolve(expandHome(a, home));
  const right = path.resolve(expandHome(b, home));
  try { return fs.realpathSync.native(left) === fs.realpathSync.native(right); }
  catch { return left === right; }
}

function marketplacePath(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.path === "string") return entry.path;
  if (entry.source && typeof entry.source.path === "string") return entry.source.path;
  return "";
}

function writeJsonIfChanged(pathname, value) {
  const beforeState = capturePathState(pathname);
  if (beforeState.exists && beforeState.type !== "file") {
    throw new Error(`JSON config is not a regular file; refusing to follow or overwrite ${pathname}`);
  }
  const before = beforeState.exists ? fs.readFileSync(pathname, "utf8") : "";
  const after = `${JSON.stringify(value, null, 2)}\n`;
  if (before !== after) {
    atomicWriteFile(pathname, after, { mode: 0o600, rejectSymlink: true, label: "JSON config" });
    return true;
  }
  if (fs.existsSync(pathname)) fs.chmodSync(pathname, 0o600);
  return false;
}

export function scrubSensitivePluginCacheFiles(root) {
  const removed = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (isSensitivePluginCachePath(entry.name)) {
        try {
          fs.rmSync(p, { force: true });
          removed.push(p);
        } catch { /* best-effort cache scrub */ }
      }
    }
  }
  if (root) walk(root);
  return removed;
}

function snapshotRollbackFile({ target, backupDir, name }) {
  const backupPath = path.join(backupDir, name);
  const before = capturePathState(target);
  if (before.exists && !["file", "symlink"].includes(before.type)) {
    throw new Error(`refusing to snapshot non-file registry target: ${target}`);
  }
  if (before.type === "file") {
    ensurePrivateBackupDir(path.dirname(backupPath));
    fs.copyFileSync(target, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  return {
    target: path.resolve(target),
    backupPath,
    existed: before.exists,
    mode: before.mode ?? null,
    type: before.type ?? null,
    linkTarget: before.linkTarget ?? null,
    sha256: before.sha256 ?? null
  };
}

function latestInstalledPluginPath({
  installedPath,
  pluginId,
  scope = "user"
}) {
  const installed = readJson(installedPath);
  const entries = Array.isArray(installed?.plugins?.[pluginId]) ? installed.plugins[pluginId] : [];
  const scoped = entries.filter((entry) => !scope || entry.scope === scope);
  const latest = (scoped.length ? scoped : entries).at(-1);
  return typeof latest?.installPath === "string" ? latest.installPath : null;
}

function legacyPluginCachePath({ claudeDir, marketplace, pluginName }) {
  return path.join(claudeDir, "plugins", "cache", marketplace, pluginName);
}

export function claudePluginInstallRoots({
  home = os.homedir(),
  claudeDir = path.join(home, ".claude"),
  repoRoot = ROOT,
  marketplaceName = DEFAULT_CLAUDE_MARKETPLACE,
  pluginName = CLAUDE_PLUGIN_NAME,
  legacyMarketplaces = LEGACY_CLAUDE_MARKETPLACES
} = {}) {
  const known = readJson(path.join(claudeDir, "plugins", "known_marketplaces.json"));
  const installed = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
  const marketplaces = [marketplaceName];
  for (const legacy of legacyMarketplaces) {
    const entry = known[legacy];
    if (entry && sameDirectory(marketplacePath(entry.source) || entry.installLocation, repoRoot, home)) marketplaces.push(legacy);
  }
  const roots = [];
  for (const marketplace of marketplaces) {
    const entries = installed?.plugins?.[`${pluginName}@${marketplace}`];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.scope && entry.scope !== "user") continue;
      if (typeof entry?.installPath !== "string") continue;
      const root = path.resolve(expandHome(entry.installPath, home));
      const state = capturePathState(root);
      if (!state.exists) continue;
      if (state.type !== "directory") throw new Error(`Claude plugin install root is not a regular directory: ${root}`);
      if (!roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

function allClaudeBenchCacheRoots({
  home,
  claudeDir = path.join(home, ".claude"),
  marketplaceName,
  pluginName = CLAUDE_PLUGIN_NAME,
  legacyMarketplaces = LEGACY_CLAUDE_MARKETPLACES
}) {
  const roots = new Set();
  const marketplaces = [...new Set([marketplaceName, ...legacyMarketplaces].filter(Boolean))];
  const installed = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
  for (const marketplace of marketplaces) {
    const entries = installed?.plugins?.[`${pluginName}@${marketplace}`];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry?.installPath !== "string") continue;
        const candidate = path.resolve(expandHome(entry.installPath, home));
        if (capturePathState(candidate).exists) roots.add(candidate);
      }
    }
    const cacheRoot = path.join(claudeDir, "plugins", "cache", marketplace, pluginName);
    let versions = [];
    try { versions = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { versions = []; }
    for (const version of versions) {
      if (version.isSymbolicLink()) throw new Error(`Claude plugin cache version is a symlink: ${path.join(cacheRoot, version.name)}`);
      if (version.isDirectory()) roots.add(path.join(cacheRoot, version.name));
    }
  }
  return [...roots];
}

function runCommand(runner, command, args, opts = {}) {
  const res = runner(command, args, opts);
  return {
    command: [command, ...args].join(" "),
    status: typeof res.status === "number" ? res.status : (res.error ? 1 : 0),
    stdout: (res.stdout || "").toString().trim(),
    stderr: (res.stderr || "").toString().trim(),
    error: res.error ? String(res.error.message || res.error) : ""
  };
}

export function syncClaudePluginRegistry({
  repoRoot = ROOT,
  home = os.homedir(),
  claudeDir = path.join(home, ".claude"),
  marketplaceName = DEFAULT_CLAUDE_MARKETPLACE,
  pluginName = CLAUDE_PLUGIN_NAME,
  legacyMarketplaces = LEGACY_CLAUDE_MARKETPLACES,
  runner = spawnSync,
  env = process.env,
  now = () => new Date().toISOString(),
  skipCli = false,
  onBeforeMutation = () => {}
} = {}) {
  const knownPath = path.join(claudeDir, "plugins", "known_marketplaces.json");
  const installedPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const known = readJson(knownPath);
  const nextKnown = { ...known };
  const removedLegacy = [];
  for (const legacy of legacyMarketplaces) {
    if (!legacy || legacy === marketplaceName) continue;
    const entry = known[legacy];
    if (entry && sameDirectory(marketplacePath(entry.source) || entry.installLocation, repoRoot, home)) {
      delete nextKnown[legacy];
      removedLegacy.push(legacy);
    }
  }
  nextKnown[marketplaceName] = {
    source: { source: "directory", path: path.resolve(repoRoot) },
    installLocation: path.resolve(repoRoot),
    lastUpdated: now()
  };
  const existingMarketplace = known[marketplaceName];
  const currentMarketplaceMatches = sameDirectory(
    marketplacePath(existingMarketplace?.source) || existingMarketplace?.installLocation,
    repoRoot,
    home
  );

  const result = {
    knownPath,
    installedPath,
    marketplaceName,
    pluginId: `${pluginName}@${marketplaceName}`,
    knownUpdated: false,
    removedLegacy,
    cli: { attempted: false, skipped: false, commands: [] },
    installPath: null,
    scrubbed: []
  };
  const hardenRegistryFiles = () => {
    for (const target of [knownPath, installedPath]) {
      try {
        const stat = fs.lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(target, 0o600);
      } catch {}
    }
  };

  if (skipCli) {
    result.knownUpdated = writeJsonIfChanged(knownPath, nextKnown);
    hardenRegistryFiles();
    result.cli.skipped = true;
    result.cli.reason = "disabled";
    return result;
  }

  const probe = runCommand(runner, "claude", ["--version"], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
  if (probe.error || probe.status !== 0) {
    result.knownUpdated = writeJsonIfChanged(knownPath, nextKnown);
    hardenRegistryFiles();
    result.cli.skipped = true;
    result.cli.reason = probe.error || probe.stderr || probe.stdout || "claude CLI not available";
    return result;
  }
  result.cli.attempted = true;
  onBeforeMutation();

  for (const legacy of removedLegacy) {
    const uninstall = runCommand(runner, "claude", ["plugin", "remove", `${pluginName}@${legacy}`, "--keep-data", "-s", "user"], {
      cwd: repoRoot,
      env,
      encoding: "utf8"
    });
    result.cli.commands.push(uninstall);
    // Old plugin ids may not be installed; removing them is best-effort.
    const remove = runCommand(runner, "claude", ["plugin", "marketplace", "remove", legacy], {
      cwd: repoRoot,
      env,
      encoding: "utf8"
    });
    result.cli.commands.push(remove);
    // Removal can be a no-op if the registry was already edited by a previous run.
  }

  const steps = [];
  const existingInstallPath = latestInstalledPluginPath({ installedPath, pluginId: result.pluginId, scope: "user" });
  if (existingInstallPath) {
    steps.push(["plugin", "remove", result.pluginId, "--keep-data", "-s", "user"]);
  }
  if (!currentMarketplaceMatches) {
    steps.push(["plugin", "marketplace", "add", path.resolve(repoRoot)]);
  }
  steps.push(["plugin", "install", result.pluginId]);

  for (const args of steps) {
    const step = runCommand(runner, "claude", args, { cwd: repoRoot, env, encoding: "utf8" });
    result.cli.commands.push(step);
    if (step.status !== 0) {
      throw new Error(`claude ${args.join(" ")} failed: ${step.stderr || step.stdout || step.error || `exit ${step.status}`}`);
    }
  }

  result.knownUpdated = writeJsonIfChanged(knownPath, nextKnown);
  hardenRegistryFiles();
  result.installPath = latestInstalledPluginPath({ installedPath, pluginId: result.pluginId, scope: "user" });
  if (result.installPath) result.scrubbed = scrubSensitivePluginCacheFiles(result.installPath);
  for (const legacy of removedLegacy) {
    result.scrubbed.push(...scrubSensitivePluginCacheFiles(legacyPluginCachePath({ claudeDir, marketplace: legacy, pluginName })));
  }
  return result;
}

export function syncClaudePluginSettings({
  settingsPath = path.join(os.homedir(), ".claude", "settings.json"),
  repoRoot = ROOT,
  marketplaceName = DEFAULT_CLAUDE_MARKETPLACE,
  legacyMarketplaces = LEGACY_CLAUDE_MARKETPLACES,
  home = os.homedir()
} = {}) {
  const settings = readJsonObjectStrict(settingsPath, { label: "Claude settings" });
  if (settings.extraKnownMarketplaces !== undefined
      && (!settings.extraKnownMarketplaces || typeof settings.extraKnownMarketplaces !== "object" || Array.isArray(settings.extraKnownMarketplaces))) {
    throw new Error("Claude settings has an invalid extraKnownMarketplaces value; expected an object");
  }
  if (settings.enabledPlugins !== undefined
      && (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object" || Array.isArray(settings.enabledPlugins))) {
    throw new Error("Claude settings has an invalid enabledPlugins value; expected an object");
  }
  settings.extraKnownMarketplaces ||= {};
  settings.enabledPlugins ||= {};

  const migrated = [];
  for (const legacy of legacyMarketplaces) {
    if (!legacy || legacy === marketplaceName) continue;
    const entry = settings.extraKnownMarketplaces[legacy];
    if (entry && sameDirectory(marketplacePath(entry), repoRoot, home)) {
      delete settings.extraKnownMarketplaces[legacy];
      delete settings.enabledPlugins[`bench@${legacy}`];
      migrated.push(legacy);
    }
  }

  settings.extraKnownMarketplaces[marketplaceName] = {
    source: { source: "directory", path: path.resolve(repoRoot) }
  };
  const pluginId = `bench@${marketplaceName}`;
  settings.enabledPlugins[pluginId] = true;

  const updated = writeJsonIfChanged(settingsPath, settings);
  return {
    settingsPath,
    marketplaceName,
    pluginId,
    migrated,
    updated
  };
}

export function parseInstallArgs(argv = []) {
  const opts = {
    claude: true,
    codex: true,
    loadKeys: false,
    keysPath: null,
    marketplaceName: DEFAULT_CLAUDE_MARKETPLACE,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--claude-only") { opts.claude = true; opts.codex = false; continue; }
    if (arg === "--codex-only") { opts.claude = false; opts.codex = true; continue; }
    if (arg === "--no-claude") { opts.claude = false; continue; }
    if (arg === "--no-codex") { opts.codex = false; continue; }
    if (arg === "--claude") { opts.claude = true; continue; }
    if (arg === "--codex") { opts.codex = true; continue; }
    if (arg === "--load-keys") { opts.loadKeys = true; continue; }
    if (arg === "--keys" && i + 1 < argv.length) { opts.keysPath = argv[++i]; continue; }
    if (arg === "--marketplace" && i + 1 < argv.length) { opts.marketplaceName = argv[++i]; continue; }
    throw new Error(`unknown install option: ${arg}`);
  }
  if (!opts.claude && !opts.codex) throw new Error("nothing to install: both Claude and Codex are disabled");
  return opts;
}

function acquireInstallLock({ home, now = () => Date.now() }) {
  const dataDir = path.join(home, ".claude", "plugins", "data");
  ensureDirectoryPathNoSymlinks(dataDir, { create: true, label: "peerBench data directory", trustedRoots: [home, os.tmpdir()] });
  const lockPath = path.join(dataDir, ".peerbench-install.lock");
  const token = `${process.pid}:${now()}:${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`); }
      finally { fs.closeSync(fd); }
      return {
        lockPath,
        release() {
          try {
            const stat = fs.lstatSync(lockPath);
            if (!stat.isFile() || stat.isSymbolicLink()) return;
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (current?.token === token) fs.rmSync(lockPath, { force: true });
          } catch {}
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockState = capturePathState(lockPath);
      if (lockState.type === "symlink") throw new Error(`peerBench install lock is a symlink: ${lockPath}`);
      if (lockState.type !== "file") throw new Error(`peerBench install lock is not a regular file: ${lockPath}`);
      let ownerPid = null, lockAgeMs = 0;
      try {
        ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, "utf8"))?.pid);
        lockAgeMs = Math.max(0, Date.now() - fs.lstatSync(lockPath).mtimeMs);
      } catch {
        try { lockAgeMs = Math.max(0, Date.now() - fs.lstatSync(lockPath).mtimeMs); } catch {}
      }
      let alive = false;
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); alive = true; }
        catch (probeError) { alive = probeError?.code === "EPERM"; }
      }
      if (!Number.isInteger(ownerPid) && lockAgeMs < 30 * 60_000) alive = true;
      if (alive || attempt > 0) throw new Error(`another peerBench install is already running (lock: ${lockPath})`);
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire peerBench install lock: ${lockPath}`);
}

function createUniqueBackupDir({ sharedRoot, stamp, home }) {
  ensureDirectoryPathNoSymlinks(sharedRoot, {
    create: true,
    label: "peerBench backup root",
    trustedRoots: [home, os.tmpdir()]
  });
  fs.chmodSync(sharedRoot, 0o700);
  const base = path.join(sharedRoot, `backup-${stamp}`);
  for (let index = 0; index < 100; index++) {
    const candidate = index === 0 ? base : `${base}-${process.pid}-${index}`;
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a unique peerBench backup directory");
}

function codexCacheRoots({ home, marketplaceName, pluginName }) {
  const cacheBase = path.join(home, ".codex", "plugins", "cache", marketplaceName, pluginName);
  const state = capturePathState(cacheBase);
  if (!state.exists) return [];
  if (state.type !== "directory") throw new Error(`Codex plugin cache root is not a regular directory: ${cacheBase}`);
  return fs.readdirSync(cacheBase, { withFileTypes: true }).map((entry) => {
    const candidate = path.join(cacheBase, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Codex plugin cache version is a symlink: ${candidate}`);
    return entry.isDirectory() ? candidate : null;
  }).filter(Boolean);
}

export function installPeerBench({
  repoRoot = ROOT,
  home = os.homedir(),
  claude = true,
  codex = true,
  loadKeys = false,
  keysPath = path.join(repoRoot, ".keys"),
  marketplaceName = DEFAULT_CLAUDE_MARKETPLACE,
  now = () => Date.now(),
  env = process.env,
  syncClaudePlugin = home === os.homedir(),
  claudeRunner = spawnSync
} = {}) {
  const resolvedRepo = path.resolve(repoRoot);
  const globalHooksSrc = path.join(resolvedRepo, "global-hooks");
  const promptsSrc = path.join(resolvedRepo, "codex-prompts");
  const globalHooksState = capturePathState(globalHooksSrc);
  if (globalHooksState.type !== "directory") throw new Error(`global hook source is not a regular directory: ${globalHooksSrc}`);
  if (codex && capturePathState(promptsSrc).type !== "directory") throw new Error(`Codex prompt source is not a regular directory: ${promptsSrc}`);
  const checkoutVersion = checkoutPluginVersion(resolvedRepo);
  const sourceHookNames = fs.readdirSync(globalHooksSrc).filter((name) => name.endsWith(".mjs")).sort();
  const plannedHookNames = [...new Set([...sourceHookNames, ...RETIRED_RUNTIME_FILES])].sort();
  const promptNames = codex ? fs.readdirSync(promptsSrc).filter((name) => name.endsWith(".md")).sort() : [];
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const claudeSettingsPath = path.join(claudeDir, "settings.json");
  const knownPath = path.join(claudeDir, "plugins", "known_marketplaces.json");
  const installedPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const codexHooksPath = path.join(home, ".codex", "hooks.json");

  // Strictly validate every config/cache surface before the lock or any install mutation.
  if (claude) {
    ensureDirectoryPathNoSymlinks(claudeDir, { create: false, label: "Claude config directory", trustedRoots: [home, os.tmpdir()] });
    ensureDirectoryPathNoSymlinks(path.dirname(knownPath), { create: false, label: "Claude plugin registry directory", trustedRoots: [home, os.tmpdir()] });
    const dataBase = path.join(home, ".claude", "plugins", "data");
    ensureDirectoryPathNoSymlinks(dataBase, { create: false, label: "peerBench data root", trustedRoots: [home, os.tmpdir()] });
    for (const [target, label] of [
      [dataBase, "peerBench data root"],
      [path.join(dataBase, "grok-companion-shared"), "legacy peerBench data"],
      [path.join(dataBase, "bench-shared"), "peerBench shared data"]
    ]) {
      const state = capturePathState(target);
      if (state.exists && state.type !== "directory") throw new Error(`${label} is not a regular directory: ${target}`);
      const configPath = path.join(target, "companion.json");
      if (capturePathState(configPath).exists) readJsonObjectStrict(configPath, { label: "peerBench config" });
    }
    readJsonObjectStrict(claudeSettingsPath, { label: "Claude settings" });
    readJsonObjectStrict(knownPath, { label: "Claude marketplace registry" });
    readJsonObjectStrict(installedPath, { label: "Claude installed-plugin registry" });
    claudePluginInstallRoots({ home, claudeDir, repoRoot: resolvedRepo, marketplaceName });
    allClaudeBenchCacheRoots({ home, claudeDir, marketplaceName });
  }
  if (codex) {
    ensureDirectoryPathNoSymlinks(path.join(home, ".codex"), { create: false, label: "Codex config directory", trustedRoots: [home, os.tmpdir()] });
    ensureDirectoryPathNoSymlinks(path.join(home, ".codex", "plugins", "cache", marketplaceName, CLAUDE_PLUGIN_NAME), {
      create: false,
      label: "Codex plugin cache",
      trustedRoots: [home, os.tmpdir()]
    });
    readJsonObjectStrict(codexHooksPath, { label: "Codex hooks config" });
  }
  const codexRoots = codex ? codexCacheRoots({ home, marketplaceName, pluginName: CLAUDE_PLUGIN_NAME }) : [];
  const codexPluginRootAtStart = codex
    ? latestCodexBenchPluginRoot({ home, marketplaceName, pluginName: CLAUDE_PLUGIN_NAME, expectedVersion: checkoutVersion })
    : null;
  if (codexPluginRootAtStart) {
    assertPluginCacheVersionMatch({ repoRoot: resolvedRepo, pluginRoot: codexPluginRootAtStart, platform: "codex" });
  } else if (codexRoots.length > 0) {
    const versions = codexRoots.map((root) => path.basename(root)).sort().join(", ");
    throw new Error([
      `peerBench Codex plugin cache version mismatch: checkout=${checkoutVersion}; installed cache version(s)=${versions}.`,
      "Refusing to overlay a different version in place. Install the new version first, then rerun:",
      "",
      `  CODEX_HOME=~/.codex codex plugin add ${CLAUDE_PLUGIN_NAME}@${marketplaceName}`,
      "  node scripts/install.mjs --codex-only",
      "",
      "(`codex plugin marketplace upgrade` does NOT work here — this marketplace is a directory, not a Git remote.)",
      `NOTE: \`plugin add\` REPLACES ${versions} instead of keeping it, so any Codex session already open still`,
      "points at the old path and will report the bench skill as missing/stale. Restart those sessions."
    ].join("\n"));
  }

  const origin = compareLocalWithOrigin({ cwd: resolvedRepo });
  const lock = acquireInstallLock({ home, now });
  let backupDir = null;
  let transactionPrepared = false;
  let pluginMutationStarted = false;
  let captureCreatedPluginRoots = () => {};
  let persistTransaction = () => {};
  try {
    const sharedRoot = path.join(home, ".claude", "plugins", "data", "bench-shared");
    const migrate = claude ? migrateDataDir({ base: path.join(home, ".claude", "plugins", "data") }) : { migrated: false };
    backupDir = createUniqueBackupDir({ sharedRoot, stamp: now(), home });
    const result = {
      repoRoot: resolvedRepo,
      checkoutVersion,
      backupDir,
      origin,
      claude: null,
      codex: null,
      keys: { loaded: false, keysPath, present: fs.existsSync(keysPath) }
    };
    const transactionMetadata = { repoRoot: resolvedRepo, claude: null, codex: null };
    persistTransaction = () => {
      result.rollbackMetadata = writeRollbackMetadata({ backupDir, metadata: transactionMetadata });
      return result.rollbackMetadata;
    };

    let claudeContext = null;
    if (claude) {
      const hooksDir = path.join(claudeDir, "hooks");
      const statuslinePath = path.join(claudeDir, "statusline-command.sh");
      const snap = snapshot({
        hooksDir,
        settingsPath: claudeSettingsPath,
        backupDir,
        statuslinePath,
        fileNames: plannedHookNames
      });
      const pluginRegistryFiles = [
        snapshotRollbackFile({ target: knownPath, backupDir: path.join(backupDir, "claude-plugin-registry"), name: "known_marketplaces.json" }),
        snapshotRollbackFile({ target: installedPath, backupDir: path.join(backupDir, "claude-plugin-registry"), name: "installed_plugins.json" })
      ];
      const pluginRootsBefore = claudePluginInstallRoots({ home, claudeDir, repoRoot: resolvedRepo, marketplaceName });
      let pluginInstallSnapshots = pluginRootsBefore.map((pluginRoot, index) => snapshotPluginInstallRoot({
        pluginRoot,
        backupDir: path.join(backupDir, "plugin-installs", `claude-before-${index}`)
      })).filter(Boolean);
      const cacheRootsBefore = new Set(allClaudeBenchCacheRoots({ home, claudeDir, marketplaceName }).map((value) => path.resolve(value)));
      const transactionClaude = {
        hooksDir,
        settingsPath: claudeSettingsPath,
        statuslinePath,
        deployedNames: plannedHookNames,
        restoreNames: plannedHookNames,
        fileSnapshots: snap.entries,
        hookAfterStates: [],
        settingsSnapshot: snap.settingsEntry,
        settingsAfterState: null,
        settingsBackedUp: snap.settingsBackedUp,
        settingsMode: snap.settingsMode,
        statuslineSnapshot: snap.statuslineEntry,
        statuslineAfterState: null,
        statuslineBackedUp: snap.statuslineBackedUp,
        statuslineMode: snap.statuslineMode,
        statuslineUpdated: false,
        pluginInstallSnapshots: pluginInstallSnapshots.map((entry) => ({ pluginRoot: entry.pluginRoot, backupDir: entry.backupDir })),
        pluginMutationStarted: false,
        pluginRegistryFiles
      };
      transactionMetadata.claude = transactionClaude;
      captureCreatedPluginRoots = () => {
        const recorded = new Set(pluginInstallSnapshots.map((entry) => path.resolve(entry.pluginRoot)));
        for (const candidate of allClaudeBenchCacheRoots({ home, claudeDir, marketplaceName })) {
          const root = path.resolve(candidate);
          if (cacheRootsBefore.has(root) || recorded.has(root)) continue;
          const entry = snapshotPluginInstallRoot({
            pluginRoot: root,
            backupDir: path.join(backupDir, "plugin-installs", `claude-created-${pluginInstallSnapshots.length}`),
            existedBefore: false
          });
          if (entry) { pluginInstallSnapshots.push(entry); recorded.add(root); }
        }
        transactionClaude.pluginInstallSnapshots = pluginInstallSnapshots.map((entry) => ({ pluginRoot: entry.pluginRoot, backupDir: entry.backupDir }));
      };
      claudeContext = { hooksDir, statuslinePath, snap, pluginRegistryFiles, transactionClaude, get pluginInstallSnapshots() { return pluginInstallSnapshots; }, migrate };
    }

    let codexContext = null;
    if (codex) {
      const hooksDir = path.join(home, ".codex", "hooks");
      const promptsDir = path.join(home, ".codex", "prompts");
      const codexBackupDir = path.join(backupDir, "codex");
      const snap = snapshotCodex({
        hooksDir,
        hooksPath: codexHooksPath,
        backupDir: codexBackupDir,
        promptsDir,
        promptNames,
        fileNames: plannedHookNames
      });
      const pluginRuntimeSnapshots = codexPluginRootAtStart ? [snapshotPluginRuntime({
        pluginRoot: codexPluginRootAtStart,
        backupDir: path.join(backupDir, "plugin-runtime", "codex-before")
      })].filter(Boolean) : [];
      const transactionCodex = {
        hooksDir,
        hooksPath: codexHooksPath,
        promptsDir,
        deployedNames: plannedHookNames,
        restoreNames: plannedHookNames,
        fileSnapshots: snap.entries,
        hookAfterStates: [],
        promptNames,
        promptSnapshots: snap.promptEntries,
        promptAfterStates: [],
        hooksJsonSnapshot: snap.hooksJsonEntry,
        hooksJsonAfterState: null,
        hooksJsonBackedUp: snap.hooksJsonBackedUp,
        hooksJsonMode: snap.hooksJsonMode,
        pluginRuntimeSnapshots: pluginRuntimeSnapshots.map((entry) => ({ backupDir: entry.backupDir }))
      };
      transactionMetadata.codex = transactionCodex;
      codexContext = { hooksDir, promptsDir, snap, pluginRuntimeSnapshots, transactionCodex };
    }

    // Both platform snapshots and rollback routing exist before the first platform write.
    persistTransaction();
    transactionPrepared = true;

    if (claudeContext) {
      const { hooksDir, statuslinePath, snap, pluginRegistryFiles, transactionClaude } = claudeContext;
      const plugin = syncClaudePluginSettings({ settingsPath: claudeSettingsPath, repoRoot: resolvedRepo, marketplaceName, home });
      transactionClaude.settingsAfterState = capturePathState(claudeSettingsPath);
      persistTransaction();
      const pluginRegistry = syncClaudePluginRegistry({
        repoRoot: resolvedRepo,
        home,
        claudeDir,
        marketplaceName,
        env,
        runner: claudeRunner,
        skipCli: !syncClaudePlugin,
        onBeforeMutation: () => {
          pluginMutationStarted = true;
          transactionClaude.pluginMutationStarted = true;
          persistTransaction();
        }
      });
      if (pluginRegistry.cli.attempted) {
        captureCreatedPluginRoots();
        if (!pluginRegistry.installPath) throw new Error(`Claude reported a successful install of ${pluginRegistry.pluginId}, but no installed plugin root was registered`);
        const expectedCacheBase = path.resolve(claudeDir, "plugins", "cache", marketplaceName, CLAUDE_PLUGIN_NAME);
        const installedRoot = path.resolve(expandHome(pluginRegistry.installPath, home));
        if (!installedRoot.startsWith(`${expectedCacheBase}${path.sep}`)) {
          throw new Error(`Claude reported an unexpected plugin root for ${pluginRegistry.pluginId}: ${installedRoot}`);
        }
        assertPluginCacheVersionMatch({ repoRoot: resolvedRepo, pluginRoot: installedRoot, platform: "claude" });
      }
      for (const entry of pluginRegistryFiles) entry.expectedAfter = capturePathState(entry.target);
      transactionClaude.pluginInstallSnapshots = claudeContext.pluginInstallSnapshots.map((entry) => ({ pluginRoot: entry.pluginRoot, backupDir: entry.backupDir }));
      persistTransaction();
      const pluginDeploy = pluginRegistry.installPath
        ? deployPluginRuntime({ repoRoot: resolvedRepo, pluginRoot: pluginRegistry.installPath, platform: "claude" })
        : null;
      const dep = deploy({ src: globalHooksSrc, dest: hooksDir });
      transactionClaude.hookAfterStates = dep.states;
      persistTransaction();
      const sync = pluginRegistry.cli.skipped
        ? syncSettings({ hooksDir, settingsPath: claudeSettingsPath })
        : removeClaudeSettingsPeerBenchHooks({ settingsPath: claudeSettingsPath });
      transactionClaude.settingsAfterState = capturePathState(claudeSettingsPath);
      persistTransaction();
      const statusline = removePeerBenchStatuslineSegment({ statuslinePath });
      transactionClaude.statuslineUpdated = statusline.updated;
      transactionClaude.statuslineAfterState = statusline.updated ? capturePathState(statuslinePath) : null;
      persistTransaction();
      result.claude = { plugin, pluginRegistry, pluginDeploy, migrate: claudeContext.migrate, snapshot: snap, deploy: dep, sync, statusline };
    }

    if (codexContext) {
      const { hooksDir, promptsDir, snap, pluginRuntimeSnapshots, transactionCodex } = codexContext;
      const dep = deploy({ src: globalHooksSrc, dest: hooksDir });
      transactionCodex.hookAfterStates = dep.states;
      persistTransaction();
      const pluginDeploy = codexPluginRootAtStart
        ? deployPluginRuntime({ repoRoot: resolvedRepo, pluginRoot: codexPluginRootAtStart, platform: "codex" })
        : null;
      const sync = codexPluginRootAtStart
        ? removeCodexSettingsPeerBenchHooks({ hooksPath: codexHooksPath })
        : syncCodexHooks({ hooksDir, hooksPath: codexHooksPath });
      transactionCodex.hooksJsonAfterState = capturePathState(codexHooksPath);
      persistTransaction();
      const prompts = syncCodexPrompts({
        srcDir: promptsSrc,
        promptsDir,
        benchRunnerPath: path.join(resolvedRepo, "scripts", "bench-runner.mjs")
      });
      transactionCodex.promptNames = prompts.copied;
      transactionCodex.promptAfterStates = prompts.states;
      persistTransaction();
      result.codex = { snapshot: snap, deploy: dep, pluginDeploy, pluginRuntimeSnapshots, sync, prompts };
    }

    if (loadKeys) {
      const res = spawnSync(process.execPath, [path.join(resolvedRepo, "scripts", "load-keys.mjs"), keysPath], { cwd: resolvedRepo, env, encoding: "utf8" });
      result.keys = {
        loaded: res.status === 0,
        keysPath,
        present: fs.existsSync(keysPath),
        stdout: (res.stdout || "").trim(),
        stderr: (res.stderr || "").trim(),
        status: res.status
      };
      if (res.status !== 0) throw new Error(`load-keys failed: ${result.keys.stderr || result.keys.stdout || `exit ${res.status}`}`);
    }
    return result;
  } catch (error) {
    if (pluginMutationStarted) {
      try { captureCreatedPluginRoots(); persistTransaction(); } catch {}
    }
    if (transactionPrepared && backupDir) {
      let rollbackResult;
      try { rollbackResult = rollback({ backupDir }); }
      catch (rollbackError) {
        throw new Error(`peerBench install failed (${error instanceof Error ? error.message : String(error)}); automatic rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`, { cause: error });
      }
      if (!rollbackResult.ok) {
        throw new Error(`peerBench install failed (${error instanceof Error ? error.message : String(error)}); automatic rollback was partial (${rollbackResult.failures.join("; ")})`, { cause: error });
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : "?";
}

export function renderInstallSummary(result) {
  const lines = ["peerbench install complete", `repo: ${result.repoRoot}`];
  if (result.origin?.ok) {
    lines.push(`origin: ${result.origin.branch} ${result.origin.status} (${shortSha(result.origin.localHead)} local, ${shortSha(result.origin.remoteHead)} origin), dirty ${result.origin.dirty}`);
  } else if (result.origin) {
    lines.push(`origin: unable to compare (${result.origin.reason || "unknown"})`);
  }
  if (result.claude) {
    const c = result.claude;
    lines.push(`Claude: enabled ${c.plugin.pluginId} in ${c.plugin.settingsPath}`);
    if (c.plugin.migrated.length) lines.push(`Claude: migrated legacy marketplace id(s): ${c.plugin.migrated.join(", ")}`);
    if (c.pluginRegistry) {
      if (c.pluginRegistry.cli.skipped) {
        lines.push(`Claude plugin registry: CLI install skipped (${c.pluginRegistry.cli.reason || "not requested"})`);
      } else {
        lines.push(`Claude plugin registry: installed ${c.pluginRegistry.pluginId}${c.pluginRegistry.scrubbed.length ? `; scrubbed ${c.pluginRegistry.scrubbed.length} sensitive cache file(s)` : ""}`);
      }
    }
    if (c.pluginDeploy) {
      lines.push(`Claude plugin cache: refreshed ${c.pluginDeploy.copied.length} path(s) in ${c.pluginDeploy.pluginRoot}`);
    }
    if (c.sync.pluginManaged) {
      lines.push(`Claude hooks: plugin-managed; copied ${c.deploy.copied.length}, removed ${c.sync.removedEntries} legacy settings hook(s)`);
    } else {
      lines.push(`Claude hooks: copied ${c.deploy.copied.length}, backed up ${c.deploy.backedUp.length}; gates synced`);
    }
    if (!c.sync.pluginManaged && (c.sync.removedEntries || c.sync.removedFiles?.length)) {
      lines.push(`Claude hooks: removed legacy entries ${c.sync.removedEntries}, files ${c.sync.removedFiles.join(", ") || "(none)"}`);
    }
    lines.push(`Claude statusline: ${c.statusline.updated ? `removed ${c.statusline.removedInvocations} retired peerBench invocation(s)` : `no change (${c.statusline.reason || "already clean"})`}`);
  }
  if (result.codex) {
    const c = result.codex;
    if (c.pluginDeploy) {
      lines.push(`Codex plugin cache: refreshed ${c.pluginDeploy.copied.length} path(s) in ${c.pluginDeploy.pluginRoot}; removed ${c.sync.removedEntries} settings hook(s)`);
    } else {
      lines.push(`Codex hooks: copied ${c.deploy.copied.length}, backed up ${c.deploy.backedUp.length}; Stop gate synced in ${c.sync.hooksPath}`);
    }
    lines.push(`Codex prompts: copied ${c.prompts.copied.length}, backed up ${c.prompts.backedUp.length} in ${c.prompts.promptsDir}`);
  }
  if (result.keys.loaded) {
    lines.push(`Keys: loaded from ${result.keys.keysPath} (${result.keys.stdout || "key values redacted"})`);
  } else if (result.keys.present) {
    lines.push(`Keys: not loaded. Run: node scripts/load-keys.mjs`);
  } else {
    lines.push("Keys: .keys not found. Copy .keys.example to .keys, fill API keys, then run: node scripts/load-keys.mjs");
  }
  lines.push("Restart Claude Code and open a fresh Codex session for hook/prompt changes to be picked up.");
  if (result.codex?.pluginDeploy) {
    // Codex resolves the bench skill through a VERSIONED cache path captured at session start, and
    // `codex plugin add` deletes the previous version dir (Claude keeps every version, so it never
    // hits this). Any Codex session open across a version bump reports the skill path as stale.
    lines.push(`⚠ Codex sessions started before this deploy still reference the OLD ${CLAUDE_PLUGIN_NAME} version path`);
    lines.push("  and will report the bench skill as stale/missing. Restart them — reloading is not enough.");
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage: node scripts/install.mjs [options]",
    "",
    "Installs peerBench for Claude Code and direct Codex by default.",
    "",
    "Options:",
    "  --claude-only        Install Claude plugin/hooks only",
    "  --codex-only         Install Codex hooks/prompts only",
    "  --no-claude          Skip Claude setup",
    "  --no-codex           Skip Codex setup",
    "  --load-keys          Load provider keys from .keys after installing",
    "  --keys <path>        Key file path for --load-keys (default: ./.keys)",
    `  --marketplace <name> Claude marketplace id (default: ${DEFAULT_CLAUDE_MARKETPLACE})`,
    "  -h, --help           Show this help",
    ""
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  try {
    const opts = parseInstallArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = installPeerBench({
      claude: opts.claude,
      codex: opts.codex,
      loadKeys: opts.loadKeys,
      keysPath: opts.keysPath ? path.resolve(opts.keysPath) : path.join(ROOT, ".keys"),
      marketplaceName: opts.marketplaceName
    });
    process.stdout.write(renderInstallSummary(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
