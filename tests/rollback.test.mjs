import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rollback } from "../scripts/rollback.mjs";
import { claudePluginInstallRoots, installPeerBench } from "../scripts/install.mjs";
import { ensureNativePrePushHook, nativePrePushStatus } from "../global-hooks/native-git-hook.mjs";
import { capturePathState, deploy, snapshot, snapshotPluginInstallRoot } from "../scripts/deploy-global-hooks.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

test("rollback restores snapshot files, removes new deploy files, restores settings", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  // Post-deploy live state: codex-plan-* gone, panel-lib mutated, new modules present, settings mutated
  fs.writeFileSync(path.join(hooks, "panel-lib.mjs"), "NEW panel\n");
  fs.writeFileSync(path.join(hooks, "review-client.mjs"), "new module\n");
  fs.writeFileSync(path.join(hooks, "plan-review.mjs"), "new plan hook\n");
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, '{"hooks":{"PreToolUse":[{"matcher":"ExitPlanMode"}]}}');
  // Snapshot (pre-deploy): the originals
  fs.writeFileSync(path.join(backup, "codex-plan-review.mjs"), "ORIG codex hook\n");
  fs.writeFileSync(path.join(backup, "panel-lib.mjs"), "ORIG panel\n");
  fs.writeFileSync(path.join(backup, "settings.json"), '{"hooks":{}}');

  const deployedNames = ["panel-lib.mjs", "review-client.mjs", "plan-review.mjs", "config-store.mjs"];
  const r = rollback({ backupDir: backup, hooksDir: hooks, settingsPath, deployedNames });

  // codex-plan-review.mjs restored from backup
  assert.equal(fs.readFileSync(path.join(hooks, "codex-plan-review.mjs"), "utf8"), "ORIG codex hook\n");
  // panel-lib.mjs reverted to original
  assert.equal(fs.readFileSync(path.join(hooks, "panel-lib.mjs"), "utf8"), "ORIG panel\n");
  // new module removed (deployed, not in snapshot)
  assert.equal(fs.existsSync(path.join(hooks, "review-client.mjs")), false);
  assert.ok(r.removed.includes("review-client.mjs"));
  assert.ok(r.removed.includes("plan-review.mjs"));
  // settings restored
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"hooks":{}}');
  assert.equal(r.settingsRestored, true);
});

