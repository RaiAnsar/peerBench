import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { runMain } from "../global-hooks/native-session-start.mjs";
import { normalizeSessionId, readReviewedHead, workspaceStateDir, writeReviewedHead } from "../global-hooks/config-store.mjs";
import {
  adoptSessionUntrackedBaseline,
  markSessionUntrackedStopStarted,
  prepareSessionUntrackedBaselineForStop,
  readSessionUntrackedBaseline,
  recordSessionUntrackedBaseline,
  sessionUntrackedSnapshot
} from "../global-hooks/session-untracked-baseline.mjs";

process.env.BENCH_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-root-")));

test("SessionStart arms a fresh repository before its first push", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-arm-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: ws }).status, 0);
  const result = runMain({ input: { cwd: ws, hook_event_name: "SessionStart", source: "startup" } });
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.match(fs.readFileSync(path.join(ws, ".git", "hooks", "pre-push"), "utf8"), /peerBench managed native pre-push dispatcher/);
});

test("direct Codex SessionStart records the pre-turn HEAD for the later Stop review", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-baseline-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: ws });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
  assert.equal(readReviewedHead(ws), null);

  runMain({
    input: { cwd: ws, hook_event_name: "SessionStart", source: "startup" },
    ensureImpl: () => ({ ok: true, installed: true })
  });
  assert.equal(readReviewedHead(ws), head, "SessionStart supplies the baseline even when no Bash PreToolUse hook runs");

  writeReviewedHead(ws, "older-unreviewed-marker");
  runMain({ input: { cwd: ws }, ensureImpl: () => ({ ok: true, installed: true }) });
  assert.equal(readReviewedHead(ws), "older-unreviewed-marker", "an existing unreviewed baseline is never overwritten");
});

test("SessionStart records untracked identities once per reliable session and never re-baselines later work", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-untracked-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "old-backlog.txt"), "pre-session\n");

  const input = { cwd: ws, session_id: "untracked-session", hook_event_name: "SessionStart", source: "startup" };
  runMain({ input, ensureImpl: () => ({ ok: true, installed: true }) });
  const initial = readSessionUntrackedBaseline(ws, "untracked-session");
  assert.equal(initial?.complete, true);
  assert.deepEqual(initial.initialEntries.map((entry) => entry.path), ["old-backlog.txt"]);
  assert.deepEqual(initial.adoptedEntries, []);

  fs.writeFileSync(path.join(ws, "created-after-start.txt"), "must remain reviewable\n");
  fs.writeFileSync(path.join(ws, "old-backlog.txt"), "modified after start\n");
  runMain({ input, ensureImpl: () => ({ ok: true, installed: true }) });
  assert.deepEqual(
    readSessionUntrackedBaseline(ws, "untracked-session"),
    initial,
    "resume/repeated SessionStart must not bless new or modified paths"
  );
});

test("SessionStart arms Git before baseline capture and never first-baselines a resume or compact", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-order-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  const order = [];
  const common = {
    ensureImpl: () => { order.push("armed"); return { ok: true, installed: true }; },
    recordUntrackedBaselineImpl: () => { order.push("baseline"); throw new Error("injected slow/failing capture"); }
  };
  const startup = runMain({ input: { cwd: ws, session_id: "new", source: "startup" }, ...common });
  assert.equal(startup.installed, true, "baseline failure is fail-safe after the native hook is armed");
  assert.deepEqual(order, ["armed", "baseline"]);

  order.length = 0;
  runMain({ input: { cwd: ws, session_id: "existing", source: "resume" }, ...common });
  runMain({ input: { cwd: ws, session_id: "existing", source: "compact" }, ...common });
  runMain({ input: { cwd: ws, session_id: "existing" }, ...common });
  assert.deepEqual(order, ["armed", "armed", "armed"], "mid-session and source-less lifecycle events cannot create the first backlog baseline");
});

test("the first concurrent SessionStart reservation wins before a later inventory can be captured", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-race-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  let competing;
  const first = recordSessionUntrackedBaseline(ws, "same-session", {
    captureInventoryImpl: () => {
      fs.writeFileSync(path.join(ws, "created-during-race.txt"), "new\n");
      competing = recordSessionUntrackedBaseline(ws, "same-session");
      return {
        complete: true,
        entries: [{ path: "pre-session.txt", identity: "a".repeat(64) }]
      };
    }
  });
  assert.equal(first.recorded, true);
  assert.equal(competing.recorded, false, "the later hook observes the incomplete reservation and never captures");
  assert.equal(competing.complete, false, "an in-flight reservation is not treated as an approved baseline");
  assert.deepEqual(
    readSessionUntrackedBaseline(ws, "same-session")?.initialEntries.map((entry) => entry.path),
    ["pre-session.txt"],
    "the later mid-session path is not blessed by a racing SessionStart"
  );
});

