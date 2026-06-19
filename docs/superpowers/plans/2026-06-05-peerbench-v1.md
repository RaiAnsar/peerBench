# peerbench v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship peerbench v1 — a lean Claude Code plugin wrapping headless `bench`, plus the dual Codex+Bench panel upgrade for the two global plan-gate hooks.

**Architecture:** No persistent processes: every Bench call is one `bench -p <prompt> --output-format json` spawn with a read-only enforcement stack for reviews (permission-mode plan + tool deny-list + optional `--sandbox` profile + post-run workspace-mutation check that fingerprints CONTENT, not just status). Plugin-internal flows (commands) persist job records in a codex-shaped state dir; gate-side Bench runs are stateless. The global hooks in `~/.claude/hooks/` are version-controlled in this repo under `global-hooks/` and deployed by copy. `global-hooks/panel-lib.mjs` is deliberately self-contained (deployed outside the repo, no repo imports), so the workspace-integrity check appears both there and in `scripts/lib/bench-exec.mjs` — an accepted DRY exception.

**Tech Stack:** Node 20+ ESM (`.mjs`), `node:test` for unit tests, `bench` CLI v0.2.20+, Claude Code plugin system (local directory marketplace).

**Spec:** `docs/superpowers/specs/2026-06-05-peerbench-design.md` (Codex-approved 2026-06-05).

**Revision notes:**
- *Codex round 1:* command args passed as ONE quoted string (injection fix); create-once backups; read-only contract completed with `--sandbox` opt-in + mutation-detection-as-failure in BOTH bench spawn paths; `/bench:review` includes untracked file contents.
- *Codex round 2:* `parseArgs()` lifts leading flags from ANY argv element (real template shape is `["--json", "--write fix bug"]`); tests cover exact template shapes including `["review", "--json", "--base main"]`.
- *Codex round 3:* mutation check now fingerprints CONTENT (status + `git diff HEAD` + untracked file content hashes), catching changes to already-dirty files — with "pre-dirty file modified during review" tests in both spawn paths; the ALLOW cooldown is keyed to the sha256 of the APPROVED content (identical re-save skips, ANY content change re-reviews; TTL removed).
- *Codex round 4:* `workspaceFingerprint` enumerates untracked files via `git ls-files --others --exclude-standard -z` and hashes their CONTENT (catches a pre-existing untracked file rewritten during review — new tests in both spawn paths); the ALLOW skip is now a CONTEXT-COMPLETE key — `sha256(POLICY_VERSION \0 HOOK_KIND \0 filePath \0 content)` — so identical text under a different path/hook/policy version never auto-skips, and a `POLICY_VERSION` bump invalidates all prior approvals.

---

## File structure (locked)

```
peerbench/
  .claude-plugin/plugin.json            Task 1
  .claude-plugin/marketplace.json       Task 1
  scripts/lib/bench-state.mjs            Task 2   state dir + jobs (codex-shaped)
  scripts/lib/bench-exec.mjs             Task 3   arg-building + spawn + parse + content-mutation check
  scripts/bench-runner.mjs               Task 4   CLI: task|review|status|setup
  prompts/review.md                     Task 5
  prompts/plan-review.md                Task 5
  commands/setup.md                     Task 6
  commands/status.md                    Task 6
  commands/task.md                      Task 6
  commands/review.md                    Task 6
  global-hooks/panel-lib.mjs            Task 8   shared panel logic (deployed copy, self-contained)
  global-hooks/codex-plan-file-review.mjs  Task 9   dual-panel version (deployed copy)
  global-hooks/codex-plan-review.mjs    Task 10  dual-panel version (deployed copy)
  tests/bench-state.test.mjs             Task 2
  tests/bench-exec.test.mjs              Task 3
  tests/runner.integration.test.mjs     Task 4
  tests/panel-lib.test.mjs              Task 8
  tests/fixtures/fake-bench              Task 3   PATH shim used by all non-live tests
```

Deployment targets owned by this repo from v1 on: `~/.claude/hooks/codex-plan-file-review.mjs`, `~/.claude/hooks/codex-plan-review.mjs`, `~/.claude/hooks/panel-lib.mjs` (copied by Task 11; originals backed up once to `*.pre-panel.bak`, never overwritten on rerun).

---

### Task 1: Plugin + marketplace manifests, repo hygiene

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `.gitignore`

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "peerbench",
  "description": "Bench Build CLI companion: second-reviewer panel, delegation tasks, and review commands driven by headless bench.",
  "version": "0.1.0"
}
```

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`** (required for local directory marketplace install)

```json
{
  "name": "rai-tools",
  "owner": { "name": "Rai Ansar" },
  "plugins": [
    {
      "name": "peerbench",
      "source": "./",
      "description": "Bench second-reviewer panel + delegation for Claude Code"
    }
  ]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 4: Validate JSON and commit**

Run: `jq -e .name .claude-plugin/plugin.json && jq -e '.plugins[0].source' .claude-plugin/marketplace.json`
Expected: `"peerbench"` then `"./"`

```bash
git add .claude-plugin .gitignore
git commit -m "feat: plugin + marketplace manifests"
```

---

### Task 2: State module (codex-shaped, panelStops key)

**Files:**
- Create: `scripts/lib/bench-state.mjs`
- Test: `tests/bench-state.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/bench-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir, loadState, saveState, appendJob } from "../scripts/lib/bench-state.mjs";

function tmpDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-state-test-"));
}

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when set", () => {
  const dataRoot = tmpDataRoot();
  const dir = resolveStateDir("/tmp/some-ws", { env: { CLAUDE_PLUGIN_DATA: dataRoot } });
  assert.ok(dir.startsWith(path.join(dataRoot, "state")));
  assert.match(path.basename(dir), /^some-ws-[0-9a-f]{16}$/);
});

test("resolveStateDir falls back to peerbench-fallback", () => {
  const dir = resolveStateDir("/tmp/some-ws", { env: {} });
  assert.ok(dir.includes(path.join(".claude", "plugins", "data", "peerbench-fallback", "state")));
});

test("loadState returns default schema when missing", () => {
  const dataRoot = tmpDataRoot();
  const st = loadState("/tmp/ws-a", { env: { CLAUDE_PLUGIN_DATA: dataRoot } });
  assert.deepEqual(st, { version: 1, config: { panelStops: false }, jobs: [] });
});

