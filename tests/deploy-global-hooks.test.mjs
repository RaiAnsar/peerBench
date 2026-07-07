import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { deploy, snapshot, snapshotCodex, syncSettings, syncCodexHooks, syncCodexPrompts, migrateDataDir, syncStatuslineSessionArg, compareLocalWithOrigin, removeClaudeSettingsPeerBenchHooks, removeCodexSettingsPeerBenchHooks, deployPluginRuntime, latestClaudeBenchPluginRoot, latestCodexBenchPluginRoot } from "../scripts/deploy-global-hooks.mjs";

test("migrateDataDir: clean legacy → rename", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.mkdirSync(path.join(base, "grok-companion-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["kimi"]}');
  const r = migrateDataDir({ base });
  assert.equal(r.migrated, true);
  assert.ok(fs.existsSync(path.join(base, "bench-shared", "companion.json")), "data moved to bench-shared");
  assert.equal(fs.existsSync(path.join(base, "grok-companion-shared")), false, "old dir removed");
});
test("migrateDataDir: BROKEN-DEPLOY state (empty bench-shared pre-created) → merges real data + recovers", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-broken-"));
  // real data in legacy:
  fs.mkdirSync(path.join(base, "grok-companion-shared", "state", "ws-x", "traces"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["kimi","glm"]}');
  fs.writeFileSync(path.join(base, "grok-companion-shared", "state", "ws-x", "traces", "t.json"), "{}");
  // empty/incomplete bench-shared pre-created by a prior broken deploy (no companion.json):
  fs.mkdirSync(path.join(base, "bench-shared", "backup-x"), { recursive: true });
  const r = migrateDataDir({ base });
  assert.equal(r.migrated, true); assert.equal(r.merged, true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(base, "bench-shared", "companion.json"), "utf8")).reviewers.includes("glm"), "real config recovered");
  assert.ok(fs.existsSync(path.join(base, "bench-shared", "state", "ws-x", "traces", "t.json")), "traces recovered");
  assert.equal(fs.existsSync(path.join(base, "grok-companion-shared")), false, "legacy removed after merge");
});
test("migrateDataDir: already-migrated bench-shared is NOT clobbered; fresh install no-ops", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mig-done-"));
  fs.mkdirSync(path.join(base, "bench-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "bench-shared", "companion.json"), '{"reviewers":["mimo"]}');
  fs.mkdirSync(path.join(base, "grok-companion-shared"), { recursive: true });
  fs.writeFileSync(path.join(base, "grok-companion-shared", "companion.json"), '{"reviewers":["STALE"]}');
  assert.equal(migrateDataDir({ base }).migrated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, "bench-shared", "companion.json"), "utf8")).reviewers[0], "mimo", "current config not clobbered");
  assert.equal(migrateDataDir({ base: fs.mkdtempSync(path.join(os.tmpdir(), "fresh-")) }).migrated, false);
});

test("deploy copies modules flat and backs up a differing existing file", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-")), dest = fs.mkdtempSync(path.join(os.tmpdir(), "dst-"));
  fs.writeFileSync(path.join(src, "panel-lib.mjs"), "export const v=2;\n");
  fs.writeFileSync(path.join(dest, "panel-lib.mjs"), "export const v=1;\n");
  const r = deploy({ src, dest });
  assert.ok(r.copied.includes("panel-lib.mjs"));
  assert.ok(r.backedUp.includes("panel-lib.mjs"));
  assert.ok(fs.existsSync(path.join(dest, "panel-lib.mjs.pre-panel.bak")));
  assert.equal(fs.readFileSync(path.join(dest, "panel-lib.mjs"), "utf8"), "export const v=2;\n");
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

test("syncStatuslineSessionArg passes Claude session_id to peerBench statusline segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slcmd-"));
  const statuslinePath = path.join(dir, "statusline-command.sh");
  fs.writeFileSync(statuslinePath, [
    "#!/bin/bash",
    "input=$(cat)",
    "dir=$(echo \"$input\" | jq -r '.workspace.current_dir // .cwd // empty')",
    "gate_dir=\"$dir\"",
    "# comment mentioning statusline-segment.mjs must not be patched",
    "gc_gate=$(node ~/.claude/hooks/statusline-segment.mjs \"$gate_dir\" 2>/dev/null)",
    "echo \"$gc_gate\"",
    ""
  ].join("\n"));

  const first = syncStatuslineSessionArg({ statuslinePath });
  assert.equal(first.updated, true);
  const once = fs.readFileSync(statuslinePath, "utf8");
  assert.match(once, /bench_session_id=.*session_id.*workspace\.session_id/, "wrapper extracts the per-invocation session id");
  assert.match(once, /statusline-segment\.mjs "\$gate_dir" "\$bench_session_id"/, "segment receives session id as argv3");

  const second = syncStatuslineSessionArg({ statuslinePath });
  assert.equal(second.updated, false);
  assert.equal(second.reason, "already session-aware");
  const twice = fs.readFileSync(statuslinePath, "utf8");
  assert.equal((twice.match(/bench_session_id=/g) || []).length, 1, "idempotent: extraction line is not duplicated");
  assert.equal((twice.match(/\$bench_session_id/g) || []).length, 1, "idempotent: one argv use");
});

