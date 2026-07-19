import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep cache and disable-marker state out of the user's real peerBench data dir.
const BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-light-root-"));
process.env.BENCH_ROOT = BENCH_ROOT;

const {
  MAX_PUSH_EVIDENCE_BYTES,
  buildPushEvidence,
  parseUpdates,
  resolveUpdateBase,
  reviewUpdate,
  runMain
} = await import("../global-hooks/git-pre-push-review.mjs");

const ZERO_SHA = "0".repeat(40);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureRepo(cwd) {
  git(cwd, "config", "user.email", "peerbench-test@example.invalid");
  git(cwd, "config", "user.name", "peerBench Test");
}

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

function freshRemoteWithMain() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-light-remote-"));
  git(remote, "init", "--bare", "-q", "-b", "main");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-light-ws-"));
  git(path.dirname(ws), "clone", "-q", remote, ws);
  configureRepo(ws);
  const remoteSha = commitFile(ws, "base.txt", "base\n", "base");
  git(ws, "push", "-q", "-u", "origin", "main");
  return { remote, ws, remoteSha };
}

function updateFor({ localSha, remoteSha, localRef = "refs/heads/main", remoteRef = "refs/heads/main" }) {
  return { localRef, localSha, remoteRef, remoteSha };
}

function fakeReviewer(name, outcome, calls) {
  return {
    name,
    reviewIdentity: `${name.toLowerCase()}/test-v1`,
    async run() {
      calls.push(name);
      if (outcome === "unavailable") return { name, error: "quota unavailable" };
      return {
        name,
        verdict: outcome,
        firstLine: `${outcome}: ${name} test verdict`,
        raw: `${outcome}: ${name} test verdict`
      };
    }
  };
}

function reviewers(outcomes, calls = []) {
  return {
    calls,
    resolveReviewersImpl: () => Object.entries(outcomes).map(([name, outcome]) => fakeReviewer(name, outcome, calls))
  };
}

test("parseUpdates accepts native Git tuples and rejects malformed input", () => {
  const first = `${"1".repeat(40)}`;
  const second = `${"2".repeat(40)}`;
  const parsed = parseUpdates([
    `refs/heads/main ${first} refs/heads/main ${second}`,
    `refs/heads/topic ${second} refs/heads/topic ${ZERO_SHA}`,
    ""
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updates, [
    updateFor({ localSha: first, remoteSha: second }),
    updateFor({ localSha: second, remoteSha: ZERO_SHA, localRef: "refs/heads/topic", remoteRef: "refs/heads/topic" })
  ]);

  const malformed = parseUpdates(`refs/heads/main ${first} refs/heads/main`);
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /invalid pre-push update tuple/i);
  assert.deepEqual(malformed.updates, []);
});

test("existing branch uses the exact destination SHA as its review base", () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "feature.txt", "feature\n", "outgoing only");
  const update = updateFor({ localSha, remoteSha });

  const resolved = resolveUpdateBase(update, remote, ws);
  assert.deepEqual(resolved, { ok: true, base: remoteSha, localCommit: localSha, kind: "existing" });

  const evidence = buildPushEvidence(update, resolved.base, ws);
  assert.equal(evidence.ok, true);
  assert.match(evidence.user, /outgoing only/);
  assert.doesNotMatch(evidence.user, /\n[0-9a-f]+ base\n/, "the already-remote base commit is not re-reviewed");
  assert.match(evidence.user, /\+feature/);
});

test("outgoing evidence bypasses attributes that would hide reviewable text", () => {
  const { ws, remoteSha } = freshRemoteWithMain();
  fs.writeFileSync(path.join(ws, ".gitattributes"), "payload.txt -diff\n");
  fs.writeFileSync(path.join(ws, "payload.txt"), "dangerous code execution\n");
  git(ws, "add", ".gitattributes", "payload.txt");
  git(ws, "commit", "-qm", "attribute-hidden payload");
  const localSha = git(ws, "rev-parse", "HEAD");

  const evidence = buildPushEvidence(updateFor({ localSha, remoteSha }), remoteSha, ws);
  assert.equal(evidence.ok, true);
  assert.match(evidence.user, /dangerous code execution/);
  assert.doesNotMatch(evidence.user, /GIT binary patch/);
});