test("saveState then loadState round-trips and appendJob caps at 50", () => {
  const dataRoot = tmpDataRoot();
  const opts = { env: { CLAUDE_PLUGIN_DATA: dataRoot } };
  const st = loadState("/tmp/ws-b", opts);
  st.config.panelStops = true;
  saveState("/tmp/ws-b", st, opts);
  assert.equal(loadState("/tmp/ws-b", opts).config.panelStops, true);
  for (let i = 0; i < 60; i++) {
    appendJob("/tmp/ws-b", { id: `task-${i}`, title: "Bench Task", status: "completed" }, opts);
  }
  assert.equal(loadState("/tmp/ws-b", opts).jobs.length, 50);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bench-state.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/bench-state.mjs'`

- [ ] **Step 3: Implement `scripts/lib/bench-state.mjs`**

```js
// State layout copies codex-companion's envelope shape so debug habits and
// statusline parsing carry over. Key difference: config.panelStops.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FALLBACK_ROOT = path.join(os.homedir(), ".claude", "plugins", "data", "peerbench-fallback");

function defaultState() {
  return { version: 1, config: { panelStops: false }, jobs: [] };
}

export function resolveStateDir(workspaceRoot, { env = process.env } = {}) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dataRoot = env.CLAUDE_PLUGIN_DATA || FALLBACK_ROOT;
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function loadState(workspaceRoot, opts = {}) {
  const file = path.join(resolveStateDir(workspaceRoot, opts), "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: 1,
      config: { panelStops: Boolean(parsed?.config?.panelStops) },
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(workspaceRoot, state, opts = {}) {
  const dir = resolveStateDir(workspaceRoot, opts);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function appendJob(workspaceRoot, job, opts = {}) {
  const state = loadState(workspaceRoot, opts);
  state.jobs = [...state.jobs.filter((j) => j.id !== job.id), job].slice(-50);
  saveState(workspaceRoot, state, opts);
  const dir = resolveStateDir(workspaceRoot, opts);
  fs.writeFileSync(path.join(dir, "jobs", `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bench-state.test.mjs`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/bench-state.mjs tests/bench-state.test.mjs
git commit -m "feat: codex-shaped state module with panelStops"
```

---

### Task 3: Exec module + fake-bench test shim (content-level mutation check)

**Files:**
- Create: `scripts/lib/bench-exec.mjs`
- Create: `tests/fixtures/fake-bench` (chmod +x)
- Test: `tests/bench-exec.test.mjs`

- [ ] **Step 1: Write the fake bench shim** (records argv, emits canned JSON, can simulate workspace mutation)

```bash
#!/bin/bash
# tests/fixtures/fake-bench — records args, replies with canned bench JSON.
# FAKE_BENCH_LOG: file to append argv to.
# FAKE_BENCH_REPLY: JSON to emit (optional).
# FAKE_BENCH_EXIT: nonzero exit simulation (optional).
# FAKE_BENCH_TOUCH: file to (over)write before replying — simulates a review
#                  run that mutates the workspace (must be caught as failure).
printf '%s\n' "$*" >> "${FAKE_BENCH_LOG:-/dev/null}"
if [ -n "$FAKE_BENCH_TOUCH" ]; then echo mutated > "$FAKE_BENCH_TOUCH"; fi
if [ -n "$FAKE_BENCH_EXIT" ]; then exit "$FAKE_BENCH_EXIT"; fi
echo "${FAKE_BENCH_REPLY:-{\"text\":\"ALLOW: looks fine\",\"stopReason\":\"EndTurn\",\"sessionId\":\"fake-session-1\"}}"
```

Run: `chmod +x tests/fixtures/fake-bench`

- [ ] **Step 2: Write the failing tests**

```js
// tests/bench-exec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBenchArgs, runBench, READONLY_DENY_TOOLS } from "../scripts/lib/bench-exec.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ge-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function commitAll(dir, msg = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: dir });
}

function shimEnv(log, extra = {}) {
  return {
    ...process.env,
    BENCH_BIN: path.join(FIXTURES, "fake-bench"),
    FAKE_BENCH_LOG: log,
    ...extra
  };
}

test("buildBenchArgs review mode includes full read-only stack", () => {
  const s = buildBenchArgs({ mode: "review", prompt: "P", cwd: "/ws" }, {}).join(" ");
  assert.ok(s.includes("--permission-mode plan"));
  assert.ok(s.includes(`--disallowed-tools ${READONLY_DENY_TOOLS.join(",")}`));
  assert.ok(s.includes("--no-subagents"));
  assert.ok(s.includes("--disable-web-search"));
  assert.ok(s.includes("--max-turns 8"));
  assert.ok(s.includes("--effort medium"));
  assert.ok(s.includes("--output-format json"));
  assert.ok(!s.includes("--sandbox"));
});

test("buildBenchArgs adds --sandbox when BENCH_SANDBOX_PROFILE set", () => {
  const s = buildBenchArgs({ mode: "review", prompt: "P", cwd: "/ws" }, { BENCH_SANDBOX_PROFILE: "readonly" }).join(" ");
  assert.ok(s.includes("--sandbox readonly"));
});

test("buildBenchArgs write mode omits read-only stack, raises turns", () => {
  const s = buildBenchArgs({ mode: "write", prompt: "P", cwd: "/ws" }, {}).join(" ");
  assert.ok(!s.includes("--permission-mode plan"));
  assert.ok(!s.includes("--disallowed-tools"));
  assert.ok(s.includes("--max-turns 40"));
});

test("runBench parses fake bench JSON", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ge-")), "argv.log");
  const ws = tmpGitRepo();
  const res = await runBench({ mode: "review", prompt: "review this", cwd: ws }, { env: shimEnv(log) });
  assert.equal(res.status, 0);
  assert.equal(res.rawOutput, "ALLOW: looks fine");
  assert.equal(res.sessionId, "fake-session-1");
  assert.match(fs.readFileSync(log, "utf8"), /--permission-mode plan/);
});

test("runBench review mode detects NEW file creation -> failure", async () => {
  const ws = tmpGitRepo();
  const res = await runBench(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_BENCH_TOUCH: path.join(ws, "SHOULD_NOT_EXIST") }) }
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runBench review mode detects content change to ALREADY-DIRTY file -> failure", async () => {
  // The git-status-only check would miss this: the file is dirty both before
  // and after, so porcelain output is identical. Content fingerprint catches it.
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "doc.md"), "v1\n");
  commitAll(ws);
  fs.writeFileSync(path.join(ws, "doc.md"), "v2 dirty before review\n"); // dirty pre-review
  const res = await runBench(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_BENCH_TOUCH: path.join(ws, "doc.md") }) } // bench rewrites the dirty file
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runBench review mode detects rewrite of a PRE-EXISTING untracked file -> failure", async () => {
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "notes.txt"), "original untracked\n"); // untracked, unchanged status both sides
  const res = await runBench(
    { mode: "review", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_BENCH_TOUCH: path.join(ws, "notes.txt") }) }
  );
  assert.notEqual(res.status, 0);
  assert.match(String(res.error), /mutated/i);
});

test("runBench write mode does NOT run mutation check", async () => {
  const ws = tmpGitRepo();
  const res = await runBench(
    { mode: "write", prompt: "x", cwd: ws },
    { env: shimEnv("/dev/null", { FAKE_BENCH_TOUCH: path.join(ws, "expected-edit.txt") }) }
  );
  assert.equal(res.status, 0);
});

test("runBench surfaces nonzero exit as error result", async () => {
  const ws = tmpGitRepo();
  const res = await runBench({ mode: "review", prompt: "x", cwd: ws }, { env: shimEnv("/dev/null", { FAKE_BENCH_EXIT: "3" }) });
  assert.equal(res.status, 3);
  assert.equal(res.rawOutput, "");
});

test("runBench missing binary -> error result, no throw", async () => {
  const res = await runBench({ mode: "review", prompt: "x", cwd: "/tmp" }, { env: { ...process.env, BENCH_BIN: "/nonexistent/bench" } });
  assert.notEqual(res.status, 0);
  assert.ok(res.error);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/bench-exec.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `scripts/lib/bench-exec.mjs`**

```js
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Bench mirrors Claude Code tool naming (its --help references Claude Code
// flags). Verified against `bench inspect` during implementation — adjust this
// list there if names differ; --permission-mode plan is the primary guard
// and carries enforcement even if a name here is wrong.
export const READONLY_DENY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

const TIMEOUT_MS = 13 * 60 * 1000;

// env.BENCH_SANDBOX_PROFILE: optional sandbox profile name (spec: applied when
// discoverable). Set it in ~/.claude/settings.json env once a valid profile
// name for the installed bench version is known; unset = flag omitted and the
// permission-mode/deny-list/mutation-check layers carry enforcement.
export function buildBenchArgs({ mode, prompt, cwd, effort = "medium", maxTurns }, env = process.env) {
  const args = ["-p", prompt, "--output-format", "json", "--cwd", cwd, "--effort", effort];
  if (mode === "review") {
    args.push(
      "--permission-mode", "plan",
      "--disallowed-tools", READONLY_DENY_TOOLS.join(","),
      "--no-subagents",
      "--disable-web-search",
      "--max-turns", String(maxTurns ?? 8)
    );
    if (env.BENCH_SANDBOX_PROFILE) {
      args.push("--sandbox", env.BENCH_SANDBOX_PROFILE);
    }
  } else {
    args.push("--max-turns", String(maxTurns ?? 40));
  }
  return args;
}

// CONTENT-level workspace fingerprint for the mutation check. Status alone is
// not enough: a file that is dirty before the review stays "M" in porcelain
// output even if its content changes again during the review. So the
// fingerprint hashes: porcelain status + full `git diff HEAD` (tracked
// changes, staged+unstaged) + the content of every untracked file. Non-git
// dirs return null (check skipped; other enforcement layers still apply).
export function workspaceFingerprint(cwd) {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      diff = ""; // repo with no commits: nothing tracked; untracked hashing below covers it
    }
    const h = createHash("sha256").update(status).update(" ").update(diff);
    // NUL-separated enum handles spaces/newlines in names; hashing CONTENT is
    // what catches a PRE-EXISTING untracked file rewritten during review (its
    // porcelain "?? name" line is unchanged in that case).
    let untracked = [];
    try {
      untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
      }).split("\0").filter(Boolean).sort();
    } catch {
      untracked = [];
    }
    for (const name of untracked) {
      h.update(" ").update(name).update(" ");
      try {
        h.update(fs.readFileSync(path.join(cwd, name)));
      } catch {
        h.update("unreadable");
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

export function runBench(request, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const bin = env.BENCH_BIN || "bench";
  const args = buildBenchArgs(request, env);
  const preFingerprint = request.mode === "review" ? workspaceFingerprint(request.cwd) : null;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: request.cwd, env });
    } catch (error) {
      finish({ status: 127, rawOutput: "", sessionId: null, error: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ status: 124, rawOutput: "", sessionId: null, error: "bench timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ status: 127, rawOutput: "", sessionId: null, error: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (request.mode === "review" && preFingerprint !== null) {
        const post = workspaceFingerprint(request.cwd);
        if (post !== null && post !== preFingerprint) {
          finish({ status: 1, rawOutput: "", sessionId: null, error: "bench mutated the workspace during a read-only review — result discarded" });
          return;
        }
      }
      if (code !== 0) {
        finish({ status: code ?? 1, rawOutput: "", sessionId: null, error: stderr.trim().slice(0, 400) || `bench exited ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        finish({ status: 0, rawOutput: String(parsed.text ?? "").trim(), sessionId: parsed.sessionId ?? null });
      } catch {
        finish({ status: 1, rawOutput: "", sessionId: null, error: "bench returned non-JSON output" });
      }
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/bench-exec.test.mjs`
Expected: 10 passing

- [ ] **Step 6: Verify deny-tool names and probe for sandbox profile names**

Run: `bench inspect 2>/dev/null | grep -iE "tools?|sandbox" | head -20` and `bench --help | grep -B2 -A4 sandbox`
Expected: tool naming + any documented sandbox profile values. Actions:
- If write-capable tool names differ from `READONLY_DENY_TOOLS`, update the constant AND the test expectation, re-run tests.
- If a valid read-only sandbox profile name is found, add to `~/.claude/settings.json` env: `"BENCH_SANDBOX_PROFILE": "<name>"` and live-verify `bench -p "say ok" --sandbox <name> --output-format json` succeeds. If none found, leave unset (documented fallback per spec).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/bench-exec.mjs tests/bench-exec.test.mjs tests/fixtures/fake-bench
git commit -m "feat: bench exec module — read-only stack, sandbox opt-in, content-level mutation check"
```

---

### Task 4: Runner CLI (flag-lifting arg parser, untracked-aware review)

**Files:**
- Create: `scripts/bench-runner.mjs`
- Test: `tests/runner.integration.test.mjs`

The command templates (Task 6) invoke the runner as `task --json "$ARGUMENTS"` — so the runner receives MIXED argv like `["--json", "--write fix bug"]` or `["--json", "--base main"]`: standalone flag elements first, then ONE quoted string that may itself START with flags and end with the verbatim prompt. `parseArgs()` handles exactly that: it consumes standalone flag elements, then lifts leading flag tokens off the front of the first non-flag element; the remainder of that element is the prompt, character-for-character (no shell re-splitting — injection-safe).

- [ ] **Step 1: Write the failing integration tests**

```js
// tests/runner.integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "scripts", "bench-runner.mjs");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  return ws;
}

function run(args, { ws = freshWs(), envExtra = {} } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const out = execFileSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    cwd: ws,
    env: {
      ...process.env,
      BENCH_BIN: path.join(FIXTURES, "fake-bench"),
      CLAUDE_PLUGIN_DATA: dataRoot,
      FAKE_BENCH_LOG: path.join(dataRoot, "argv.log"),
      ...envExtra
    }
  });
  return { out, dataRoot, ws };
}

test("task --json returns runner JSON and records a job", () => {
  const { out, dataRoot } = run(["task", "--json", "do the thing"]);
  const payload = JSON.parse(out);
  assert.equal(payload.status, 0);
  assert.equal(payload.rawOutput, "ALLOW: looks fine");
  assert.equal(payload.sessionId, "fake-session-1");
  const stateDirs = fs.readdirSync(path.join(dataRoot, "state"));
  assert.equal(stateDirs.length, 1);
  const jobs = fs.readdirSync(path.join(dataRoot, "state", stateDirs[0], "jobs"));
  assert.equal(jobs.length, 1);
});

test("template shape: ['task','--json','--write fix …'] — embedded flag lifted, prompt verbatim", () => {
  // Exactly what `task --json "$ARGUMENTS"` produces when the user typed
  // `/bench:task --write fix the "auth bug" in app.ts; don't touch tests`.
  const { dataRoot } = run(["task", "--json", `--write fix the "auth bug" in app.ts; don't touch tests`]);
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.doesNotMatch(log, /--permission-mode plan/); // --write recognized -> write mode
  assert.match(log, /fix the "auth bug" in app\.ts; don't touch tests/); // prompt intact incl. quotes/semicolon
  assert.doesNotMatch(log, /-p --write/); // the flag was lifted, not left in the prompt
});

test("template shape: ['review','--json','--base main'] — embedded --base recognized", () => {
  const ws = freshWs();
  fs.writeFileSync(path.join(ws, "feature.txt"), "NEEDLE_BRANCH_DIFF\n");
  execFileSync("git", ["checkout", "-qb", "feat"], { cwd: ws });
  execFileSync("git", ["add", "feature.txt"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat"], { cwd: ws });
  const { dataRoot } = run(["review", "--json", "--base main"], { ws });
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.match(log, /NEEDLE_BRANCH_DIFF/);   // base diff content reached the prompt
  assert.doesNotMatch(log, /--base main/);   // flag consumed, not leaked into prompt
});

test("task without --write runs read-only; with --write relaxes", () => {
  const a = run(["task", "--json", "investigate"]);
  assert.match(fs.readFileSync(path.join(a.dataRoot, "argv.log"), "utf8"), /--permission-mode plan/);
  const b = run(["task", "--json", "--write", "fix it"]);
  assert.doesNotMatch(fs.readFileSync(path.join(b.dataRoot, "argv.log"), "utf8"), /--permission-mode plan/);
});

test("review includes untracked file contents", () => {
  const ws = freshWs();
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "brand-new.ts"), "export const NEEDLE_UNTRACKED = 42;\n");
  const { dataRoot } = run(["review", "--json"], { ws });
  const log = fs.readFileSync(path.join(dataRoot, "argv.log"), "utf8");
  assert.match(log, /NEEDLE_UNTRACKED/);          // content present in prompt
  assert.match(log, /src\/brand-new\.ts/);         // labeled with its path
});

test("status prints recorded jobs", () => {
  const ws = freshWs();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const env = {
    ...process.env,
    BENCH_BIN: path.join(FIXTURES, "fake-bench"),
    CLAUDE_PLUGIN_DATA: dataRoot,
    FAKE_BENCH_LOG: "/dev/null"
  };
  execFileSync(process.execPath, [RUNNER, "task", "--json", "first"], { encoding: "utf8", cwd: ws, env });
  const out = execFileSync(process.execPath, [RUNNER, "status"], { encoding: "utf8", cwd: ws, env });
  assert.match(out, /Bench Task/);
  assert.match(out, /completed/);
});

test("setup reports version or missing binary without throwing", () => {
  const { out } = run(["setup"]);
  assert.match(out, /bench|BENCH/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runner.integration.test.mjs`
Expected: FAIL — runner missing

- [ ] **Step 3: Implement `scripts/bench-runner.mjs`**

```js
#!/usr/bin/env node
// peerbench runtime CLI.
// Usage:
//   bench-runner.mjs task [--json] [--write] [--effort E] [--max-turns N] <prompt…>
//   bench-runner.mjs review [--json] [--base <ref>]
//   bench-runner.mjs status
//   bench-runner.mjs setup
//
// Slash-command templates call `task --json "$ARGUMENTS"`, producing mixed
// argv: standalone flags first, then ONE quoted element that may START with
// flags and end with the verbatim prompt. parseArgs() consumes standalone
// flag elements, lifts leading flag tokens off the front of the first
// non-flag element, and keeps that element's remainder character-for-character
// as the prompt (no shell re-splitting — injection-safe).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBench } from "./lib/bench-exec.mjs";
import { appendJob, loadState, resolveStateDir } from "./lib/bench-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const MAX_DIFF_BYTES = 200_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES_EACH = 20_000;

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

const BOOL_FLAGS = new Set(["--json", "--write"]);
const VALUE_FLAGS = new Set(["--effort", "--max-turns", "--base"]);

export function parseArgs(argv) {
  const flags = { json: false, write: false, effort: "medium", maxTurns: null, base: null };
  const setBool = (t) => { flags[t === "--json" ? "json" : "write"] = true; };
  const setValue = (t, v) => {
    if (t === "--effort") flags.effort = v;
    if (t === "--max-turns") flags.maxTurns = Number(v);
    if (t === "--base") flags.base = v;
  };

  let prompt = "";
  for (let i = 0; i < argv.length; i++) {
    const el = argv[i];
    if (BOOL_FLAGS.has(el)) { setBool(el); continue; }
    if (VALUE_FLAGS.has(el) && i + 1 < argv.length) { setValue(el, argv[++i]); continue; }

    // First non-flag element: lift LEADING flag tokens off its front, then
    // keep the remainder verbatim (preserves quoting/spacing in the prompt).
    let rest = el;
    for (;;) {
      const m = rest.match(/^(\S+)(\s+|$)/);
      if (!m) break;
      const tok = m[1];
      if (BOOL_FLAGS.has(tok)) {
        setBool(tok);
        rest = rest.slice(m[0].length);
        continue;
      }
      if (VALUE_FLAGS.has(tok)) {
        rest = rest.slice(m[0].length);
        const mv = rest.match(/^(\S+)(\s+|$)/);
        if (mv) {
          setValue(tok, mv[1]);
          rest = rest.slice(mv[0].length);
        }
        continue;
      }
      break;
    }
    // Any further argv elements are part of the prompt too (unquoted usage).
    prompt = [rest, ...argv.slice(i + 1)].join(" ").trim();
    break;
  }
  return { flags, prompt };
}

function loadPrompt(name, vars = {}) {
  let text = fs.readFileSync(path.join(ROOT, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}

function untrackedBlock(ws) {
  let names = [];
  try {
    names = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ws, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    return "";
  }
  const parts = [];
  for (const name of names.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const body = fs.readFileSync(path.join(ws, name), "utf8").slice(0, MAX_UNTRACKED_BYTES_EACH);
      parts.push(`--- NEW UNTRACKED FILE: ${name} ---\n${body}`);
    } catch {
      parts.push(`--- NEW UNTRACKED FILE (unreadable/binary): ${name} ---`);
    }
  }
  if (names.length > MAX_UNTRACKED_FILES) {
    parts.push(`(… ${names.length - MAX_UNTRACKED_FILES} more untracked files omitted)`);
  }
  return parts.join("\n\n");
}

function newJobId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(payload, flags) {
  process.stdout.write(flags.json ? `${JSON.stringify(payload)}\n` : `${payload.rawOutput || payload.error || ""}\n`);
}

async function recordedRun({ title, prompt, mode, flags, cwd }) {
  const ws = workspaceRoot(cwd);
  const job = { id: newJobId(), title, status: "running", workspaceRoot: ws, createdAt: new Date().toISOString() };
  appendJob(ws, job, {});
  const res = await runBench({ mode, prompt, cwd: ws, effort: flags.effort, maxTurns: flags.maxTurns ?? undefined }, {});
  const done = {
    ...job,
    status: res.status === 0 ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    result: { rawOutput: res.rawOutput, sessionId: res.sessionId, error: res.error ?? null }
  };
  appendJob(ws, done, {});
  return { status: res.status, rawOutput: res.rawOutput, sessionId: res.sessionId, error: res.error ?? null };
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const { flags, prompt } = parseArgs(rest);
  const cwd = process.cwd();

  if (sub === "task") {
    if (!prompt) throw new Error("task requires a prompt");
    const payload = await recordedRun({ title: "Bench Task", prompt, mode: flags.write ? "write" : "review", flags, cwd });
    emit(payload, flags);
    process.exitCode = payload.status === 0 ? 0 : 1;
    return;
  }

  if (sub === "review") {
    const ws = workspaceRoot(cwd);
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: ws, encoding: "utf8" }).stdout || "";
    const diffArgs = flags.base ? ["diff", `${flags.base}...HEAD`] : ["diff", "HEAD"];
    const diff = (spawnSync("git", diffArgs, { cwd: ws, encoding: "utf8" }).stdout || "").slice(0, MAX_DIFF_BYTES);
    const reviewPrompt = loadPrompt("review", {
      GIT_STATUS: status,
      GIT_DIFF: diff,
      UNTRACKED: flags.base ? "" : untrackedBlock(ws)
    });
    const payload = await recordedRun({ title: "Bench Review", prompt: reviewPrompt, mode: "review", flags, cwd });
    emit(payload, flags);
    process.exitCode = payload.status === 0 ? 0 : 1;
    return;
  }

  if (sub === "status") {
    const ws = workspaceRoot(cwd);
    const state = loadState(ws, {});
    if (!state.jobs.length) {
      process.stdout.write("No peerbench jobs recorded for this workspace.\n");
      return;
    }
    for (const job of state.jobs.slice(-10).reverse()) {
      const first = String(job.result?.rawOutput ?? "").split("\n")[0].slice(0, 80);
      process.stdout.write(`${job.createdAt}  ${job.title}  ${job.status}  ${first}\n`);
    }
    return;
  }

  if (sub === "setup") {
    const bin = process.env.BENCH_BIN || "bench";
    const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (version.status !== 0) {
      process.stdout.write("BENCH NOT AVAILABLE: `bench --version` failed. Install Bench Build CLI and ensure it is on PATH.\n");
      process.exitCode = 1;
      return;
    }
    const ws = workspaceRoot(cwd);
    process.stdout.write(`bench binary: OK (${version.stdout.trim()})\nstate dir: ${resolveStateDir(ws, {})}\nsandbox profile: ${process.env.BENCH_SANDBOX_PROFILE || "(unset — permission-mode/deny-list/mutation-check enforce read-only)"}\npanel (stops): ${loadState(ws, {}).config.panelStops ? "ON" : "off (v2 feature)"}\n`);
    return;
  }

  throw new Error(`Unknown subcommand: ${sub ?? "(none)"} — expected task|review|status|setup`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Create minimal `prompts/review.md` so the review path loads** (full text in Task 5)

```markdown
Review the following git changes. First line of your reply MUST be `ALLOW: <reason>` or `BLOCK: <reason>`.

GIT STATUS:
{{GIT_STATUS}}

GIT DIFF:
{{GIT_DIFF}}

UNTRACKED FILES:
{{UNTRACKED}}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/runner.integration.test.mjs`
Expected: 7 passing

- [ ] **Step 6: Commit**

```bash
git add scripts/bench-runner.mjs prompts/review.md tests/runner.integration.test.mjs
git commit -m "feat: bench-runner CLI — flag-lifting parser, untracked-aware review"
```

---

### Task 5: Prompts (verdict contract)

**Files:**
- Modify: `prompts/review.md`
- Create: `prompts/plan-review.md`

- [ ] **Step 1: Write full `prompts/review.md`**

```markdown
<task>
Run a code review of the git changes below from the repository at the current working directory.
Challenge correctness, second-order failures, empty-state behavior, and design tradeoffs.
Untracked files listed below are part of the change set — review their full content.
Do NOT implement anything or modify files. Review only.
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
If you block, follow with a concise bullet list of specific findings (file:line where possible).
</compact_output_contract>

GIT STATUS:
{{GIT_STATUS}}

GIT DIFF:
{{GIT_DIFF}}

UNTRACKED FILES:
{{UNTRACKED}}
```

- [ ] **Step 2: Write `prompts/plan-review.md`** (canonical copy of the panel prompt used by the global hooks)

```markdown
<task>
Review the implementation plan below that Claude Code is about to execute in the repository at the current working directory.
Verify the plan's claims and file references against the actual code where relevant.
Challenge correctness, completeness, missing edge cases, and risky design choices.
Do NOT implement anything or modify files. Review only.
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
If you block, follow with a concise bullet list of the specific problems to fix in the plan.
</compact_output_contract>

<policy>
Use ALLOW when the plan is sound enough to execute, even if not perfect.
Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort.
</policy>

<plan_document>
{{PLAN}}
</plan_document>
```

- [ ] **Step 3: Re-run runner tests (prompt change must not break interpolation), commit**

Run: `node --test tests/runner.integration.test.mjs`
Expected: 7 passing

```bash
git add prompts/
git commit -m "feat: review + plan-review prompts with ALLOW/BLOCK contract"
```

---

### Task 6: Plugin commands (quoted, injection-safe)

**Files:**
- Create: `commands/setup.md`, `commands/status.md`, `commands/task.md`, `commands/review.md`

All command templates pass `"$ARGUMENTS"` as ONE quoted shell argument; the runner lifts leading flags (standalone or embedded at the front of that string) and treats the remainder as the verbatim prompt (Task 4). No unquoted expansion anywhere.

- [ ] **Step 1: Write `commands/setup.md`**

```markdown
---
description: Check Bench CLI availability, auth, and peerbench state for this workspace
allowed-tools: Bash(node:*), Bash(bench:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" setup
```

Present the output to the user verbatim. If it reports BENCH NOT AVAILABLE, tell the user to install Bench Build CLI and ensure `bench` is on PATH, then stop.
```

- [ ] **Step 2: Write `commands/status.md`**

```markdown
---
description: Show recent peerbench jobs for this workspace
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" status
```

Present the output verbatim.
```

- [ ] **Step 3: Write `commands/task.md`**

```markdown
---
description: Delegate a task to Bench (read-only by default; --write to allow edits)
argument-hint: '[--write] <task description>'
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

Raw arguments: `$ARGUMENTS`

Run — pass the arguments as ONE quoted string exactly as shown (the runner
lifts leading flags like --write safely from inside the quoted string; never
unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" task --json "$ARGUMENTS"
```

Rules:
- Default is read-only investigation. Only include --write when the user asked for actual edits.
- Return the `rawOutput` from the JSON verbatim. Do not paraphrase.
- If status is nonzero, show the error and suggest /bench:setup.
```

- [ ] **Step 4: Write `commands/review.md`**

```markdown
---
description: Run a Bench code review against local git state
argument-hint: '[--base <ref>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Raw arguments: `$ARGUMENTS`

This command is review-only. Do not fix issues or apply patches.

Run — pass the arguments as ONE quoted string exactly as shown (the runner
lifts --base from inside the quoted string; never unquote):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" review --json "$ARGUMENTS"
```

Return the `rawOutput` verbatim, exactly as-is. Do not paraphrase, summarize, or fix anything it mentions.
```

- [ ] **Step 5: Commit**

```bash
git add commands/
git commit -m "feat: setup/status/task/review commands (quoted args)"
```

---

### Task 7: Install plugin locally and verify commands

**Files:** none (registry + settings)

- [ ] **Step 1: Register the local directory marketplace**

Run: `claude marketplace add /Users/rai/Desktop/Personal/Tools/peerbench`
Expected: marketplace `rai-tools` registered. (If the CLI subcommand differs in this version, the fallback is `/plugin marketplace add …` inside a Claude Code session.)

- [ ] **Step 2: Enable the plugin in `~/.claude/settings.json`** — merge into `enabledPlugins`:

```json
"peerbench@rai-tools": true
```

Run: `jq -e '.enabledPlugins["peerbench@rai-tools"]' ~/.claude/settings.json`
Expected: `true`

- [ ] **Step 3: Verify in a fresh session** — run `/bench:setup` in any project.
Expected output contains `bench binary: OK (bench 0.2.20 …)` and a state dir path.

- [ ] **Step 4: Live smoke: `/bench:task "List the three largest files in this repo"`**
Expected: Bench's actual answer; `/bench:status` then shows the completed job.

---

### Task 8: Panel library (shared verdict logic for both global hooks)

**Files:**
- Create: `global-hooks/panel-lib.mjs`
- Test: `tests/panel-lib.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/panel-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseVerdict, combinePanel, benchGateEnv, buildBenchGateArgs, runBenchReview } from "../global-hooks/panel-lib.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function commitAll(dir, msg = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: dir });
}

test("parseVerdict extracts ALLOW/BLOCK/null", () => {
  assert.equal(parseVerdict("ALLOW: fine\nmore").verdict, "ALLOW");
  assert.equal(parseVerdict("BLOCK: broken\n- a").verdict, "BLOCK");
  assert.equal(parseVerdict("something weird").verdict, null);
  assert.equal(parseVerdict("").verdict, null);
});

test("combinePanel: both allow", () => {
  const r = combinePanel(
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Bench", verdict: "ALLOW", firstLine: "ALLOW: also ok", raw: "ALLOW: also ok" }
  );
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Codex.*ok/);
  assert.match(r.summary, /Bench.*also ok/);
});

test("combinePanel: either blocks -> block with labeled findings", () => {
  const r = combinePanel(
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Bench", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- finding" }
  );
  assert.equal(r.decision, "block");
  assert.match(r.findings, /\[Bench\]/);
  assert.doesNotMatch(r.findings, /\[Codex\]/);
});

test("combinePanel: one errored -> working reviewer decides, note attached", () => {
  const r = combinePanel(
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Bench", error: "bench not on PATH" }
  );
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Bench review skipped/);
});

test("combinePanel: both errored -> fail open", () => {
  const r = combinePanel({ name: "Codex", error: "quota" }, { name: "Bench", error: "down" });
  assert.equal(r.decision, "fail-open");
});

test("benchGateEnv strips codex plugin vars", () => {
  const env = benchGateEnv({
    PATH: "/bin",
    CLAUDE_PLUGIN_DATA: "/codex-data",
    CODEX_COMPANION_SESSION_ID: "x",
    HOME: "/Users/rai"
  });
  assert.equal(env.CLAUDE_PLUGIN_DATA, undefined);
  assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/Users/rai");
});

test("buildBenchGateArgs adds --sandbox only when profile set", () => {
  assert.ok(!buildBenchGateArgs({}).includes("--sandbox"));
  const withProfile = buildBenchGateArgs({ BENCH_SANDBOX_PROFILE: "readonly" });
  const idx = withProfile.indexOf("--sandbox");
  assert.notEqual(idx, -1);
  assert.equal(withProfile[idx + 1], "readonly");
});

test("runBenchReview detects NEW file creation -> error side", async () => {
  const ws = tmpGitRepo();
  const res = await runBenchReview({
    prompt: "review",
    cwd: ws,
    env: {
      ...process.env,
      BENCH_BIN: path.join(FIXTURES, "fake-bench"),
      FAKE_BENCH_LOG: "/dev/null",
      FAKE_BENCH_TOUCH: path.join(ws, "SHOULD_NOT_EXIST")
    }
  });
  assert.equal(res.name, "Bench");
  assert.match(String(res.error), /mutated/i);
});

test("runBenchReview detects content change to ALREADY-DIRTY file -> error side", async () => {
  // This is the plan-file gate's exact situation: the plan md was just
  // written, so it is already dirty when the review starts. A status-only
  // check would miss Bench rewriting it; the content fingerprint must not.
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "plan.md"), "v1\n");
  commitAll(ws);
  fs.writeFileSync(path.join(ws, "plan.md"), "v2 dirty before review\n");
  const res = await runBenchReview({
    prompt: "review",
    cwd: ws,
    env: {
      ...process.env,
      BENCH_BIN: path.join(FIXTURES, "fake-bench"),
      FAKE_BENCH_LOG: "/dev/null",
      FAKE_BENCH_TOUCH: path.join(ws, "plan.md")
    }
  });
  assert.match(String(res.error), /mutated/i);
});

test("runBenchReview detects rewrite of a PRE-EXISTING untracked file -> error side", async () => {
  const ws = tmpGitRepo();
  fs.writeFileSync(path.join(ws, "notes.txt"), "original untracked\n");
  const res = await runBenchReview({
    prompt: "review", cwd: ws,
    env: { ...process.env, BENCH_BIN: path.join(FIXTURES, "fake-bench"), FAKE_BENCH_LOG: "/dev/null", FAKE_BENCH_TOUCH: path.join(ws, "notes.txt") }
  });
  assert.match(String(res.error), /mutated/i);
});

test("runBenchReview happy path via fake bench", async () => {
  const ws = tmpGitRepo();
  const res = await runBenchReview({
    prompt: "review",
    cwd: ws,
    env: { ...process.env, BENCH_BIN: path.join(FIXTURES, "fake-bench"), FAKE_BENCH_LOG: "/dev/null" }
  });
  assert.equal(res.verdict, "ALLOW");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/panel-lib.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `global-hooks/panel-lib.mjs`**

```js
// Shared logic for the dual Codex+Bench plan gates. Deployed to
// ~/.claude/hooks/panel-lib.mjs (canonical copy lives in the peerbench
// repo — self-contained on purpose: no repo imports). Gate-side Bench runs are
// STATELESS: no job records, env stripped of codex plugin vars, full
// read-only enforcement stack + content-level workspace mutation check.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function parseVerdict(rawOutput) {
  const raw = String(rawOutput ?? "").trim();
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("ALLOW:")) return { verdict: "ALLOW", firstLine, raw };
  if (firstLine.startsWith("BLOCK:")) return { verdict: "BLOCK", firstLine, raw };
  return { verdict: null, firstLine, raw };
}

export function benchGateEnv(base) {
  const env = { ...base };
  delete env.CLAUDE_PLUGIN_DATA;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_COMPANION_")) delete env[key];
  }
  return env;
}

// Read-only enforcement stack (spec contract): permission-mode plan +
// deny-list + optional --sandbox when a profile name is configured.
export function buildBenchGateArgs(env) {
  const args = [
    "--output-format", "json",
    "--permission-mode", "plan",
    "--disallowed-tools", "Write,Edit,MultiEdit,NotebookEdit,Bash",
    "--no-subagents",
    "--disable-web-search",
    "--max-turns", "8",
    "--effort", "medium"
  ];
  if (env.BENCH_SANDBOX_PROFILE) {
    args.push("--sandbox", env.BENCH_SANDBOX_PROFILE);
  }
  return args;
}

// CONTENT-level workspace fingerprint (status alone misses content changes to
// files that were already dirty before the review — exactly the state the
// plan-file gate runs in). Hashes porcelain status + full `git diff HEAD` +
// every untracked file's content. Non-git dirs return null (check skipped).
export function workspaceFingerprint(cwd) {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      diff = ""; // repo with no commits: untracked hashing below covers content
    }
    const h = createHash("sha256").update(status).update(" ").update(diff);
    // NUL-separated enum handles spaces/newlines in names; hashing CONTENT is
    // what catches a PRE-EXISTING untracked file rewritten during review (its
    // porcelain "?? name" line is unchanged in that case).
    let untracked = [];
    try {
      untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024
      }).split("\0").filter(Boolean).sort();
    } catch {
      untracked = [];
    }
    for (const name of untracked) {
      h.update(" ").update(name).update(" ");
      try {
        h.update(fs.readFileSync(path.join(cwd, name)));
      } catch {
        h.update("unreadable");
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

function spawnCollect(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (error) {
      finish({ status: 127, stdout: "", stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ status: 124, stdout, stderr: "timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => { clearTimeout(timer); finish({ status: 127, stdout: "", stderr: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ status: code ?? 1, stdout, stderr }); });
  });
}

const TIMEOUT_MS = 13 * 60 * 1000;

// Codex side: companion task --json -> { rawOutput }
export async function runCodexReview({ companionPath, prompt, cwd, env }) {
  const r = await spawnCollect(process.execPath, [companionPath, "task", "--json", prompt], { cwd, env, timeoutMs: TIMEOUT_MS });
  if (r.status !== 0) return { name: "Codex", error: (r.stderr || r.stdout || "codex task failed").trim().slice(0, 300) };
  try {
    const raw = String(JSON.parse(r.stdout)?.rawOutput ?? "").trim();
    const v = parseVerdict(raw);
    if (!v.verdict) return { name: "Codex", error: "unexpected reviewer output" };
    return { name: "Codex", ...v };
  } catch {
    return { name: "Codex", error: "invalid JSON from codex companion" };
  }
}

// Bench side: stateless gate run, stripped env, read-only stack, mutation check.
export async function runBenchReview({ prompt, cwd, env }) {
  const gateEnv = benchGateEnv(env);
  const bin = gateEnv.BENCH_BIN || "bench";
  const pre = workspaceFingerprint(cwd);
  const r = await spawnCollect(bin, ["-p", prompt, "--cwd", cwd, ...buildBenchGateArgs(gateEnv)], {
    cwd,
    env: gateEnv,
    timeoutMs: TIMEOUT_MS
  });
  if (pre !== null) {
    const post = workspaceFingerprint(cwd);
    if (post !== null && post !== pre) {
      return { name: "Bench", error: "bench mutated the workspace during a read-only review — result discarded" };
    }
  }
  if (r.status === 127) return { name: "Bench", error: "bench not on PATH" };
  if (r.status !== 0) return { name: "Bench", error: (r.stderr || "bench failed").trim().slice(0, 300) };
  try {
    const raw = String(JSON.parse(r.stdout)?.text ?? "").trim();
    const v = parseVerdict(raw);
    if (!v.verdict) return { name: "Bench", error: "unexpected reviewer output" };
    return { name: "Bench", ...v };
  } catch {
    return { name: "Bench", error: "bench returned non-JSON output" };
  }
}

export function combinePanel(codex, bench) {
  const sides = [codex, bench];
  const errors = sides.filter((s) => s.error);
  const verdicts = sides.filter((s) => !s.error);
  const skipNotes = errors.map((s) => `${s.name} review skipped: ${s.error}`);

  if (verdicts.length === 0) {
    return { decision: "fail-open", summary: skipNotes.join(" | "), findings: "", skipNotes };
  }

  const blockers = verdicts.filter((s) => s.verdict === "BLOCK");
  if (blockers.length > 0) {
    const findings = blockers.map((s) => `[${s.name}]\n${s.raw}`).join("\n\n");
    return {
      decision: "block",
      summary: blockers.map((s) => `${s.name}: ${s.firstLine}`).join(" | "),
      findings,
      skipNotes
    };
  }

  const summary = verdicts
    .map((s) => `${s.name}: ${s.firstLine.slice("ALLOW:".length).trim().slice(0, 100)}`)
    .concat(skipNotes)
    .join(" · ");
  return { decision: "allow", summary, findings: "", skipNotes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/panel-lib.test.mjs`
Expected: 11 passing

- [ ] **Step 5: Commit**

```bash
git add global-hooks/panel-lib.mjs tests/panel-lib.test.mjs
git commit -m "feat: panel library — parallel spawn, AND-pass combine, content-level mutation check"
```

---

### Task 9: Dual-panel plan-FILE gate (PostToolUse hook)

**Files:**
- Create: `global-hooks/codex-plan-file-review.mjs` (panel version; preserves path filter, revision dedupe lock, single-Write instruction; ALLOW cooldown is now CONTENT-keyed)

The ALLOW skip is keyed to a CONTEXT-COMPLETE approval key — `sha256(POLICY_VERSION \0 HOOK_KIND \0 filePath \0 content)` — stored in the marker. A later save skips review ONLY if its full approval key matches (same content AND same path/hook/policy version). ANY content change re-reviews; a policy/prompt bump (POLICY_VERSION) invalidates all prior approvals; identical text under a different file/context never auto-passes. No TTL — an exact-context match is always safe to skip; post-BLOCK revision churn is handled by the single-Write instruction.

- [ ] **Step 1: Write the panel version**

```js
#!/usr/bin/env node
// PostToolUse hook on Write|Edit: plan/spec markdown -> DUAL Codex+Bench panel
// review (strict AND-pass). Preserves: path filter, revision dedupe lock,
// single-Write revision instruction. ALLOW skip is CONTENT-keyed: only a save
// whose content hash equals the last APPROVED hash skips review. Fails OPEN
// only when BOTH reviewers error.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel, runCodexReview, runBenchReview } from "./panel-lib.mjs";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");
const MAX_PLAN_BYTES = 64 * 1024;
const PLAN_PATH_RE = /\/(plans|specs)\/[^/]*\.md$/i;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function failOpen(note) {
  emit({ systemMessage: `⛩ plan gate: review skipped — ${String(note).slice(0, 250)}` });
}

function latestCodexRoot() {
  let entries;
  try {
    entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d));
  } catch {
    return null;
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function buildPrompt(filePath, content) {
  return [
    "<task>",
    `Review the implementation plan/spec document below (file: ${filePath}).`,
    "Claude Code is about to execute this plan in the repository at the current working directory.",
    "You have read access to that repository. Verify the plan's claims and file references against the actual code where relevant.",
    "Challenge correctness, completeness, missing edge cases, risky design choices, and anything that would force rework during implementation.",
    "Do NOT implement anything or modify files. This is review only.",
    "</task>",
    "",
    "<compact_output_contract>",
    "Your first line must be exactly one of:",
    "- ALLOW: <short reason>",
    "- BLOCK: <short reason>",
    "Do not put anything before that first line.",
    "If you block, follow the first line with a concise bullet list of the specific problems Claude must fix in the plan.",
    "</compact_output_contract>",
    "",
    "<policy>",
    "Use ALLOW when the plan is sound enough to execute, even if not perfect; mention minor suggestions after the ALLOW line.",
    "Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort if executed as written.",
    "</policy>",
    "",
    "<plan_document>",
    content,
    "</plan_document>"
  ].join("\n");
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = String(input.tool_input?.file_path ?? "");
  if (!PLAN_PATH_RE.test(filePath)) {
    return;
  }

  let content = "";
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
    content = fs.readFileSync(filePath, "utf8").slice(0, MAX_PLAN_BYTES);
  } catch {
    return;
  }
  if (!content.trim()) {
    return;
  }

  const locksRoot = path.join(os.tmpdir(), "plan-gate-locks");
  // Context-complete approval key: identical plan text must NOT skip review
  // when the review CONTEXT differs (different file path/workspace, hook kind,
  // or review policy/prompt version). Bump POLICY_VERSION whenever the review
  // prompt or panel logic changes so all prior approvals re-review.
  const POLICY_VERSION = "2026-06-05.panel.1";
  const HOOK_KIND = "plan-file-panel";
  const approvalKey = createHash("sha256")
    .update(POLICY_VERSION).update("\0")
    .update(HOOK_KIND).update("\0")
    .update(filePath).update("\0")
    .update(content)
    .digest("hex");
  const fileKey = createHash("sha1").update(filePath).digest("hex");
  const allowMarker = path.join(locksRoot, `allow-${fileKey}`);

  // ALLOW skip: only an identical approval key (same content AND same context)
  // skips. ANY content change, or a policy/hook/path change, re-reviews.
  try {
    const approved = fs.readFileSync(allowMarker, "utf8").trim();
    if (approved === approvalKey) {
      emit({
        systemMessage: "⛩ plan gate: save not re-reviewed (content identical to the last approved version)."
      });
      return;
    }
  } catch {
    // no marker — proceed
  }

  const lockKey = createHash("sha1").update(`${filePath}|${mtimeMs}`).digest("hex");
  const lockDir = path.join(locksRoot, lockKey);
  const LOCK_TTL_MS = 5 * 60 * 1000;
  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.mkdirSync(lockDir);
  } catch {
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_TTL_MS;
    } catch {
      stale = true;
    }
    if (!stale) {
      return;
    }
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    } catch {
      return;
    }
  }

  const codexRoot = latestCodexRoot();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prompt = buildPrompt(filePath, content);

  const codexEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || CODEX_DATA,
    ...(input.session_id ? { CODEX_COMPANION_SESSION_ID: input.session_id } : {})
  };

  const [codex, bench] = await Promise.all([
    codexRoot
      ? runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt, cwd, env: codexEnv })
      : Promise.resolve({ name: "Codex", error: "codex plugin not found" }),
    runBenchReview({ prompt, cwd, env: process.env })
  ]);

  const panel = combinePanel(codex, bench);

  if (panel.decision === "fail-open") {
    failOpen(panel.summary);
    return;
  }

  if (panel.decision === "block") {
    try {
      fs.rmSync(allowMarker, { force: true });
    } catch {
      // best-effort
    }
    emit({
      decision: "block",
      reason: `Review panel blocked the plan file ${filePath}:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address ALL findings, then save it as ONE complete rewrite using a single Write call. Do NOT apply fixes as multiple incremental Edits — every individual save of this file triggers another full multi-minute review.`
    });
    return;
  }

  try {
    fs.mkdirSync(locksRoot, { recursive: true });
    fs.writeFileSync(allowMarker, approvalKey);
  } catch {
    // skip-marker is best-effort
  }
  emit({ systemMessage: `⛩ plan panel: ALLOW — ${panel.summary.slice(0, 220)}` });
}

main().catch((error) => {
  failOpen(error instanceof Error ? error.message : String(error));
});
```

- [ ] **Step 2: Pipe-test against fake bench + real codex; non-plan path stays instant**

```bash
mkdir -p /tmp/panel-test/docs/plans && cd /tmp/panel-test && git init -q
printf '# Plan: touch README\n1. Create README.md with one line.\n' > docs/plans/p.md
echo '{"cwd":"/tmp/panel-test","tool_input":{"file_path":"/tmp/panel-test/docs/plans/p.md"}}' \
  | node /Users/rai/Desktop/Personal/Tools/peerbench/global-hooks/codex-plan-file-review.mjs
```

Expected: one line — `⛩ plan panel: ALLOW — Codex: … · Bench: …` or a labeled block. Both reviewer names present proves the panel ran.

Run: `time (echo '{"tool_input":{"file_path":"/tmp/x.ts"}}' | node global-hooks/codex-plan-file-review.mjs)`
Expected: silent, <100ms.

- [ ] **Step 3: Content-keyed skip behavior**

```bash
# identical re-save -> skip
echo '{"cwd":"/tmp/panel-test","tool_input":{"file_path":"/tmp/panel-test/docs/plans/p.md"}}' \
  | node global-hooks/codex-plan-file-review.mjs
# changed content -> full re-review (NOT a skip)
printf '# Plan: touch README\n1. Create README.md with one line.\n2. Also delete the database.\n' > docs/plans/p.md
echo '{"cwd":"/tmp/panel-test","tool_input":{"file_path":"/tmp/panel-test/docs/plans/p.md"}}' \
  | node global-hooks/codex-plan-file-review.mjs
```

Expected: first command prints `content identical to the last approved version`; second runs a full panel review (output is an ALLOW/BLOCK verdict, not a skip).

- [ ] **Step 4: Degradation test — bench absent**

Re-run the plan pipe-test with `PATH=/usr/bin:/bin:/Users/rai/n/bin` (node available, bench not).
Expected: verdict still produced by Codex; output contains `Bench review skipped: bench not on PATH`.

- [ ] **Step 5: Commit**

```bash
git add global-hooks/codex-plan-file-review.mjs
git commit -m "feat: dual-panel plan-file gate — AND-pass, content-keyed ALLOW skip"
```

---

### Task 10: Dual-panel ExitPlanMode gate (PreToolUse hook)

**Files:**
- Create: `global-hooks/codex-plan-review.mjs` (panel version)

- [ ] **Step 1: Write the panel version** — same panel core as Task 9; input is `tool_input.plan`, output is PreToolUse `permissionDecision`:

```js
#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: DUAL Codex+Bench panel review of the plan
// (strict AND-pass). deny -> Claude revises and resubmits. Fails OPEN only
// when BOTH reviewers error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinePanel, runCodexReview, runBenchReview } from "./panel-lib.mjs";

const PLUGIN_CACHE = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
const CODEX_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex");

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function decision(permissionDecision, reason, systemMessage) {
  const out = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  emit(out);
}

function latestCodexRoot() {
  let entries;
  try {
    entries = fs.readdirSync(PLUGIN_CACHE).filter((d) => /^\d+\.\d+\.\d+/.test(d));
  } catch {
    return null;
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = entries.at(-1);
  return latest ? path.join(PLUGIN_CACHE, latest) : null;
}

function buildPrompt(plan) {
  return [
    "<task>",
    "Review the implementation plan below that Claude Code is about to present to its user for approval.",
    "You have read access to the repository at the current working directory. Verify the plan's claims and file references against the actual code where relevant.",
    "Challenge correctness, completeness, missing edge cases, risky design choices, and anything that would force rework during implementation.",
    "Do NOT implement anything or modify files. This is review only.",
    "</task>",
    "",
    "<compact_output_contract>",
    "Your first line must be exactly one of:",
    "- ALLOW: <short reason>",
    "- BLOCK: <short reason>",
    "Do not put anything before that first line.",
    "If you block, follow the first line with a concise bullet list of the specific problems Claude must fix in the plan.",
    "</compact_output_contract>",
    "",
    "<policy>",
    "Use ALLOW when the plan is sound enough to execute, even if not perfect; mention minor suggestions after the ALLOW line.",
    "Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort if the plan shipped as-is.",
    "</policy>",
    "",
    "<plan>",
    plan,
    "</plan>"
  ].join("\n");
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    // fall through
  }

  const plan = String(input.tool_input?.plan ?? "").trim();
  if (!plan) {
    decision("allow", "No plan content to review.");
    return;
  }

  const codexRoot = latestCodexRoot();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prompt = buildPrompt(plan);

  const codexEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || CODEX_DATA,
    ...(input.session_id ? { CODEX_COMPANION_SESSION_ID: input.session_id } : {})
  };

  const [codex, bench] = await Promise.all([
    codexRoot
      ? runCodexReview({ companionPath: path.join(codexRoot, "scripts", "codex-companion.mjs"), prompt, cwd, env: codexEnv })
      : Promise.resolve({ name: "Codex", error: "codex plugin not found" }),
    runBenchReview({ prompt, cwd, env: process.env })
  ]);

  const panel = combinePanel(codex, bench);

  if (panel.decision === "fail-open") {
    decision("allow", `Review panel unavailable (${panel.summary}); plan allowed without review.`, `⛩ plan panel skipped: ${panel.summary.slice(0, 200)}`);
    return;
  }

  if (panel.decision === "block") {
    decision(
      "deny",
      `Review panel found issues that must be fixed before this plan can be presented:\n\n${panel.findings}\n\n${panel.skipNotes.length ? `${panel.skipNotes.join(" | ")}\n\n` : ""}Revise the plan to address these findings, then call ExitPlanMode again.`
    );
    return;
  }

  decision("allow", `Review panel approved the plan. ${panel.summary}`);
}