test("syncStatuslineSessionArg no-ops when there is no peerBench segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slcmd-none-"));
  const statuslinePath = path.join(dir, "statusline-command.sh");
  fs.writeFileSync(statuslinePath, "#!/bin/bash\necho ok\n");
  const before = fs.readFileSync(statuslinePath, "utf8");
  const result = syncStatuslineSessionArg({ statuslinePath });
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
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/unrelated-stop.mjs"' }] }]
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
  assert.equal(peer.timeout, 900);
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
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-clean-")), "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [
          { type: "command", command: 'node "/x/stop-review.mjs"' },
          { type: "command", command: 'node "/x/unrelated-stop.mjs"' }
        ] }
      ],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: 'node "/x/pre-push-review.mjs"' }] },
        { matcher: "Other", hooks: [{ type: "command", command: 'node "/x/other.mjs"' }] }
      ]
    }
  }, null, 2));

  const result = removeClaudeSettingsPeerBenchHooks({ settingsPath });
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = JSON.stringify(saved.hooks);
  assert.equal(result.pluginManaged, true);
  assert.equal(result.removedEntries, 2);
  assert.doesNotMatch(commands, /stop-review\.mjs/);
  assert.doesNotMatch(commands, /pre-push-review\.mjs/);
  assert.match(commands, /unrelated-stop\.mjs/);
  assert.match(commands, /other\.mjs/);
});

test("removeCodexSettingsPeerBenchHooks removes only the peerBench Codex wrapper", () => {
  const hooksPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-clean-")), "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [
          { type: "command", command: 'node "/x/codex-stop-review.mjs"' },
          { type: "command", command: 'node "/x/unrelated-stop.mjs"' }
        ] }
      ]
    }
  }, null, 2));

  const result = removeCodexSettingsPeerBenchHooks({ hooksPath });
  const saved = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const commands = JSON.stringify(saved.hooks);
  assert.equal(result.pluginManaged, true);
  assert.equal(result.removedEntries, 1);
  assert.doesNotMatch(commands, /codex-stop-review\.mjs/);
  assert.match(commands, /unrelated-stop\.mjs/);
});

test("plugin root discovery finds installed Claude and newest Codex bench plugin cache", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-roots-"));
  const claudeRoot = path.join(home, ".claude", "plugins", "cache", "aiwithrai", "bench", "0.3.0");
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(home, ".claude", "plugins", "installed_plugins.json")), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    plugins: { "bench@aiwithrai": [{ scope: "user", installPath: claudeRoot }] }
  }));

  const oldCodexRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.2.0");
  const newCodexRoot = path.join(home, ".codex", "plugins", "cache", "aiwithrai", "bench", "0.3.0");
  fs.mkdirSync(path.join(oldCodexRoot, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(newCodexRoot, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(oldCodexRoot, ".codex-plugin", "plugin.json"), "{}");
  fs.writeFileSync(path.join(newCodexRoot, ".codex-plugin", "plugin.json"), "{}");
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(newCodexRoot, future, future);

  assert.equal(latestClaudeBenchPluginRoot({ home }), claudeRoot);
  assert.equal(latestCodexBenchPluginRoot({ home }), newCodexRoot);
});