test("install metadata rolls back Claude and Codex exactly and removes the native hook from the installed repo only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rollback-full-"));
  const home = path.join(root, "home");
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  gitInit(repoA);
  gitInit(repoB);
  fs.cpSync(path.join(PROJECT_ROOT, "global-hooks"), path.join(repoA, "global-hooks"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "codex-prompts"), path.join(repoA, "codex-prompts"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "package.json"), path.join(repoA, "package.json"));
  fs.cpSync(path.join(PROJECT_ROOT, ".claude-plugin"), path.join(repoA, ".claude-plugin"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, ".codex-plugin"), path.join(repoA, ".codex-plugin"), { recursive: true });
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(repoA, "package.json"), "utf8")).version;

  const claudeHooks = path.join(home, ".claude", "hooks");
  const claudeSettings = path.join(home, ".claude", "settings.json");
  const statusline = path.join(home, ".claude", "statusline-command.sh");
  const codexHooks = path.join(home, ".codex", "hooks");
  const codexHooksPath = path.join(home, ".codex", "hooks.json");
  const codexPrompts = path.join(home, ".codex", "prompts");
  fs.mkdirSync(claudeHooks, { recursive: true });
  fs.mkdirSync(codexHooks, { recursive: true });
  fs.mkdirSync(codexPrompts, { recursive: true });
  fs.writeFileSync(path.join(claudeHooks, "user-hook.mjs"), "// claude original\n");
  fs.writeFileSync(claudeSettings, "{\"user\":\"claude-before\"}");
  const originalStatusline = "#!/bin/sh\ninput=$(cat)\ngate_dir=/tmp\nnode ~/.claude/hooks/statusline-segment.mjs \"$gate_dir\"\n";
  fs.writeFileSync(statusline, originalStatusline);
  fs.writeFileSync(path.join(codexHooks, "user-hook.mjs"), "// codex original\n");
  fs.writeFileSync(codexHooksPath, "{\"user\":\"codex-before\"}");
  fs.writeFileSync(path.join(codexPrompts, "bench-review.md"), "original review prompt\n");
  fs.writeFileSync(path.join(codexPrompts, "personal.md"), "personal prompt\n");
  const codexPluginRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", pluginVersion);
  fs.mkdirSync(path.join(codexPluginRoot, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(codexPluginRoot, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(codexPluginRoot, "package.json"), `${JSON.stringify({ name: "peerbench", version: pluginVersion })}\n`);
  fs.writeFileSync(path.join(codexPluginRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name: "bench", version: pluginVersion })}\n`);
  fs.writeFileSync(path.join(codexPluginRoot, "global-hooks", "panel-lib.mjs"), "// plugin cache original\n");

  const originalNative = path.join(repoA, ".git", "hooks", "pre-push");
  fs.writeFileSync(originalNative, "#!/bin/sh\n# repo A user hook\nexit 0\n");
  fs.chmodSync(originalNative, 0o755);

  const installed = installPeerBench({
    repoRoot: repoA,
    home,
    now: () => 4242,
    syncClaudePlugin: false,
    env: { ...process.env, BENCH_ROOT: path.join(home, ".claude", "plugins", "data", "bench-shared") }
  });
  assert.equal(nativePrePushStatus(repoA).installed, true);
  assert.ok(fs.existsSync(installed.rollbackMetadata));
  const metadata = JSON.parse(fs.readFileSync(installed.rollbackMetadata, "utf8"));
  assert.equal(metadata.repoRoot, path.resolve(repoA));
  assert.equal(metadata.nativePrePush.repoRoot, path.resolve(repoA));
  assert.equal(metadata.codex.hooksPath, codexHooksPath);
  assert.equal(metadata.codex.pluginRuntimeSnapshots.length, 1);
  const claudeKnownMarketplaces = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  assert.equal(fs.existsSync(claudeKnownMarketplaces), true);
  assert.notEqual(fs.readFileSync(path.join(codexPluginRoot, "global-hooks", "panel-lib.mjs"), "utf8"), "// plugin cache original\n");

  // A second repository proves rollback does not use the caller's cwd or touch unrelated hooks.
  assert.equal(ensureNativePrePushHook(repoB, {
    runtimePath: path.join(repoA, "global-hooks", "git-pre-push-review.mjs")
  }).installed, true);

  const first = rollback({ backupDir: installed.backupDir });
  assert.equal(first.metadataFound, true);
  assert.equal(first.nativePrePush.changed, true);
  assert.equal(nativePrePushStatus(repoA).managed, false);
  assert.equal(fs.readFileSync(originalNative, "utf8"), "#!/bin/sh\n# repo A user hook\nexit 0\n");
  assert.equal(nativePrePushStatus(repoB).installed, true, "the unrelated repo must remain installed");

  assert.equal(fs.readFileSync(claudeSettings, "utf8"), "{\"user\":\"claude-before\"}");
  assert.equal(fs.readFileSync(statusline, "utf8"), originalStatusline);
  assert.equal(fs.existsSync(claudeKnownMarketplaces), false, "fresh Claude registry file is removed on rollback");
  assert.equal(fs.readFileSync(path.join(claudeHooks, "user-hook.mjs"), "utf8"), "// claude original\n");
  assert.equal(fs.readFileSync(codexHooksPath, "utf8"), "{\"user\":\"codex-before\"}");
  assert.equal(fs.readFileSync(path.join(codexHooks, "user-hook.mjs"), "utf8"), "// codex original\n");
  assert.equal(fs.existsSync(path.join(codexHooks, "review-client.mjs")), false);
  assert.equal(fs.readFileSync(path.join(codexPrompts, "bench-review.md"), "utf8"), "original review prompt\n");
  assert.equal(fs.readFileSync(path.join(codexPrompts, "personal.md"), "utf8"), "personal prompt\n");
  assert.equal(fs.existsSync(path.join(codexPrompts, "bench-hunt.md")), false);
  assert.equal(fs.readFileSync(path.join(codexPluginRoot, "global-hooks", "panel-lib.mjs"), "utf8"), "// plugin cache original\n");
  assert.ok(first.codex.removed.includes("review-client.mjs"));
  assert.ok(first.codex.promptsRemoved.includes("bench-hunt.md"));

  const second = rollback({ backupDir: installed.backupDir });
  assert.equal(second.nativePrePush.changed, false);
  assert.equal(nativePrePushStatus(repoB).installed, true);
  assert.equal(fs.readFileSync(codexHooksPath, "utf8"), "{\"user\":\"codex-before\"}");
});

test("native rollback restores pre-existing managed bytes and mode, and removes an absent-before hook", () => {
  for (const preexisting of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pb-native-exact-${preexisting ? "managed" : "absent"}-`));
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    gitInit(repo);
    fs.cpSync(path.join(PROJECT_ROOT, "global-hooks"), path.join(repo, "global-hooks"), { recursive: true });
    fs.cpSync(path.join(PROJECT_ROOT, "codex-prompts"), path.join(repo, "codex-prompts"), { recursive: true });
    if (preexisting) execFileSync("git", ["config", "core.hooksPath", "custom-hooks"], { cwd: repo });
    const hookPath = preexisting
      ? path.join(repo, "custom-hooks", "pre-push")
      : path.join(repo, ".git", "hooks", "pre-push");
    let original = null;
    if (preexisting) {
      const runtimeA = path.join(repo, "runtime-a.mjs");
      fs.writeFileSync(runtimeA, "process.exit(0);\n");
      assert.equal(ensureNativePrePushHook(repo, { runtimePath: runtimeA }).installed, true);
      fs.chmodSync(hookPath, 0o640);
      original = fs.readFileSync(hookPath);
    }

    const installed = installPeerBench({
      repoRoot: repo,
      home,
      claude: false,
      codex: true,
      now: () => 4343,
      syncClaudePlugin: false
    });
    assert.equal(nativePrePushStatus(repo).installed, true);
    if (preexisting) assert.notDeepEqual(fs.readFileSync(hookPath), original, "install updates the embedded runtime");

    const first = rollback({ backupDir: installed.backupDir });
    assert.equal(first.nativePrePush.ok, true);
    assert.equal(first.nativePrePush.changed, true);
    if (preexisting) {
      assert.deepEqual(fs.readFileSync(hookPath), original);
      assert.equal(fs.statSync(hookPath).mode & 0o777, 0o640);
    } else {
      assert.equal(fs.existsSync(hookPath), false);
    }
    assert.equal(rollback({ backupDir: installed.backupDir }).nativePrePush.changed, false, "native restore is idempotent");
  }
});

