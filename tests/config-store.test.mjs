import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, workspaceStateDir, sharedRoot } from "../global-hooks/config-store.mjs";

test("env vars populate keys; CLAUDE_PLUGIN_DATA does not affect result", () => {
  const base = { MOONSHOT_API_KEY: "mk", MIMO_API_KEY: "xk" };
  const a = resolveConfig({ env: { ...base } });
  const b = resolveConfig({ env: { ...base, CLAUDE_PLUGIN_DATA: "/tmp/whatever" } });
  assert.equal(a.providers.kimi.apiKey, "mk");
  assert.equal(a.providers.kimi.model, "kimi-k2.7-code");
  assert.equal(a.providers.mimo.apiKey, "xk");
  assert.deepEqual(a.reviewers, ["kimi", "mimo"]);
  assert.deepEqual(a, b);
});
test("workspaceStateDir lands under the env-independent shared root", () => {
  const dir = workspaceStateDir("/some/workspace");
  assert.ok(dir.startsWith(sharedRoot()));
  assert.ok(/\/state\/workspace-[0-9a-f]{16}$/.test(dir));
});
