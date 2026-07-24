import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installPeerBench,
  parseInstallArgs,
  renderInstallSummary,
  scrubSensitivePluginCacheFiles,
  syncClaudePluginRegistry,
  syncClaudePluginSettings
} from "../scripts/install.mjs";

function writeMinimalRepo(repo, version = "0.4.0") {
  for (const dir of ["global-hooks", "codex-prompts", "scripts", ".claude-plugin", ".codex-plugin"]) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(repo, "global-hooks", "stop-review.mjs"), "// lightweight stop\n");
  fs.writeFileSync(path.join(repo, "global-hooks", "codex-stop-review.mjs"), "// lightweight Codex stop\n");
  fs.writeFileSync(path.join(repo, "codex-prompts", "bench-review.md"), "node \"{{BENCH_RUNNER}}\" review\n");
  fs.writeFileSync(path.join(repo, "scripts", "bench-runner.mjs"), "// runner\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "peerbench", version }));
  fs.writeFileSync(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "bench", version }));
  fs.writeFileSync(path.join(repo, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "bench", version }));
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
    help: false
  });
  assert.equal(parseInstallArgs(["--codex-only"]).claude, false);
  assert.equal(parseInstallArgs(["--claude-only"]).codex, false);
  assert.equal(parseInstallArgs(["--load-keys", "--keys", "/tmp/.keys"]).keysPath, "/tmp/.keys");
});

test("installPeerBench preserves the independent codex-plugin-cc gate and its state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-preserve-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-preserve-repo-"));
  writeMinimalRepo(repo);

  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const independentStart = { type: "command", command: 'node "/independent/codex-stop-gate-autoenable.mjs"', timeout: 7, marker: "start-state" };
  const independentStop = { type: "command", command: 'node "/independent/codex-multirepo-gate.mjs"', timeout: 31, marker: "stop-state" };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [independentStart] }],
    Stop: [{ hooks: [independentStop] }]
  } }, null, 2));
  const statuslinePath = path.join(home, ".claude", "statusline-command.sh");
  fs.writeFileSync(statuslinePath, [
    "#!/bin/bash",
    "set -u",
    "input=$(cat)",
    "gate_dir=\"$(printf '%s' \"$input\" | jq -r '.workspace.current_dir // empty')\"",
    "codex_gate=$(python3 ~/.claude/gate-status.py \"$gate_dir\" 2>/dev/null)",
    "bench_session_id=$(printf '%s' \"$input\" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')",
    "gc_gate=$(node ~/.claude/hooks/statusline-segment.mjs \"$gate_dir\" \"$bench_session_id\" 2>/dev/null)",
    "gate_seg=\"${gc_gate:-$codex_gate}\"",
    "printf 'custom %s\\n' \"$gate_seg\"",
    ""
  ].join("\n"), { mode: 0o751 });

  const independentState = path.join(home, ".claude", "plugins", "data", "codex-plugin-cc", "state", "workspace.json");
  fs.mkdirSync(path.dirname(independentState), { recursive: true });
  const stateBefore = '{"armed":false,"reviewed":"abc123"}\n';
  fs.writeFileSync(independentState, stateBefore);

  const installed = installPeerBench({ repoRoot: repo, home, claude: true, codex: false, syncClaudePlugin: false, now: () => 1234 });

  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const stop = saved.hooks.Stop.flatMap((block) => block.hooks || []);
  const sessionStart = saved.hooks.SessionStart.flatMap((block) => block.hooks || []);
  assert.deepEqual(stop.find((hook) => hook.command.includes("codex-multirepo-gate.mjs")), independentStop);
  assert.deepEqual(sessionStart.find((hook) => hook.command.includes("codex-stop-gate-autoenable.mjs")), independentStart);
  assert.equal(fs.readFileSync(independentState, "utf8"), stateBefore, "independent per-workspace state is untouched");
  const peerBenchStop = stop.find((hook) => hook.command.includes("stop-review.mjs") && !hook.command.includes("codex-multirepo"));
  assert.equal(peerBenchStop.timeout, 20);
  assert.equal(peerBenchStop.asyncRewake, undefined);
  const statusline = fs.readFileSync(statuslinePath, "utf8");
  // A wrapper that ALREADY invokes the segment is left exactly as the user wrote it — including a
  // custom `${gc_gate:-$codex_gate}` composition. Wiring is only added when it is absent.
  assert.match(statusline, /gc_gate=\$\(node ~\/\.claude\/hooks\/statusline-segment\.mjs/, "the user's own bench invocation is preserved");
  assert.match(statusline, /gate_seg="\$\{gc_gate:-\$codex_gate\}"/, "custom fallback composition is untouched");
  assert.match(statusline, /codex_gate=\$\(python3 ~\/\.claude\/gate-status\.py/, "independent Codex gate remains intact");
  assert.match(statusline, /printf 'custom %s\\n'/, "unrelated custom statusline content remains intact");
  assert.equal(fs.statSync(statuslinePath).mode & 0o777, 0o751);
  assert.equal(installed.claude.statusline.updated, false);
  assert.equal(installed.claude.statusline.reason, "already integrated");
});

