import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReviewTools } from "../global-hooks/review-tools.mjs";

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  fs.writeFileSync(path.join(d, "a.js"), "export const x = 1;\nconst secret = 'find me';\n");
  fs.mkdirSync(path.join(d, "sub"));
  fs.writeFileSync(path.join(d, "sub", "b.js"), "import { x } from '../a.js';\n");
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"], { cwd: d });
  return d;
}

test("read_file reads within the repo", async () => {
  const { execute } = createReviewTools(tmpRepo());
  const out = await execute("read_file", { path: "a.js" });
  assert.match(out, /find me/);
});
test("read_file rejects path traversal", async () => {
  const { execute } = createReviewTools(tmpRepo());
  await assert.rejects(() => execute("read_file", { path: "../../etc/passwd" }), /escapes workspace/);
});
test("grep finds matches via git grep", async () => {
  const { execute } = createReviewTools(tmpRepo());
  const out = await execute("grep", { pattern: "find me" });
  assert.match(out, /a\.js:2/);
});
test("grep no-match returns a clean message", async () => {
  const { execute } = createReviewTools(tmpRepo());
  assert.equal((await execute("grep", { pattern: "zzzznotfound" })).trim(), "(no matches)");
});
test("glob lists tracked files", async () => {
  const { execute } = createReviewTools(tmpRepo());
  const out = await execute("glob", { pattern: "*.js" });
  assert.match(out, /a\.js/);
});
test("list_dir lists entries; rejects escape", async () => {
  const d = tmpRepo();
  const { execute } = createReviewTools(d);
  const out = await execute("list_dir", { path: "." });
  assert.match(out, /sub\//);
  await assert.rejects(() => execute("list_dir", { path: "/etc" }), /escapes workspace/);
});
test("unknown tool throws", async () => {
  const { execute } = createReviewTools(tmpRepo());
  await assert.rejects(() => execute("rm_rf", {}), /unknown tool/);
});
test("schemas are well-formed OpenAI tool defs", () => {
  const { schemas } = createReviewTools(tmpRepo());
  assert.equal(schemas.length, 4);
  for (const s of schemas) { assert.equal(s.type, "function"); assert.ok(s.function.name); assert.equal(s.function.parameters.type, "object"); }
});