test("deployPluginRuntime refreshes hook/runtime files in an installed plugin cache", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-src-"));
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-plugin-dest-"));
  fs.mkdirSync(path.join(repo, "global-hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "global-hooks", "stop-review.mjs"), "new stop\n");
  fs.writeFileSync(path.join(repo, "scripts", "bench-runner.mjs"), "new runner\n");
  fs.writeFileSync(path.join(repo, "hooks", "hooks.json"), "{\"hooks\":{}}\n");
  fs.writeFileSync(path.join(repo, ".codex-plugin", "plugin.json"), "{\"name\":\"bench\"}\n");
  fs.mkdirSync(path.join(pluginRoot, "global-hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "old stop\n");

  const result = deployPluginRuntime({ repoRoot: repo, pluginRoot });
  assert.ok(result.copied.includes("global-hooks/"));
  assert.ok(result.copied.includes("scripts/"));
  assert.equal(fs.readFileSync(path.join(pluginRoot, "global-hooks", "stop-review.mjs"), "utf8"), "new stop\n");
  assert.equal(fs.readFileSync(path.join(pluginRoot, "scripts", "bench-runner.mjs"), "utf8"), "new runner\n");
  assert.equal(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"), "{\"name\":\"bench\"}\n");
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

test("syncSettings removes only matching legacy commands, drops empty entries, registers absolute plan-* paths, preserves unrelated hooks", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  fs.writeFileSync(path.join(hooks, "codex-plan-review.mjs"), "// old\n");
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    PreToolUse: [
      { matcher: "ExitPlanMode", hooks: [ { type: "command", command: "node ~/.claude/hooks/codex-plan-review.mjs" } ] },
      { matcher: "Bash", hooks: [ { type: "command", command: "node ~/.claude/hooks/some-unrelated.mjs" } ] }
    ]
  } }, null, 2));
  const r = syncSettings({ hooksDir: hooks, settingsPath });
  assert.ok(r.removedFiles.includes("codex-plan-review.mjs"));
  assert.equal(fs.existsSync(path.join(hooks, "codex-plan-review.mjs")), false);
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const pre = s.hooks.PreToolUse;
  // the codex-only entry was dropped (became empty); the unrelated Bash entry preserved; plan-review registered with absolute path
  assert.ok(pre.some((e) => e.matcher === "Bash"));
  assert.ok(pre.some((e) => e.hooks.some((h) => h.command.includes(path.join(hooks, "plan-review.mjs")) && !h.command.includes("~"))));
  assert.ok(!pre.some((e) => e.hooks.some((h) => h.command.includes("codex-plan-review.mjs"))));
  assert.ok(s.hooks.PostToolUse.some((e) => e.matcher === "Write|Edit" && e.hooks.some((h) => h.command.includes("plan-file-review.mjs"))));
});

test("syncSettings registers all four gates: plan-review(ExitPlanMode), pre-push-review(Bash), plan-file-review(Write|Edit), stop-review(Stop) with asyncRewake", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss4-"));
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, "{}");
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  // PreToolUse: ExitPlanMode → plan-review.mjs
  assert.ok(
    s.hooks.PreToolUse.some((e) => e.matcher === "ExitPlanMode" && e.hooks.some((h) => h.command.includes("plan-review.mjs"))),
    "plan-review must be registered under ExitPlanMode"
  );
  // PreToolUse: Bash → pre-push-review.mjs
  assert.ok(
    s.hooks.PreToolUse.some((e) => e.matcher === "Bash" && e.hooks.some((h) => h.command.includes("pre-push-review.mjs"))),
    "pre-push-review must be registered under Bash"
  );
  // PostToolUse: Write|Edit → plan-file-review.mjs
  assert.ok(
    s.hooks.PostToolUse.some((e) => e.matcher === "Write|Edit" && e.hooks.some((h) => h.command.includes("plan-file-review.mjs"))),
    "plan-file-review must be registered under Write|Edit"
  );
  // Stop: stop-review.mjs with asyncRewake:true
  assert.ok(Array.isArray(s.hooks.Stop), "Stop hooks array must exist");
  const stopHook = s.hooks.Stop.flatMap((b) => b.hooks || []).find((h) => h.command.includes("stop-review.mjs"));
  assert.ok(stopHook, "stop-review must be registered in Stop hooks");
  assert.equal(stopHook.asyncRewake, true, "stop-review must have asyncRewake:true");
  assert.ok(stopHook.rewakeMessage, "stop-review must have rewakeMessage");
  assert.ok(stopHook.rewakeSummary, "stop-review must have rewakeSummary");
  assert.ok(typeof stopHook.timeout === "number", "stop-review must have numeric timeout");
  assert.equal(stopHook.timeout, 900, "stop-review should not regress to the old 300s cap");

  // Quick wins (hooks-doc optimizations): statusMessage on every gate (visible spinner) + an
  // `if` narrowing pre-push to git commands (fails open, so compound pushes stay covered).
  const allEntries = [...s.hooks.PreToolUse, ...s.hooks.PostToolUse, ...s.hooks.Stop];
  const byFile = (name) => allEntries.flatMap((b) => b.hooks || []).find((h) => h.command.includes(name));
  for (const f of ["plan-review.mjs", "plan-file-review.mjs", "pre-push-review.mjs", "stop-review.mjs"]) {
    assert.ok(byFile(f)?.statusMessage, `${f} must carry a statusMessage (visible spinner)`);
  }
  assert.equal(byFile("pre-push-review.mjs").if, "Bash(git *)", "pre-push must narrow to git commands via `if`");
  assert.equal(byFile("pre-push-review.mjs").timeout, 1320, "pre-push full review needs room for the 20-minute investigate budget");
});

