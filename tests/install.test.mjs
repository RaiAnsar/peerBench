import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseInstallArgs,
  renderInstallSummary,
  syncClaudePluginSettings
} from "../scripts/install.mjs";

test("syncClaudePluginSettings installs peerbench and migrates legacy rai-tools only when it points at this repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-repo-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-other-"));
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    extraKnownMarketplaces: {
      "rai-tools": { source: { source: "directory", path: repo } },
      "other-tools": { source: { source: "directory", path: other } }
    },
    enabledPlugins: {
      "bench@rai-tools": true,
      "other@other-tools": true
    }
  }, null, 2));

  const result = syncClaudePluginSettings({ settingsPath, repoRoot: repo, home });
  assert.deepEqual(result.migrated, ["rai-tools"]);
  assert.equal(result.pluginId, "bench@peerbench");

  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(saved.enabledPlugins["bench@peerbench"], true);
  assert.equal(saved.enabledPlugins["bench@rai-tools"], undefined);
  assert.equal(saved.enabledPlugins["other@other-tools"], true);
  assert.equal(saved.extraKnownMarketplaces["rai-tools"], undefined);
  assert.equal(saved.extraKnownMarketplaces["other-tools"].source.path, other);
  assert.equal(saved.extraKnownMarketplaces.peerbench.source.path, repo);
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
    marketplaceName: "peerbench",
    help: false
  });
  assert.equal(parseInstallArgs(["--codex-only"]).claude, false);
  assert.equal(parseInstallArgs(["--claude-only"]).codex, false);
  assert.equal(parseInstallArgs(["--load-keys", "--keys", "/tmp/.keys"]).keysPath, "/tmp/.keys");
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
