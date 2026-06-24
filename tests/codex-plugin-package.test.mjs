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
  assert.match(commands, /\$\{PLUGIN_ROOT\}\/global-hooks\/codex-stop-review\.mjs/);
  assert.doesNotMatch(commands, /global-hooks\/stop-review\.mjs/);
  assert.doesNotMatch(commands, /global-hooks\/deep-review-runner\.mjs/);
});