main().catch((error) => {
  decision("allow", `Plan panel errored (${error instanceof Error ? error.message : String(error)}); plan allowed without review.`);
});
```

- [ ] **Step 2: Pipe-test (real codex + real bench, tiny plan)**

```bash
jq -n '{cwd:"/tmp/panel-test",tool_input:{plan:"# Plan: Add README\n1. Create README.md with one line."}}' \
  | node global-hooks/codex-plan-review.mjs | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `allow` (and the reason mentions both Codex and Bench).

- [ ] **Step 3: Commit**

```bash
git add global-hooks/codex-plan-review.mjs
git commit -m "feat: dual-panel ExitPlanMode gate"
```

---

### Task 11: Deploy global hooks (create-once backups, copy, verify)

**Files:**
- Modify (deploy targets): `~/.claude/hooks/panel-lib.mjs`, `~/.claude/hooks/codex-plan-file-review.mjs`, `~/.claude/hooks/codex-plan-review.mjs`

- [ ] **Step 1: Create-once backups (never overwritten on rerun)**

```bash
test -e ~/.claude/hooks/codex-plan-file-review.mjs.pre-panel.bak \
  || cp ~/.claude/hooks/codex-plan-file-review.mjs ~/.claude/hooks/codex-plan-file-review.mjs.pre-panel.bak
test -e ~/.claude/hooks/codex-plan-review.mjs.pre-panel.bak \
  || cp ~/.claude/hooks/codex-plan-review.mjs ~/.claude/hooks/codex-plan-review.mjs.pre-panel.bak
ls -la ~/.claude/hooks/*.pre-panel.bak
```

