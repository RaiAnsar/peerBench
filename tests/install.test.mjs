import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPeerBench,
  parseInstallArgs,
  renderInstallSummary,
  scrubSensitivePluginCacheFiles,
  syncClaudePluginRegistry,
  syncClaudePluginSettings
} from "../scripts/install.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyInstallRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-fixture-"));
  for (const relativePath of ["global-hooks", "codex-prompts", ".claude-plugin", ".codex-plugin"]) {
    fs.cpSync(path.join(PROJECT_ROOT, relativePath), path.join(repo, relativePath), { recursive: true });
  }
  fs.copyFileSync(path.join(PROJECT_ROOT, "package.json"), path.join(repo, "package.json"));
  return repo;
}

function fakeNativeStatus(repo) {
  const hooks = path.join(repo, ".git", "hooks");
  return {
    ok: true,
    managed: false,
    installed: false,
    hookPath: path.join(hooks, "pre-push"),
    localPath: path.join(hooks, "pre-push.local")
  };
}

test("syncClaudePluginSettings installs aiwithrai and migrates legacy ids only when they point at this repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-repo-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-other-"));
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    extraKnownMarketplaces: {
      "rai-tools": { source: { source: "directory", path: repo } },
      "peerbench": { source: { source: "directory", path: repo } },
      "other-tools": { source: { source: "directory", path: other } }
    },
    enabledPlugins: {
      "bench@rai-tools": true,
      "bench@peerbench": true,
      "other@other-tools": true
    }
  }, null, 2));

  const result = syncClaudePluginSettings({ settingsPath, repoRoot: repo, home });
  assert.deepEqual(result.migrated, ["rai-tools", "peerbench"]);
  assert.equal(result.pluginId, "bench@aiwithrai");

  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(saved.enabledPlugins["bench@aiwithrai"], true);
  assert.equal(saved.enabledPlugins["bench@rai-tools"], undefined);
  assert.equal(saved.enabledPlugins["bench@peerbench"], undefined);
  assert.equal(saved.enabledPlugins["other@other-tools"], true);
  assert.equal(saved.extraKnownMarketplaces["rai-tools"], undefined);
  assert.equal(saved.extraKnownMarketplaces.peerbench, undefined);
  assert.equal(saved.extraKnownMarketplaces["other-tools"].source.path, other);
  assert.equal(saved.extraKnownMarketplaces.aiwithrai.source.path, repo);
});

test("syncClaudePluginSettings is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-idem-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-idem-repo-"));
  const settingsPath = path.join(home, ".claude", "settings.json");
  const first = syncClaudePluginSettings({ settingsPath, repoRoot: repo, home });
  const second = syncClaudePluginSettings({ settingsPath, repoRoot: repo, home });
  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
});

test("parseInstallArgs defaults to Claude+Codex and supports focused installs", () => {
  assert.deepEqual(parseInstallArgs([]), {
    claude: true,
    codex: true,
    loadKeys: false,
    keysPath: null,
    marketplaceName: "aiwithrai",
    help: false,
    allowDirty: false,
    skipTests: false
  });
  assert.equal(parseInstallArgs(["--codex-only"]).claude, false);
  assert.equal(parseInstallArgs(["--claude-only"]).codex, false);
  assert.equal(parseInstallArgs(["--load-keys", "--keys", "/tmp/.keys"]).keysPath, "/tmp/.keys");
  assert.equal(parseInstallArgs(["--allow-dirty"]).allowDirty, true);
  assert.equal(parseInstallArgs(["--skip-tests"]).skipTests, true);
});