test("native rollback refuses to overwrite a pre-existing hook that was replaced after install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-native-replaced-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  gitInit(repo);
  fs.cpSync(path.join(PROJECT_ROOT, "global-hooks"), path.join(repo, "global-hooks"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "codex-prompts"), path.join(repo, "codex-prompts"), { recursive: true });
  const hookPath = path.join(repo, ".git", "hooks", "pre-push");
  // A managed hook existed BEFORE install (an older peerbench dispatcher).
  const runtimeA = path.join(repo, "runtime-a.mjs");
  fs.writeFileSync(runtimeA, "process.exit(0);\n");
  assert.equal(ensureNativePrePushHook(repo, { runtimePath: runtimeA }).installed, true);

  const installed = installPeerBench({
    repoRoot: repo,
    home,
    claude: false,
    codex: true,
    now: () => 4747,
    syncClaudePlugin: false
  });
  assert.equal(nativePrePushStatus(repo).installed, true);

  // A post-install tool (e.g. husky reinstall) rewrote the hook: it differs from BOTH the
  // pre-install original and the dispatcher install left behind.
  const replacement = "#!/bin/sh\n# husky reinstall\nexit 0\n";
  fs.writeFileSync(hookPath, replacement);
  fs.chmodSync(hookPath, 0o755);

  const result = rollback({ backupDir: installed.backupDir });
  assert.equal(result.nativePrePush.ok, false);
  assert.match(result.nativePrePush.reason, /replaced after install/);
  assert.equal(fs.readFileSync(hookPath, "utf8"), replacement, "the post-install replacement is preserved");
});

