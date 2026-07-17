import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

// Small budget so the timeout test is fast; block/allow stubs resolve immediately and beat it.
process.env.BENCH_MERGE_GATE_BUDGET_MS = "300";
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pmg-root-"));

import { buildMergePrompt, captureGitBounded, parseMergeSegment, findMergeSegment, runMain } from "../global-hooks/pre-merge-review.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

// ── detection ──────────────────────────────────────────────────────────────
test("findMergeSegment detects a real git merge and its ref", () => {
  assert.deepEqual(findMergeSegment("git merge staging")?.refs, ["staging"]);
  assert.deepEqual(findMergeSegment("git merge origin/main")?.refs, ["origin/main"]);
  assert.deepEqual(findMergeSegment("cd repo && git merge feature")?.refs, ["feature"]);
  assert.deepEqual(findMergeSegment("FOO=1 git merge x")?.refs, ["x"]);
  assert.deepEqual(findMergeSegment("git -C /r merge y")?.refs, ["y"]);
  assert.deepEqual(findMergeSegment("git merge --no-ff release")?.refs, ["release"]);
});

test("parseMergeSegment skips value-flag values so refs[0] is the branch, not the -m message", () => {
  assert.deepEqual(parseMergeSegment('git merge -m "wip merge" staging')?.refs, ["staging"]);
  assert.deepEqual(parseMergeSegment("git merge --no-ff -m msg -s recursive staging")?.refs, ["staging"]);
});

test("parseMergeSegment sees the argv the SHELL passes to git (redirects lexed out, control ops end the command)", () => {
  assert.deepEqual(parseMergeSegment("git merge feature 2>&1")?.refs, ["feature"]);
  assert.deepEqual(parseMergeSegment("git merge --no-ff release 2>&1")?.refs, ["release"]);
  assert.deepEqual(parseMergeSegment("git merge feature 2>&1 | tee log")?.refs, ["feature"]);
  // a GENUINE octopus merge is still parsed with both refs
  assert.deepEqual(parseMergeSegment("git merge feature-a feature-b 2>&1")?.refs, ["feature-a", "feature-b"]);
  // a redirect BETWEEN the octopus refs must not drop the second ref
  assert.deepEqual(parseMergeSegment("git merge feature-a 2>/dev/null feature-b")?.refs, ["feature-a", "feature-b"]);
  // an UNQUOTED mid-word redirect (stop-gate catch): the shell hands git the ref `feature` —
  // keeping `feature>/dev/null` whole made rev-parse fail and the merge gate fail OPEN
  assert.deepEqual(parseMergeSegment("git merge feature>/dev/null")?.refs, ["feature"]);
  // a QUOTED `>` is literal — a deliberate `>`-in-ref survives intact
  assert.deepEqual(parseMergeSegment('git merge "feature>old"')?.refs, ["feature>old"]);
  // a heredoc delimiter is NOT a second ref (stop-gate catch: `EOF` as a ref failed open)
  assert.deepEqual(parseMergeSegment("git merge feature << EOF")?.refs, ["feature"]);
  // input-FD duplication between octopus refs (stop-gate catch: the segment splitter kept only
  // `>`-adjacent &, so `3<&0` split its segment and dropped feature-b from review)
  assert.deepEqual(findMergeSegment("git merge feature-a 3<&0 feature-b")?.refs, ["feature-a", "feature-b"]);
  // only COMMAND-position `git` counts (stop-gate catch): a fake `echo g\it merge bad-ref` segment
  // must not shadow the REAL octopus merge — the fake's unresolvable ref failed the gate OPEN
  assert.deepEqual(findMergeSegment("echo g\\it merge does-not-exist & git merge feature-a feature-b")?.refs,
    ["feature-a", "feature-b"]);
  assert.equal(findMergeSegment("echo git merge x"), null);
});

test("findMergeSegment ignores --abort/--continue/--quit and non-merge git commands", () => {
  assert.equal(findMergeSegment("git merge --abort"), null);
  assert.equal(findMergeSegment("git merge --continue"), null);
  assert.equal(findMergeSegment("git merge --quit"), null);
  assert.equal(findMergeSegment("git status"), null);
  assert.equal(findMergeSegment("git commit -m 'merge stuff'"), null);
});

test("findMergeSegment collects EVERY merge segment of a compound command (a later merge cannot bypass the gate)", () => {
  assert.deepEqual(findMergeSegment("git merge feature-a && git merge feature-b")?.refs, ["feature-a", "feature-b"]);
  assert.deepEqual(findMergeSegment("git status; git merge a || git merge b")?.refs, ["a", "b"]);
  assert.deepEqual(findMergeSegment("git merge --abort; git merge feature")?.refs, ["feature"]);
  // a ref-less segment merges the upstream — dropping it would leave that merge ungated
  assert.deepEqual(findMergeSegment("git merge && git merge branch")?.refs, ["@{u}", "branch"]);
});

test("parseMergeSegment treats --cleanup's value as a flag argument, not a ref", () => {
  assert.deepEqual(parseMergeSegment("git merge --cleanup whitespace feature")?.refs, ["feature"]);
  assert.deepEqual(parseMergeSegment("git merge --cleanup=whitespace feature")?.refs, ["feature"]);
});