test("installPeerBench refuses a stale Codex cache before creating transaction state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-version-home-"));
  const checkoutVersion = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
  const staleVersion = checkoutVersion === "0.0.0" ? "9.9.9" : "0.0.0";
  const pluginRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", staleVersion);
  fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "package.json"), `${JSON.stringify({ name: "peerbench", version: staleVersion })}\n`);
  fs.writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name: "bench", version: staleVersion })}\n`);
  fs.writeFileSync(path.join(pluginRoot, "global-hooks", "sentinel.mjs"), "unchanged\n");

  assert.throws(
    () => installPeerBench({ repoRoot: PROJECT_ROOT, home, claude: false, codex: true, now: () => 1234 }),
    (error) => {
      assert.equal(error.message.includes(`checkout=${checkoutVersion}`), true);
      assert.match(error.message, /codex plugin marketplace upgrade aiwithrai/);
      assert.match(error.message, /codex plugin add bench@aiwithrai/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(path.join(pluginRoot, "global-hooks", "sentinel.mjs"), "utf8"), "unchanged\n");
  assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "data", "bench-shared", "backup-1234")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);
});

test("installPeerBench rolls back a Claude CLI install that returns the wrong cache version", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-claude-version-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-claude-version-repo-"));
  for (const relativePath of ["global-hooks", "codex-prompts", ".claude-plugin", ".codex-plugin"]) {
    fs.cpSync(path.join(PROJECT_ROOT, relativePath), path.join(repo, relativePath), { recursive: true });
  }
  fs.copyFileSync(path.join(PROJECT_ROOT, "package.json"), path.join(repo, "package.json"));
  const checkoutVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  const staleVersion = checkoutVersion === "0.0.0" ? "9.9.9" : "0.0.0";
  const pluginRoot = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", staleVersion);
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const settingsPath = path.join(home, ".claude", "settings.json");

  const claudeRunner = (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
    if (args[0] === "plugin" && args[1] === "install") {
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), `${JSON.stringify({ name: "peerbench", version: staleVersion })}\n`);
      fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "bench", version: staleVersion })}\n`);
      fs.mkdirSync(path.dirname(installedPath), { recursive: true });
      fs.writeFileSync(installedPath, JSON.stringify({
        plugins: { "bench@aiwithrai": [{ scope: "user", installPath: pluginRoot }] }
      }));
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () => installPeerBench({
      repoRoot: repo,
      home,
      claude: true,
      codex: false,
      now: () => 2345,
      syncClaudePlugin: true,
      claudeRunner
    }),
    (error) => {
      assert.equal(error.message.includes(`checkout=${checkoutVersion}`), true);
      assert.match(error.message, /claude plugin remove bench@aiwithrai/);
      assert.match(error.message, /claude plugin install bench@aiwithrai/);
      return true;
    }
  );
  assert.equal(fs.existsSync(pluginRoot), false, "the mismatched CLI-created cache is removed by rollback");
  assert.equal(fs.existsSync(installedPath), false, "the plugin registry is restored");
  assert.equal(fs.existsSync(knownPath), false, "the marketplace registry is restored");
  assert.equal(fs.existsSync(settingsPath), false, "Claude settings are restored");
});

test("scrubSensitivePluginCacheFiles removes local secrets but keeps examples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-cache-"));
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  for (const name of [
    ".keys", ".keys.local", "prod.keys",
    ".env", ".env.local", ".env.production", ".envrc", "prod.env",
    "bench.log", "resultsofHunt.txt"
  ]) {
    fs.writeFileSync(path.join(nested, name), "secret");
  }
  fs.writeFileSync(path.join(nested, ".keys.example"), "placeholder");
  fs.writeFileSync(path.join(nested, ".env.example"), "placeholder");
  fs.writeFileSync(path.join(nested, ".env.production.example"), "placeholder");
  fs.writeFileSync(path.join(nested, "companion.json"), "{}");

  const removed = scrubSensitivePluginCacheFiles(root).map((p) => path.basename(p)).sort();
  assert.deepEqual(removed, [
    ".env", ".env.local", ".env.production", ".envrc", ".keys", ".keys.local",
    "bench.log", "prod.env", "prod.keys", "resultsofHunt.txt"
  ].sort());
  assert.equal(fs.existsSync(path.join(nested, ".keys.example")), true);
  assert.equal(fs.existsSync(path.join(nested, ".env.example")), true);
  assert.equal(fs.existsSync(path.join(nested, ".env.production.example")), true);
  assert.equal(fs.existsSync(path.join(nested, "companion.json")), true);
});

