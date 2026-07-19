import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOAD_KEYS = path.join(import.meta.dirname, "..", "scripts", "load-keys.mjs");

test("load-keys writes configured provider temperatures without printing secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-root-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-src-"));
  const keys = path.join(dir, ".keys");
  fs.writeFileSync(keys, [
    "MIMO_API_KEY=secret-mimo-key",
    "MIMO_TEMPERATURE=0.2",
    ""
  ].join("\n"));
  const out = execFileSync(process.execPath, [LOAD_KEYS, keys], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: root }
  });
  assert.match(out, /key values redacted/);
  assert.doesNotMatch(out, /secret-mimo-key/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.providers), ["mimo"]);
  assert.equal(saved.providers.mimo.temperature, 0.2);
  assert.equal(saved.providers.mimo.apiKey, "secret-mimo-key");
});
