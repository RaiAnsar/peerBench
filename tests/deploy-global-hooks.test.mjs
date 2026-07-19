import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  RETIRED_RUNTIME_FILES,
  assertPluginCacheVersionMatch,
  deploy,
  snapshot,
  snapshotCodex,
  syncSettings,
  syncCodexHooks,
  syncCodexPrompts,
  migrateDataDir,
  removePeerBenchStatuslineSegment,
  compareLocalWithOrigin,
  removeClaudeSettingsPeerBenchHooks,
  removeCodexSettingsPeerBenchHooks,
  deployPluginRuntime,
  latestClaudeBenchPluginRoot,
  latestCodexBenchPluginRoot
} from "../scripts/deploy-global-hooks.mjs";

function writeVersionFiles(root, version = "0.4.0") {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "peerbench", version }));
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "bench", version }));
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "bench", version }));
}

test("migrateDataDir: clean legacy → rename", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.mkdirSync(path.join(base, "grok-companion-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["mimo"]}');
  const r = migrateDataDir({ base });
  assert.equal(r.migrated, true);
  assert.ok(fs.existsSync(path.join(base, "bench-shared", "companion.json")), "data moved to bench-shared");
  assert.equal(fs.existsSync(path.join(base, "grok-companion-shared")), false, "old dir removed");
});
test("migrateDataDir: BROKEN-DEPLOY state (empty bench-shared pre-created) → merges real data + recovers", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-broken-"));
  // real data in legacy:
  fs.mkdirSync(path.join(base, "grok-companion-shared", "state", "ws-x", "traces"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["grok","mimo"]}');
  fs.writeFileSync(path.join(base, "grok-companion-shared", "state", "ws-x", "traces", "t.json"), "{}");
  // empty/incomplete bench-shared pre-created by a prior broken deploy (no companion.json):
  fs.mkdirSync(path.join(base, "bench-shared", "backup-x"), { recursive: true });
  const r = migrateDataDir({ base });
  assert.equal(r.migrated, true); assert.equal(r.merged, true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(base, "bench-shared", "companion.json"), "utf8")).reviewers.includes("grok"), "real config recovered");
  assert.ok(fs.existsSync(path.join(base, "bench-shared", "state", "ws-x", "traces", "t.json")), "traces recovered");
  assert.equal(fs.existsSync(path.join(base, "grok-companion-shared")), false, "legacy removed after merge");
});
test("migrateDataDir: already-migrated bench-shared is NOT clobbered; fresh install no-ops", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-done-"));
  fs.mkdirSync(path.join(base, "bench-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "bench-shared", "companion.json"), '{"reviewers":["mimo"]}');
  fs.writeFileSync(path.join(base, "bench-shared", "disabled-global"), "disabled\n");
  fs.mkdirSync(path.join(base, "grok-companion-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["STALE"]}');
  assert.equal(migrateDataDir({ base }).migrated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, "bench-shared", "companion.json"), "utf8")).reviewers[0], "mimo", "current config not clobbered");
  assert.equal(fs.readFileSync(path.join(base, "bench-shared", "disabled-global"), "utf8"), "disabled\n", "global disable marker preserved");
  assert.equal(migrateDataDir({ base: fs.mkdtempSync(path.join(os.tmpdir(), "fresh-")) }).migrated, false);
});

