#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareLocalWithOrigin,
  deploy,
  migrateDataDir,
  snapshot,
  snapshotCodex,
  syncCodexHooks,
  syncCodexPrompts,
  deployPluginRuntime,
  latestCodexBenchPluginRoot,
  removeClaudeSettingsPeerBenchHooks,
  removeCodexSettingsPeerBenchHooks,
  syncSettings,
  syncStatuslineSessionArg
} from "./deploy-global-hooks.mjs";
import { disableLegacyCodexStopGateStates } from "../global-hooks/legacy-codex-gate.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_CLAUDE_MARKETPLACE = "aiwithrai";
export const LEGACY_CLAUDE_MARKETPLACES = ["rai-tools", "peerbench"];
export const CLAUDE_PLUGIN_NAME = "bench";

function readJson(pathname) {
  try { return JSON.parse(fs.readFileSync(pathname, "utf8")); }
  catch { return {}; }
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
  const before = fs.existsSync(pathname) ? fs.readFileSync(pathname, "utf8") : "";
  const after = `${JSON.stringify(value, null, 2)}\n`;
  if (before !== after) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, after);
    return true;
  }
  return false;
}

function isSensitivePluginCacheFile(name) {
  return name === ".keys"
    || name.endsWith(".keys")
    || name === ".env"
    || name.endsWith(".env")
    || name.endsWith(".log")
    || name === "resultsofHunt.txt";
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
      } else if (isSensitivePluginCacheFile(entry.name)) {
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

function legacyPluginCachePath({ home, marketplace, pluginName }) {
  return path.join(home, ".claude", "plugins", "cache", marketplace, pluginName);
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
  marketplaceName = DEFAULT_CLAUDE_MARKETPLACE,
  pluginName = CLAUDE_PLUGIN_NAME,
  legacyMarketplaces = LEGACY_CLAUDE_MARKETPLACES,
  runner = spawnSync,
  env = process.env,
  now = () => new Date().toISOString(),
  skipCli = false
} = {}) {
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
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

  if (skipCli) {
    result.knownUpdated = writeJsonIfChanged(knownPath, nextKnown);
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
    result.cli.skipped = true;
    result.cli.reason = probe.error || probe.stderr || probe.stdout || "claude CLI not available";
    return result;
  }
  result.cli.attempted = true;

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
  result.installPath = latestInstalledPluginPath({ installedPath, pluginId: result.pluginId, scope: "user" });
  if (result.installPath) result.scrubbed = scrubSensitivePluginCacheFiles(result.installPath);
  for (const legacy of removedLegacy) {
    result.scrubbed.push(...scrubSensitivePluginCacheFiles(legacyPluginCachePath({ home, marketplace: legacy, pluginName })));
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
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const settings = readJson(settingsPath);
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === "object"
    ? settings.extraKnownMarketplaces
    : {};
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === "object"
    ? settings.enabledPlugins
    : {};

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
  syncClaudePlugin = home === os.homedir()
} = {}) {
  const result = {
    repoRoot: path.resolve(repoRoot),
    origin: compareLocalWithOrigin({ cwd: repoRoot }),
    claude: null,
    codex: null,
    keys: { loaded: false, keysPath, present: fs.existsSync(keysPath) }
  };
  const globalHooksSrc = path.join(repoRoot, "global-hooks");
  const backupDir = path.join(home, ".claude", "plugins", "data", "bench-shared", `backup-${now()}`);

  if (claude) {
    const hooksDir = path.join(home, ".claude", "hooks");
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const migrate = migrateDataDir({ base: path.join(home, ".claude", "plugins", "data") });
    const snap = snapshot({ hooksDir, settingsPath, backupDir });
    const plugin = syncClaudePluginSettings({ settingsPath, repoRoot, marketplaceName, home });
    const pluginRegistry = syncClaudePluginRegistry({
      repoRoot,
      home,
      marketplaceName,
      env,
      skipCli: !syncClaudePlugin
    });
    const pluginDeploy = pluginRegistry.installPath
      ? deployPluginRuntime({ repoRoot, pluginRoot: pluginRegistry.installPath })
      : null;
    const dep = deploy({ src: globalHooksSrc, dest: hooksDir });
    const sync = pluginRegistry.cli.skipped
      ? syncSettings({ hooksDir, settingsPath })
      : removeClaudeSettingsPeerBenchHooks({ settingsPath });
    const legacyCodexGate = disableLegacyCodexStopGateStates({
      pluginDataDir: path.join(home, ".claude", "plugins", "data", "codex-openai-codex")
    });
    const statusline = syncStatuslineSessionArg({
      statuslinePath: path.join(home, ".claude", "statusline-command.sh")
    });
    result.claude = { plugin, pluginRegistry, pluginDeploy, migrate, snapshot: snap, deploy: dep, sync, legacyCodexGate, statusline };
  }

  if (codex) {
    const hooksDir = path.join(home, ".codex", "hooks");
    const hooksPath = path.join(home, ".codex", "hooks.json");
    const promptsDir = path.join(home, ".codex", "prompts");
    const codexBackupDir = path.join(backupDir, "codex");
    const snap = snapshotCodex({ hooksDir, hooksPath, backupDir: codexBackupDir });
    const dep = deploy({ src: globalHooksSrc, dest: hooksDir });
    const pluginRoot = latestCodexBenchPluginRoot({ home });
    const pluginDeploy = pluginRoot ? deployPluginRuntime({ repoRoot, pluginRoot }) : null;
    const sync = pluginRoot
      ? removeCodexSettingsPeerBenchHooks({ hooksPath })
      : syncCodexHooks({ hooksDir, hooksPath });
    const prompts = syncCodexPrompts({
      srcDir: path.join(repoRoot, "codex-prompts"),
      promptsDir,
      benchRunnerPath: path.join(repoRoot, "scripts", "bench-runner.mjs")
    });
    result.codex = { snapshot: snap, deploy: dep, pluginDeploy, sync, prompts };
  }

  if (loadKeys) {
    const res = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "load-keys.mjs"), keysPath], {
      cwd: repoRoot,
      env,
      encoding: "utf8"
    });
    result.keys = {
      loaded: res.status === 0,
      keysPath,
      present: fs.existsSync(keysPath),
      stdout: (res.stdout || "").trim(),
      stderr: (res.stderr || "").trim(),
      status: res.status
    };
    if (res.status !== 0) {
      const detail = result.keys.stderr || result.keys.stdout || `exit ${res.status}`;
      throw new Error(`load-keys failed: ${detail}`);
    }
  }

  return result;
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
    lines.push(`Claude statusline: ${c.statusline.updated ? "session-aware patch applied" : `no change (${c.statusline.reason || "already ok"})`}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
