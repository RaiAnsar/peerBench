import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { deploy, snapshot, syncSettings, migrateDataDir } from "../scripts/deploy-global-hooks.mjs";

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

test("syncSettings does not remove a pre-existing unrelated Stop hook", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stoppreserve-"));
  const settingsPath = path.join(hooks, "settings.json");
  // Seed with an existing Stop hook (e.g. a codex multi-repo gate)
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/home/user/.claude/hooks/codex-multirepo-gate.mjs"' }] }]
    }
  }, null, 2));
  syncSettings({ hooksDir: hooks, settingsPath });
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  // Unrelated stop hook must still be present
  const allStopCmds = s.hooks.Stop.flatMap((b) => b.hooks || []).map((h) => h.command);
  assert.ok(allStopCmds.some((c) => c.includes("codex-multirepo-gate.mjs")), "unrelated Stop hook must be preserved");
  assert.ok(allStopCmds.some((c) => c.includes("stop-review.mjs")), "stop-review must also be registered");
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
  assert.ok(stop.some((h) => h.command.includes("codex-multirepo-gate.mjs")), "unrelated Stop hook preserved");
  const stopCmd = stop.find((h) => h.command.includes("stop-review.mjs")).command;
  assert.ok(stopCmd.includes(path.join(hooks, "stop-review.mjs")) && !stopCmd.includes("$HOME"), "canonical entry uses the absolute deploy path");
});