test("native rollback restores a pre-existing pre-push symlink as a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-native-symlink-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  gitInit(repo);
  fs.cpSync(path.join(PROJECT_ROOT, "global-hooks"), path.join(repo, "global-hooks"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "codex-prompts"), path.join(repo, "codex-prompts"), { recursive: true });
  const hooks = path.join(repo, ".git", "hooks");
  const target = path.join(hooks, "user-pre-push");
  const hook = path.join(hooks, "pre-push");
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(target, 0o755);
  fs.symlinkSync("user-pre-push", hook);

  const installed = installPeerBench({
    repoRoot: repo,
    home,
    claude: false,
    codex: true,
    now: () => 4545,
    syncClaudePlugin: false
  });
  assert.equal(nativePrePushStatus(repo).installed, true);
  rollback({ backupDir: installed.backupDir });
  assert.equal(fs.lstatSync(hook).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(hook), "user-pre-push");
  assert.equal(fs.existsSync(path.join(hooks, "pre-push.local")), false);
});

test("Claude CLI install failure automatically restores plugin root, registries, and settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-install-transaction-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  gitInit(repo);
  fs.cpSync(path.join(PROJECT_ROOT, "global-hooks"), path.join(repo, "global-hooks"), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "codex-prompts"), path.join(repo, "codex-prompts"), { recursive: true });

  const pluginsDir = path.join(home, ".claude", "plugins");
  const oldRoot = path.join(pluginsDir, "cache", "aiwithrai", "bench", "old");
  const knownPath = path.join(pluginsDir, "known_marketplaces.json");
  const installedPath = path.join(pluginsDir, "installed_plugins.json");
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.join(oldRoot, "global-hooks"), { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "global-hooks", "sentinel.mjs"), "original plugin root\n");
  const knownBefore = `${JSON.stringify({ aiwithrai: { source: { source: "directory", path: repo }, installLocation: repo } }, null, 2)}\n`;
  const installedBefore = `${JSON.stringify({ plugins: { "bench@aiwithrai": [{ scope: "user", installPath: oldRoot }] } }, null, 2)}\n`;
  const settingsBefore = '{"before":true}\n';
  fs.writeFileSync(knownPath, knownBefore, { mode: 0o644 });
  fs.writeFileSync(installedPath, installedBefore, { mode: 0o644 });
  fs.writeFileSync(settingsPath, settingsBefore, { mode: 0o644 });

  const claudeRunner = (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
    if (args[0] === "plugin" && args[1] === "remove" && args[2] === "bench@aiwithrai") {
      fs.rmSync(oldRoot, { recursive: true, force: true });
      fs.writeFileSync(installedPath, JSON.stringify({ plugins: { "bench@aiwithrai": [] } }));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "install") {
      return { status: 19, stdout: "", stderr: "injected install failure" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(() => installPeerBench({
    repoRoot: repo,
    home,
    claude: true,
    codex: false,
    now: () => 4646,
    syncClaudePlugin: true,
    claudeRunner
  }), /injected install failure/);

  const backupDir = path.join(home, ".claude", "plugins", "data", "bench-shared", "backup-4646");
  assert.equal(fs.existsSync(path.join(backupDir, "install-metadata.json")), true, "rollback plan exists before the failing CLI mutation");
  assert.equal(fs.readFileSync(path.join(oldRoot, "global-hooks", "sentinel.mjs"), "utf8"), "original plugin root\n");
  assert.equal(fs.readFileSync(knownPath, "utf8"), knownBefore);
  assert.equal(fs.readFileSync(installedPath, "utf8"), installedBefore);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o644, "automatic rollback restores the original mode");
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backupDir, "settings.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(backupDir, "claude-plugin-registry", "known_marketplaces.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(backupDir, "claude-plugin-registry", "installed_plugins.json")).mode & 0o777, 0o600);
});