test("syncClaudePluginRegistry migrates Claude marketplace registry, installs plugin, and scrubs cache", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reg-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reg-repo-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reg-other-"));
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const installPath = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "0.3.0");
  const legacyInstallPath = path.join(home, ".claude", "plugins", "cache", "peerbench", "bench", "0.3.0");
  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.mkdirSync(legacyInstallPath, { recursive: true });
  fs.writeFileSync(path.join(legacyInstallPath, ".env"), "old-secret");
  fs.writeFileSync(knownPath, JSON.stringify({
    "rai-tools": { source: { source: "directory", path: repo }, installLocation: repo },
    "peerbench": { source: { source: "directory", path: repo }, installLocation: repo },
    "other-tools": { source: { source: "directory", path: other }, installLocation: other }
  }, null, 2));

  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0" };
    if (args.join(" ") === "plugin install bench@aiwithrai") {
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(path.join(installPath, ".keys"), "secret");
      fs.writeFileSync(path.join(installPath, ".keys.local"), "secret");
      fs.writeFileSync(path.join(installPath, ".env.production"), "secret");
      fs.writeFileSync(path.join(installPath, ".keys.example"), "placeholder");
      fs.writeFileSync(installedPath, JSON.stringify({
        plugins: {
          "bench@aiwithrai": [{ scope: "user", installPath }]
        }
      }, null, 2));
    }
    return { status: 0, stdout: "ok" };
  };

  const result = syncClaudePluginRegistry({
    repoRoot: repo,
    home,
    runner,
    now: () => "2026-06-24T00:00:00.000Z"
  });

  const known = JSON.parse(fs.readFileSync(knownPath, "utf8"));
  assert.deepEqual(result.removedLegacy, ["rai-tools", "peerbench"]);
  assert.equal(result.pluginId, "bench@aiwithrai");
  assert.equal(known["rai-tools"], undefined);
  assert.equal(known.peerbench, undefined);
  assert.equal(known["other-tools"].installLocation, other);
  assert.equal(known.aiwithrai.source.path, path.resolve(repo));
  assert.deepEqual(calls, [
    ["claude", "--version"],
    ["claude", "plugin", "remove", "bench@rai-tools", "--keep-data", "-s", "user"],
    ["claude", "plugin", "marketplace", "remove", "rai-tools"],
    ["claude", "plugin", "remove", "bench@peerbench", "--keep-data", "-s", "user"],
    ["claude", "plugin", "marketplace", "remove", "peerbench"],
    ["claude", "plugin", "marketplace", "add", path.resolve(repo)],
    ["claude", "plugin", "install", "bench@aiwithrai"]
  ]);
  assert.equal(result.installPath, installPath);
  assert.equal(result.scrubbed.map((p) => path.basename(p)).includes(".keys"), true);
  assert.equal(result.scrubbed.map((p) => path.basename(p)).includes(".env"), true);
  assert.equal(fs.existsSync(path.join(installPath, ".keys")), false);
  assert.equal(fs.existsSync(path.join(installPath, ".keys.local")), false);
  assert.equal(fs.existsSync(path.join(installPath, ".env.production")), false);
  assert.equal(fs.existsSync(path.join(legacyInstallPath, ".env")), false);
  assert.equal(fs.existsSync(path.join(installPath, ".keys.example")), true);
});

test("syncClaudePluginRegistry force-refreshes an existing same-version local install and scrubs copied secrets", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reg-refresh-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reg-refresh-repo-"));
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const installPath = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "0.3.0");
  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.writeFileSync(knownPath, JSON.stringify({
    aiwithrai: { source: { source: "directory", path: repo }, installLocation: repo }
  }, null, 2));
  fs.writeFileSync(installedPath, JSON.stringify({
    plugins: {
      "bench@aiwithrai": [{ scope: "user", installPath }]
    }
  }, null, 2));

  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0" };
    if (args.join(" ") === "plugin install bench@aiwithrai") {
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(path.join(installPath, ".keys"), "secret");
    }
    return { status: 0, stdout: "ok" };
  };

  const result = syncClaudePluginRegistry({ repoRoot: repo, home, runner });
  assert.deepEqual(calls, [
    ["claude", "--version"],
    ["claude", "plugin", "remove", "bench@aiwithrai", "--keep-data", "-s", "user"],
    ["claude", "plugin", "install", "bench@aiwithrai"]
  ]);
  assert.equal(result.scrubbed.map((p) => path.basename(p)).includes(".keys"), true);
  assert.equal(fs.existsSync(path.join(installPath, ".keys")), false);
});

test("renderInstallSummary reports origin comparison and never includes secret values", () => {
  const out = renderInstallSummary({
    repoRoot: "/repo",
    origin: {
      ok: true,
      branch: "main",
      status: "same-as-origin",
      localHead: "aaaaaaaaaaaaaaaa",
      remoteHead: "bbbbbbbbbbbbbbbb",
      dirty: 0
    },
    claude: null,
    codex: null,
    keys: {
      loaded: true,
      keysPath: "/repo/.keys",
      stdout: "load-keys: wrote providers to companion.json -> kimi (key values redacted)"
    }
  });
  assert.match(out, /origin: main same-as-origin/);
  assert.match(out, /key values redacted/);
  assert.doesNotMatch(out, /sk-/);
});

