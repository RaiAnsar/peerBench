import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "push-evidence-state-"));

import { resolveNativeUpdateRange } from "../global-hooks/pre-push-lib.mjs";
import { runPushReview, streamGitEvidence } from "../global-hooks/spec-review-run.mjs";
import { materializeImmutableCommit, pushReviewPanel } from "../global-hooks/hunt.mjs";
import { createReviewTools } from "../global-hooks/review-tools.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "advice.graftFileDeprecated=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_GRAFT_FILE: os.devNull }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function gitInput(cwd, input, ...args) {
  const result = spawnSync("git", ["-c", "advice.graftFileDeprecated=false", ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_GRAFT_FILE: os.devNull }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "push-evidence-repo-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  return cwd;
}

function commitFile(cwd, file, content, message) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (content == null) fs.rmSync(target, { force: true });
  else fs.writeFileSync(target, content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const allow = [{ name: "Kimi", verdict: "ALLOW", findings: "ALLOW: clean", findingCount: 0, severity: "none" }];

async function captureReview(cwd, base, tip) {
  let seen = null;
  const result = await runPushReview(`${base}..${tip}`, cwd, {
    baseCommit: base,
    targetCommit: tip,
    writeTraceImpl: () => null,
    panelImpl: async (input) => { seen = input; return allow; }
  });
  return { result, seen };
}

test("replacement refs cannot change object type or substitute benign push evidence", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "app.js", "export const value = 'BASE';\n", "base");
  const malicious = commitFile(cwd, "app.js", "export const value = 'MALICIOUS_ORIGINAL';\n", "malicious");

  git(cwd, "checkout", "-q", "-b", "benign", base);
  const benign = commitFile(cwd, "app.js", "export const value = 'BENIGN_REPLACEMENT';\n", "benign");
  git(cwd, "replace", "-f", malicious, benign);

  const update = { localRef: "refs/heads/malicious", localSha: malicious, remoteRef: "refs/heads/main", remoteSha: base };
  const resolved = resolveNativeUpdateRange(cwd, "origin", update);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.localCommit, malicious);

  const { result, seen } = await captureReview(cwd, base, malicious);
  assert.equal(result.retry, undefined);
  assert.match(seen.content, /MALICIOUS_ORIGINAL/);
  assert.doesNotMatch(seen.content, /BENIGN_REPLACEMENT/);
  const exactTools = createReviewTools(cwd, { treeish: malicious });
  const exactFile = await exactTools.execute("read_file", { path: "app.js" });
  assert.match(exactFile, /MALICIOUS_ORIGINAL/);
  assert.doesNotMatch(exactFile, /BENIGN_REPLACEMENT/);
  const exactSnapshot = materializeImmutableCommit(cwd, malicious);
  try {
    assert.match(fs.readFileSync(path.join(exactSnapshot, "app.js"), "utf8"), /MALICIOUS_ORIGINAL/);
  } finally {
    fs.rmSync(exactSnapshot, { recursive: true, force: true });
  }

  git(cwd, "replace", "-d", malicious);
  const blob = gitInput(cwd, "fake blob\n", "hash-object", "-w", "--stdin");
  git(cwd, "replace", "-f", malicious, blob);
  const typeSafe = resolveNativeUpdateRange(cwd, "origin", update);
  assert.equal(typeSafe.ok, true, "a commit replaced with a blob must still be resolved as the real commit");
  assert.equal(typeSafe.localCommit, malicious);
});