test("focused-install metadata makes rollback skip the platform that was not installed", () => {
  for (const installedPlatform of ["claude", "codex"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pb-rollback-${installedPlatform}-only-`));
    const backupDir = path.join(root, "backup");
    const claudeHooks = path.join(root, "claude-hooks");
    const codexHooks = path.join(root, "codex-hooks");
    const claudeSettings = path.join(root, "claude-settings.json");
    const codexHooksPath = path.join(root, "codex-hooks.json");
    const codexPrompts = path.join(root, "codex-prompts");
    fs.mkdirSync(path.join(backupDir, "codex"), { recursive: true });
    fs.mkdirSync(claudeHooks);
    fs.mkdirSync(codexHooks);
    fs.mkdirSync(codexPrompts);
    fs.writeFileSync(path.join(claudeHooks, "review-client.mjs"), "leave claude alone\n");
    fs.writeFileSync(path.join(codexHooks, "review-client.mjs"), "leave codex alone\n");
    fs.writeFileSync(claudeSettings, "leave claude settings alone\n");
    fs.writeFileSync(codexHooksPath, "leave codex settings alone\n");
    fs.writeFileSync(path.join(codexPrompts, "bench-review.md"), "leave codex prompt alone\n");

    const claude = installedPlatform === "claude" ? {
      hooksDir: claudeHooks,
      settingsPath: claudeSettings,
      deployedNames: ["review-client.mjs"],
      restoreNames: ["review-client.mjs"],
      settingsBackedUp: false,
      statuslineUpdated: false
    } : null;
    const codex = installedPlatform === "codex" ? {
      hooksDir: codexHooks,
      hooksPath: codexHooksPath,
      promptsDir: codexPrompts,
      deployedNames: ["review-client.mjs"],
      restoreNames: ["review-client.mjs"],
      promptNames: ["bench-review.md"],
      hooksJsonBackedUp: false
    } : null;
    fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
      schemaVersion: 1,
      claude,
      codex,
      nativePrePush: null
    }));

    rollback({
      backupDir,
      // These emulate the CLI's legacy fallbacks; explicit null metadata must win over them.
      hooksDir: claudeHooks,
      settingsPath: claudeSettings,
      deployedNames: ["review-client.mjs"],
      codexHooksDir: codexHooks,
      codexHooksPath,
      codexPromptsDir: codexPrompts,
      codexDeployedNames: ["review-client.mjs"],
      codexPromptNames: ["bench-review.md"]
    });

    assert.equal(fs.existsSync(path.join(claudeHooks, "review-client.mjs")), installedPlatform !== "claude");
    assert.equal(fs.existsSync(claudeSettings), installedPlatform !== "claude");
    assert.equal(fs.existsSync(path.join(codexHooks, "review-client.mjs")), installedPlatform !== "codex");
    assert.equal(fs.existsSync(codexHooksPath), installedPlatform !== "codex");
    assert.equal(fs.existsSync(path.join(codexPrompts, "bench-review.md")), installedPlatform !== "codex");
  }
});

test("rollback restores Claude plugin registry identity across replacement and fresh installs", () => {
  for (const fresh of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pb-registry-rollback-${fresh ? "fresh" : "replace"}-`));
    const backupDir = path.join(root, "backup");
    const registryDir = path.join(root, "registry");
    const knownPath = path.join(registryDir, "known_marketplaces.json");
    const installedPath = path.join(registryDir, "installed_plugins.json");
    const oldRoot = path.join(root, ".claude", "plugins", "cache", "aiwithrai", "bench", "old");
    const legacyRoot = path.join(root, ".claude", "plugins", "cache", "peerbench", "bench", "legacy");
    const newRoot = path.join(root, ".claude", "plugins", "cache", "aiwithrai", "bench", "new");
    fs.mkdirSync(registryDir, { recursive: true });
    const installSnapshots = [];

    if (!fresh) {
      fs.mkdirSync(path.join(oldRoot, "global-hooks"), { recursive: true });
      fs.writeFileSync(path.join(oldRoot, "global-hooks", "panel-lib.mjs"), "old plugin runtime\n");
      fs.mkdirSync(path.join(oldRoot, "tests"), { recursive: true });
      fs.writeFileSync(path.join(oldRoot, "tests", "outside-runtime-sentinel.txt"), "old full package\n");
      fs.writeFileSync(path.join(oldRoot, ".keys"), "must not enter rollback backup\n");
      fs.writeFileSync(path.join(oldRoot, ".keys.local"), "must not enter rollback backup\n");
      fs.writeFileSync(path.join(oldRoot, ".env.production"), "must not enter rollback backup\n");
      fs.writeFileSync(path.join(oldRoot, ".env.example"), "safe template\n");
      fs.mkdirSync(path.join(legacyRoot, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, "prompts", "legacy-sentinel.md"), "legacy full package\n");
      installSnapshots.push(snapshotPluginInstallRoot({
        pluginRoot: oldRoot,
        backupDir: path.join(backupDir, "plugin-installs", "old")
      }));
      installSnapshots.push(snapshotPluginInstallRoot({
        pluginRoot: legacyRoot,
        backupDir: path.join(backupDir, "plugin-installs", "legacy")
      }));
      const oldBackupContent = path.join(backupDir, "plugin-installs", "old", "content");
      assert.equal(fs.existsSync(path.join(oldBackupContent, ".keys")), false);
      assert.equal(fs.existsSync(path.join(oldBackupContent, ".keys.local")), false);
      assert.equal(fs.existsSync(path.join(oldBackupContent, ".env.production")), false);
      assert.equal(fs.readFileSync(path.join(oldBackupContent, ".env.example"), "utf8"), "safe template\n");
      fs.mkdirSync(path.join(backupDir, "claude-plugin-registry"), { recursive: true });
      fs.writeFileSync(path.join(backupDir, "claude-plugin-registry", "known.json"), JSON.stringify({ root: oldRoot }));
      fs.writeFileSync(path.join(backupDir, "claude-plugin-registry", "installed.json"), JSON.stringify({ root: oldRoot }));
    }
    installSnapshots.push(snapshotPluginInstallRoot({
      pluginRoot: newRoot,
      backupDir: path.join(backupDir, "plugin-installs", "new"),
      existedBefore: false
    }));

    // Post-install state points at and contains only the new cache root.
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(newRoot, "global-hooks"), { recursive: true });
    fs.writeFileSync(path.join(newRoot, "global-hooks", "panel-lib.mjs"), "new plugin runtime\n");
    fs.writeFileSync(knownPath, JSON.stringify({ root: newRoot }));
    fs.writeFileSync(installedPath, JSON.stringify({ root: newRoot }));
    const registryBackupDir = path.join(backupDir, "claude-plugin-registry");
    fs.mkdirSync(registryBackupDir, { recursive: true });
    const registryFiles = [
      {
        target: knownPath,
        backupPath: path.join(registryBackupDir, "known.json"),
        existed: !fresh
      },
      {
        target: installedPath,
        backupPath: path.join(registryBackupDir, "installed.json"),
        existed: !fresh
      }
    ];
    fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
      schemaVersion: 1,
      claude: {
        pluginInstallSnapshots: installSnapshots.map((entry) => ({ pluginRoot: entry.pluginRoot, backupDir: entry.backupDir })),
        pluginRegistryFiles: registryFiles,
        statuslineUpdated: false
      },
      codex: null,
      nativePrePush: null
    }));

    const result = rollback({ backupDir });
    assert.equal(result.pluginInstalls.every((entry) => entry.ok), true);
    assert.equal(fs.existsSync(path.join(newRoot, "global-hooks", "panel-lib.mjs")), false);
    if (fresh) {
      assert.equal(fs.existsSync(knownPath), false);
      assert.equal(fs.existsSync(installedPath), false);
    } else {
      assert.equal(fs.readFileSync(path.join(oldRoot, "global-hooks", "panel-lib.mjs"), "utf8"), "old plugin runtime\n");
      assert.equal(fs.readFileSync(path.join(oldRoot, "tests", "outside-runtime-sentinel.txt"), "utf8"), "old full package\n");
      assert.equal(fs.existsSync(path.join(oldRoot, ".keys")), false, "secret-like cache files are excluded from rollback snapshots");
      assert.equal(fs.existsSync(path.join(oldRoot, ".keys.local")), false);
      assert.equal(fs.existsSync(path.join(oldRoot, ".env.production")), false);
      assert.equal(fs.readFileSync(path.join(oldRoot, ".env.example"), "utf8"), "safe template\n");
      assert.equal(fs.readFileSync(path.join(legacyRoot, "prompts", "legacy-sentinel.md"), "utf8"), "legacy full package\n");
      assert.deepEqual(JSON.parse(fs.readFileSync(knownPath, "utf8")), { root: oldRoot });
      assert.deepEqual(JSON.parse(fs.readFileSync(installedPath, "utf8")), { root: oldRoot });
    }
  }
});