test("deploy copies modules flat and backs up a differing existing file", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-")), dest = fs.mkdtempSync(path.join(os.tmpdir(), "dst-"));
  fs.writeFileSync(path.join(src, "panel-lib.mjs"), "export const v=2;\n");
  fs.writeFileSync(path.join(src, "statusline-segment.mjs"), "// stale source must not be redeployed\n");
  fs.writeFileSync(path.join(dest, "panel-lib.mjs"), "export const v=1;\n");
  for (const name of RETIRED_RUNTIME_FILES) fs.writeFileSync(path.join(dest, name), "// retired\n");
  const r = deploy({ src, dest });
  assert.ok(r.copied.includes("panel-lib.mjs"));
  assert.ok(r.backedUp.includes("panel-lib.mjs"));
  assert.ok(fs.existsSync(path.join(dest, "panel-lib.mjs.pre-panel.bak")));
  assert.equal(fs.readFileSync(path.join(dest, "panel-lib.mjs"), "utf8"), "export const v=2;\n");
  assert.deepEqual([...r.removed].sort(), [...RETIRED_RUNTIME_FILES].sort());
  for (const name of RETIRED_RUNTIME_FILES) {
    assert.equal(fs.existsSync(path.join(dest, name)), false, `${name} remains retired`);
    assert.deepEqual(r.states.find((entry) => entry.name === name)?.state, { exists: false });
  }
});
test("snapshot captures existing hooks + settings", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "hk-")), backup = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  fs.writeFileSync(path.join(hooks, "codex-plan-review.mjs"), "// old\n");
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, "{}");
  const r = snapshot({ hooksDir: hooks, settingsPath, backupDir: path.join(backup, "b1") });
  assert.ok(r.files.includes("codex-plan-review.mjs"));
  assert.equal(r.settingsBackedUp, true);
  assert.ok(fs.existsSync(path.join(backup, "b1", "settings.json")));
});

test("snapshotCodex captures existing Codex hooks + hooks.json", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hk-"));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bk-"));
  fs.writeFileSync(path.join(hooks, "old.mjs"), "// old\n");
  const hooksPath = path.join(hooks, "hooks.json");
  fs.writeFileSync(hooksPath, '{"hooks":{}}');
  const r = snapshotCodex({ hooksDir: hooks, hooksPath, backupDir: path.join(backup, "b1") });
  assert.ok(r.files.includes("old.mjs"));
  assert.equal(r.hooksJsonBackedUp, true);
  assert.ok(fs.existsSync(path.join(backup, "b1", "hooks.json")));
});

test("removePeerBenchStatuslineSegment disables only the retired segment and preserves custom fallbacks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slcmd-"));
  const statuslinePath = path.join(dir, "statusline-command.sh");
  fs.writeFileSync(statuslinePath, [
    "#!/bin/bash",
    "set -u",
    "input=$(cat)",
    "dir=$(echo \"$input\" | jq -r '.workspace.current_dir // .cwd // empty')",
    "gate_dir=\"$dir\"",
    "# comment mentioning statusline-segment.mjs must not be patched",
    "codex_gate=$(python3 ~/.claude/gate-status.py \"$gate_dir\" 2>/dev/null)",
    "bench_session_id=$(printf '%s' \"$input\" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')",
    "gc_gate=$(node ~/.claude/hooks/statusline-segment.mjs \"$gate_dir\" \"$bench_session_id\" 2>/dev/null)",
    "gate_seg=\"${gc_gate:-$codex_gate}\"",
    "echo \"custom:${gate_seg}\"",
    ""
  ].join("\n"), { mode: 0o750 });

  const first = removePeerBenchStatuslineSegment({ statuslinePath });
  assert.equal(first.updated, true);
  assert.equal(first.removedInvocations, 1);
  assert.equal(first.removedSessionHelper, true);
  const once = fs.readFileSync(statuslinePath, "utf8");
  assert.match(once, /^gc_gate=""$/m, "the retired process is replaced by an empty, set-u-safe value");
  assert.doesNotMatch(once, /^\s*bench_session_id=/m, "the exact installer-owned helper is removed when unused");
  assert.match(once, /codex_gate=\$\(python3 ~\/\.claude\/gate-status\.py/, "independent Codex gate is preserved");
  assert.match(once, /gate_seg="\$\{gc_gate:-\$codex_gate\}"/, "the user's fallback composition is preserved");
  assert.match(once, /echo "custom:\$\{gate_seg\}"/, "unrelated custom statusline content is preserved");
  assert.equal(fs.statSync(statuslinePath).mode & 0o777, 0o750);

  const second = removePeerBenchStatuslineSegment({ statuslinePath });
  assert.equal(second.updated, false);
  assert.equal(second.reason, "no peerbench statusline segment");
  assert.equal(fs.readFileSync(statuslinePath, "utf8"), once, "cleanup is idempotent");
});

