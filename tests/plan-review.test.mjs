import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPrompt } from "../global-hooks/plan-review.mjs";
test("plan prompt is content-only (no repo-read claim)", () => {
  const { system, user } = buildPrompt("PLAN BODY");
  assert.doesNotMatch(system, /read access|verify.*against.*code|explore the/i);
  assert.match(system, /ALLOW:|BLOCK:/);
  assert.match(user, /PLAN BODY/);
});

// F: the plan gate's permissionDecisionReason leads with the verdict badge.
// Driven via subprocess: a single configured reviewer (kimi) with NO api key
// errors → fail-open ALLOW, whose reason leads with the badge `[Kimi!]`.
test("F: plan-review fail-open reason leads with the badge", () => {
  const HOOK = fileURLToPath(new URL("../global-hooks/plan-review.mjs", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-badge-root-"));
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ reviewers: ["kimi"] }));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-badge-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: ws });

  const env = { ...process.env, BENCH_ROOT: root, CLAUDE_PROJECT_DIR: ws };
  delete env.KIMI_API_KEY; delete env.MIMO_API_KEY; delete env.GLM_API_KEY;

  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env,
    input: JSON.stringify({ cwd: ws, tool_input: { plan: "do a thing" } })
  });

  const lines = result.stdout.split("\n").filter((l) => l.trim());
  const parsed = JSON.parse(lines[0]);
  const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(reason, /\[Kimi!\]/, `reason should lead with the badge; got: ${reason}`);
});