// ── runMain on a real repo ───────────────────────────────────────────────────
function repoWithIncoming() {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pmg-ws-")));
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base");
  g("checkout", "-q", "-b", "staging");
  fs.writeFileSync(path.join(ws, "f.js"), "export const x = 1;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat: add x");
  g("checkout", "-q", "main");
  return ws;
}
function capture() {
  let out = "";
  return { emitter: { hasEmitted: () => !!out, emit: (p) => { if (!out) out = JSON.stringify(p); return true; } }, get payload() { return out ? JSON.parse(out) : null; } };
}
const stubReviewer = (verdict, raw) => ({ name: "MiMo", async run() { return { name: "MiMo", verdict, firstLine: raw.split("\n")[0], raw }; } });

async function captureReviewedPrompt(ws, {
  command = "git merge staging",
  sessionId = `evidence-${path.basename(ws)}`,
  env = {}
} = {}) {
  const cap = capture();
  let userPrompt = "";
  let reviewerCalls = 0;
  await runMain({
    input: { cwd: ws, session_id: sessionId, tool_input: { command } },
    env: { ...process.env, ...env, BENCH_MERGE_REVIEW_REFRESH: "1" },
    resolveReviewersImpl: () => [{
      name: "MiMo",
      reviewIdentity: { kind: "api", model: "evidence-audit" },
      async run({ user }) {
        reviewerCalls++;
        userPrompt = user;
        return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: complete evidence", raw: "ALLOW: complete evidence\nSEVERITY: none" };
      }
    }],
    enqueueImpl: () => true,
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: cap.emitter,
    exit: () => {}
  });
  return { payload: cap.payload, userPrompt, reviewerCalls };
}

test("merge prompt demands one exhaustive grouped all-blockers pass with no finding cap", () => {
  const evidence = { ok: true, complete: true, totalBytes: 1, sha256: "a".repeat(64), text: "x" };
  const { system, user } = buildMergePrompt([{ refs: ["staging"], range: "a..b", commitCount: 1, commitsEvidence: evidence, historyEvidence: evidence }]);
  assert.match(system, /ONE exhaustive discovery pass/);
  assert.match(system, /never stop after the first blocker/);
  assert.match(system, /every verified independent blocking issue/);
  assert.match(system, /group sibling manifestations under their shared root cause/);
  assert.match(system, /no finding-count cap/);
  assert.match(user, /Immutable range: a\.\.b/);
});

test("runMain: merge INTO a protected branch with a high BLOCK → deny + user-visible systemMessage", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let enqueued = null;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [stubReviewer("BLOCK", "BLOCK: null deref\nSEVERITY: high\n- f.js:1 crashes")],
    enqueueImpl: (_ws, job) => { enqueued = job; return true; },
    writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false,
    emitter: cap.emitter,
    exit: () => {}
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(cap.payload.systemMessage, /bench merge BLOCKED/);
  assert.match(cap.payload.systemMessage, /staging → main/);
  // The queued deep review must be SHA-PINNED (never symbolic HEAD..ref — it runs AFTER the merge
  // advances HEAD, where the symbolic range is empty/wrong) and kind:"merge" (its durable-block
  // identity recomputes as merge:<range>; kind:"push" made every merge block retire at the next Stop).
  const sha = (ref) => execFileSync("git", ["rev-parse", ref], { cwd: ws, encoding: "utf8" }).trim();
  assert.ok(enqueued, "a deep async review is enqueued");
  assert.equal(enqueued.kind, "merge");
  assert.equal(enqueued.range, `${sha("HEAD")}..${sha("staging")}`, "range pinned to SHAs at enqueue time");
});

test("runMain: an OCTOPUS merge enqueues a deep review per ref and reviews every ref's commits", async () => {
  const ws = repoWithIncoming();
  // second incoming branch alongside staging
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("checkout", "-q", "-b", "feature-b", "main");
  fs.writeFileSync(path.join(ws, "g.js"), "export const y = 2;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat: add y");
  g("checkout", "-q", "main");
  const sha = (ref) => execFileSync("git", ["rev-parse", ref], { cwd: ws, encoding: "utf8" }).trim();
  const cap = capture();
  const enqueued = [];
  let userPrompt = "";
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging feature-b" } },
    resolveReviewersImpl: () => [{ name: "MiMo", async run({ user }) { userPrompt = user; return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }; } }],
    enqueueImpl: (_ws, job) => { enqueued.push(job); return true; },
    writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(enqueued.length, 2, "every octopus ref gets its own deep review (refs[1..] must not bypass the gate)");
  assert.deepEqual(enqueued.map((j) => j.range).sort(), [`${sha("HEAD")}..${sha("feature-b")}`, `${sha("HEAD")}..${sha("staging")}`].sort());
  assert.ok(enqueued.every((j) => j.kind === "merge"));
  assert.match(userPrompt, /add x/, "staging's commits are in the fast review");
  assert.match(userPrompt, /add y/, "feature-b's commits are in the fast review too");
});