test("installPeerBench refuses a stale Codex cache before creating transaction state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-stale-codex-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-stale-codex-repo-"));
  writeMinimalRepo(repo, "0.4.0");
  const stale = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.3.1");
  fs.mkdirSync(path.join(stale, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(stale, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "bench", version: "0.3.1" }));
  fs.writeFileSync(path.join(stale, "sentinel.txt"), "stale untouched\n");

  // The refusal must hand over the EXACT recovery, not a generic pointer: `marketplace upgrade`
  // fails for a directory marketplace, and `plugin add` deletes the old version dir out from under
  // any live Codex session, which is what makes it report the bench skill path as stale.
  assert.throws(
    () => installPeerBench({ repoRoot: repo, home, claude: false, codex: true, now: () => 100 }),
    /checkout=0\.4\.0[\s\S]*0\.3\.1[\s\S]*codex plugin add bench@aiwithrai[\s\S]*--codex-only[\s\S]*stale/i
  );
  assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "data", "bench-shared")), false, "failure occurs before lock/backup mutation");
  assert.equal(fs.existsSync(path.join(home, ".codex", "hooks")), false);
  assert.equal(fs.readFileSync(path.join(stale, "sentinel.txt"), "utf8"), "stale untouched\n");
});

test("installPeerBench rolls back a Claude CLI install that returns the wrong cache version", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-wrong-claude-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-wrong-claude-repo-"));
  writeMinimalRepo(repo, "0.4.0");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  const settingsBefore = "{}\n";
  const knownBefore = `${JSON.stringify({ aiwithrai: { source: { source: "directory", path: repo }, installLocation: repo } }, null, 2)}\n`;
  fs.writeFileSync(settingsPath, settingsBefore);
  fs.writeFileSync(knownPath, knownBefore);
  const wrongRoot = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "0.3.1");
  const runner = (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0" };
    if (args.join(" ") === "plugin install bench@aiwithrai") {
      writeMinimalRepo(wrongRoot, "0.3.1");
      fs.writeFileSync(installedPath, JSON.stringify({
        plugins: { "bench@aiwithrai": [{ scope: "user", installPath: wrongRoot }] }
      }));
    }
    return { status: 0, stdout: "ok" };
  };

  assert.throws(
    () => installPeerBench({
      repoRoot: repo,
      home,
      claude: true,
      codex: false,
      syncClaudePlugin: true,
      claudeRunner: runner,
      now: () => 150
    }),
    /Claude plugin cache version mismatch[\s\S]*checkout=0\.4\.0/i
  );
  assert.equal(fs.existsSync(wrongRoot), false, "wrong-version root created by the manager is removed");
  assert.equal(fs.existsSync(installedPath), false, "new registry is rolled back to absent");
  assert.equal(fs.readFileSync(knownPath, "utf8"), knownBefore);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore);
});