test("Claude install discovery includes current and repo-owned legacy cache roots only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-legacy-root-discovery-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const otherRepo = path.join(root, "other-repo");
  const currentRoot = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "current");
  const legacyRoot = path.join(home, ".claude", "plugins", "cache", "peerbench", "bench", "legacy");
  const unrelatedLegacyRoot = path.join(home, ".claude", "plugins", "cache", "rai-tools", "bench", "unrelated");
  for (const dir of [repo, otherRepo, currentRoot, legacyRoot, unrelatedLegacyRoot]) fs.mkdirSync(dir, { recursive: true });
  const pluginsDir = path.join(home, ".claude", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "known_marketplaces.json"), JSON.stringify({
    peerbench: { source: { path: repo } },
    "rai-tools": { source: { path: otherRepo } }
  }));
  fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ plugins: {
    "bench@aiwithrai": [{ scope: "user", installPath: currentRoot }],
    "bench@peerbench": [{ scope: "user", installPath: legacyRoot }],
    "bench@rai-tools": [{ scope: "user", installPath: unrelatedLegacyRoot }]
  } }));

  assert.deepEqual(claudePluginInstallRoots({ home, repoRoot: repo }), [currentRoot, legacyRoot]);
});

test("generic hook rollback restores symlink identity without writing through its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-hook-symlink-rollback-"));
  const src = path.join(root, "src");
  const hooks = path.join(root, "hooks");
  const backupDir = path.join(root, "backup");
  const settingsPath = path.join(root, "settings.json");
  fs.mkdirSync(src);
  fs.mkdirSync(hooks);
  fs.writeFileSync(settingsPath, "{}\n");
  fs.writeFileSync(path.join(src, "gate.mjs"), "managed\n");
  const external = path.join(root, "external.mjs");
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, path.join(hooks, "gate.mjs"));
  const snap = snapshot({ hooksDir: hooks, settingsPath, backupDir, fileNames: ["gate.mjs"] });
  const dep = deploy({ src, dest: hooks });
  fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
    schemaVersion: 1,
    claude: {
      hooksDir: hooks,
      settingsPath,
      deployedNames: ["gate.mjs"],
      restoreNames: ["gate.mjs"],
      fileSnapshots: snap.entries,
      hookAfterStates: dep.states,
      settingsSnapshot: snap.settingsEntry,
      settingsAfterState: snap.settingsEntry.existed ? { exists: true, type: "file", mode: 0o644, sha256: snap.settingsEntry.sha256 } : { exists: false },
      statuslineUpdated: false
    },
    codex: null,
    nativePrePush: null
  }));

  const result = rollback({ backupDir });
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(path.join(hooks, "gate.mjs")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(hooks, "gate.mjs")), external);
  assert.equal(fs.readFileSync(external, "utf8"), "external\n");
});