test("native hook failure aborts install, rolls back Claude and Codex, and cannot render a false success", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-native-install-fail-"));
  const repo = copyInstallRepo();
  const claudeSettings = path.join(home, ".claude", "settings.json");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.mkdirSync(path.dirname(codexHooks), { recursive: true });
  const claudeBefore = '{"sentinel":"claude"}\n';
  const codexBefore = '{"sentinel":"codex"}\n';
  fs.writeFileSync(claudeSettings, claudeBefore);
  fs.writeFileSync(codexHooks, codexBefore);

  assert.throws(() => installPeerBench({
    repoRoot: repo,
    home,
    syncClaudePlugin: false,
    now: () => 7001,
    nativeStatus: () => fakeNativeStatus(repo),
    ensureNativeHook: () => ({ ok: false, installed: false, changed: false, reason: "injected native failure" })
  }), /native Git pre-push hook installation failed: injected native failure/);

  assert.equal(fs.readFileSync(claudeSettings, "utf8"), claudeBefore);
  assert.equal(fs.readFileSync(codexHooks, "utf8"), codexBefore);
  assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "data", ".peerbench-install.lock")), false);
});

test("malformed registry fails closed before settings are changed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-invalid-registry-"));
  const repo = copyInstallRepo();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const registryPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"keep":true}\n');
  fs.writeFileSync(registryPath, "{broken");
  assert.throws(() => installPeerBench({ repoRoot: repo, home, claude: true, codex: false }), /invalid JSON/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"keep":true}\n');
  assert.equal(fs.readFileSync(registryPath, "utf8"), "{broken");

  const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pb-symlink-registry-"));
  const linkedSettings = path.join(linkedHome, ".claude", "settings.json");
  const linkedRegistry = path.join(linkedHome, ".claude", "plugins", "known_marketplaces.json");
  const external = path.join(linkedHome, "external.json");
  fs.mkdirSync(path.dirname(linkedSettings), { recursive: true });
  fs.mkdirSync(path.dirname(linkedRegistry), { recursive: true });
  fs.writeFileSync(linkedSettings, '{"keep":true}\n');
  fs.writeFileSync(external, '{"external":true}\n');
  fs.symlinkSync(external, linkedRegistry);
  assert.throws(() => installPeerBench({ repoRoot: repo, home: linkedHome, claude: true, codex: false }), /symlink/);
  assert.equal(fs.readFileSync(external, "utf8"), '{"external":true}\n');
  assert.equal(fs.lstatSync(linkedRegistry).isSymbolicLink(), true);
});

test("all Codex snapshots complete before any Claude mutation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-codex-preflight-"));
  const repo = copyInstallRepo();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const hooksPath = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"keep":"claude"}\n');
  fs.writeFileSync(hooksPath, "{}\n");
  const badHook = fs.readdirSync(path.join(repo, "global-hooks")).find((name) => name.endsWith(".mjs"));
  fs.mkdirSync(path.join(home, ".codex", "hooks", badHook), { recursive: true });

  assert.throws(() => installPeerBench({
    repoRoot: repo,
    home,
    syncClaudePlugin: false,
    now: () => 7002,
    nativeStatus: () => fakeNativeStatus(repo)
  }), /refusing to snapshot non-file target/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"keep":"claude"}\n');
});

test("zero-exit Claude install must prove its plugin root and preserves fallback hooks on failure", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-claude-postcondition-"));
  const repo = copyInstallRepo();
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const before = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node fallback-stop.mjs" }] }] } }, null, 2)}\n`;
  fs.writeFileSync(settingsPath, before);
  const runner = (_command, args) => ({ status: 0, stdout: args[0] === "--version" ? "1.0.0" : "", stderr: "" });

  assert.throws(() => installPeerBench({
    repoRoot: repo,
    home,
    claude: true,
    codex: false,
    syncClaudePlugin: true,
    claudeRunner: runner,
    now: () => 7003,
    nativeStatus: () => fakeNativeStatus(repo)
  }), /no installed plugin root was registered/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
});

test("automatic rollback reports partial failure instead of hiding an ok:false restore", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-partial-auto-rollback-"));
  const repo = copyInstallRepo();
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"before":true}\n');
  const backupDir = path.join(home, ".claude", "plugins", "data", "bench-shared", "backup-7004");

  assert.throws(() => installPeerBench({
    repoRoot: repo,
    home,
    claude: true,
    codex: false,
    syncClaudePlugin: false,
    now: () => 7004,
    nativeStatus: () => fakeNativeStatus(repo),
    ensureNativeHook: () => {
      fs.rmSync(path.join(backupDir, "settings.json"), { force: true });
      return { ok: false, installed: false, changed: false, reason: "injected" };
    }
  }), /automatic rollback was partial/);
});

