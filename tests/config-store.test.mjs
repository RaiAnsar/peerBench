import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, workspaceStateDir, sharedRoot, KNOWN_REVIEWERS, setReviewers } from "../global-hooks/config-store.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
test("reviewers override allows codex/grok selection", () => {
  const cfg = resolveConfig({ env: {}, reviewers: ["codex", "grok"] });
  assert.deepEqual(cfg.reviewers, ["codex", "grok"]);
});
test("unknown reviewer names are filtered out", () => {
  const cfg = resolveConfig({ env: {}, reviewers: ["kimi", "bogus"] });
  assert.deepEqual(cfg.reviewers, ["kimi"]);
});
test("setReviewers writes companion.json and filters unknowns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-"));
  const out = setReviewers(["codex", "grok", "bogus"], { root });
  assert.deepEqual(out, ["codex", "grok"]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8"));
  assert.deepEqual(saved.reviewers, ["codex", "grok"]);
});
test("setReviewers throws on all-invalid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj2-"));
  assert.throws(() => setReviewers(["bogus"], { root }));
});
