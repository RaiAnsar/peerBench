import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const skillPath = path.join(process.cwd(), "skills", "bench", "SKILL.md");

test("the shared Codex bench skill routes all subcommands instead of hardcoding review", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(skill, /<subcommand> \[arguments\]/);
  assert.match(skill, /setup/);
  assert.match(skill, /status/);
  assert.match(skill, /hunt/);
  assert.match(skill, /reviewers/);
  assert.match(skill, /health/);
  assert.doesNotMatch(skill, /review --json "\$ARGUMENTS"/);
});
