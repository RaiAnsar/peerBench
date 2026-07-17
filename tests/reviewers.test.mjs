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