test("immutable CLI snapshots recursively materialize ordinary nested pushed files", () => {
  const cwd = repo();
  const tip = commitFile(cwd, "src/deep/nested/app.js", "export const nested = true;\n", "nested file");
  const snapshot = materializeImmutableCommit(cwd, tip);
  try {
    assert.equal(
      fs.readFileSync(path.join(snapshot, "src", "deep", "nested", "app.js"), "utf8"),
      "export const nested = true;\n"
    );
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
});

test("multi-chunk push panel materializes the immutable tip once and forwards every bounded prompt", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "src/base.js", "export const base = 1;\n", "base");
  const tip = commitFile(cwd, "src/nested/feature.js", "export const feature = 2;\n", "feature");
  let calls = 0;
  const results = await pushReviewPanel({
    cwd,
    range: `${base}..${tip}`,
    targetCommit: tip,
    content: "chunk one",
    contents: ["chunk one", "chunk two"],
    huntPanelImpl: async ({ cliCwd, treeish, reviewChunks }) => {
      calls++;
      assert.equal(treeish, tip);
      assert.equal(reviewChunks.length, 2);
      assert.match(reviewChunks[0].user, /chunk one/);
      assert.match(reviewChunks[1].user, /chunk two/);
      assert.match(fs.readFileSync(path.join(cliCwd, "src", "nested", "feature.js"), "utf8"), /feature = 2/);
      return [{ name: "Kimi", findings: "ALLOW: clean\nSEVERITY: none", error: null, coverageComplete: true }];
    }
  });
  assert.equal(calls, 1, "one panel invocation owns one immutable snapshot for the whole sequence");
  assert.equal(results[0].verdict, "ALLOW");
});

test("external diff, textconv, and -diff attributes cannot hide raw pushed bytes", async () => {
  const cwd = repo();
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.js diff=hide\n*.secret -diff\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'BASE';\n");
  fs.writeFileSync(path.join(cwd, "payload.secret"), "BASE_SECRET\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");

  const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-evidence-drivers-"));
  const external = path.join(driverDir, "external-diff.sh");
  const textconv = path.join(driverDir, "textconv.sh");
  fs.writeFileSync(external, "#!/bin/sh\nprintf 'BENIGN EXTERNAL DIFF\\n'\n");
  fs.writeFileSync(textconv, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(external, 0o755);
  fs.chmodSync(textconv, 0o755);
  git(cwd, "config", "diff.external", external);
  git(cwd, "config", "diff.hide.textconv", textconv);

  const tip = commitFile(cwd, "app.js", "export const value = 'MALICIOUS_TEXTCONV';\n", "malicious js");
  fs.writeFileSync(path.join(cwd, "payload.secret"), "MALICIOUS_ATTRIBUTE\n");
  git(cwd, "add", "payload.secret");
  git(cwd, "commit", "-q", "-m", "malicious attributed file");
  const finalTip = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(tip, finalTip);

  const { seen } = await captureReview(cwd, base, finalTip);
  assert.match(seen.content, /MALICIOUS_TEXTCONV/);
  assert.match(seen.content, /MALICIOUS_ATTRIBUTE/);
  assert.doesNotMatch(seen.content, /BENIGN EXTERNAL DIFF/);
});

test("every pushed commit delta is visible even when the net tree removes the intermediate payload", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "stable.txt", "stable\n", "base");
  commitFile(cwd, "published-secret.txt", "INTERMEDIATE_PUBLISHED_SECRET\n", "add payload");
  const tip = commitFile(cwd, "published-secret.txt", null, "remove payload");

  const { seen } = await captureReview(cwd, base, tip);
  assert.match(seen.content, /<per_commit_deltas/);
  assert.match(seen.content, /INTERMEDIATE_PUBLISHED_SECRET/);
  assert.match(seen.content, /<net_tree_diff omitted="true">/);
});

test("a force rewind includes the old-base to new-tip net tree effect", async () => {
  const cwd = repo();
  const older = commitFile(cwd, "value.txt", "OLDER_VALUE\n", "older");
  const newer = commitFile(cwd, "value.txt", "NEWER_VALUE_THAT_REWIND_REMOVES\n", "newer");
  const { seen } = await captureReview(cwd, newer, older);
  assert.match(seen.content, /<net_tree_diff/);
  assert.match(seen.content, /NEWER_VALUE_THAT_REWIND_REMOVES/);
  assert.match(seen.content, /OLDER_VALUE/);
  assert.doesNotMatch(seen.content, /net_tree_diff omitted/);
});

test("legacy info/grafts cannot hide an intermediate pushed commit", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "stable.txt", "stable\n", "base");
  commitFile(cwd, "payload.txt", "GRAFT_HIDDEN_PAYLOAD\n", "hidden payload");
  const tip = commitFile(cwd, "payload.txt", null, "remove payload");
  git(cwd, "config", "advice.graftFileDeprecated", "false");
  fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "info", "grafts"), `${tip} ${base}\n`);

  const { seen } = await captureReview(cwd, base, tip);
  assert.match(seen.content, /GRAFT_HIDDEN_PAYLOAD/);
});