test("outgoing evidence includes content introduced and reverted in intermediate commits", () => {
  const { ws, remoteSha } = freshRemoteWithMain();
  commitFile(ws, "historic-secret.txt", "historic-only-secret\n", "temporarily add sensitive file");
  git(ws, "rm", "-q", "historic-secret.txt");
  git(ws, "commit", "-qm", "remove sensitive file before tip");
  const localSha = git(ws, "rev-parse", "HEAD");

  const evidence = buildPushEvidence(updateFor({ localSha, remoteSha }), remoteSha, ws);
  assert.equal(evidence.ok, true);
  assert.match(evidence.user, /historic-only-secret/);
  assert.match(evidence.user, /temporarily add sensitive file/);
  assert.match(evidence.user, /remove sensitive file before tip/);
});

test("legacy grafts cannot hide an intermediate outgoing commit", () => {
  const { ws, remoteSha } = freshRemoteWithMain();
  commitFile(ws, "grafted-secret.txt", "secret-only-in-history\n", "graft-hidden secret");
  git(ws, "rm", "-q", "grafted-secret.txt");
  git(ws, "commit", "-qm", "delete graft-hidden secret");
  const localSha = git(ws, "rev-parse", "HEAD");
  const infoDir = path.join(ws, ".git", "info");
  fs.mkdirSync(infoDir, { recursive: true });
  fs.writeFileSync(path.join(infoDir, "grafts"), `${localSha} ${remoteSha}\n`);

  const evidence = buildPushEvidence(updateFor({ localSha, remoteSha }), remoteSha, ws);
  assert.equal(evidence.ok, true);
  assert.match(evidence.user, /secret-only-in-history/);
  assert.match(evidence.user, /graft-hidden secret/);
});

test("new branch chooses the nearest advertised ancestor instead of the empty tree", () => {
  const { ws, remote, remoteSha: mainSha } = freshRemoteWithMain();
  git(ws, "switch", "-qc", "release", mainSha);
  const releaseSha = commitFile(ws, "release.txt", "release\n", "release base");
  git(ws, "push", "-q", "-u", "origin", "release");
  git(ws, "switch", "-qc", "feature", releaseSha);
  const featureSha = commitFile(ws, "feature.txt", "feature\n", "feature only");

  const resolved = resolveUpdateBase(updateFor({
    localSha: featureSha,
    remoteSha: ZERO_SHA,
    localRef: "refs/heads/feature",
    remoteRef: "refs/heads/feature"
  }), remote, ws);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.kind, "new-branch");
  assert.equal(resolved.base, releaseSha, "the closest remote head is the exact base");
  assert.notEqual(resolved.base, mainSha);
});

test("a genuinely empty remote uses Git's empty-tree base", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-empty-remote-"));
  git(remote, "init", "--bare", "-q", "-b", "main");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-empty-ws-"));
  git(ws, "init", "-q", "-b", "main");
  configureRepo(ws);
  const localSha = commitFile(ws, "first.txt", "first\n", "first commit");
  git(ws, "remote", "add", "origin", remote);

  const resolved = resolveUpdateBase(updateFor({ localSha, remoteSha: ZERO_SHA }), remote, ws);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.kind, "empty-remote");
  assert.equal(resolved.base, git(ws, "hash-object", "-t", "tree", "/dev/null"));
});

test("non-empty remote with locally missing objects gives fetch guidance and calls no reviewer", async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-missing-remote-"));
  git(remote, "init", "--bare", "-q", "-b", "main");

  const producer = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-producer-"));
  git(producer, "init", "-q", "-b", "main");
  configureRepo(producer);
  commitFile(producer, "remote-only.txt", "object absent from consumer\n", "remote only");
  git(producer, "remote", "add", "origin", remote);
  git(producer, "push", "-q", "origin", "main");

  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-consumer-"));
  git(consumer, "init", "-q", "-b", "main");
  configureRepo(consumer);
  const localSha = commitFile(consumer, "local-only.txt", "independent\n", "local only");
  git(consumer, "remote", "add", "origin", remote);
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });

  const result = await reviewUpdate(
    updateFor({ localSha, remoteSha: ZERO_SHA, localRef: "refs/heads/topic", remoteRef: "refs/heads/topic" }),
    remote,
    consumer,
    { resolveReviewersImpl: fake.resolveReviewersImpl }
  );

  assert.equal(result.decision, "unreviewed");
  assert.match(result.note, /git fetch --prune and retry/i);
  assert.deepEqual(fake.calls, [], "range resolution fails before any model is selected or called");
});