test("removePeerBenchStatuslineSegment no-ops when there is no peerBench segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slcmd-none-"));
  const statuslinePath = path.join(dir, "statusline-command.sh");
  fs.writeFileSync(statuslinePath, "#!/bin/bash\necho ok\n");
  const before = fs.readFileSync(statuslinePath, "utf8");
  const result = removePeerBenchStatuslineSegment({ statuslinePath });
  assert.equal(result.updated, false);
  assert.equal(result.reason, "no peerbench statusline segment");
  assert.equal(fs.readFileSync(statuslinePath, "utf8"), before);
});

test("syncCodexHooks registers only the Codex wrapper stop hook and is idempotent", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-hk-"));
  fs.writeFileSync(path.join(hooks, "codex-stop-review.mjs"), "// wrapper\n");
  const hooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-cfg-")), "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/unrelated-stop.mjs"' }] }],
      SessionStart: [{ hooks: [{ type: "command", command: `node "${path.join(hooks, "native-session-start.mjs")}"` }] }]
    }
  }, null, 2));

  syncCodexHooks({ hooksDir: hooks, hooksPath });
  syncCodexHooks({ hooksDir: hooks, hooksPath });
  const s = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const stop = s.hooks.Stop.flatMap((b) => b.hooks || []);
  assert.equal(stop.filter((h) => h.command.includes("codex-stop-review.mjs")).length, 1, "Codex wrapper appears exactly once");
  assert.equal(stop.filter((h) => h.command.includes("stop-review.mjs") && !h.command.includes("codex-stop-review.mjs")).length, 0, "Claude stop hook is not registered directly in Codex");
  assert.ok(stop.some((h) => h.command.includes("unrelated-stop.mjs")), "unrelated Codex Stop hook preserved");
  const peer = stop.find((h) => h.command.includes("codex-stop-review.mjs"));
  assert.equal(peer.timeout, 20);
  assert.equal(peer.asyncRewake, undefined);
  assert.equal(peer.rewakeMessage, undefined);
  assert.equal(peer.rewakeSummary, undefined);
  assert.doesNotMatch(JSON.stringify(s.hooks), /native-session-start\.mjs/, "stale native SessionStart hook removed");
  assert.ok(peer.statusMessage);
  assert.ok(peer.command.includes(path.join(hooks, "codex-stop-review.mjs")), "uses deployed ~/.codex hook path");
});

test("syncCodexPrompts renders peerBench custom prompts for Codex", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prompts-src-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prompts-dest-"));
  fs.writeFileSync(path.join(src, "bench-hunt.md"), [
    "---",
    "description: Run hunt",
    "---",
    "node \"{{BENCH_RUNNER}}\" hunt \"$ARGUMENTS\"",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dest, "bench-hunt.md"), "old\n");

  const r = syncCodexPrompts({ srcDir: src, promptsDir: dest, benchRunnerPath: "/abs/bench/scripts/bench-runner.mjs" });
  assert.deepEqual(r.copied, ["bench-hunt.md"]);
  assert.deepEqual(r.backedUp, ["bench-hunt.md"]);
  const rendered = fs.readFileSync(path.join(dest, "bench-hunt.md"), "utf8");
  assert.match(rendered, /\/abs\/bench\/scripts\/bench-runner\.mjs/);
  assert.doesNotMatch(rendered, /\{\{BENCH_RUNNER\}\}/);
  assert.ok(fs.existsSync(path.join(dest, "bench-hunt.md.pre-peerbench.bak")));
});

