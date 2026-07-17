import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gc-root-"));
import { extractVerdict, resolveReviewers } from "../global-hooks/reviewers.mjs";

test("extractVerdict skips filler + code fences to find the verdict line", () => {
  // ALLOW inside a fence is ignored (Fix 2); must find verdict outside
  assert.equal(extractVerdict("Sure!\n```\nALLOW: looks fine\n```"), null);
  assert.equal(extractVerdict("BLOCK: bad\n- reason").verdict, "BLOCK");
  assert.equal(extractVerdict("no verdict here"), null);
});
test("extractVerdict ignores ALLOW:/BLOCK: inside fenced code blocks", () => {
  const result = extractVerdict("```\nALLOW: not real\n```\nBLOCK: the real one");
  assert.equal(result?.verdict, "BLOCK");
});
test("run retries once on non-conforming output then succeeds", async () => {
  const calls = [];
  const reviewImpl = async ({ user }) => { calls.push(user); return calls.length === 1 ? { ok: true, text: "I think it's fine", usage: null } : { ok: true, text: "ALLOW: fine on retry", usage: null }; };
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl }).filter((r) => r.name === "kimi");
  const res = await kimi.run({ system: "s", user: "u" });
  assert.equal(res.verdict, "ALLOW");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /ALLOW:|BLOCK:/);
});
test("no key → error, skipped not crashed", async () => {
  const r = resolveReviewers({ env: {}, reviewImpl: async () => ({ ok: true, text: "ALLOW: x" }) });
  assert.equal((await r.find((x) => x.name === "kimi").run({ system: "s", user: "u" })).error, "no api key");
});
test("hard error from client → error side", async () => {
  const r = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl: async () => ({ ok: false, error: { kind: "timeout", detail: "slow" } }) });
  const res = await r.find((x) => x.name === "kimi").run({ system: "s", user: "u" });
  assert.match(res.error, /timeout/);
});
test("codex resolves to named CLI adapter", () => {
  const r = resolveReviewers({ env: {}, reviewers: ["codex"] });
  assert.deepEqual(r.map((x) => x.name), ["codex"]);
  assert.equal(typeof r[0].run, "function");
});
test("codex CLI identity carries the review model from $CODEX_HOME/config.toml (no spawn)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.writeFileSync(path.join(home, "config.toml"), 'provider = "openai"\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n');
  const [codex] = resolveReviewers({ env: { CODEX_HOME: home }, reviewers: ["codex"] });
  assert.equal(codex.reviewIdentity.kind, "codex-cli");
  assert.equal(codex.reviewIdentity.model, "gpt-5.6-sol", "switching the codex model must invalidate cached exact ALLOWs");
});
test("codex CLI identity degrades to an empty model when no config is readable", () => {
  const [codex] = resolveReviewers({ env: { CODEX_HOME: path.join(os.tmpdir(), "no-such-codex-home") }, reviewers: ["codex"] });
  assert.equal(codex.reviewIdentity.model, "");
});
test("grok CLI identity carries the installed CLI version from $GROK_HOME/version.json (no spawn)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  fs.writeFileSync(path.join(home, "version.json"), JSON.stringify({ version: "0.2.101" }));
  const [grok] = resolveReviewers({ env: { GROK_HOME: home }, reviewers: ["grok"] });
  assert.equal(grok.reviewIdentity.kind, "grok-cli");
  assert.equal(grok.reviewIdentity.model, "grok-cli@0.2.101", "reviews use the CLI build's built-in default model, so the build version is the cache-identity signal");
});
test("grok CLI identity degrades to an empty model when version.json is missing", () => {
  const [grok] = resolveReviewers({ env: { GROK_HOME: path.join(os.tmpdir(), "no-such-grok-home") }, reviewers: ["grok"] });
  assert.equal(grok.reviewIdentity.model, "");
});
test("kimi adapter run still accepts the extended params and ignores cwd/env", async () => {
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewers: ["kimi"], reviewImpl: async () => ({ ok: true, text: "ALLOW: ok" }) });
  assert.equal(kimi.reviewIdentity.kind, "api");
  assert.ok(kimi.reviewIdentity.model, "ALLOW cache identity carries the configured model");
  assert.ok(kimi.reviewIdentity.baseURL, "ALLOW cache identity carries the configured endpoint");
  const res = await kimi.run({ system: "s", user: "u", cwd: "/tmp", env: {} });
  assert.equal(res.verdict, "ALLOW");
});
test("retry call failure surfaces the retry error, not 'unparseable verdict'", async () => {
  let calls = 0;
  const reviewImpl = async () => {
    calls++;
    if (calls === 1) return { ok: true, text: "I think it is fine", usage: null };
    return { ok: false, error: { kind: "timeout", detail: "slow" } };
  };
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewers: ["kimi"], reviewImpl });
  const res = await kimi.run({ system: "s", user: "u" });
  assert.match(res.error, /timeout/);
});