test("branch deletion is allowed without reviewer calls", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });
  const result = await reviewUpdate(
    updateFor({ localSha: ZERO_SHA, remoteSha }),
    remote,
    ws,
    { resolveReviewersImpl: fake.resolveReviewersImpl }
  );

  assert.equal(result.decision, "allow");
  assert.match(result.note, /branch deletion/i);
  assert.deepEqual(fake.calls, []);
});

test("an exhausted total budget stops before Git preparation or reviewer calls", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "late.txt", "too late\n", "late update");
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });
  let resolved = false;

  const result = await reviewUpdate(updateFor({ localSha, remoteSha }), remote, ws, {
    deadline: Date.now() - 1,
    resolveUpdateBaseImpl: () => { resolved = true; return { ok: true, base: remoteSha, localCommit: localSha }; },
    resolveReviewersImpl: fake.resolveReviewersImpl
  });

  assert.equal(result.decision, "unreviewed");
  assert.match(result.note, /45-second budget reached/i);
  assert.equal(resolved, false);
  assert.deepEqual(fake.calls, []);
});

test("a non-fast-forward rewind is explicitly unreviewed without model calls", async () => {
  const { ws, remote, remoteSha: baseSha } = freshRemoteWithMain();
  const remoteTip = commitFile(ws, "critical.txt", "critical security fix\n", "critical security fix");
  git(ws, "push", "-q", "origin", "main");
  git(ws, "reset", "--hard", "-q", baseSha);
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });

  const result = await reviewUpdate(updateFor({ localSha: baseSha, remoteSha: remoteTip }), remote, ws, {
    resolveReviewersImpl: fake.resolveReviewersImpl
  });

  assert.equal(result.decision, "unreviewed");
  assert.match(result.note, /non-fast-forward.*dropped history.*force-push/i);
  assert.deepEqual(fake.calls, []);
});

test("annotated tag updates are peeled and reviewed as commit changes", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  git(ws, "tag", "-a", "v1", "-m", "safe release", remoteSha);
  git(ws, "push", "-q", "origin", "refs/tags/v1");
  const remoteTagObject = git(ws, "rev-parse", "refs/tags/v1");
  const maliciousCommit = commitFile(ws, "release.js", "dangerous release payload\n", "replacement release");
  git(ws, "tag", "-f", "-a", "v1", "-m", "replacement release", maliciousCommit);
  const localTagObject = git(ws, "rev-parse", "refs/tags/v1");
  const update = updateFor({
    localSha: localTagObject,
    remoteSha: remoteTagObject,
    localRef: "refs/tags/v1",
    remoteRef: "refs/tags/v1"
  });
  const resolved = resolveUpdateBase(update, remote, ws);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.base, remoteSha);
  assert.equal(resolved.localCommit, maliciousCommit);
  const evidence = buildPushEvidence({ ...update, localCommit: resolved.localCommit }, resolved.base, ws);
  assert.equal(evidence.ok, true);
  assert.match(evidence.user, /dangerous release payload/);

  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });
  const result = await reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });
  assert.equal(result.decision, "allow");
  assert.deepEqual(fake.calls, ["Grok", "MiMo"]);
});

test("oversized evidence fails open without spending reviewer quota", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const large = Array.from({ length: MAX_PUSH_EVIDENCE_BYTES / 32 + 1024 }, (_, i) => `${i.toString(16).padStart(8, "0")}:not-compressible-as-a-diff-line`).join("\n");
  const localSha = commitFile(ws, "large.txt", `${large}\n`, "large outgoing change");
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });

  const result = await reviewUpdate(
    updateFor({ localSha, remoteSha }),
    remote,
    ws,
    { resolveReviewersImpl: fake.resolveReviewersImpl }
  );

  assert.equal(result.decision, "unreviewed");
  assert.match(result.note, /evidence too large.*split the push/i);
  assert.deepEqual(fake.calls, []);
});

test("an identical retry reuses cached verdicts and makes no additional model calls", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "cached.txt", "cache me\n", "cacheable outgoing change");
  const update = updateFor({ localSha, remoteSha });
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });

  const first = await reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });
  const second = await reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });

  assert.equal(first.decision, "allow");
  assert.equal(second.decision, "allow");
  assert.deepEqual(fake.calls, ["Grok", "MiMo"], "only the first review invokes models");
});