test("diff.ignoreSubmodules=all cannot hide a gitlink pointer update", async () => {
  const cwd = repo();
  const first = commitFile(cwd, "inner.txt", "one\n", "inner one");
  const second = commitFile(cwd, "inner.txt", "two\n", "inner two");
  git(cwd, "update-index", "--add", "--cacheinfo", `160000,${first},vendor/module`);
  git(cwd, "commit", "-q", "-m", "base gitlink");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "config", "diff.ignoreSubmodules", "all");
  git(cwd, "update-index", "--cacheinfo", `160000,${second},vendor/module`);
  git(cwd, "commit", "-q", "-m", "update gitlink");
  const tip = git(cwd, "rev-parse", "HEAD");

  const { seen } = await captureReview(cwd, base, tip);
  assert.match(seen.content, new RegExp(first.slice(0, 7)));
  assert.match(seen.content, new RegExp(second.slice(0, 7)));
});

test("non-text diff bytes are losslessly represented instead of omitted or lossy-decoded", async () => {
  const cwd = repo();
  fs.writeFileSync(path.join(cwd, "payload.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  git(cwd, "add", "payload.bin");
  git(cwd, "commit", "-q", "-m", "base binary");
  const base = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "payload.bin"), Buffer.from([0x00, 0x4d, 0x41, 0x4c, 0xff]));
  git(cwd, "add", "payload.bin");
  git(cwd, "commit", "-q", "-m", "binary update");
  const tip = git(cwd, "rev-parse", "HEAD");
  let captured = null;
  const result = await runPushReview(`${base}..${tip}`, cwd, {
    baseCommit: base,
    targetCommit: tip,
    writeTraceImpl: () => null,
    panelImpl: async ({ content }) => { captured = content; return allow; }
  });
  assert.equal(result.coverageBlocked, undefined);
  assert.match(captured, /per_commit_deltas[^>]+encoding="all-byte-hex"/);
  assert.match(captured, /raw Git evidence encoded losslessly; every source byte is one \\xHH token/);
  assert.match(captured, /\\x64\\x69\\x66\\x66\\x20\\x2d\\x2d\\x67\\x69\\x74/, "the diff header remains exactly recoverable from unambiguous byte tokens");
  assert.doesNotMatch(captured, /bytes omitted/);
});

test("API and CLI exploration are pinned to the exact non-HEAD pushed tip", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "value.txt", "BASE\n", "base");
  git(cwd, "checkout", "-q", "-b", "feature");
  const feature = commitFile(cwd, "value.txt", "IMMUTABLE_FEATURE_TIP\n", "feature");
  git(cwd, "checkout", "-q", "-b", "other", base);
  fs.writeFileSync(path.join(cwd, "value.txt"), "DIRTY_WRONG_WORKTREE\n");

  let snapshotPath = null;
  const results = await pushReviewPanel({
    cwd,
    range: `${base}..${feature}`,
    targetCommit: feature,
    content: "immutable evidence",
    huntPanelImpl: async ({ cwd: original, cliCwd, treeish }) => {
      snapshotPath = cliCwd;
      assert.equal(original, cwd);
      assert.equal(treeish, feature);
      assert.equal(fs.readFileSync(path.join(cliCwd, "value.txt"), "utf8"), "IMMUTABLE_FEATURE_TIP\n");
      assert.equal(fs.existsSync(path.join(cliCwd, ".git")), false, "CLI snapshot must not inherit mutable Git metadata");

      const tools = createReviewTools(original, { treeish });
      assert.match(await tools.execute("read_file", { path: "value.txt" }), /IMMUTABLE_FEATURE_TIP/);
      assert.doesNotMatch(await tools.execute("read_file", { path: "value.txt" }), /DIRTY_WRONG_WORKTREE/);
      assert.match(await tools.execute("grep", { pattern: "IMMUTABLE_FEATURE_TIP" }), /value\.txt/);
      return [{ name: "Kimi", findings: "ALLOW: exact tip inspected\nSEVERITY: none", error: null }];
    }
  });
  assert.equal(results[0].verdict, "ALLOW");
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), false, "temporary immutable snapshot is removed after the panel");
});

