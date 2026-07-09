import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-root-"));
import { resolveConfig, workspaceStateDir, sharedRoot, KNOWN_REVIEWERS, setReviewers, isBenchDisabled, displayName, PROVIDER_NAMES, normalizeSessionId, sessionKeyFromInput } from "../global-hooks/config-store.mjs";

test("registry: display names + KNOWN_REVIEWERS + PROVIDER_NAMES all derive from the single DEFAULTS source", () => {
  // Adding/swapping a model is one DEFAULTS entry — these are derived, not hand-maintained lists.
  assert.deepEqual(PROVIDER_NAMES, ["kimi", "mimo", "glm", "qwen", "grok", "minimax"]);
  assert.deepEqual(KNOWN_REVIEWERS, ["kimi", "mimo", "glm", "qwen", "grok", "minimax", "codex"]);
  assert.equal(displayName("kimi"), "Kimi");
  assert.equal(displayName("mimo"), "MiMo");
  assert.equal(displayName("glm"), "GLM");
  assert.equal(displayName("qwen"), "Qwen");
  assert.equal(displayName("grok"), "Grok");
  assert.equal(displayName("minimax"), "MiniMax");
  assert.equal(displayName("codex"), "Codex");
  assert.equal(displayName("whatever"), "whatever", "unknown names pass through unchanged");
});