test("installPeerBench automatically rolls back both settings and hooks after a late failure", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-rollback-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-rollback-repo-"));
  writeMinimalRepo(repo);
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const originalSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node /other/plugin/stop-review.mjs"}]}]}}\n';
  fs.writeFileSync(settingsPath, originalSettings, { mode: 0o640 });
  const statuslinePath = path.join(home, ".claude", "statusline-command.sh");
  const originalStatusline = [
    "#!/bin/bash",
    "input=$(cat)",
    "codex_gate=$(python3 ~/.claude/gate-status.py 2>/dev/null)",
    "bench_session_id=$(printf '%s' \"$input\" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')",
    "gc_gate=$(node ~/.claude/hooks/statusline-segment.mjs \"$gate_dir\" \"$bench_session_id\" 2>/dev/null)",
    "gate_seg=\"${gc_gate:-$codex_gate}\"",
    ""
  ].join("\n");
  fs.writeFileSync(statuslinePath, originalStatusline, { mode: 0o741 });

  assert.throws(
    () => installPeerBench({
      repoRoot: repo,
      home,
      claude: true,
      codex: false,
      syncClaudePlugin: false,
      loadKeys: true,
      keysPath: path.join(repo, ".missing-keys"),
      now: () => 200
    }),
    /load-keys failed/
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(statuslinePath, "utf8"), originalStatusline, "late failure restores the pre-install statusline byte-for-byte");
  assert.equal(fs.statSync(statuslinePath).mode & 0o777, 0o741, "late failure restores statusline mode");
  assert.equal(fs.existsSync(path.join(home, ".claude", "hooks", "stop-review.mjs")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "data", ".peerbench-install.lock")), false, "transaction lock released");
  const metadataPath = path.join(home, ".claude", "plugins", "data", "bench-shared", "backup-200", "install-metadata.json");
  assert.equal(fs.existsSync(metadataPath), true, "rollback checkpoints remain available for audit/manual recovery");
});

test("installPeerBench rejects malformed and symlinked config before the first mutation", () => {
  for (const kind of ["malformed", "symlink"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `pb-install-preflight-${kind}-`));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-preflight-repo-"));
    writeMinimalRepo(repo);
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (kind === "malformed") fs.writeFileSync(settingsPath, "{broken");
    else {
      const real = path.join(home, "real-settings.json");
      fs.writeFileSync(real, "{}");
      fs.symlinkSync(real, settingsPath);
    }
    assert.throws(
      () => installPeerBench({ repoRoot: repo, home, claude: true, codex: false, syncClaudePlugin: false }),
      kind === "malformed" ? /invalid JSON/i : /symlink/i
    );
    assert.equal(fs.existsSync(path.join(home, ".claude", "plugins", "data", "bench-shared")), false);
  }
});

test("installPeerBench serializes transactions and allocates unique backups", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-lock-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-lock-repo-"));
  writeMinimalRepo(repo);
  const dataDir = path.join(home, ".claude", "plugins", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".peerbench-install.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "other" }));
  assert.throws(
    () => installPeerBench({ repoRoot: repo, home, claude: true, codex: false, syncClaudePlugin: false, now: () => 300 }),
    /another peerBench install is already running/
  );
  fs.rmSync(lockPath);

  const first = installPeerBench({ repoRoot: repo, home, claude: true, codex: false, syncClaudePlugin: false, now: () => 300 });
  const second = installPeerBench({ repoRoot: repo, home, claude: true, codex: false, syncClaudePlugin: false, now: () => 300 });
  assert.notEqual(first.backupDir, second.backupDir);
  assert.match(path.basename(first.backupDir), /^backup-300$/);
  assert.match(path.basename(second.backupDir), /^backup-300-\d+-1$/);
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
      stdout: "load-keys: wrote providers to companion.json -> mimo (key values redacted)"
    }
  });
  assert.match(out, /origin: main same-as-origin/);
  assert.match(out, /key values redacted/);
  assert.doesNotMatch(out, /sk-/);
});