test("removeClaudeSettingsPeerBenchHooks removes old settings hooks and preserves unrelated hooks", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-clean-"));
  const settingsPath = path.join(configDir, "settings.json");
  const hooksDir = path.join(configDir, "hooks");
  const managed = (name) => `node "${path.join(hooksDir, name)}"`;
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [
          { type: "command", command: managed("stop-review.mjs") },
          { type: "command", command: managed("deep-review-runner.mjs") },
          { type: "command", command: 'node "/other/plugin/stop-review.mjs"', owner: "other" },
          { type: "command", command: 'node "/x/codex-multirepo-gate.mjs"', timeout: 17 },
          { type: "command", command: 'node "/x/unrelated-stop.mjs"' }
        ] }
      ],
      SessionStart: [{ hooks: [
        { type: "command", command: managed("native-session-start.mjs") },
        { type: "command", command: 'node "/x/codex-stop-gate-autoenable.mjs"', marker: "preserve" }
      ] }],
      PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: managed("plan-file-review.mjs") }] }],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: managed("pre-push-review.mjs") }] },
        { matcher: "Bash", hooks: [{ type: "command", command: managed("pre-merge-review.mjs") }] },
        { matcher: "ExitPlanMode", hooks: [{ type: "command", command: managed("plan-review.mjs") }] },
        { matcher: "Other", hooks: [{ type: "command", command: 'node "/x/other.mjs"' }] }
      ]
    }
  }, null, 2));

  const result = removeClaudeSettingsPeerBenchHooks({ settingsPath });
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = JSON.stringify(saved.hooks);
  assert.equal(result.pluginManaged, true);
  assert.equal(result.removedEntries, 7);
  assert.doesNotMatch(commands, new RegExp(path.join(hooksDir, "stop-review.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(commands, /pre-push-review\.mjs/);
  assert.doesNotMatch(commands, /plan-review|plan-file-review|pre-merge-review|deep-review-runner|native-session-start/);
  assert.match(commands, /\/other\/plugin\/stop-review\.mjs/, "same-basename foreign hook is preserved");
  assert.match(commands, /codex-multirepo-gate\.mjs/);
  assert.match(commands, /codex-stop-gate-autoenable\.mjs/);
  assert.match(commands, /unrelated-stop\.mjs/);
  assert.match(commands, /other\.mjs/);
});

test("removeCodexSettingsPeerBenchHooks removes only the peerBench Codex wrapper", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-clean-"));
  const hooksPath = path.join(configDir, "hooks.json");
  const hooksDir = path.join(configDir, "hooks");
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [
          { type: "command", command: `node "${path.join(hooksDir, "codex-stop-review.mjs")}"` },
          { type: "command", command: 'node "/other/plugin/codex-stop-review.mjs"' },
          { type: "command", command: 'node "/x/unrelated-stop.mjs"' }
        ] }
      ],
      SessionStart: [{ hooks: [{ type: "command", command: `node "${path.join(hooksDir, "native-session-start.mjs")}"` }] }]
    }
  }, null, 2));

  const result = removeCodexSettingsPeerBenchHooks({ hooksPath });
  const saved = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const commands = JSON.stringify(saved.hooks);
  assert.equal(result.pluginManaged, true);
  assert.equal(result.removedEntries, 2);
  assert.match(commands, /\/other\/plugin\/codex-stop-review\.mjs/);
  assert.doesNotMatch(commands, new RegExp(path.join(hooksDir, "codex-stop-review.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(commands, /native-session-start\.mjs/);
  assert.match(commands, /unrelated-stop\.mjs/);
});

test("plugin root discovery can select the checkout's exact Codex cache version", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-roots-"));
  const claudeRoot = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "0.3.0");
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(home, ".claude", "plugins", "installed_plugins.json")), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    plugins: { "bench@aiwithrai": [{ scope: "user", installPath: claudeRoot }] }
  }));

  const oldCodexRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.3.1");
  const newCodexRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.4.0");
  fs.mkdirSync(path.join(oldCodexRoot, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(newCodexRoot, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(oldCodexRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "0.3.1" }));
  fs.writeFileSync(path.join(newCodexRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "0.4.0" }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(oldCodexRoot, future, future);

  assert.equal(latestClaudeBenchPluginRoot({ home }), claudeRoot);
  assert.equal(latestCodexBenchPluginRoot({ home, expectedVersion: "0.4.0" }), newCodexRoot);
});

