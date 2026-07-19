import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { rollback } from "../scripts/rollback.mjs";
import { capturePathState, snapshot, writeRollbackMetadata } from "../scripts/deploy-global-hooks.mjs";

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

test("metadata rollback preserves post-install hook edits and reports a conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rollback-conflict-"));
  const hooksDir = path.join(root, "hooks");
  const backupDir = path.join(root, "backup");
  const settingsPath = path.join(root, "settings.json");
  fs.mkdirSync(hooksDir);
  fs.writeFileSync(settingsPath, "{}\n");
  const hookPath = path.join(hooksDir, "stop-review.mjs");
  fs.writeFileSync(hookPath, "before\n");
  const snap = snapshot({ hooksDir, settingsPath, backupDir, fileNames: ["stop-review.mjs"] });
  fs.writeFileSync(hookPath, "installed\n");
  const installedState = capturePathState(hookPath);
  writeRollbackMetadata({
    backupDir,
    metadata: {
      claude: {
        hooksDir,
        settingsPath,
        deployedNames: ["stop-review.mjs"],
        restoreNames: ["stop-review.mjs"],
        fileSnapshots: snap.entries,
        hookAfterStates: [{ name: "stop-review.mjs", state: installedState }],
        settingsSnapshot: snap.settingsEntry,
        settingsAfterState: capturePathState(settingsPath),
        settingsBackedUp: true,
        settingsMode: snap.settingsMode,
        statuslineUpdated: false,
        pluginMutationStarted: false,
        pluginRegistryFiles: []
      },
      codex: null
    }
  });
  fs.writeFileSync(hookPath, "later user replacement\n");

  const result = rollback({ backupDir });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /changed after install; preserving user changes/);
  assert.equal(fs.readFileSync(hookPath, "utf8"), "later user replacement\n");
});

test("rollback restores symlink identity and does not clobber a recreated retired hook", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-rollback-symlink-"));
  const hooksDir = path.join(root, "hooks");
  const backupDir = path.join(root, "backup");
  const settingsPath = path.join(root, "settings.json");
  fs.mkdirSync(hooksDir);
  fs.writeFileSync(settingsPath, "{}\n");
  const linkTarget = "../original-hook.mjs";
  fs.symlinkSync(linkTarget, path.join(hooksDir, "stop-review.mjs"));
  fs.writeFileSync(path.join(hooksDir, "plan-review.mjs"), "retired predecessor\n");
  const snap = snapshot({
    hooksDir,
    settingsPath,
    backupDir,
    fileNames: ["stop-review.mjs", "plan-review.mjs"]
  });
  fs.rmSync(path.join(hooksDir, "stop-review.mjs"));
  fs.writeFileSync(path.join(hooksDir, "stop-review.mjs"), "installed stop\n");
  fs.rmSync(path.join(hooksDir, "plan-review.mjs"));
  const afterStates = [
    { name: "stop-review.mjs", state: capturePathState(path.join(hooksDir, "stop-review.mjs")) },
    { name: "plan-review.mjs", state: { exists: false } }
  ];
  writeRollbackMetadata({
    backupDir,
    metadata: {
      claude: {
        hooksDir,
        settingsPath,
        deployedNames: ["stop-review.mjs", "plan-review.mjs"],
        restoreNames: ["stop-review.mjs", "plan-review.mjs"],
        fileSnapshots: snap.entries,
        hookAfterStates: afterStates,
        settingsSnapshot: snap.settingsEntry,
        settingsAfterState: capturePathState(settingsPath),
        settingsBackedUp: true,
        settingsMode: snap.settingsMode,
        statuslineUpdated: false,
        pluginMutationStarted: false,
        pluginRegistryFiles: []
      },
      codex: null
    }
  });
  fs.writeFileSync(path.join(hooksDir, "plan-review.mjs"), "new user hook\n");

  const result = rollback({ backupDir });
  assert.equal(fs.lstatSync(path.join(hooksDir, "stop-review.mjs")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(hooksDir, "stop-review.mjs")), linkTarget);
  assert.equal(result.ok, false, "the recreated retired hook is a reported conflict");
  assert.equal(fs.readFileSync(path.join(hooksDir, "plan-review.mjs"), "utf8"), "new user hook\n");
});