test("runMain: merge while on a NON-protected branch is not gated (reviewers never called)", async () => {
  const ws = repoWithIncoming();
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: ws });   // current branch = feature (not protected)
  const cap = capture();
  let called = false;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge main" } },
    resolveReviewersImpl: () => { called = true; return []; },
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(called, false, "a merge into a non-protected branch must not run the panel");
  assert.equal(cap.payload, null, "no decision emitted (silent allow)");
});

test("runMain: a hung reviewer → FAIL OPEN (allow) within the budget, never a hang", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let exited = false;
  const hung = { name: "MiMo", run: () => new Promise(() => {}) };   // never resolves
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [hung],
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => { exited = true; }
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "allow", "a hung review must fail OPEN, not block");
  assert.match(cap.payload.systemMessage, /timed out/);
  assert.equal(exited, true, "the timeout path exits so it never lingers on the dangling promise");

  const retry = capture();
  let retryCalls = 0;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [{
      name: "MiMo",
      async run() {
        retryCalls++;
        return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: recovered", raw: "ALLOW: recovered\nSEVERITY: none" };
      }
    }],
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: retry.emitter, exit: () => {}
  });
  assert.equal(retryCalls, 1, "timeout releases the identity lease before hard exit so the next attempt can review immediately");
  assert.doesNotMatch(retry.payload.hookSpecificOutput.permissionDecisionReason, /already in progress/);
});

test("runMain: nothing to merge (already up to date) → quiet allow, no review", async () => {
  const ws = repoWithIncoming();
  const cap = capture();
  let called = false;
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge main" } },   // HEAD..main is empty (we're on main)
    resolveReviewersImpl: () => { called = true; return []; },
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(called, false);
  assert.match(cap.payload.hookSpecificOutput.permissionDecisionReason, /nothing to merge/);
});