test("syncSettings is idempotent: running twice does not duplicate any gate", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-idem-"));
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, "{}");
  syncSettings({ hooksDir: hooks, settingsPath });
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  const countPlanReview = s.hooks.PreToolUse.filter(
    (e) => e.matcher === "ExitPlanMode" && e.hooks.some((h) => h.command.includes("plan-review.mjs"))
  ).length;
  const countPrePush = s.hooks.PreToolUse.filter(
    (e) => e.matcher === "Bash" && e.hooks.some((h) => h.command.includes("pre-push-review.mjs"))
  ).length;
  const countPlanFile = s.hooks.PostToolUse.filter(
    (e) => e.matcher === "Write|Edit" && e.hooks.some((h) => h.command.includes("plan-file-review.mjs"))
  ).length;
  const countStop = s.hooks.Stop.flatMap((b) => b.hooks || []).filter((h) => h.command.includes("stop-review.mjs")).length;

  assert.equal(countPlanReview, 1, "plan-review must appear exactly once after two syncSettings calls");
  assert.equal(countPrePush, 1, "pre-push-review must appear exactly once after two syncSettings calls");
  assert.equal(countPlanFile, 1, "plan-file-review must appear exactly once after two syncSettings calls");
  assert.equal(countStop, 1, "stop-review must appear exactly once after two syncSettings calls");
});

test("syncSettings removes legacy Codex stop-gate hooks but preserves unrelated Stop hooks", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stoppreserve-"));
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "/home/user/.claude/hooks/codex-stop-gate-autoenable.mjs"' }] }],
      Stop: [{ hooks: [
        { type: "command", command: 'node "/home/user/.claude/hooks/codex-multirepo-gate.mjs"' },
        { type: "command", command: 'node "/home/user/.claude/hooks/unrelated-stop.mjs"' }
      ] }]
    }
  }, null, 2));
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const allStopCmds = s.hooks.Stop.flatMap((b) => b.hooks || []).map((h) => h.command);
  const allSessionStartCmds = (s.hooks.SessionStart || []).flatMap((b) => b.hooks || []).map((h) => h.command);
  assert.ok(!allStopCmds.some((c) => c.includes("codex-multirepo-gate.mjs")), "legacy Codex multi-repo stop gate must be removed");
  assert.ok(!allSessionStartCmds.some((c) => c.includes("codex-stop-gate-autoenable.mjs")), "legacy Codex auto-enable hook must be removed");
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

test("syncSettings DE-DUPES pre-existing stop/pre-push entries across path forms ($HOME vs absolute)", () => {
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
  assert.equal(push.filter((h) => h.command.includes("pre-push-review.mjs")).length, 1, "pre-push-review collapses to exactly one");
  assert.ok(!stop.some((h) => h.command.includes("codex-multirepo-gate.mjs")), "legacy Codex stop gate removed");
  const stopCmd = stop.find((h) => h.command.includes("stop-review.mjs")).command;
  assert.ok(stopCmd.includes(path.join(hooks, "stop-review.mjs")) && !stopCmd.includes("$HOME"), "canonical entry uses the absolute deploy path");
});