test("deployPluginRuntime refreshes hook/runtime files in an installed plugin cache", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-src-"));
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-dest-"));
  writeVersionFiles(repo);
  writeVersionFiles(pluginRoot);
  fs.mkdirSync(path.join(repo, "global-hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "global-hooks", "stop-review.mjs"), "new stop\n");
  fs.writeFileSync(path.join(repo, "global-hooks", "statusline-segment.mjs"), "stale source\n");
  fs.writeFileSync(path.join(repo, "scripts", "bench-runner.mjs"), "new runner\n");
  fs.writeFileSync(path.join(repo, "hooks", "hooks.json"), "{\"hooks\":{}}\n");
  fs.writeFileSync(path.join(repo, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "bench", version: "0.4.0" }));
  fs.mkdirSync(path.join(pluginRoot, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "old stop\n");
  fs.writeFileSync(path.join(pluginRoot, "global-hooks", "deep-review-runner.mjs"), "retired\n");

  const result = deployPluginRuntime({ repoRoot: repo, pluginRoot });
  assert.ok(result.copied.includes("global-hooks/"));
  assert.ok(result.copied.includes("scripts/"));
  assert.equal(fs.readFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "utf8"), "new stop\n");
  assert.equal(fs.readFileSync(path.join(pluginRoot, "scripts", "bench-runner.mjs"), "utf8"), "new runner\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")), { name: "bench", version: "0.4.0" });
  assert.equal(fs.existsSync(path.join(pluginRoot, "global-hooks", "deep-review-runner.mjs")), false, "staged directory replacement prunes retired runtime files");
  assert.equal(fs.existsSync(path.join(pluginRoot, "global-hooks", "statusline-segment.mjs")), false, "retired statusline runtime is not copied from a stale checkout source");
});

test("deployPluginRuntime refuses mismatched cache versions before copying", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-version-src-"));
  const cacheParent = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-version-cache-"));
  const pluginRoot = path.join(cacheParent, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.3.1");
  writeVersionFiles(repo, "0.4.0");
  writeVersionFiles(pluginRoot, "0.3.1");
  fs.mkdirSync(path.join(repo, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "global-hooks", "stop-review.mjs"), "new\n");
  fs.mkdirSync(path.join(pluginRoot, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "old\n");

  assert.throws(
    () => deployPluginRuntime({ repoRoot: repo, pluginRoot, platform: "codex" }),
    /cache version mismatch[\s\S]*plugin manager/i
  );
  assert.equal(fs.readFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "utf8"), "old\n");
  assert.throws(() => assertPluginCacheVersionMatch({ repoRoot: repo, pluginRoot, platform: "codex" }), /0\.4\.0/);
});

test("legacy deploy entrypoint delegates to transactional install even from a path with spaces", () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "deploy-global-hooks.mjs");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench deploy symlink parent "));
  const linkedScript = path.join(parent, "legacy deploy entrypoint.mjs");
  fs.symlinkSync(script, linkedScript);
  for (const entrypoint of [script, linkedScript]) {
    const run = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage: node scripts\/install\.mjs/);
  }
});

test("compareLocalWithOrigin reports same, dirty, and differing states", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "origin-"));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "local-"));
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(remote, ["init", "-q", "--bare"]);
  git(local, ["init", "-q", "-b", "main"]);
  git(local, ["config", "user.email", "t@t.t"]);
  git(local, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(local, "a.txt"), "one\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-qm", "one"]);
  git(local, ["remote", "add", "origin", remote]);
  git(local, ["push", "-q", "-u", "origin", "main"]);

  const same = compareLocalWithOrigin({ cwd: local });
  assert.equal(same.ok, true);
  assert.equal(same.status, "same-as-origin");
  assert.equal(same.dirty, 0);

  fs.writeFileSync(path.join(local, "dirty.txt"), "dirty\n");
  const dirty = compareLocalWithOrigin({ cwd: local });
  assert.equal(dirty.status, "same-as-origin-with-local-changes");
  assert.equal(dirty.dirty, 1);

  git(local, ["add", "-A"]);
  git(local, ["commit", "-qm", "local change"]);
  const differs = compareLocalWithOrigin({ cwd: local });
  assert.equal(differs.ok, true);
  assert.equal(differs.status, "differs-from-origin");
  assert.notEqual(differs.localHead, differs.remoteHead);
});

