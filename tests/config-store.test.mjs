import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-config-"));
process.env.BENCH_ROOT = ROOT;

import {
  KNOWN_REVIEWERS,
  PROVIDER_NAMES,
  clearReviewerCooldowns,
  displayName,
  isBenchDisabled,
  normalizeSessionId,
  readReviewerCooldown,
  recordReviewerCooldown,
  resolveConfig,
  sessionKeyFromInput,
  setBenchDisabled,
  setReviewers,
  sharedRoot,
  workspaceStateDir
} from "../global-hooks/config-store.mjs";

test("the reviewer registry contains only Grok and MiMo", () => {
  assert.deepEqual(PROVIDER_NAMES, ["mimo"]);
  assert.deepEqual(KNOWN_REVIEWERS, ["grok", "mimo"]);
  assert.equal(displayName("grok"), "Grok");
  assert.equal(displayName("mimo"), "MiMo");
  assert.equal(displayName("unknown"), "unknown");
});

test("Grok and MiMo are the default panel", () => {
  const config = resolveConfig({ env: {} });
  assert.deepEqual(config.reviewers, ["grok", "mimo"]);
  assert.deepEqual(Object.keys(config.providers), ["mimo"]);
});

test("MiMo configuration comes from its environment variables", () => {
  const config = resolveConfig({
    env: {
      MIMO_API_KEY: "fake-mimo-key",
      MIMO_MODEL: "mimo-test",
      MIMO_BASE_URL: "https://mimo.invalid/v1",
      MIMO_THINKING: "enabled"
    }
  });
  assert.equal(config.providers.mimo.apiKey, "fake-mimo-key");
  assert.deepEqual(config.providers.mimo.apiKeys, ["fake-mimo-key"]);
  assert.equal(config.providers.mimo.model, "mimo-test");
  assert.equal(config.providers.mimo.baseURL, "https://mimo.invalid/v1");
  assert.equal(config.providers.mimo.thinking, "enabled");
  assert.equal(config.providers.mimo.timeoutMs, 45_000);
});

test("expired and unknown reviewers cannot be selected", () => {
  const config = resolveConfig({
    env: {},
    reviewers: ["kimi", "qwen", "glm", "minimax", "codex", "grok", "mimo", "bogus"]
  });
  assert.deepEqual(config.reviewers, ["grok", "mimo"]);
});

test("setReviewers persists only Grok and MiMo and de-duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-reviewers-"));
  const selected = setReviewers(["grok", "grok", "kimi", "mimo"], { root });
  assert.deepEqual(selected, ["grok", "mimo"]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8"));
  assert.deepEqual(saved.reviewers, ["grok", "mimo"]);
  assert.throws(() => setReviewers(["kimi", "glm"], { root }), /no valid reviewers/);
});

test("workspace state uses the shared root and canonicalizes symlinks", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bench-workspace-"));
  const real = path.join(parent, "real");
  const link = path.join(parent, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  assert.ok(workspaceStateDir(real).startsWith(sharedRoot()));
  assert.equal(workspaceStateDir(real), workspaceStateDir(link));
});

test("session ids are stable and ambient Claude/Codex ids are ignored", () => {
  const normalized = normalizeSessionId("chat-A");
  assert.match(normalized, /^session-[0-9a-f]{16}$/);
  assert.equal(normalizeSessionId(normalized), normalized);
  assert.equal(sessionKeyFromInput({ session_id: "chat-A" }, {}), normalized);
  assert.equal(sessionKeyFromInput({}, { BENCH_SESSION_ID: "chat-A" }), normalized);
  assert.equal(sessionKeyFromInput({}, { CLAUDE_SESSION_ID: "ambient", CODEX_COMPANION_SESSION_ID: "ambient" }), null);
});

test("global disable marker disables every workspace until removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-disable-"));
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ws-a-"));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ws-b-"));
  setBenchDisabled(wsA, true, { scope: "global", root });
  assert.equal(isBenchDisabled(wsA, { root }), true);
  assert.equal(isBenchDisabled(wsB, { root }), true);
  setBenchDisabled(wsA, false, { scope: "global", root });
  assert.equal(isBenchDisabled(wsA, { root }), false);
  assert.equal(isBenchDisabled(wsB, { root }), false);
});

test("cooldown state redacts exact and structured credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cooldown-"));
  const secret = "fake_exact_secret_123";
  const detail = [
    "HTTP 402",
    ["Bearer", "bearer-fake"].join(" "),
    `Authorization: ${["Basic", "dXNlcjpwYXNz"].join(" ")}`,
    ["https://", ["alice", "password"].join(String.fromCharCode(58)), "@example.invalid"].join(""),
    secret
  ].join(" ");
  recordReviewerCooldown("mimo", "quota", detail, {
    root,
    now: 1_000,
    ttlMs: 60_000,
    env: { MIMO_API_KEY: secret }
  });
  const entry = readReviewerCooldown("mimo", {
    root,
    now: 2_000,
    env: { MIMO_API_KEY: secret }
  });
  assert.equal(entry.kind, "quota");
  assert.doesNotMatch(entry.detail, /fake_exact_secret_123|bearer-fake|dXNlcjpwYXNz|alice:password/);
  assert.match(entry.detail, /\[redacted\]/);
  assert.equal(fs.statSync(path.join(root, "reviewer-cooldowns.json")).mode & 0o777, 0o600);
  clearReviewerCooldowns({ root });
  assert.equal(readReviewerCooldown("mimo", { root, now: 2_000 }), null);
});