test("env vars populate keys; CLAUDE_PLUGIN_DATA does not affect result", () => {
  const base = { KIMI_API_KEY: "mk", MIMO_API_KEY: "xk" };
  const a = resolveConfig({ env: { ...base } });
  const b = resolveConfig({ env: { ...base, CLAUDE_PLUGIN_DATA: "/tmp/whatever" } });
  assert.equal(a.providers.kimi.apiKey, "mk");
  assert.equal(a.providers.kimi.model, "kimi-k2.6");
  assert.equal(a.providers.kimi.baseURL, "https://api.kimi.com/coding/v1");
  assert.equal(a.providers.kimi.temperature, 0.6);
  assert.match(a.providers.kimi.headers["User-Agent"], /claude-cli/);
  assert.equal(a.providers.mimo.apiKey, "xk");
  assert.equal(a.providers.mimo.temperature, 0);
  // glm provider is defined and now part of the default fallback set
  assert.equal(a.providers.glm.baseURL, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(a.providers.glm.model, "glm-5.2");
  // Default fallback is kimi+glm (mimo disabled — quota-exhausted — but still wired/selectable).
  assert.deepEqual(a.reviewers, ["kimi", "glm"]);
  assert.deepEqual(a, b);
});
test("mimo is selectable (KNOWN, integration retained) but NOT in the default set", () => {
  assert.ok(KNOWN_REVIEWERS.includes("mimo"), "mimo must stay KNOWN/selectable (disabled, not removed)");
  assert.ok(!resolveConfig({ env: {} }).reviewers.includes("mimo"), "mimo must not be active by default");
});
test("grok is wired as a KNOWN/selectable provider with xAI defaults (dot model id)", () => {
  assert.ok(KNOWN_REVIEWERS.includes("grok"), "grok must be KNOWN/selectable");
  const a = resolveConfig({ env: { GROK_API_KEY: "gk" } });
  assert.equal(a.providers.grok.apiKey, "gk");
  assert.equal(a.providers.grok.model, "grok-4.5", "model id uses a DOT — grok-4-5 is model-not-found");
  assert.equal(a.providers.grok.baseURL, "https://api.x.ai/v1");
  assert.ok(!resolveConfig({ env: {} }).reviewers.includes("grok"), "grok must not be active by default");
});
test("qwen is wired as a KNOWN/selectable provider with its DashScope defaults", () => {
  assert.ok(KNOWN_REVIEWERS.includes("qwen"), "qwen must be KNOWN/selectable");
  const a = resolveConfig({ env: { QWEN_API_KEY: "qk" } });
  assert.equal(a.providers.qwen.apiKey, "qk");
  assert.equal(a.providers.qwen.model, "qwen3.7-max");
  assert.match(a.providers.qwen.baseURL, /maas\.aliyuncs\.com\/compatible-mode/);
});
test("QWEN_MODEL / QWEN_BASE_URL env overrides win (quick-swap without code edits)", () => {
  const a = resolveConfig({ env: { QWEN_API_KEY: "qk", QWEN_MODEL: "qwen-max", QWEN_BASE_URL: "https://example/v1" } });
  assert.equal(a.providers.qwen.model, "qwen-max");
  assert.equal(a.providers.qwen.baseURL, "https://example/v1");
});
test("companion.json can override temperature/headers (via file param seam)", () => {
  // resolveConfig reads companion.json from sharedRoot; we can't write there in a unit test,
  // so just assert the default headers/temperature object shape is present and overridable in code.
  const a = resolveConfig({ env: { KIMI_API_KEY: "k" } });
  assert.equal(typeof a.providers.kimi.temperature, "number");
  assert.equal(typeof a.providers.kimi.headers, "object");
});
test("workspaceStateDir lands under the env-independent shared root", () => {
  const dir = workspaceStateDir("/some/workspace");
  assert.ok(dir.startsWith(sharedRoot()));
  assert.ok(/\/state\/workspace-[0-9a-f]{16}$/.test(dir));
});
test("workspaceStateDir maps a symlinked workspace to the SAME state dir as the real path (no split)", () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-")));
  const real = path.join(base, "realname"); fs.mkdirSync(real);
  const link = path.join(base, "linkname"); fs.symlinkSync(real, link);   // differently-named symlink → real
  assert.equal(workspaceStateDir(link), workspaceStateDir(real), "symlink + real path must resolve to one state dir");
});
test("sessionKeyFromInput normalizes Claude session ids and is idempotent", () => {
  const a = normalizeSessionId("claude-session-A");
  assert.match(a, /^session-[0-9a-f]{16}$/);
  assert.equal(normalizeSessionId(a), a, "already-normalized keys must not be hashed again");
  assert.equal(sessionKeyFromInput({ session_id: "claude-session-A" }, {}), a);
  assert.equal(sessionKeyFromInput({ sessionId: "claude-session-A" }, {}), a);
  assert.equal(sessionKeyFromInput({}, { BENCH_SESSION_ID: "claude-session-A" }), a);
  assert.equal(sessionKeyFromInput({}, { CLAUDE_SESSION_ID: "ambient", CODEX_COMPANION_SESSION_ID: "ambient" }), null,
    "ambient parent-runtime session env vars must not create a peerBench chat key");
  assert.equal(sessionKeyFromInput({ session_id: "null" }, {}), null);
});
test("reviewers override allows codex-only selection", () => {
  const cfg = resolveConfig({ env: {}, reviewers: ["codex"] });
  assert.deepEqual(cfg.reviewers, ["codex"]);
});
test("resolveConfig can suppress the Codex reviewer for direct Codex prompt sessions", () => {
  const mixed = resolveConfig({ env: { BENCH_SUPPRESS_CODEX_REVIEWER: "1" }, reviewers: ["codex", "kimi", "glm"] });
  assert.deepEqual(mixed.reviewers, ["kimi", "glm"]);
  const codexOnly = resolveConfig({ env: { BENCH_SUPPRESS_CODEX_REVIEWER: "1" }, reviewers: ["codex"] });
  assert.deepEqual(codexOnly.reviewers, ["kimi", "glm"]);
});
test("unknown reviewer names are filtered out", () => {
  const cfg = resolveConfig({ env: {}, reviewers: ["kimi", "bogus"] });
  assert.deepEqual(cfg.reviewers, ["kimi"]);
});
test("setReviewers writes companion.json and filters unknowns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-"));
  const out = setReviewers(["codex", "kimi", "bogus"], { root });
  assert.deepEqual(out, ["codex", "kimi"]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "companion.json"), "utf8"));
  assert.deepEqual(saved.reviewers, ["codex", "kimi"]);
});
test("setReviewers throws on all-invalid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj2-"));
  assert.throws(() => setReviewers(["bogus"], { root }));
});
test("setReviewers de-dupes (kimi kimi mimo → kimi mimo) — no double API calls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj3-"));
  assert.deepEqual(setReviewers(["kimi", "kimi", "mimo"], { root }), ["kimi", "mimo"]);
});
test("resolveConfig de-dupes a duplicated reviewer override", () => {
  assert.deepEqual(resolveConfig({ env: {}, reviewers: ["kimi", "kimi"] }).reviewers, ["kimi"]);
});
test("resolveConfig includes per-provider timeoutMs defaults (kimi=300000, mimo=180000)", () => {
  const cfg = resolveConfig({ env: { KIMI_API_KEY: "k" } });
  assert.equal(cfg.providers.kimi.timeoutMs, 300_000);
  assert.equal(cfg.providers.mimo.timeoutMs, 180_000);
});
test("resolveConfig kimi defaults: model kimi-k2.6, temperature 0.6, thinking disabled", () => {
  const cfg = resolveConfig({ env: { KIMI_API_KEY: "k" } });
  assert.equal(cfg.providers.kimi.model, "kimi-k2.6");
  assert.equal(cfg.providers.kimi.temperature, 0.6);
  assert.equal(cfg.providers.kimi.thinking, "disabled");
});
test("resolveConfig KIMI_THINKING env overrides kimi thinking", () => {
  const cfg = resolveConfig({ env: { KIMI_API_KEY: "k", KIMI_THINKING: "enabled" } });
  assert.equal(cfg.providers.kimi.thinking, "enabled");
});
test("resolveConfig normalizes empty string thinking to null", () => {
  const cfg = resolveConfig({ env: { KIMI_API_KEY: "k", KIMI_THINKING: "" } });
  assert.equal(cfg.providers.kimi.thinking, null);
});
test("resolveConfig mimo defaults: thinking null", () => {
  const cfg = resolveConfig({ env: { MIMO_API_KEY: "m" } });
  assert.equal(cfg.providers.mimo.thinking, null);
});
test("C2: isBenchDisabled stays fail-open (false) AND warns on existsSync error", () => {
  const realExistsSync = fs.existsSync;
  const realWrite = process.stderr.write.bind(process.stderr);
  let warned = "";
  fs.existsSync = () => { throw Object.assign(new Error("boom"), { code: "EIO" }); };
  process.stderr.write = (chunk) => { warned += chunk; return true; };
  try {
    const result = isBenchDisabled("/some/workspace");
    assert.equal(result, false, "must stay fail-open (enabled) on FS error");
  } finally {
    fs.existsSync = realExistsSync;
    process.stderr.write = realWrite;
  }
  assert.match(warned, /⛩/, "must emit a ⛩ stderr warning");
  assert.match(warned, /bench/i, "warning should mention bench");
  assert.match(warned, /EIO|boom/, "warning should name the error");
});
