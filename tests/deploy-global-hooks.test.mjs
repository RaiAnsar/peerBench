import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { deploy, snapshot, syncSettings } from "../scripts/deploy-global-hooks.mjs";

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