test("the same objects pushed to a different destination ref receive a fresh review", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "ref-specific.txt", "same bytes\n", "ref-specific policy");
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });
  const mainUpdate = updateFor({ localSha, remoteSha });
  const stagingUpdate = updateFor({
    localSha,
    remoteSha,
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/staging"
  });

  const first = await reviewUpdate(mainUpdate, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });
  const second = await reviewUpdate(stagingUpdate, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });

  assert.equal(first.decision, "allow");
  assert.equal(second.decision, "allow");
  assert.equal(second.cached, undefined);
  assert.deepEqual(fake.calls, ["Grok", "MiMo", "Grok", "MiMo"]);
});

test("one valid ALLOW plus one unavailable reviewer allows the push", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "partial.txt", "partial panel\n", "partial panel");
  const fake = reviewers({ Grok: "unavailable", MiMo: "ALLOW" });

  const result = await reviewUpdate(updateFor({ localSha, remoteSha }), remote, ws, {
    resolveReviewersImpl: fake.resolveReviewersImpl
  });

  assert.equal(result.decision, "allow");
  assert.match(result.panel.summary, /Grok review skipped/i);
  assert.deepEqual(fake.calls, ["Grok", "MiMo"]);
});

test("an unchanged partial-panel retry reuses the valid verdict without another call", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "partial-cache.txt", "partial cache\n", "partial cache");
  const update = updateFor({ localSha, remoteSha });
  const fake = reviewers({ Grok: "unavailable", MiMo: "ALLOW" });

  const first = await reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });
  const second = await reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl });

  assert.equal(first.decision, "allow");
  assert.equal(second.decision, "allow");
  assert.equal(second.cached, true);
  assert.deepEqual(fake.calls, ["Grok", "MiMo"], "an unavailable side is not hammered again for identical evidence");
});

test("concurrent identical reviews use one quota-spending panel", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "concurrent.txt", "one panel\n", "one concurrent panel");
  const update = updateFor({ localSha, remoteSha });
  const fake = reviewers({ Grok: "ALLOW", MiMo: "ALLOW" });

  const results = await Promise.all([
    reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl }),
    reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl })
  ]);

  assert.deepEqual(results.map((result) => result.decision), ["allow", "allow"]);
  assert.equal(results.some((result) => result.cached), true);
  assert.deepEqual(fake.calls, ["Grok", "MiMo"]);
});

test("a concurrent contender observes the first review's BLOCK before it can push", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "concurrent-block.txt", "blocked once\n", "one concurrent block");
  const update = updateFor({ localSha, remoteSha });
  const fake = reviewers({ Grok: "BLOCK", MiMo: "ALLOW" });

  const results = await Promise.all([
    reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl }),
    reviewUpdate(update, remote, ws, { resolveReviewersImpl: fake.resolveReviewersImpl })
  ]);

  assert.deepEqual(results.map((result) => result.decision), ["block", "block"]);
  assert.equal(results.some((result) => result.cached), true);
  assert.deepEqual(fake.calls, ["Grok", "MiMo"]);
});

test("an explicit reviewer BLOCK blocks the push", async () => {
  const { ws, remote, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "blocked.txt", "broken\n", "blocked change");
  const fake = reviewers({ Grok: "BLOCK", MiMo: "ALLOW" });

  const result = await reviewUpdate(updateFor({ localSha, remoteSha }), remote, ws, {
    resolveReviewersImpl: fake.resolveReviewersImpl
  });

  assert.equal(result.decision, "block");
  assert.match(result.panel.findings, /\[Grok\]/);
});

test("global disable short-circuits the native gate before review", async () => {
  const { ws, remoteSha } = freshRemoteWithMain();
  const localSha = commitFile(ws, "disabled.txt", "disabled\n", "disabled gate");
  fs.mkdirSync(BENCH_ROOT, { recursive: true });
  fs.writeFileSync(path.join(BENCH_ROOT, "disabled-global"), "disabled global\n");
  let calls = 0;
  try {
    const code = await runMain({
      cwd: ws,
      remote: "origin",
      input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
      reviewUpdateImpl: async () => { calls += 1; return { decision: "block" }; }
    });
    assert.equal(code, 0);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(path.join(BENCH_ROOT, "disabled-global"), { force: true });
  }
});