test("captureGitBounded streams and hashes output beyond 64 MiB without an exec maxBuffer false-empty", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pmg-fake-git-"));
  const fakeGit = path.join(bin, "git");
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const chunk = Buffer.alloc(1024 * 1024, 120);
let sent = 0;
function pump() {
  while (sent < 65) {
    const ok = process.stdout.write(chunk);
    sent++;
    if (!ok) { process.stdout.once("drain", pump); return; }
  }
}
pump();
`);
  fs.chmodSync(fakeGit, 0o755);
  const result = await captureGitBounded(["ignored"], bin, {
    maxBytes: 1024,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` }
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 65 * 1024 * 1024);
  assert.equal(result.complete, false, "oversized output is explicit, never mistaken for an empty complete diff");
  assert.equal(Buffer.byteLength(result.text), 1024);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("captureGitBounded terminates a hung Git evidence process instead of wedging the merge hook", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pmg-hung-git-"));
  const fakeGit = path.join(bin, "git");
  fs.writeFileSync(fakeGit, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  fs.chmodSync(fakeGit, 0o755);
  const started = Date.now();
  const result = await captureGitBounded(["ignored"], bin, {
    maxBytes: 1024,
    timeoutMs: 50,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` }
  });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.match(result.error, /timed out after 50ms/);
  assert.ok(Date.now() - started < 1500, "hung Git is killed within the bounded capture timeout");
});

test("runMain: exact immutable-range ALLOW is cached by reviewer/model identity and skips evidence + panel on retry", async () => {
  const ws = repoWithIncoming();
  let model = "mimo-a";
  let reviewerCalls = 0;
  let evidenceCalls = 0;
  const captureGitImpl = async (args) => {
    evidenceCalls++;
    const text = args.includes("-p") ? "diff --git a/f.js b/f.js\n+export const x = 1;" : "abc feat: add x";
    return { ok: true, complete: true, text, totalBytes: Buffer.byteLength(text), sha256: "b".repeat(64) };
  };
  const resolveReviewersImpl = () => [{
    name: "mimo",
    reviewIdentity: { kind: "api", model, baseURL: "https://review.invalid" },
    async run() {
      reviewerCalls++;
      return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean\nSEVERITY: none" };
    }
  }];
  const invoke = async () => {
    const cap = capture();
    await runMain({
      input: { cwd: ws, session_id: "cache-session", tool_input: { command: "git merge staging" } },
      resolveReviewersImpl, captureGitImpl, enqueueImpl: () => true, writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}
    });
    return cap.payload;
  };

  assert.match((await invoke()).hookSpecificOutput.permissionDecisionReason, /exact ALLOW/);
  assert.equal(reviewerCalls, 1);
  assert.equal(evidenceCalls, 2);
  assert.match((await invoke()).hookSpecificOutput.permissionDecisionReason, /cached exact ALLOW/);
  assert.equal(reviewerCalls, 1, "unchanged retry does not rerun the panel");
  assert.equal(evidenceCalls, 2, "unchanged retry does not even re-stream immutable Git objects");

  model = "mimo-b";
  assert.match((await invoke()).hookSpecificOutput.permissionDecisionReason, /exact ALLOW/);
  assert.equal(reviewerCalls, 2, "changing the actual reviewer model invalidates the old ALLOW");
  assert.equal(evidenceCalls, 4);
});

test("runMain: duplicate octopus aliases are resolved but each immutable incoming range is inspected and queued once", async () => {
  const ws = repoWithIncoming();
  execFileSync("git", ["branch", "staging-copy", "staging"], { cwd: ws });
  const enqueued = [];
  let userPrompt = "";
  let reviewerCalls = 0;
  const cap = capture();
  const resolveReviewersImpl = () => [{ name: "MiMo", async run({ user }) { reviewerCalls++; userPrompt = user; return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean\nSEVERITY: none" }; } }];
  await runMain({
    input: { cwd: ws, session_id: "dedupe-session", tool_input: { command: "git merge staging staging staging-copy" } },
    resolveReviewersImpl,
    enqueueImpl: (_ws, job) => { enqueued.push(job); return true; }, writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(enqueued.length, 1, "same target SHA is one deep job even when named repeatedly");
  assert.match(userPrompt, /Incoming refs: staging, staging-copy/);
  assert.equal((userPrompt.match(/Immutable range:/g) || []).length, 1, "same immutable range appears once in the fast pass");

  const retry = capture();
  await runMain({
    input: { cwd: ws, session_id: "dedupe-session", tool_input: { command: "git merge staging-copy staging" } },
    resolveReviewersImpl,
    enqueueImpl: (_ws, job) => { enqueued.push(job); return true; }, writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false, emitter: retry.emitter, exit: () => {}
  });
  assert.match(retry.payload.hookSpecificOutput.permissionDecisionReason, /cached exact ALLOW/);
  assert.equal(reviewerCalls, 1, "ref order and aliases do not change the immutable range-set cache key");
  assert.equal(enqueued.length, 1, "a cached retry does not enqueue the same deep range again");
});

test("runMain: annotated merge tags are peeled to and reviewed as their immutable commit target", async () => {
  const ws = repoWithIncoming();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", "release-candidate", "staging", "-m", "rc"], { cwd: ws });
  const commitSha = execFileSync("git", ["rev-parse", "staging"], { cwd: ws, encoding: "utf8" }).trim();
  const tagSha = execFileSync("git", ["rev-parse", "release-candidate"], { cwd: ws, encoding: "utf8" }).trim();
  assert.notEqual(tagSha, commitSha);
  let job;
  const cap = capture();
  await runMain({
    input: { cwd: ws, session_id: "tag-session", tool_input: { command: "git merge release-candidate" } },
    resolveReviewersImpl: () => [stubReviewer("ALLOW", "ALLOW: clean\nSEVERITY: none")],
    enqueueImpl: (_ws, value) => { job = value; return true; }, writeTraceImpl: () => {},
    isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}
  });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  assert.equal(job.range, `${headSha}..${commitSha}`);
  assert.doesNotMatch(job.range, new RegExp(tagSha));
});

test("runMain: refs/replace cannot substitute or de-type the immutable incoming commit evidence", async () => {
  const ws = repoWithIncoming();
  const incomingSha = execFileSync("git", ["rev-parse", "staging"], { cwd: ws, encoding: "utf8" }).trim();
  const replacementBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: ws,
    input: "SAFE REPLACEMENT DECOY\n",
    encoding: "utf8"
  }).trim();
  // update-ref deliberately bypasses `git replace`'s same-object-type check. Without
  // --no-replace-objects, `<ref>^{commit}`/rev-list/log can now see a blob and the old gate quietly
  // failed open without reviewing the real incoming commit.
  execFileSync("git", ["update-ref", `refs/replace/${incomingSha}`, replacementBlob], { cwd: ws });

  const reviewed = await captureReviewedPrompt(ws, { sessionId: "replace-object-session" });
  assert.equal(reviewed.reviewerCalls, 1, "a replacement blob must not make real incoming commits disappear");
  assert.match(reviewed.userPrompt, /export const x = 1;/, "review sees bytes from the real commit object");
  assert.doesNotMatch(reviewed.userPrompt, /SAFE REPLACEMENT DECOY/);
  assert.match(reviewed.payload.hookSpecificOutput.permissionDecisionReason, /exact ALLOW/);
});

test("runMain: legacy GIT_GRAFT_FILE cannot hide an intermediate incoming commit from evidence", async () => {
  const ws = repoWithIncoming();
  const g = (...args) => execFileSync("git", args, { cwd: ws });
  g("checkout", "-q", "staging");
  fs.writeFileSync(path.join(ws, "transient-graft.env"), "GRAFT_HIDDEN_INTERMEDIATE=must-review\n");
  g("add", "transient-graft.env");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add transient graft payload");
  fs.rmSync(path.join(ws, "transient-graft.env"));
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove transient graft payload");
  g("checkout", "-q", "main");

  const mainSha = execFileSync("git", ["rev-parse", "main"], { cwd: ws, encoding: "utf8" }).trim();
  const stagingSha = execFileSync("git", ["rev-parse", "staging"], { cwd: ws, encoding: "utf8" }).trim();
  const graftFile = path.join(ws, "legacy-grafts");
  fs.writeFileSync(graftFile, `${stagingSha} ${mainSha}\n`);

  const forgedHistory = execFileSync("git", ["-c", "advice.graftFileDeprecated=false", "log", "--no-color", "-p", "main..staging"], {
    cwd: ws,
    encoding: "utf8",
    env: { ...process.env, GIT_GRAFT_FILE: graftFile }
  });
  assert.doesNotMatch(forgedHistory, /GRAFT_HIDDEN_INTERMEDIATE/, "the hostile graft really removes the intermediate commit from ordinary Git history");

  const reviewed = await captureReviewedPrompt(ws, {
    sessionId: "legacy-graft-session",
    env: { GIT_GRAFT_FILE: graftFile }
  });
  assert.equal(reviewed.reviewerCalls, 1);
  assert.match(reviewed.userPrompt, /GRAFT_HIDDEN_INTERMEDIATE=must-review/,
    "pre-merge evidence ignores the inherited graft and reviews the real stored parent graph");
  assert.match(reviewed.payload.hookSpecificOutput.permissionDecisionReason, /exact ALLOW/);
});

test("runMain: complete per-commit patches expose add-then-remove content absent from the net tree diff", async () => {
  const ws = repoWithIncoming();
  const g = (...args) => execFileSync("git", args, { cwd: ws });
  g("checkout", "-q", "staging");
  fs.writeFileSync(path.join(ws, "transient.env"), "SUPER_SECRET_INTERMEDIATE=steal-me\n");
  g("add", "transient.env");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "temporary diagnostic file");
  fs.rmSync(path.join(ws, "transient.env"));
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "cleanup diagnostic file");
  g("checkout", "-q", "main");

  const netDiff = execFileSync("git", ["diff", "main..staging"], { cwd: ws, encoding: "utf8" });
  assert.doesNotMatch(netDiff, /SUPER_SECRET_INTERMEDIATE/, "the final tree diff proves the old evidence was blind");
  const reviewed = await captureReviewedPrompt(ws, { sessionId: "intermediate-history-session" });
  assert.match(reviewed.userPrompt, /SUPER_SECRET_INTERMEDIATE=steal-me/,
    "review evidence includes dangerous bytes from every shipped intermediate commit");
});

test("runMain: external diff, textconv, and committed -diff attributes cannot forge clean evidence", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pmg-attrs-ws-")));
  const g = (...args) => execFileSync("git", args, { cwd: ws });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(ws, ".gitattributes"), "*.js -diff\n*.secret diff=mask\n");
  g("add", ".gitattributes");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base attributes");

  const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmg-diff-driver-"));
  const marker = path.join(driverDir, "diff-driver-was-invoked");
  const driver = path.join(driverDir, "deceptive-diff-driver.sh");
  const quotedMarker = `'${marker.replaceAll("'", `'\"'\"'`)}'`;
  fs.writeFileSync(driver, `#!/bin/sh\nprintf invoked >> ${quotedMarker}\nprintf 'SAFE DRIVER DECOY\\n'\n`);
  fs.chmodSync(driver, 0o755);
  g("config", "diff.external", driver);
  g("config", "diff.mask.textconv", driver);

  g("checkout", "-q", "-b", "staging");
  fs.writeFileSync(path.join(ws, "attribute-hidden.js"), "MALICIOUS_ATTRIBUTE_HIDDEN();\n");
  fs.writeFileSync(path.join(ws, "textconv-hidden.secret"), "MALICIOUS_TEXTCONV_HIDDEN\n");
  g("add", "attribute-hidden.js", "textconv-hidden.secret");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add generated assets");
  g("checkout", "-q", "main");

  const binaryDecoy = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "main..staging", "--", "attribute-hidden.js"], { cwd: ws, encoding: "utf8" });
  assert.match(binaryDecoy, /Binary files .* differ/, "the committed -diff attribute really hides content without --text");
  const textconvDecoy = execFileSync("git", ["diff", "--no-ext-diff", "--textconv", "main..staging", "--", "textconv-hidden.secret"], { cwd: ws, encoding: "utf8" });
  assert.match(textconvDecoy, /SAFE DRIVER DECOY/, "the configured textconv really can forge a clean rendering");
  fs.rmSync(marker);

  const reviewed = await captureReviewedPrompt(ws, { sessionId: "diff-driver-session" });
  assert.match(reviewed.userPrompt, /MALICIOUS_ATTRIBUTE_HIDDEN/,
    "--text defeats a committed -diff attribute instead of accepting only Binary files differ");
  assert.match(reviewed.userPrompt, /MALICIOUS_TEXTCONV_HIDDEN/,
    "--no-textconv exposes stored bytes instead of a configured clean rendering");
  assert.doesNotMatch(reviewed.userPrompt, /SAFE DRIVER DECOY/);
  assert.equal(fs.existsSync(marker), false, "--no-ext-diff/--no-textconv never executes the deceptive driver");
});

