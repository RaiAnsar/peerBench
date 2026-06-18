import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../global-hooks/plan-review.mjs";
test("plan prompt is content-only (no repo-read claim)", () => {
  const { system, user } = buildPrompt("PLAN BODY");
  assert.doesNotMatch(system, /read access|verify.*against.*code|explore the/i);
  assert.match(system, /ALLOW:|BLOCK:/);
  assert.match(user, /PLAN BODY/);
});