test("a displaced SessionStart lock owner cannot publish its captured inventory", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-lock-fence-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  const sessionId = "displaced-owner";
  const stateFile = path.join(workspaceStateDir(ws), `untracked-baseline.${normalizeSessionId(sessionId)}.json`);
  const lockDir = `${stateFile}.lock`;
  const displacedDir = `${lockDir}.test-displaced`;

  const result = recordSessionUntrackedBaseline(ws, sessionId, {
    captureInventoryImpl: () => {
      fs.renameSync(lockDir, displacedDir);
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`, { mode: 0o600 });
      return { complete: true, entries: [{ path: "pre-session.txt", identity: "c".repeat(64) }] };
    }
  });

  assert.equal(result.recorded, false);
  assert.match(result.reason, /lock was lost/);
  assert.equal(readSessionUntrackedBaseline(ws, sessionId), null, "the displaced owner leaves only its fail-safe incomplete reservation");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).complete, false);
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.rmSync(displacedDir, { recursive: true, force: true });
});

test("Stop adoption cannot overwrite an in-progress SessionStart reservation", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-adopt-race-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  let adopted;
  const captured = recordSessionUntrackedBaseline(ws, "same-session", {
    captureInventoryImpl: () => {
      adopted = adoptSessionUntrackedBaseline(ws, "same-session", {
        complete: true,
        entries: [{ path: "late-unreviewed.txt", identity: "b".repeat(64), reviewable: true }]
      }, "policy");
      return {
        complete: true,
        entries: [{ path: "pre-session.txt", identity: "a".repeat(64) }]
      };
    }
  });
  assert.equal(adopted, false, "an authoritative-looking adoption still cannot replace an incomplete capture reservation");
  assert.equal(captured.recorded, true);
  const baseline = readSessionUntrackedBaseline(ws, "same-session");
  assert.deepEqual(baseline?.initialEntries.map((entry) => entry.path), ["pre-session.txt"]);
  assert.deepEqual(baseline?.adoptedEntries, []);
});

test("a Stop that began before SessionStart publication reviews the whole late baseline", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-stop-start-race-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  const sessionId = "late-session-publication";
  const startedBaseline = readSessionUntrackedBaseline(ws, sessionId);
  assert.equal(startedBaseline, null, "Stop begins before any reservation is visible");

  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  fs.writeFileSync(path.join(ws, "created-while-startup-hashed.txt"), "must be reviewed\n");
  assert.equal(recordSessionUntrackedBaseline(ws, sessionId).recorded, true);

  const prepared = await prepareSessionUntrackedBaselineForStop(ws, sessionId, startedBaseline);
  assert.equal(prepared.safe, true);
  const snapshot = sessionUntrackedSnapshot(ws, sessionId, {
    includeInitial: prepared.safe,
    includeAdopted: prepared.safe,
    expectedGeneration: prepared.expectedGeneration
  });
  assert.equal(snapshot.count, 2, "a baseline published after Stop began excludes nothing");
  assert.match(snapshot.block, /pre-session\.txt[\s\S]*old/);
  assert.match(snapshot.block, /created-while-startup-hashed\.txt[\s\S]*must be reviewed/);
  assert.deepEqual(readSessionUntrackedBaseline(ws, sessionId)?.initialEntries, [], "Stop fences the late publisher with an empty trusted baseline");
});

test("the synchronous pre-lock Stop fence survives termination before baseline preparation", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-stop-prelock-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  const sessionId = "stop-killed-before-lock";
  const startedBaseline = readSessionUntrackedBaseline(ws, sessionId);
  assert.equal(markSessionUntrackedStopStarted(ws, sessionId, startedBaseline), true);

  fs.writeFileSync(path.join(ws, "published-after-stop-started.txt"), "must be reviewed\n");
  assert.equal(recordSessionUntrackedBaseline(ws, sessionId).recorded, true);
  assert.deepEqual(readSessionUntrackedBaseline(ws, sessionId)?.initialEntries, []);
  const nextSnapshot = sessionUntrackedSnapshot(ws, sessionId);
  assert.equal(nextSnapshot.count, 1);
  assert.match(nextSnapshot.block, /published-after-stop-started\.txt[\s\S]*must be reviewed/);
});

test("the Stop-arrival fence survives a wait timeout and defeats a later SessionStart publication", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-stop-timeout-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  const sessionId = "stop-timeout-fence";
  const signalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-signals-"));
  const ready = path.join(signalRoot, "ready");
  const resume = path.join(signalRoot, "resume");
  const moduleUrl = new URL("../global-hooks/session-untracked-baseline.mjs", import.meta.url).href;
  const childCode = `
    import fs from "node:fs";
    const [moduleUrl, ws, sessionId, ready, resume] = process.argv.slice(1);
    const { recordSessionUntrackedBaseline } = await import(moduleUrl);
    const result = recordSessionUntrackedBaseline(ws, sessionId, {
      captureInventoryImpl: () => {
        fs.writeFileSync(ready, "ready");
        const view = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(resume)) Atomics.wait(view, 0, 0, 10);
        return {
          complete: true,
          entries: [
            { path: "pre-session.txt", identity: "d".repeat(64) },
            { path: "late-during-timeout.txt", identity: "e".repeat(64) }
          ]
        };
      }
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, moduleUrl, ws, sessionId, ready, resume], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childOut = "";
  let childErr = "";
  child.stdout.on("data", (chunk) => { childOut += chunk; });
  child.stderr.on("data", (chunk) => { childErr += chunk; });
  for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(ready), true, "SessionStart is holding the baseline lock during capture");

  const startedBaseline = readSessionUntrackedBaseline(ws, sessionId);
  assert.equal(startedBaseline, null);
  const prepared = await prepareSessionUntrackedBaselineForStop(ws, sessionId, startedBaseline, { timeoutMs: 25 });
  assert.equal(prepared.safe, false, "this invocation reviews all when it cannot acquire the startup lock");
  assert.match(prepared.reason, /timed out/);
  fs.writeFileSync(path.join(ws, "late-during-timeout.txt"), "must remain reviewable\n");
  fs.writeFileSync(resume, "resume");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, childErr);
  assert.equal(JSON.parse(childOut).recorded, true, "the late publisher converts its reservation into an empty fenced baseline");
  assert.deepEqual(readSessionUntrackedBaseline(ws, sessionId)?.initialEntries, []);

  const nextSnapshot = sessionUntrackedSnapshot(ws, sessionId);
  assert.equal(nextSnapshot.count, 2, "the next Stop still reviews everything captured after the timed-out invocation began");
  assert.match(nextSnapshot.block, /late-during-timeout\.txt[\s\S]*must remain reviewable/);
  fs.rmSync(signalRoot, { recursive: true, force: true });
});