test("CLI snapshot never follows a pushed symlink outside the immutable tree", async () => {
  const cwd = repo();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-evidence-host-secret-"));
  const outside = path.join(outsideDir, "host-secret.txt");
  fs.writeFileSync(outside, "HOST_SECRET_MUST_NOT_BE_REACHABLE\n");
  fs.symlinkSync(outside, path.join(cwd, "escape-link"));
  git(cwd, "add", "escape-link");
  git(cwd, "commit", "-q", "-m", "escaping symlink");
  const tip = git(cwd, "rev-parse", "HEAD");

  await pushReviewPanel({
    cwd,
    range: `${tip}..${tip}`,
    targetCommit: tip,
    content: "symlink snapshot",
    huntPanelImpl: async ({ cliCwd }) => {
      const materialized = path.join(cliCwd, "escape-link");
      assert.equal(fs.lstatSync(materialized).isSymbolicLink(), false);
      const text = fs.readFileSync(materialized, "utf8");
      assert.match(text, /intentionally not followed/);
      assert.match(text, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(text, /HOST_SECRET_MUST_NOT_BE_REACHABLE/);
      return [{ name: "Kimi", findings: "ALLOW: safe snapshot\nSEVERITY: none", error: null }];
    }
  });
});

test("CLI snapshot fails closed on case/Unicode filesystem path collisions", () => {
  const cwd = repo();
  const first = gitInput(cwd, "first\n", "hash-object", "-w", "--stdin");
  const second = gitInput(cwd, "second\n", "hash-object", "-w", "--stdin");
  const tree = gitInput(cwd, [
    `100644 blob ${first}\tREADME.txt`,
    `100644 blob ${second}\tReadme.txt`,
    ""
  ].join("\n"), "mktree");
  const tip = gitInput(cwd, "colliding paths\n", "commit-tree", tree, "-F", "-");
  assert.throws(
    () => materializeImmutableCommit(cwd, tip),
    /paths collide in CLI snapshot/,
    "distinct Git entries must never silently overwrite one reviewer-visible path"
  );
});

test("push review hash depends on immutable base/tip evidence, never current HEAD or dirty files", async () => {
  const cwd = repo();
  const base = commitFile(cwd, "value.txt", "BASE\n", "base");
  git(cwd, "checkout", "-q", "-b", "feature");
  const feature = commitFile(cwd, "value.txt", "FEATURE\n", "feature");
  git(cwd, "checkout", "-q", "-b", "other", base);

  const first = await captureReview(cwd, base, feature);
  commitFile(cwd, "other.txt", "unrelated HEAD\n", "unrelated");
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty\n");
  const second = await captureReview(cwd, base, feature);
  assert.equal(first.result.hash, second.result.hash);
  assert.equal(first.seen.range, `${base}..${feature}`);
  assert.equal(second.seen.targetCommit, feature);
});

test("a wedged git child is killed on a timer and fails into the retry path instead of hanging", async () => {
  // F2: streamGitEvidence must settle even when the spawned git never exits (dead NFS/fuse). The
  // native pre-push path has no outer budget and Git applies no hook timeout, so without a kill
  // timer `git push` hangs indefinitely. A fake `git` that sleeps stands in for the wedge.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-evidence-hung-bin-"));
  const hangGit = path.join(binDir, "git");
  fs.writeFileSync(hangGit, "#!/bin/sh\nexec sleep 30\n");
  fs.chmodSync(hangGit, 0o755);

  let bark;
  const watchdog = new Promise((resolve) => { bark = resolve; });
  const watchdogTimer = setTimeout(() => bark({ ok: "watchdog" }), 10_000);
  const result = await Promise.race([
    streamGitEvidence(["log", "--format=%H", "HEAD"], os.tmpdir(), {
      timeoutMs: 250,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` }
    }),
    watchdog
  ]);
  clearTimeout(watchdogTimer);
  assert.notEqual(result.ok, "watchdog", "streamGitEvidence must settle on its own kill timer");
  assert.equal(result.ok, false, "a timed-out git fails so the caller's retry/defer handling engages");
  assert.match(String(result.stderr || ""), /timed out/i);
});