test("syncSettings removes stale automatic hooks and registers only an absolute Stop hook", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  fs.writeFileSync(path.join(hooks, "codex-plan-review.mjs"), "// old\n");
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `node "${path.join(hooks, "native-session-start.mjs")}"` }] }],
    PreToolUse: [
      { matcher: "ExitPlanMode", hooks: [{ type: "command", command: "node ~/.claude/hooks/codex-plan-review.mjs" }] },
      { matcher: "Bash", hooks: [
        { type: "command", command: "node ~/.claude/hooks/pre-push-review.mjs" },
        { type: "command", command: "node ~/.claude/hooks/pre-merge-review.mjs" },
        { type: "command", command: "node ~/.claude/hooks/some-unrelated.mjs" }
      ] }
    ],
    PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "node ~/.claude/hooks/plan-file-review.mjs" }] }],
    Stop: [{ hooks: [
      { type: "command", command: "node ~/.claude/hooks/deep-review-runner.mjs" },
      { type: "command", command: "node ~/.claude/hooks/stop-review.mjs" },
      { type: "command", command: "node ~/.claude/hooks/unrelated-stop.mjs" }
    ] }]
  } }, null, 2));
  const r = syncSettings({ hooksDir: hooks, settingsPath });
  assert.ok(r.removedFiles.includes("codex-plan-review.mjs"));
  assert.equal(fs.existsSync(path.join(hooks, "codex-plan-review.mjs")), false);
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const serialized = JSON.stringify(s.hooks);
  for (const stale of [
    "native-session-start.mjs", "codex-plan-review.mjs", "plan-review.mjs",
    "plan-file-review.mjs", "pre-push-review.mjs", "pre-merge-review.mjs",
    "deep-review-runner.mjs"
  ]) assert.ok(!serialized.includes(stale), `${stale} must be removed`);
  assert.match(serialized, /some-unrelated\.mjs/);
  assert.match(serialized, /unrelated-stop\.mjs/);

  assert.ok(Array.isArray(s.hooks.Stop), "Stop hooks array must exist");
  const stopHook = s.hooks.Stop.flatMap((b) => b.hooks || []).find((h) => h.command.includes("stop-review.mjs"));
  assert.ok(stopHook, "stop-review must be registered in Stop hooks");
  assert.equal(stopHook.asyncRewake, undefined, "lightweight Stop review does not asynchronously re-wake");
  assert.equal(stopHook.rewakeMessage, undefined);
  assert.equal(stopHook.rewakeSummary, undefined);
  assert.equal(stopHook.timeout, 20, "Stop review has a 20-second outer cap");
  assert.ok(stopHook.statusMessage);
  assert.ok(stopHook.command.includes(path.join(hooks, "stop-review.mjs")) && !stopHook.command.includes("~"));
});

test("syncSettings is idempotent and does not recreate removed automatic hooks", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-idem-"));
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, "{}");
  syncSettings({ hooksDir: hooks, settingsPath });
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  const countStop = s.hooks.Stop.flatMap((b) => b.hooks || []).filter((h) => h.command.includes("stop-review.mjs")).length;
  assert.equal(countStop, 1, "stop-review must appear exactly once after two syncSettings calls");
  assert.doesNotMatch(JSON.stringify(s.hooks), /plan-review|plan-file-review|pre-push-review|pre-merge-review|deep-review-runner|native-session-start/);
});

test("syncSettings preserves the independent codex-plugin-cc gate byte-for-byte", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stoppreserve-"));
  const settingsPath = path.join(hooks, "settings.json");
  const independentStart = { type: "command", command: 'node "/home/user/.claude/hooks/codex-stop-gate-autoenable.mjs"', timeout: 7, marker: "start-state" };
  const independentStop = { type: "command", command: 'node "/home/user/.claude/hooks/codex-multirepo-gate.mjs"', timeout: 31, marker: "stop-state" };
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [independentStart] }],
      Stop: [{ hooks: [
        independentStop,
        { type: "command", command: 'node "/home/user/.claude/hooks/unrelated-stop.mjs"' }
      ] }]
    }
  }, null, 2));
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const allStop = s.hooks.Stop.flatMap((b) => b.hooks || []);
  const allSessionStart = (s.hooks.SessionStart || []).flatMap((b) => b.hooks || []);
  assert.deepEqual(allStop.find((h) => h.command.includes("codex-multirepo-gate.mjs")), independentStop);
  assert.deepEqual(allSessionStart.find((h) => h.command.includes("codex-stop-gate-autoenable.mjs")), independentStart);
  const allStopCmds = allStop.map((h) => h.command);
  assert.ok(allStopCmds.some((c) => c.includes("unrelated-stop.mjs")), "unrelated Stop hook must be preserved");
  assert.ok(allStopCmds.some((c) => c.includes("stop-review.mjs")), "stop-review must also be registered");
});

