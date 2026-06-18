import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { rollback } from "../scripts/rollback.mjs";

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