test("runMain: immutable incoming evidence never reads an untracked dirty worktree decoy", async () => {
  const ws = repoWithIncoming();
  fs.writeFileSync(path.join(ws, "f.js"), "DIRTY_WORKTREE_DECOY();\n");
  const reviewed = await captureReviewedPrompt(ws, { sessionId: "dirty-worktree-session" });
  assert.match(reviewed.userPrompt, /export const x = 1;/, "review sees the incoming committed blob");
  assert.doesNotMatch(reviewed.userPrompt, /DIRTY_WORKTREE_DECOY/,
    "the current worktree is not a source of merge evidence");
});

test("runMain: oversized evidence is visibly UNREVIEWED, never cached clean, and a complete retry still runs", async () => {
  const ws = repoWithIncoming();
  let oversized = true;
  let reviewerCalls = 0;
  const resolveReviewersImpl = () => [{
    name: "MiMo", reviewIdentity: { kind: "api", model: "mimo" },
    async run() { reviewerCalls++; return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean\nSEVERITY: none" }; }
  }];
  const captureGitImpl = async (args) => {
    const isHistory = args.includes("-p");
    const totalBytes = isHistory && oversized ? 70 * 1024 * 1024 : 32;
    return {
      ok: true,
      complete: !(isHistory && oversized),
      text: isHistory ? "per-commit patch sample" : "abc feat",
      totalBytes,
      sha256: "c".repeat(64)
    };
  };
  const invoke = async () => {
    const cap = capture();
    await runMain({
      input: { cwd: ws, session_id: "oversize-session", tool_input: { command: "git merge staging" } },
      resolveReviewersImpl, captureGitImpl, enqueueImpl: () => true, writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}
    });
    return cap.payload;
  };
  const first = await invoke();
  assert.equal(first.hookSpecificOutput.permissionDecision, "allow", "merge gate remains fail-open for infrastructure/coverage limits");
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /UNREVIEWED \/ coverage incomplete/);
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /73400320 bytes/);
  assert.equal(reviewerCalls, 0, "a truncated sample is never sent out as if it were complete evidence");

  oversized = false;
  const second = await invoke();
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /exact ALLOW/);
  assert.equal(reviewerCalls, 1, "the oversized attempt did not create a false clean cache marker");
});

