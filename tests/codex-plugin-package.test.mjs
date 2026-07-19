import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

test("Codex marketplace entry resolves to a plugin with an explicit Codex hook file", () => {
  const marketplace = readJson(path.join(ROOT, ".agents", "plugins", "marketplace.json"));
  const bench = marketplace.plugins.find((plugin) => plugin.name === "bench");
  assert.ok(bench, "bench marketplace entry exists");
  assert.equal(bench.source.path, "./plugins/bench");

  const pluginRoot = path.resolve(ROOT, bench.source.path);
  const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "bench");
  assert.equal(manifest.hooks, "./hooks.json");

  const hooks = readJson(path.join(pluginRoot, "hooks.json"));
  const commands = JSON.stringify(hooks);
  assert.deepEqual(Object.keys(hooks.hooks), ["Stop"], "Codex plugin exposes only the Stop event");
  assert.match(commands, /\$\{PLUGIN_ROOT\}\/global-hooks\/codex-stop-review\.mjs/);
  assert.doesNotMatch(commands, /global-hooks\/stop-review\.mjs/);
  assert.doesNotMatch(commands, /global-hooks\/deep-review-runner\.mjs/);
  const stop = hooks.hooks.Stop.flatMap((block) => block.hooks || []);
  assert.equal(stop.length, 1);
  assert.equal(stop[0].timeout, 20);
  assert.equal(stop[0].asyncRewake, undefined);
  assert.equal(stop[0].rewakeMessage, undefined);
  assert.equal(stop[0].rewakeSummary, undefined);
});

test("Claude plugin exposes only the lightweight Stop hook", () => {
  const hooks = readJson(path.join(ROOT, "hooks", "hooks.json"));
  assert.deepEqual(Object.keys(hooks.hooks), ["Stop"]);
  const stop = hooks.hooks.Stop.flatMap((block) => block.hooks || []);
  assert.equal(stop.length, 1);
  assert.match(stop[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/global-hooks\/stop-review\.mjs/);
  assert.equal(stop[0].timeout, 20);
  assert.equal(stop[0].asyncRewake, undefined);
  assert.equal(stop[0].rewakeMessage, undefined);
  assert.equal(stop[0].rewakeSummary, undefined);
  assert.doesNotMatch(JSON.stringify(hooks), /plan-review|plan-file-review|pre-push-review|pre-merge-review|deep-review-runner|native-session-start/);
});

test("Codex skill routes the requested subcommand instead of hardcoding review", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "bench", "SKILL.md"), "utf8");
  assert.match(skill, /bench-runner\.mjs" <subcommand> \[arguments\]/);
  assert.doesNotMatch(skill, /bench-runner\.mjs" review --json "\$ARGUMENTS"/);
  assert.doesNotMatch(skill, /\b(?:Kimi|GLM|Qwen|MiniMax)\b/);
});

test("Codex prompts expose only Grok + MiMo and no retired self-review suppression", () => {
  const promptDir = path.join(ROOT, "codex-prompts");
  const prompts = fs.readdirSync(promptDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => fs.readFileSync(path.join(promptDir, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(prompts, /\b(?:Kimi|GLM|Qwen|MiniMax)\b/);
  assert.doesNotMatch(prompts, /BENCH_SUPPRESS_CODEX_REVIEWER/);
  assert.match(fs.readFileSync(path.join(promptDir, "bench-reviewers.md"), "utf8"), /\[grok\|mimo \.\.\.\]/);
});