test("manual rollback preserves post-install user edits and reports a conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-hook-conflict-"));
  const src = path.join(root, "src");
  const hooks = path.join(root, "hooks");
  const backupDir = path.join(root, "backup");
  const settingsPath = path.join(root, "settings.json");
  fs.mkdirSync(src);
  fs.mkdirSync(hooks);
  fs.writeFileSync(settingsPath, "{}\n");
  fs.writeFileSync(path.join(src, "gate.mjs"), "managed\n");
  fs.writeFileSync(path.join(hooks, "gate.mjs"), "before\n");
  const snap = snapshot({ hooksDir: hooks, settingsPath, backupDir, fileNames: ["gate.mjs"] });
  const dep = deploy({ src, dest: hooks });
  fs.writeFileSync(path.join(hooks, "gate.mjs"), "user edit after install\n");
  fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
    schemaVersion: 1,
    claude: {
      hooksDir: hooks,
      settingsPath,
      deployedNames: ["gate.mjs"],
      restoreNames: ["gate.mjs"],
      fileSnapshots: snap.entries,
      hookAfterStates: dep.states,
      settingsSnapshot: snap.settingsEntry,
      statuslineUpdated: false
    },
    codex: null,
    nativePrePush: null
  }));

  const result = rollback({ backupDir });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /changed after install/);
  assert.equal(fs.readFileSync(path.join(hooks, "gate.mjs"), "utf8"), "user edit after install\n");
});

