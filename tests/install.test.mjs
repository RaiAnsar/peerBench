import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseInstallArgs,
  renderInstallSummary,
  scrubSensitivePluginCacheFiles,
  syncClaudePluginRegistry,
  syncClaudePluginSettings
} from "../scripts/install.mjs";

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
    help: false
  });
  assert.equal(parseInstallArgs(["--codex-only"]).claude, false);
  assert.equal(parseInstallArgs(["--claude-only"]).codex, false);
  assert.equal(parseInstallArgs(["--load-keys", "--keys", "/tmp/.keys"]).keysPath, "/tmp/.keys");
});

test("scrubSensitivePluginCacheFiles removes local secrets but keeps examples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-cache-"));
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  for (const name of [".keys", "prod.keys", ".env", "prod.env", "bench.log", "resultsofHunt.txt"]) {
    fs.writeFileSync(path.join(nested, name), "secret");
  }
  fs.writeFileSync(path.join(nested, ".keys.example"), "placeholder");
  fs.writeFileSync(path.join(nested, "companion.json"), "{}");

  const removed = scrubSensitivePluginCacheFiles(root).map((p) => path.basename(p)).sort();
  assert.deepEqual(removed, [".env", ".keys", "bench.log", "prod.env", "prod.keys", "resultsofHunt.txt"].sort());
  assert.equal(fs.existsSync(path.join(nested, ".keys.example")), true);
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