test("a queued Stop keeps initial exclusions but cannot inherit a newer adoption generation", async () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-stop-adoption-race-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  const sessionId = "queued-before-adoption";
  fs.writeFileSync(path.join(ws, "pre-session.txt"), "old\n");
  assert.equal(recordSessionUntrackedBaseline(ws, sessionId).recorded, true);
  const startedBaseline = readSessionUntrackedBaseline(ws, sessionId);

  fs.writeFileSync(path.join(ws, "reviewed-by-earlier-stop.txt"), "new\n");
  const earlierSnapshot = sessionUntrackedSnapshot(ws, sessionId);
  assert.equal(adoptSessionUntrackedBaseline(ws, sessionId, earlierSnapshot.inventory, "policy"), true);
  assert.notEqual(readSessionUntrackedBaseline(ws, sessionId)?.generation, startedBaseline.generation);

  const prepared = await prepareSessionUntrackedBaselineForStop(ws, sessionId, startedBaseline);
  assert.equal(prepared.safe, true);
  assert.equal(prepared.expectedGeneration, startedBaseline.generation);
  const queuedSnapshot = sessionUntrackedSnapshot(ws, sessionId, {
    includeInitial: true,
    includeAdopted: true,
    expectedGeneration: prepared.expectedGeneration
  });
  assert.equal(queuedSnapshot.count, 1, "the queued Stop cannot reuse an ALLOW adoption committed after it began");
  assert.match(queuedSnapshot.block, /reviewed-by-earlier-stop\.txt[\s\S]*new/);
  assert.doesNotMatch(queuedSnapshot.block, /pre-session\.txt[\s\S]*old/);
});

test("SessionStart preserves legacy behavior when no reliable session id exists", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-untracked-anon-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "backlog.txt"), "pre-session\n");
  let baselineCalls = 0;
  runMain({
    input: { cwd: ws, hook_event_name: "SessionStart" },
    ensureImpl: () => ({ ok: true, installed: true }),
    recordUntrackedBaselineImpl: () => { baselineCalls += 1; }
  });
  assert.equal(baselineCalls, 0, "an anonymous hook cannot create cross-session exclusion state");
});

test("SessionStart does not seed reviewed-head while peerBench is disabled", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "peerbench-session-disabled-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], { cwd: ws });
  runMain({
    input: { cwd: ws },
    ensureImpl: () => ({ ok: true, installed: true }),
    isBenchDisabledImpl: () => true
  });
  assert.equal(readReviewedHead(ws), null);
});

test("SessionStart is quiet outside Git and visibly reports a real install conflict", () => {
  let output = "";
  const outside = runMain({ input: { cwd: "/tmp" }, ensureImpl: () => ({ ok: false, installed: false, reason: "not a Git repository" }), stdout: (s) => { output += s; } });
  assert.equal(outside.installed, false);
  assert.equal(output, "");
  runMain({ input: { cwd: "/repo" }, ensureImpl: () => ({ ok: false, installed: false, reason: "hook conflict" }), stdout: (s) => { output += s; } });
  assert.match(JSON.parse(output).systemMessage, /hook conflict/);
});