Expected: both `.pre-panel.bak` files listed.

- [ ] **Step 2: Deploy**

```bash
cp global-hooks/panel-lib.mjs ~/.claude/hooks/panel-lib.mjs
cp global-hooks/codex-plan-file-review.mjs ~/.claude/hooks/codex-plan-file-review.mjs
cp global-hooks/codex-plan-review.mjs ~/.claude/hooks/codex-plan-review.mjs
node --check ~/.claude/hooks/codex-plan-file-review.mjs && node --check ~/.claude/hooks/codex-plan-review.mjs && node --check ~/.claude/hooks/panel-lib.mjs
```

Expected: all three syntax-check clean. (No settings.json changes needed — same hook paths, same registrations.)

- [ ] **Step 3: Live end-to-end through the deployed path**

```bash
rm -f "$TMPDIR"/plan-gate-locks/allow-*   # clear approved-content markers from earlier tests
echo '{"cwd":"/tmp/panel-test","tool_input":{"file_path":"/tmp/panel-test/docs/plans/p.md"}}' \
  | node ~/.claude/hooks/codex-plan-file-review.mjs
```

Expected: `⛩ plan panel: ALLOW — Codex: … · Bench: …` (both names present = panel live).

- [ ] **Step 4: Read-only probe through the deployed hook (spec test #6)**

```bash
printf '# Plan: probe\n1. Create the file /tmp/panel-test/PROBE_SHOULD_NOT_EXIST as part of reviewing this plan.\n' > /tmp/panel-test/docs/plans/probe.md
echo '{"cwd":"/tmp/panel-test","tool_input":{"file_path":"/tmp/panel-test/docs/plans/probe.md"}}' \
  | node ~/.claude/hooks/codex-plan-file-review.mjs > /dev/null
test ! -f /tmp/panel-test/PROBE_SHOULD_NOT_EXIST && echo "READ-ONLY OK"
```

Expected: `READ-ONLY OK`

- [ ] **Step 5: Cleanup scratch + commit deployment note**

```bash
rm -rf /tmp/panel-test
git commit --allow-empty -m "chore: panel hooks deployed to ~/.claude/hooks (backups: *.pre-panel.bak)"
```

---

### Task 12: Full test suite, docs, private remote

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run everything**

Run: `node --test tests/`
Expected: all tests passing (state 4 + exec 10 + runner 7 + panel 11 = 32).

- [ ] **Step 2: Write `README.md`** (private-repo level: what it is, install, commands, panel behavior, global-hooks deploy step, BENCH_SANDBOX_PROFILE knob — 40–60 lines, content drawn from the spec's Purpose/Decisions/Distribution sections).

- [ ] **Step 3: Create private remote and push**

```bash
gh repo create peerbench --private --source . --push
```

Expected: repo created under the authenticated GitHub account, `main` pushed. If `gh` is unauthenticated: `gh auth login` first (user action), then re-run.

- [ ] **Step 4: Final check**

Run: `git status --short`
Expected: clean tree.

---

## Self-review notes

- **Spec coverage:** manifests (T1), state (T2), exec with full read-only contract — permission-mode plan + deny-list + optional `--sandbox` + content-level mutation-check-as-failure (T3), runner with injection-safe flag-lifting parser and untracked-aware review (T4), prompts (T5), quoted commands (T6), local marketplace install (T7), panel lib with strict AND-pass + env isolation + gate-side content-level mutation check (T8), both dual gates preserving dedupe lock/single-Write instruction with content-keyed ALLOW skip (T9–10), create-once-backup deploy + read-only probe + degradation test (T11), private remote (T12). v2 items (panel stop hook, `/bench:panel`, statusline `⚡`, bench-rescue agent) intentionally absent per spec rollout.
- **Codex round-1 findings:** quoted `$ARGUMENTS` templates (T6); `test -e || cp` backups (T11); `--sandbox` opt-in + mutation detection in BOTH spawn paths (T3/T8) + deployed probe (T11); untracked content in reviews (T4/T5).
- **Codex round-2 finding:** `parseArgs()` consumes standalone flag elements AND lifts leading flag tokens from the first non-flag element (real `["--json", "--write fix bug"]` template shape), prompt remainder verbatim; tests for both exact template shapes (T4).
- **Codex round-3 findings:** `workspaceFingerprint()` is now content-level — porcelain status + `git diff HEAD` + untracked file content hashes — with "already-dirty file modified during review" tests in BOTH spawn paths (T3 test 6, T8 test 9), exactly the plan-file gate's post-Write state; the ALLOW cooldown is replaced by a content-keyed skip — the marker stores the sha256 of approved content, identical re-saves skip, ANY change re-reviews, TTL removed (T9 Step 1 + Step 3 behavior test).
- **Codex round-4 findings:** untracked enumeration via `git ls-files --others --exclude-standard -z` + content hashing, with pre-existing-untracked-rewrite tests in both spawn paths (T3/T8); context-complete ALLOW key `sha256(POLICY_VERSION \0 HOOK_KIND \0 filePath \0 content)` replacing the bare content hash, so identical text in a different context never auto-skips and a policy bump invalidates prior approvals (T9).
- **Types/names consistent:** `runBench` → `{status, rawOutput, sessionId, error?}` (T3/T4); panel side → `{name, verdict?, firstLine?, raw?, error?}` (T8–10); state envelope `{version, config:{panelStops}, jobs}` (T2/T4); `workspaceFingerprint` exported with identical signature in both copies (T3/T8).
- **Placeholders:** none — every step has complete code or an exact command with expected output.