test("runMain: three changed-revision BLOCKs stay capped forever; reset nonces are explicit and one-shot", async () => {
  const ws = repoWithIncoming();
  const g = (...args) => execFileSync("git", args, { cwd: ws });
  let calls = 0;
  const resolveReviewersImpl = () => [{
    name: "MiMo", reviewIdentity: { kind: "api", model: "mimo" },
    async run() {
      calls++;
      return { name: "MiMo", verdict: "BLOCK", raw: `BLOCK: defect ${calls}\nSEVERITY: high\n- f.js:1 broken revision ${calls}` };
    }
  }];
  const captureGitImpl = async (args) => {
    const text = args.includes("-p") ? "diff --git a/f.js b/f.js\n+broken" : "abc changed target";
    return { ok: true, complete: true, text, totalBytes: Buffer.byteLength(text), sha256: "d".repeat(64) };
  };
  const invoke = async (resetNonce = "0", now = 10_000) => {
    const cap = capture();
    await runMain({
      input: { cwd: ws, session_id: "cycle-session", tool_input: { command: "git merge staging" } },
      env: { ...process.env, BENCH_MERGE_CYCLE_RESET: resetNonce },
      resolveReviewersImpl, captureGitImpl, enqueueImpl: () => true, writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}, nowImpl: () => now
    });
    return cap.payload;
  };
  const advanceTarget = (index) => {
    g("checkout", "-q", "staging");
    fs.appendFileSync(path.join(ws, "f.js"), `export const repair${index} = ${index};\n`);
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `repair ${index}`);
    g("checkout", "-q", "main");
  };

  for (let cycle = 1; cycle <= 3; cycle++) {
    const payload = await invoke();
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, new RegExp(`cycle ${cycle}/3`));
    advanceTarget(cycle);
  }
  const held = await invoke();
  assert.equal(held.hookSpecificOutput.permissionDecision, "allow", "the ceiling is non-waking/fail-open for local merge");
  assert.match(held.hookSpecificOutput.permissionDecisionReason, /UNREVIEWED .*paused after 3 blocked repair cycles/);
  assert.match(held.hookSpecificOutput.permissionDecisionReason, /Prior unresolved findings/);
  assert.equal(calls, 3, "changed revisions cannot evade the task/session ceiling");

  const muchLater = await invoke("0", 10_000 + 365 * 24 * 60 * 60 * 1000);
  assert.equal(muchLater.hookSpecificOutput.permissionDecision, "allow");
  assert.match(muchLater.hookSpecificOutput.permissionDecisionReason, /paused after 3 blocked repair cycles/);
  assert.equal(calls, 3, "unresolved cycle records never age out into three more automatic repairs");

  const reset = await invoke("manual-reset-1");
  assert.equal(reset.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reset.hookSpecificOutput.permissionDecisionReason, /cycle 1\/3/);
  assert.equal(calls, 4, "explicit reset starts exactly one fresh cycle");

  const persistentReset = await invoke("manual-reset-1");
  assert.equal(persistentReset.hookSpecificOutput.permissionDecision, "deny");
  assert.match(persistentReset.hookSpecificOutput.permissionDecisionReason, /cycle 2\/3/);
  assert.equal(calls, 5, "leaving the same reset value exported does not reset every invocation");

  const newNonce = await invoke("manual-reset-2");
  assert.equal(newNonce.hookSpecificOutput.permissionDecision, "deny");
  assert.match(newNonce.hookSpecificOutput.permissionDecisionReason, /cycle 1\/3/);
  assert.equal(calls, 6, "changing the explicit reset nonce intentionally starts one later fresh cycle");
});