test("rollback aggregates ok:false restorers and the CLI exits nonzero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rollback-failure-"));
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
    schemaVersion: 1,
    claude: {
      pluginRuntimeSnapshots: [{ backupDir: path.join(backupDir, "missing-runtime") }],
      statuslineUpdated: false
    },
    codex: null,
    nativePrePush: null
  }));
  const result = rollback({ backupDir });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /snapshot is missing or invalid/);

  const cli = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", "rollback.mjs"), backupDir], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /"ok": false/, cli.stderr || "rollback CLI produced no JSON output");
});

test("fresh-machine plugin registry rollback honors expectedAfter instead of deleting a changed registry", () => {
  for (const changed of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pb-registry-fresh-${changed ? "changed" : "pristine"}-`));
    const backupDir = path.join(root, "backup");
    const registryDir = path.join(root, "registry");
    const installedPath = path.join(registryDir, "installed_plugins.json");
    fs.mkdirSync(registryDir, { recursive: true });
    const registryBackupDir = path.join(backupDir, "claude-plugin-registry");
    fs.mkdirSync(registryBackupDir, { recursive: true });
    // Install on a fresh machine created the registry (nothing pre-existed to back up); the
    // transaction records the after-install state so rollback can tell later edits apart.
    fs.writeFileSync(installedPath, `${JSON.stringify({ plugins: { "bench@aiwithrai": [{ scope: "user", installPath: "/x/bench" }] } })}\n`);
    const expectedAfter = capturePathState(installedPath);
    if (changed) {
      // The user installed ANOTHER plugin after peerbench: the registry no longer matches the
      // after-install state, so removing it would destroy the user's entry.
      fs.writeFileSync(installedPath, `${JSON.stringify({ plugins: {
        "bench@aiwithrai": [{ scope: "user", installPath: "/x/bench" }],
        "other@other": [{ scope: "user", installPath: "/x/other" }]
      } })}\n`);
    }
    fs.writeFileSync(path.join(backupDir, "install-metadata.json"), JSON.stringify({
      schemaVersion: 1,
      claude: {
        pluginRegistryFiles: [{
          target: installedPath,
          backupPath: path.join(registryBackupDir, "installed_plugins.json"),
          existed: false,
          mode: null,
          type: null,
          linkTarget: null,
          expectedAfter
        }],
        statuslineUpdated: false
      },
      codex: null,
      nativePrePush: null
    }));

    const result = rollback({ backupDir });
    if (changed) {
      assert.equal(result.ok, false);
      assert.match(result.failures.join("\n"), /changed after install/);
      assert.ok(JSON.parse(fs.readFileSync(installedPath, "utf8")).plugins["other@other"], "the user's post-install plugin entry survives rollback");
    } else {
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(installedPath), false, "an untouched fresh-machine registry is still removed");
    }
  }
});
