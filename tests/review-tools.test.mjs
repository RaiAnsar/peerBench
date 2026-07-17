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
test("read_file offset/limit returns the right window", async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, "lines.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
  const { execute } = createReviewTools(d);
  assert.equal(await execute("read_file", { path: "lines.txt", offset: 3, limit: 2 }), "line3\nline4");
});
test("read_file with offset/limit reads a >2MB file as a bounded window (no whole-file load, no 'too large')", async () => {
  const d = tmpRepo();
  const big = path.join(d, "big.log");
  // ~3MB: first line is short, then a lot of filler — offset/limit must NOT trip the 2MB full-read guard.
  fs.writeFileSync(big, "FIRST_LINE\n" + "x".repeat(3_000_000) + "\n");
  const { execute } = createReviewTools(d);
  const out = await execute("read_file", { path: "big.log", offset: 1, limit: 1 });
  assert.equal(out, "FIRST_LINE");
  assert.doesNotMatch(out, /too large/);
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
test("glob on a treeish lists pushed-tip files (default '*')", async () => {
  const d = tmpRepo();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  const { execute } = createReviewTools(d, { treeish: head });
  for (const out of [await execute("glob", {}), await execute("glob", { pattern: "*" })]) {
    assert.match(out, /a\.js/);
    assert.match(out, /sub\/b\.js/);
  }
});
test("glob on a treeish filters with the same semantics as git ls-files", async () => {
  const d = tmpRepo();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  const { execute } = createReviewTools(d, { treeish: head });
  const js = await execute("glob", { pattern: "*.js" });
  assert.match(js, /a\.js/);
  assert.match(js, /sub\/b\.js/);
  assert.equal(await execute("glob", { pattern: "sub" }), "sub/b.js");
  assert.equal(await execute("glob", { pattern: "*.md" }), "(no files)");
  assert.match(await execute("glob", { pattern: "." }), /sub\/b\.js/, "a '.' pathspec is the repo root — matches everything, as in git ls-files");
});
test("glob on a treeish surfaces a git failure as an error, not '(no files)'", async () => {
  const d = tmpRepo();
  const { execute } = createReviewTools(d, { treeish: "0".repeat(40) });
  await assert.rejects(() => execute("glob", { pattern: "*" }), /could not list pushed-tip files/);
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
test("read_file: >2MB file without offset/limit returns 'too large' message", async () => {
  const d = tmpRepo();
  // Write a file just over 2MB
  const bigPath = path.join(d, "big.bin");
  fs.writeFileSync(bigPath, Buffer.alloc(2_000_001, 0x61)); // 2MB+1 bytes of 'a'
  execFileSync("git", ["add", "big.bin"], { cwd: d });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "big"], { cwd: d });
  const { execute } = createReviewTools(d);
  const out = await execute("read_file", { path: "big.bin" });
  assert.match(out, /too large/);
  assert.match(out, /2000001 bytes/);
});
test("read_file: >2MB file with limit still reads", async () => {
  const d = tmpRepo();
  const bigPath = path.join(d, "big2.bin");
  fs.writeFileSync(bigPath, "line1\n".repeat(500_000)); // ~3MB of text
  execFileSync("git", ["add", "big2.bin"], { cwd: d });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "big2"], { cwd: d });
  const { execute } = createReviewTools(d);
  const out = await execute("read_file", { path: "big2.bin", limit: 5 });
  assert.match(out, /line1/);
  assert.doesNotMatch(out, /too large/);
});
