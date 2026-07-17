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
    "KIMI_API_KEY=k",
    "KIMI_TEMPERATURE=0.6",
    "GLM_API_KEY=g",
    "GLM_TEMPERATURE=0.2",
    ""
  ].join("\n"));
  const out = execFileSync(process.execPath, [LOAD_KEYS, keys], {
    encoding: "utf8",
    env: { ...process.env, BENCH_ROOT: root }
  });
  assert.match(out, /key values redacted/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8"));
  assert.equal(saved.providers.kimi.temperature, 0.6);
  assert.equal(saved.providers.glm.temperature, 0.2);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, "companion.json")).mode & 0o777, 0o600);
});

test("load-keys REPLACES managed fields (drops a removed override) but PRESERVES unmanaged companion fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-root-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-src-"));
  // Pre-existing companion.json: kimi has a stale managed field (temperature) AND unmanaged fields
  // (timeoutMs, concurrencyPerKey, a custom header) that .keys does not set.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "companion.json"), JSON.stringify({ providers: {
    kimi: { baseURL: "https://old/v1", model: "kimi-k2.6", apiKey: "old", temperature: 0.6,
            timeoutMs: 999000, concurrencyPerKey: 4, headers: { "X-Custom": "keep-me" } }
  } }));
  const keys = path.join(dir, ".keys");
  // New .keys: K3, no KIMI_TEMPERATURE (must be DROPPED, not kept at 0.6).
  fs.writeFileSync(keys, ["KIMI_API_KEY=newkey", "KIMI_MODEL=k3", ""].join("\n"));
  execFileSync(process.execPath, [LOAD_KEYS, keys], { encoding: "utf8", env: { ...process.env, BENCH_ROOT: root } });
  const kimi = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8")).providers.kimi;
  // Managed fields reflect the NEW .keys (stale temperature gone → resolveConfig will use the K3 default null).
  assert.equal(kimi.model, "k3");
  assert.equal(kimi.apiKey, "newkey");
  assert.equal("temperature" in kimi, false, "a dropped .keys override must NOT survive as a stale companion field");
  // Unmanaged fields PRESERVED across the reload (regression: full-object REPLACE wiped these).
  assert.equal(kimi.timeoutMs, 999000, "timeoutMs preserved");
  assert.equal(kimi.concurrencyPerKey, 4, "concurrencyPerKey preserved");
  assert.deepEqual(kimi.headers, { "X-Custom": "keep-me" }, "custom companion headers preserved");
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, "companion.json")).mode & 0o777, 0o600);
});

test("load-keys strips a provider dropped from .keys so its rotated-out key goes dead", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-root-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-keys-src-"));
  const keys = path.join(dir, ".keys");
  fs.writeFileSync(keys, ["KIMI_API_KEY=k1", "GLM_API_KEY=g1", "GLM_MODEL=glm-old", ""].join("\n"));
  execFileSync(process.execPath, [LOAD_KEYS, keys], { encoding: "utf8", env: { ...process.env, BENCH_ROOT: root } });
  // Give glm an unmanaged field that must survive the strip.
  const file = path.join(root, "companion.json");
  const seeded = JSON.parse(fs.readFileSync(file, "utf8"));
  seeded.providers.glm.timeoutMs = 123000;
  fs.writeFileSync(file, JSON.stringify(seeded));

  // GLM is dropped from .keys: its managed fields (apiKey/model/...) must NOT stay live.
  fs.writeFileSync(keys, ["KIMI_API_KEY=k2", ""].join("\n"));
  execFileSync(process.execPath, [LOAD_KEYS, keys], { encoding: "utf8", env: { ...process.env, BENCH_ROOT: root } });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.providers.kimi.apiKey, "k2");
  assert.equal("apiKey" in saved.providers.glm, false, "a dropped provider's apiKey must be stripped");
  assert.equal("model" in saved.providers.glm, false, "a dropped provider's model must be stripped");
  assert.equal(saved.providers.glm.timeoutMs, 123000, "unmanaged companion fields are preserved");
});