test("quota failure → friendly out-of-quota error, errorKind, and a recorded cooldown that skips the next call instantly", async () => {
  const { clearReviewerCooldowns } = await import("../global-hooks/config-store.mjs");
  clearReviewerCooldowns({ name: "kimi" });
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, error: { kind: "quota", detail: "HTTP 429: rate limit reached" } }; };
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl: failing }).filter((r) => r.name === "kimi");
  const res = await kimi.run({ system: "s", user: "u" });
  assert.match(res.error, /out of quota/i);
  assert.equal(res.errorKind, "quota");
  assert.equal(calls, 1);

  // Second resolve: the cooldown must short-circuit BEFORE the (would-succeed) client call.
  const succeeding = async () => { calls++; return { ok: true, text: "ALLOW: fine" }; };
  const [kimi2] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl: succeeding }).filter((r) => r.name === "kimi");
  const res2 = await kimi2.run({ system: "s", user: "u" });
  assert.match(res2.error, /out of quota.*cooldown/is);
  assert.equal(res2.errorKind, "quota");
  assert.equal(res2.skipped, "cooldown");
  assert.equal(calls, 1, "cooldown must skip without calling the client");
  clearReviewerCooldowns({ name: "kimi" });
});
test("expired cooldown lets the reviewer run again", async () => {
  const { recordReviewerCooldown, clearReviewerCooldowns } = await import("../global-hooks/config-store.mjs");
  clearReviewerCooldowns({ name: "kimi" });
  const t0 = Date.now();
  recordReviewerCooldown("kimi", "quota", "HTTP 429", { now: t0 - 60 * 60_000 });   // recorded an hour ago
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl: async () => ({ ok: true, text: "ALLOW: back" }) }).filter((r) => r.name === "kimi");
  const res = await kimi.run({ system: "s", user: "u" });
  assert.equal(res.verdict, "ALLOW");
  clearReviewerCooldowns({ name: "kimi" });
});
test("classifyReviewerFailureText sniffs CLI quota/auth failures conservatively", async () => {
  const { classifyReviewerFailureText } = await import("../global-hooks/reviewers.mjs");
  assert.equal(classifyReviewerFailureText("You have reached your usage limit until Jul 23"), "quota");
  assert.equal(classifyReviewerFailureText("error: invalid_grant, please re-authenticate"), "auth");
  assert.equal(classifyReviewerFailureText("the author field is required"), null);
  assert.equal(classifyReviewerFailureText("segfault in tokenizer"), null);
});
test("non-availability errors (timeout/parse) do NOT record a cooldown", async () => {
  const { readReviewerCooldown, clearReviewerCooldowns } = await import("../global-hooks/config-store.mjs");
  clearReviewerCooldowns({ name: "kimi" });
  const [kimi] = resolveReviewers({ env: { KIMI_API_KEY: "k" }, reviewImpl: async () => ({ ok: false, error: { kind: "timeout", detail: "slow" } }) }).filter((r) => r.name === "kimi");
  const res = await kimi.run({ system: "s", user: "u" });
  assert.match(res.error, /timeout/);
  assert.equal(readReviewerCooldown("kimi"), null, "timeout must not park the reviewer");
});