test("syncSettings: stop-review lands in a MATCHER-LESS Stop block even when a matcher-scoped Stop block comes first (D1); idempotent", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-d1-"));
  const settingsPath = path.join(hooks, "settings.json");
  // Pre-seed a matcher-SCOPED Stop block FIRST. The old code's list.find(b => Array.isArray(b.hooks))
  // returns this block and buries stop-review in it, so it only fires for SomeTool's Stop events.
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        { matcher: "SomeTool", hooks: [{ type: "command", command: 'node "/x/.claude/hooks/some-scoped-stop.mjs"' }] }
      ]
    }
  }, null, 2));
  syncSettings({ hooksDir: hooks, settingsPath });
  let s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  const scopedBlock = s.hooks.Stop.find((b) => b.matcher === "SomeTool");
  const matcherlessBlock = s.hooks.Stop.find((b) => !b.matcher && Array.isArray(b.hooks));
  // stop-review MUST be in the matcher-less block, NOT in the SomeTool-scoped block.
  assert.ok(matcherlessBlock, "a matcher-less Stop block must exist");
  assert.ok(
    matcherlessBlock.hooks.some((h) => h.command.includes("stop-review.mjs")),
    "stop-review must be registered in the matcher-less Stop block"
  );
  assert.ok(
    !scopedBlock.hooks.some((h) => h.command.includes("stop-review.mjs")),
    "stop-review must NOT be buried in the matcher-scoped (SomeTool) block"
  );
  // the scoped block's own hook is preserved
  assert.ok(scopedBlock.hooks.some((h) => h.command.includes("some-scoped-stop.mjs")), "scoped Stop hook preserved");

  // Idempotent on a second sync: still exactly one stop-review, still matcher-less.
  syncSettings({ hooksDir: hooks, settingsPath });
  s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const allStop = s.hooks.Stop.flatMap((b) => b.hooks || []);
  assert.equal(allStop.filter((h) => h.command.includes("stop-review.mjs")).length, 1, "stop-review appears exactly once after re-sync");
  const stopOwner = s.hooks.Stop.find((b) => (b.hooks || []).some((h) => h.command.includes("stop-review.mjs")));
  assert.ok(!stopOwner.matcher, "stop-review still in a matcher-less block after re-sync");
});

test("syncSettings de-dupes Stop and removes pre-push entries across path forms", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-dedup-"));
  const settingsPath = path.join(hooks, "settings.json");
  // Real-world bug: an existing $HOME-form entry + a duplicate absolute-form entry for the same hook.
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    Stop: [
      { hooks: [
        { type: "command", command: 'node "/x/.claude/hooks/codex-multirepo-gate.mjs"' },
        { type: "command", command: 'node "$HOME/.claude/hooks/stop-review.mjs"' }
      ] },
      { hooks: [{ type: "command", command: 'node "/abs/.claude/hooks/stop-review.mjs"' }] }
    ],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: 'node "$HOME/.claude/hooks/pre-push-review.mjs"' }] },
      { matcher: "Bash", hooks: [{ type: "command", command: 'node "/abs/.claude/hooks/pre-push-review.mjs"' }] }
    ]
  } }, null, 2));
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const stop = s.hooks.Stop.flatMap((b) => b.hooks || []);
  const push = s.hooks.PreToolUse.flatMap((b) => b.hooks || []);
  assert.equal(stop.filter((h) => h.command.includes("stop-review.mjs")).length, 1, "stop-review collapses to exactly one");
  assert.equal(push.filter((h) => h.command.includes("pre-push-review.mjs")).length, 0, "settings pre-push hooks are removed");
  assert.ok(stop.some((h) => h.command.includes("codex-multirepo-gate.mjs")), "independent Codex stop gate preserved");
  const stopCmd = stop.find((h) => h.command.includes("stop-review.mjs")).command;
  assert.ok(stopCmd.includes(path.join(hooks, "stop-review.mjs")) && !stopCmd.includes("$HOME"), "canonical entry uses the absolute deploy path");
});