test("runMain: identical concurrent reviews are single-flight and BLOCK permanently dominates exact-cache eligibility", async () => {
  const ws = repoWithIncoming();
  let releaseBlockingPanel;
  const blockingPanelMayFinish = new Promise((resolve) => { releaseBlockingPanel = resolve; });
  let blockingPanelEntered;
  const blockingPanelDidEnter = new Promise((resolve) => { blockingPanelEntered = resolve; });
  let blockCalls = 0;
  let allowCalls = 0;
  const identity = { kind: "api", model: "same-model", baseURL: "https://review.invalid" };
  const blockingReviewer = {
    name: "MiMo",
    reviewIdentity: identity,
    async run() {
      blockCalls++;
      blockingPanelEntered();
      await blockingPanelMayFinish;
      return { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: unsafe", raw: "BLOCK: unsafe\nSEVERITY: high\n- f.js:1 defect" };
    }
  };
  const allowingReviewer = {
    name: "MiMo",
    reviewIdentity: identity,
    async run() {
      allowCalls++;
      return { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: clean", raw: "ALLOW: clean\nSEVERITY: none" };
    }
  };
  const invoke = async (reviewer, { refresh = true } = {}) => {
    const cap = capture();
    await runMain({
      input: { cwd: ws, session_id: "concurrent-identity-session", tool_input: { command: "git merge staging" } },
      env: {
        ...process.env,
        BENCH_MERGE_GATE_BUDGET_MS: "2000",
        BENCH_MERGE_REVIEW_REFRESH: refresh ? "1" : "0"
      },
      resolveReviewersImpl: () => [reviewer],
      enqueueImpl: () => true,
      writeTraceImpl: () => {},
      isBenchDisabledImpl: () => false,
      emitter: cap.emitter,
      exit: () => {}
    });
    return cap.payload;
  };

  const blockingInvocation = invoke(blockingReviewer);
  await blockingPanelDidEnter;
  const duplicate = await invoke(allowingReviewer);
  assert.equal(duplicate.hookSpecificOutput.permissionDecision, "allow", "the local merge gate remains fail-open under contention");
  assert.match(duplicate.hookSpecificOutput.permissionDecisionReason, /identical immutable pre-merge review is already in progress/);
  assert.equal(allowCalls, 0, "a duplicate panel cannot race the active BLOCK with a delayed ALLOW");

  releaseBlockingPanel();
  const blocked = await blockingInvocation;
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(blockCalls, 1);

  const laterAllow = await invoke(allowingReviewer);
  assert.equal(laterAllow.hookSpecificOutput.permissionDecision, "allow");
  assert.match(laterAllow.hookSpecificOutput.permissionDecisionReason, /not cached because this immutable identity was previously blocked/);
  assert.equal(allowCalls, 1, "a fresh explicit review may allow the current local attempt");

  const future = await invoke(blockingReviewer, { refresh: false });
  assert.equal(future.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(blockCalls, 2, "the post-BLOCK ALLOW was never reusable as a false-clean exact cache hit");
  assert.doesNotMatch(future.hookSpecificOutput.permissionDecisionReason, /cached exact ALLOW/);
});

test("runMain: EVERY merge in a compound command is gated — `merge a && merge b` reviews/enqueues both and denies on a blocker", async () => {
  const ws = repoWithIncoming();
  const g = (...a) => execFileSync("git", a, { cwd: ws });
  g("checkout", "-q", "-b", "feature-b", "main");
  fs.writeFileSync(path.join(ws, "g.js"), "export const y = 2;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat: add y");
  g("checkout", "-q", "main");
  const sha = (ref) => execFileSync("git", ["rev-parse", ref], { cwd: ws, encoding: "utf8" }).trim();
  const cap = capture();
  const enqueued = [];
  let userPrompt = "";
  await runMain({
    input: { cwd: ws, tool_input: { command: "git merge staging && git merge feature-b" } },
    resolveReviewersImpl: () => [{ name: "MiMo", async run({ user }) { userPrompt = user; return { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\nSEVERITY: high\n- g.js:1 defect" }; } }],
    enqueueImpl: (_ws, job) => { enqueued.push(job); return true; },
    writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "deny", "a blocker in ANY merge of the compound denies the command");
  assert.equal(enqueued.length, 2, "the second merge's range gets its own deep review too (was silently skipped)");
  assert.deepEqual(enqueued.map((j) => j.range).sort(), [`${sha("HEAD")}..${sha("feature-b")}`, `${sha("HEAD")}..${sha("staging")}`].sort());
  assert.match(userPrompt, /add x/, "the first merge's commits are in the fast review");
  assert.match(userPrompt, /add y/, "the second merge's commits are in the fast review too");
});

test("runMain: a merge redirected by --git-dir/GIT_DIR is visibly UNREVIEWED — never reviewed against the wrong repo", async () => {
  const ws = repoWithIncoming();
  const other = repoWithIncoming();   // the repo the merge ACTUALLY targets
  const gitDir = path.join(other, ".git");
  for (const command of [
    `git --git-dir=${gitDir} merge staging`,
    `git --git-dir ${gitDir} merge staging`,
    `GIT_DIR=${gitDir} git merge staging`
  ]) {
    const cap = capture();
    let panelResolved = false;
    await runMain({
      input: { cwd: ws, tool_input: { command } },
      resolveReviewersImpl: () => { panelResolved = true; return [stubReviewer("ALLOW", "ALLOW: clean\nSEVERITY: none")]; },
      enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
      emitter: cap.emitter, exit: () => {}
    });
    assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "allow", "repo redirection fails OPEN");
    assert.match(cap.payload.hookSpecificOutput.permissionDecisionReason, /UNREVIEWED/);
    assert.match(cap.payload.hookSpecificOutput.permissionDecisionReason, /--git-dir\/GIT_DIR/, command);
    assert.match(cap.payload.systemMessage, /UNREVIEWED/);
    assert.equal(panelResolved, false, `the panel never runs against the wrong repository (${command})`);
  }
});

test("runMain: the cycle-exhausted UNREVIEWED path still enqueues the deep reviews", async () => {
  const ws = repoWithIncoming();
  const g = (...args) => execFileSync("git", args, { cwd: ws });
  let calls = 0;
  const enqueued = [];
  const resolveReviewersImpl = () => [{
    name: "MiMo", reviewIdentity: { kind: "api", model: "mimo" },
    async run() {
      calls++;
      return { name: "MiMo", verdict: "BLOCK", raw: `BLOCK: defect ${calls}\nSEVERITY: high\n- f.js:1 broken revision ${calls}` };
    }
  }];
  const captureGitImpl = async (args) => {
    const text = args.includes("-p") ? "diff --git a/f.js b/f.js\n+broken" : "abc changed target";
    return { ok: true, complete: true, text, totalBytes: Buffer.byteLength(text), sha256: "d".repeat(64) };
  };
  const invoke = async () => {
    const cap = capture();
    await runMain({
      input: { cwd: ws, session_id: "cycle-enqueue-session", tool_input: { command: "git merge staging" } },
      resolveReviewersImpl, captureGitImpl,
      enqueueImpl: (_ws, job) => { enqueued.push(job); return true; },
      writeTraceImpl: () => {}, isBenchDisabledImpl: () => false, emitter: cap.emitter, exit: () => {}
    });
    return cap.payload;
  };
  const advanceTarget = (index) => {
    g("checkout", "-q", "staging");
    fs.appendFileSync(path.join(ws, "f.js"), `export const repair${index} = ${index};\n`);
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `repair ${index}`);
    g("checkout", "-q", "main");
  };

  for (let cycle = 1; cycle <= 3; cycle++) {
    assert.equal((await invoke()).hookSpecificOutput.permissionDecision, "deny");
    advanceTarget(cycle);
  }
  assert.equal(enqueued.length, 3, "each blocked attempt queued its deep review");
  const held = await invoke();
  assert.equal(held.hookSpecificOutput.permissionDecision, "allow", "the ceiling stays non-waking/fail-open for the local merge");
  assert.match(held.hookSpecificOutput.permissionDecisionReason, /paused after 3 blocked repair cycles/);
  assert.equal(calls, 3, "the exhausted path never reruns the panel");
  assert.equal(enqueued.length, 4, "the exhausted path still queues the thorough async pass (was zero async coverage)");
  assert.equal(enqueued[3].kind, "merge");
});

test("runMain: a failed ALLOW-cache write is reported as a write failure, not a prior BLOCK", async () => {
  const ws = repoWithIncoming();
  // Force writeMergeAllow to throw: allow-cache as a regular file makes the atomic tmp+rename fail.
  const mergeGate = path.join(workspaceStateDir(ws), "merge-gate");
  fs.mkdirSync(mergeGate, { recursive: true });
  fs.writeFileSync(path.join(mergeGate, "allow-cache"), "not a directory\n");
  const cap = capture();
  await runMain({
    input: { cwd: ws, session_id: "cache-failure-session", tool_input: { command: "git merge staging" } },
    resolveReviewersImpl: () => [stubReviewer("ALLOW", "ALLOW: clean\nSEVERITY: none")],
    enqueueImpl: () => true, writeTraceImpl: () => {}, isBenchDisabledImpl: () => false,
    emitter: cap.emitter, exit: () => {}
  });
  assert.equal(cap.payload.hookSpecificOutput.permissionDecision, "allow", "the current review still allows");
  assert.match(cap.payload.hookSpecificOutput.permissionDecisionReason, /cache write failed/);
  assert.doesNotMatch(cap.payload.hookSpecificOutput.permissionDecisionReason, /previously blocked/,
    "an infrastructure failure must not be attributed to a prior BLOCK");
});