test("install lock rejects overlap and backup allocation never reuses an existing directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-lock-"));
  const dataDir = path.join(home, ".claude", "plugins", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".peerbench-install.lock"), JSON.stringify({ pid: process.pid, token: "other" }));
  assert.throws(() => installPeerBench({ repoRoot: PROJECT_ROOT, home, claude: false, codex: false }), /already running/);

  fs.rmSync(path.join(dataDir, ".peerbench-install.lock"));
  const existing = path.join(dataDir, "bench-shared", "backup-7005");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "sentinel"), "keep");
  const result = installPeerBench({
    repoRoot: PROJECT_ROOT,
    home,
    claude: false,
    codex: false,
    now: () => 7005,
    nativeStatus: () => fakeNativeStatus(PROJECT_ROOT),
    ensureNativeHook: () => ({ ok: true, installed: true, changed: false })
  });
  assert.notEqual(result.backupDir, existing);
  assert.equal(fs.readFileSync(path.join(existing, "sentinel"), "utf8"), "keep");
});

test("installPeerBench honors CLAUDE_CONFIG_DIR for Claude settings, hooks, and the plugin registry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-claude-config-home-"));
  const claudeDir = path.join(home, "custom-claude");
  const repo = copyInstallRepo();
  const result = installPeerBench({
    repoRoot: repo,
    home,
    claude: true,
    codex: false,
    syncClaudePlugin: false,
    now: () => 7006,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
    nativeStatus: () => fakeNativeStatus(repo),
    ensureNativeHook: () => ({ ok: true, installed: true, changed: false })
  });

  const settingsPath = path.join(claudeDir, "settings.json");
  assert.equal(result.claude.settingsPath, settingsPath);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.enabledPlugins["bench@aiwithrai"], true);
  assert.ok(
    settings.hooks.Stop.flatMap((b) => b.hooks || []).some((h) => h.command.includes("stop-review.mjs")),
    "gates are registered in the settings Claude actually reads"
  );
  assert.ok(fs.existsSync(path.join(claudeDir, "hooks", "stop-review.mjs")), "hooks deploy into CLAUDE_CONFIG_DIR");
  const known = JSON.parse(fs.readFileSync(path.join(claudeDir, "plugins", "known_marketplaces.json"), "utf8"));
  assert.equal(known.aiwithrai.source.path, path.resolve(repo));

  // Nothing of Claude's config tree leaks into the default ~/.claude location (peerBench's own
  // state under ~/.claude/plugins/data is intentionally home-based).
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "hooks")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "known_marketplaces.json")), false);
});

test("assertDeployableSource blocks a dirty checkout unless --allow-dirty", async () => {
  const { assertDeployableSource } = await import("../scripts/install.mjs");
  const calls = [];
  const execImpl = (cmd, args) => {
    calls.push(args[0] === "rev-parse" ? "rev-parse" : "status");
    return args[0] === "rev-parse" ? "true\n" : " M global-hooks/stop-review.mjs\n?? junk.txt\n";
  };
  assert.throws(
    () => assertDeployableSource("/repo", { execImpl, skipTests: true, env: {} }),
    /deploy blocked: the working tree has 2 uncommitted change/
  );
  const overridden = assertDeployableSource("/repo", { execImpl, allowDirty: true, skipTests: true, env: {} });
  assert.equal(overridden.checked, true);
  assert.equal(overridden.dirtyOverridden, true);
});
test("assertDeployableSource blocks when the test suite fails, passes when green", async () => {
  const { assertDeployableSource } = await import("../scripts/install.mjs");
  const execImpl = (cmd, args) => (args[0] === "rev-parse" ? "true\n" : "");
  assert.throws(
    () => assertDeployableSource("/repo", { execImpl, env: {}, spawnImpl: () => ({ status: 1, stdout: "1 failing" }) }),
    /deploy blocked: the test suite failed/
  );
  const ok = assertDeployableSource("/repo", { execImpl, env: {}, spawnImpl: () => ({ status: 0, stdout: "" }) });
  assert.equal(ok.testsRun, true);
});
test("assertDeployableSource skips checks for a non-git (packaged) source root", async () => {
  const { assertDeployableSource } = await import("../scripts/install.mjs");
  const res = assertDeployableSource("/packaged", { execImpl: () => { throw new Error("not a repo"); }, env: {} });
  assert.equal(res.checked, false);
});
test("install no longer mass-enables the Codex plugin gate (per-workspace setting untouched)", async () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "scripts", "install.mjs"), "utf8");
  const defaultBranch = src.split("BENCH_SINGLE_GATE")[2] || "";
  assert.ok(!/enableLegacyCodexStopGateStates\(/.test(defaultBranch), "default install branch must not call the mass-enable");
});
