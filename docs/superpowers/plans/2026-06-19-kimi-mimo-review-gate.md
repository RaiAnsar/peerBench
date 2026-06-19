# Kimi + MiMo Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace peerbench's Codex + Bench reviewer backends with Kimi K2.7 Code and Xiaomi MiMo, called over their OpenAI-compatible APIs (read-only by omitting `tools`), with reliable verdict handling and expandable per-review traces.

**Architecture:** A small `review()` HTTP client (Node `fetch`, no `tools` field) drives both providers; a registry resolves which run; the existing AND-pass `combinePanel` aggregates an N-sized result array. Plan/stop/pre-push hooks call the registry. Approved plans (ExitPlanMode only) are persisted to an env-independent shared dir and injected into per-turn and pre-push reviews. Every review writes a trace inspectable via `/bench:status <id>`.

**Tech Stack:** Node 20+ (ESM `.mjs`), `node:test`, `node:fetch`, git hooks (sh shim).

## Global Constraints

- Node 20+ (developed on 24); ESM `.mjs` only; no new npm dependencies (built-in `fetch`, `node:crypto`, `node:fs`).
- Reviewers are **read-only by omission**: the chat-completions body MUST NOT include `tools` or `tool_choice`.
- Two execution contexts: `global-hooks/*` are self-contained (only `./`-relative imports; no `CLAUDE_PLUGIN_DATA`); `scripts/*` may import `../global-hooks/*` and have plugin env.
- **Every entrypoint that also exports test helpers MUST guard its `main()`:** `if (import.meta.url === \`file://${process.argv[1]}\`) main();` — importing it for tests must NOT run `main()` or read stdin.
- `scripts/lib/bench-state.mjs`, `state.json`, and `tests/bench-state.test.mjs` MUST remain unchanged.
- Provider defaults: Kimi `https://api.moonshot.ai/v1` / `kimi-k2.7-code` / `MOONSHOT_API_KEY`; MiMo `https://token-plan-sgp.xiaomimimo.com/v1` / `mimo-v2.5-pro` / `MIMO_API_KEY`.
- Shared dir is env-independent: `~/.claude/plugins/data/bench-shared/` (from `os.homedir()`, never `CLAUDE_PLUGIN_DATA`).
- Verdict contract: success `{ name, verdict:"ALLOW"|"BLOCK", firstLine, raw }`; failure `{ name, error }`.
- Run tests: `node --test 'tests/*.test.mjs'`.
- Spec of record: `docs/superpowers/specs/2026-06-19-kimi-mimo-companion-design.md`.

---

## File Structure

**Phase 0 — reviewer core (new code path, no behavior change):** `global-hooks/review-client.mjs`, `config-store.mjs`, `trace-store.mjs`, `reviewers.mjs`; modify `panel-lib.mjs` (`combinePanel` N-ary).
**Phase 1 — switch plan hooks:** rename `codex-plan-*.mjs` → `plan-*.mjs` (content-only prompts, registry, trace); `scripts/deploy-global-hooks.mjs`.
**Phase 2 — plan-store + stop migration + auto-arm + disarm + status:** `global-hooks/plan-store.mjs`; modify `scripts/panel-stop-hook.mjs`, `plan-review.mjs`, `scripts/bench-runner.mjs`.
**Phase 3 — pre-push:** `global-hooks/pre-push-lib.mjs` (+ `isGitPush`), `scripts/pre-push-git.mjs`, `pre-push-review.mjs`, `pre-push-disarm.mjs`, `install-prepush.mjs`; modify `hooks/hooks.json`.

---

## Phase 0 — Reviewer core

### Task 1: `review()` HTTP client

**Files:** Create `global-hooks/review-client.mjs`; Test `tests/review-client.test.mjs`

**Interfaces:** Produces `review({ baseURL, apiKey, model, system, user, timeoutMs, fetchImpl }) -> Promise<{ ok:true, text, usage } | { ok:false, error:{ kind, detail } }>`. `kind ∈ {auth,network,http,timeout,parse,nokey}`. Body `{ model, messages, temperature:0 }` — never `tools`/`tool_choice`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/review-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { review } from "../global-hooks/review-client.mjs";

function fakeFetch(captured, response) {
  return async (url, opts) => { captured.url = url; captured.opts = opts; captured.body = JSON.parse(opts.body); return response; };
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });

test("sends no tools/tool_choice and returns text+usage", async () => {
  const cap = {};
  const res = await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "sys", user: "usr", timeoutMs: 5000,
    fetchImpl: fakeFetch(cap, ok({ choices: [{ message: { content: "ALLOW: ok" } }], usage: { total_tokens: 9 } })) });
  assert.equal(res.ok, true);
  assert.equal(res.text, "ALLOW: ok");
  assert.deepEqual(res.usage, { total_tokens: 9 });
  assert.equal(cap.url, "https://x/v1/chat/completions");
  assert.equal("tools" in cap.body, false);
  assert.equal("tool_choice" in cap.body, false);
  assert.equal(cap.body.temperature, 0);
  assert.equal(cap.opts.headers.Authorization, "Bearer k");
});
test("maps HTTP 401 to auth error", async () => {
  const res = await review({ baseURL: "https://x/v1", apiKey: "k", model: "m", system: "s", user: "u", timeoutMs: 5000,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "auth");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-client.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/review-client.mjs
// OpenAI-compatible reviewer. READ-ONLY by omission: body never has tools/tool_choice.
const DEFAULT_TIMEOUT_MS = 90_000;
export async function review({ baseURL, apiKey, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  if (!apiKey) return { ok: false, error: { kind: "nokey", detail: "no api key" } };
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await doFetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0 }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: { kind: e?.name === "AbortError" ? "timeout" : "network", detail: String(e?.message || e).slice(0, 300) } };
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: { kind: resp.status === 401 || resp.status === 403 ? "auth" : "http", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` } };
  }
  let json;
  try { json = await resp.json(); } catch { return { ok: false, error: { kind: "parse", detail: "non-JSON response" } }; }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return { ok: false, error: { kind: "parse", detail: "no message content" } };
  return { ok: true, text: text.trim(), usage: json.usage ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/review-client.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/review-client.mjs tests/review-client.test.mjs
git commit -m "feat(review): OpenAI-compatible no-tools review client"
```

---

### Task 2: `config-store` — env-independent config + shared dir

**Files:** Create `global-hooks/config-store.mjs`; Test `tests/config-store.test.mjs`

**Interfaces:** `sharedRoot()`, `workspaceStateDir(ws)`, `resolveConfig({ env }) -> { reviewers:string[], providers:{kimi:{baseURL,apiKey,model},mimo:{...}} }`. Identical with/without `CLAUDE_PLUGIN_DATA`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/config-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, workspaceStateDir, sharedRoot } from "../global-hooks/config-store.mjs";
test("env vars populate keys; CLAUDE_PLUGIN_DATA does not affect result", () => {
  const base = { MOONSHOT_API_KEY: "mk", MIMO_API_KEY: "xk" };
  const a = resolveConfig({ env: { ...base } });
  const b = resolveConfig({ env: { ...base, CLAUDE_PLUGIN_DATA: "/tmp/whatever" } });
  assert.equal(a.providers.kimi.apiKey, "mk");
  assert.equal(a.providers.kimi.model, "kimi-k2.7-code");
  assert.equal(a.providers.mimo.apiKey, "xk");
  assert.deepEqual(a.reviewers, ["kimi", "mimo"]);
  assert.deepEqual(a, b);
});
test("workspaceStateDir lands under the env-independent shared root", () => {
  const dir = workspaceStateDir("/some/workspace");
  assert.ok(dir.startsWith(sharedRoot()));
  assert.ok(/\/state\/workspace-[0-9a-f]{16}$/.test(dir));
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test tests/config-store.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/config-store.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULTS = {
  kimi: { baseURL: "https://api.moonshot.ai/v1", model: "kimi-k2.7-code", keyEnv: "MOONSHOT_API_KEY" },
  mimo: { baseURL: "https://token-plan-sgp.xiaomimimo.com/v1", model: "mimo-v2.5-pro", keyEnv: "MIMO_API_KEY" }
};
const DEFAULT_REVIEWERS = ["kimi", "mimo"];
export function sharedRoot() { return path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared"); }
export function workspaceStateDir(ws) {
  let canonical = ws; try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(sharedRoot(), "state", `${slug}-${hash}`);
}
function readFileConfig() { try { return JSON.parse(fs.readFileSync(path.join(sharedRoot(), "companion.json"), "utf8")); } catch { return {}; } }
export function resolveConfig({ env = process.env } = {}) {
  const file = readFileConfig();
  const providers = {};
  for (const [name, d] of Object.entries(DEFAULTS)) {
    const f = file.providers?.[name] || {};
    providers[name] = {
      baseURL: env[`${name.toUpperCase()}_BASE_URL`] || f.baseURL || d.baseURL,
      model: env[`${name.toUpperCase()}_MODEL`] || f.model || d.model,
      apiKey: env[d.keyEnv] || f.apiKey || ""
    };
  }
  const sel = Array.isArray(file.reviewers) && file.reviewers.length ? file.reviewers : DEFAULT_REVIEWERS;
  const reviewers = sel.filter((n) => n in providers);
  return { reviewers: reviewers.length ? reviewers : DEFAULT_REVIEWERS, providers };
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/config-store.mjs tests/config-store.test.mjs
git commit -m "feat(config): env-independent provider/reviewer config store"
```

---

### Task 3: `trace-store` — write/list/read review traces

**Files:** Create `global-hooks/trace-store.mjs`; Test `tests/trace-store.test.mjs`

**Interfaces:** Consumes `workspaceStateDir`. Produces `writeTrace(ws, trace, {now}) -> id` (`<ts>-<6hex>`, caps prompts/responses 64 KiB), `listTraces(ws,limit)`, `readTrace(ws,id)`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/trace-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { writeTrace, readTrace, listTraces } from "../global-hooks/trace-store.mjs";
test("write/read/list round-trip and prompt cap", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tw-"));
  const id = writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "kimi", model: "kimi-k2.7-code", latencyMs: 12, verdict: "ALLOW", firstLine: "ALLOW: ok" }],
    systemPrompt: "s", userPrompt: "u", rawResponses: { kimi: "x".repeat(100_000) } }, { now: 1750000000000 });
  assert.match(id, /^\d+-[0-9a-f]{6}$/);
  const t = readTrace(ws, id);
  assert.equal(t.gate, "stop");
  assert.ok(t.rawResponses.kimi.length <= 64 * 1024);
  assert.equal(listTraces(ws, 5)[0].id, id);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/trace-store.mjs
import { createHash } from "node:crypto";
import fs from "node:fs"; import path from "node:path";
import { workspaceStateDir } from "./config-store.mjs";
const CAP = 64 * 1024;
const cap = (s) => (typeof s === "string" ? s.slice(0, CAP) : s);
const rand6 = (seed) => createHash("sha256").update(String(seed)).digest("hex").slice(0, 6);
export function writeTrace(ws, trace, { now = Date.now() } = {}) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  fs.mkdirSync(dir, { recursive: true });
  const id = `${now}-${rand6(now + JSON.stringify(trace.reviewers || []))}`;
  const record = { id, ts: new Date(now).toISOString(), gate: trace.gate, ws: trace.ws, reviewers: trace.reviewers || [],
    systemPrompt: cap(trace.systemPrompt), userPrompt: cap(trace.userPrompt),
    rawResponses: Object.fromEntries(Object.entries(trace.rawResponses || {}).map(([k, v]) => [k, cap(v)])) };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return id;
}
export function readTrace(ws, id) { try { return JSON.parse(fs.readFileSync(path.join(workspaceStateDir(ws), "traces", `${id}.json`), "utf8")); } catch { return null; } }
export function listTraces(ws, limit = 20) {
  const dir = path.join(workspaceStateDir(ws), "traces");
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  files.sort().reverse();
  return files.slice(0, limit).map((f) => {
    const t = readTrace(ws, f.replace(/\.json$/, "")) || {};
    const summary = (t.reviewers || []).map((r) => `${r.name} ${r.verdict || `err(${r.error?.kind || r.error || "?"})`}`).join(" · ");
    return { id: t.id, ts: t.ts, gate: t.gate, summary };
  });
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/trace-store.mjs tests/trace-store.test.mjs
git commit -m "feat(trace): review trace store (write/list/read)"
```

---

### Task 4: `combinePanel` → N-ary array

**Files:** Modify `global-hooks/panel-lib.mjs` (~line 165); Test `tests/panel-lib.test.mjs`

**Interfaces:** `combinePanel(results: Array<verdict|error>) -> { decision, summary, findings, skipNotes }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/panel-lib.test.mjs (add)
import { test } from "node:test";
import assert from "node:assert/strict";
import { combinePanel } from "../global-hooks/panel-lib.mjs";
test("array of 1 allows", () => assert.equal(combinePanel([{ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: fine", raw: "ALLOW: fine" }]).decision, "allow"));
test("any block blocks (N=3)", () => {
  const r = combinePanel([{ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: a", raw: "ALLOW: a" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" }, { name: "Extra", error: "boom" }]);
  assert.equal(r.decision, "block"); assert.match(r.summary, /MiMo: BLOCK/);
});
test("all error → fail-open", () => assert.equal(combinePanel([{ name: "Kimi", error: "no key" }, { name: "MiMo", error: "timeout" }]).decision, "fail-open"));
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (arity mismatch).
- [ ] **Step 3: Modify `combinePanel` to take an array**

```javascript
export function combinePanel(results) {
  const sides = Array.isArray(results) ? results : [results];
  const errors = sides.filter((s) => s && s.error);
  const verdicts = sides.filter((s) => s && !s.error);
  const skipNotes = errors.map((s) => `${s.name} review skipped: ${s.error}`);
  if (verdicts.length === 0) return { decision: "fail-open", summary: skipNotes.join(" | "), findings: "", skipNotes };
  const blockers = verdicts.filter((s) => s.verdict === "BLOCK");
  if (blockers.length > 0) return { decision: "block", summary: blockers.map((s) => `${s.name}: ${s.firstLine}`).join(" | "),
    findings: blockers.map((s) => `[${s.name}]\n${s.raw}`).join("\n\n"), skipNotes };
  const summary = verdicts.map((s) => `${s.name}: ${s.firstLine.slice("ALLOW:".length).trim().slice(0, 100)}`).concat(skipNotes).join(" · ");
  return { decision: "allow", summary, findings: "", skipNotes };
}
```

- [ ] **Step 4: Run the full suite** — Run: `node --test 'tests/*.test.mjs'` — Expected: PASS. Update any in-repo call site passing two args to pass `[a, b]`.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/panel-lib.mjs tests/panel-lib.test.mjs
git commit -m "refactor(panel): combinePanel takes an N-sized results array"
```

---

### Task 5: `reviewers` registry — robust verdict + one retry

**Files:** Create `global-hooks/reviewers.mjs`; Test `tests/reviewers.test.mjs`

**Interfaces:** `extractVerdict(text)` scans **all** lines for the first `ALLOW:`/`BLOCK:` (skipping filler/fences); `resolveReviewers({ env, reviewImpl }) -> [{ name, run }]`; `run({system,user})` retries once on non-conforming output.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/reviewers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerdict, resolveReviewers } from "../global-hooks/reviewers.mjs";
test("extractVerdict skips filler + code fences to find the verdict line", () => {
  assert.equal(extractVerdict("Sure!\n```\nALLOW: looks fine\n```").verdict, "ALLOW");
  assert.equal(extractVerdict("BLOCK: bad\n- reason").verdict, "BLOCK");
  assert.equal(extractVerdict("no verdict here"), null);
});
test("run retries once on non-conforming output then succeeds", async () => {
  const calls = [];
  const reviewImpl = async ({ user }) => { calls.push(user); return calls.length === 1 ? { ok: true, text: "I think it's fine", usage: null } : { ok: true, text: "ALLOW: fine on retry", usage: null }; };
  const [kimi] = resolveReviewers({ env: { MOONSHOT_API_KEY: "k" }, reviewImpl }).filter((r) => r.name === "kimi");
  const res = await kimi.run({ system: "s", user: "u" });
  assert.equal(res.verdict, "ALLOW");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /ALLOW:|BLOCK:/);
});
test("no key → error, skipped not crashed", async () => {
  const r = resolveReviewers({ env: {}, reviewImpl: async () => ({ ok: true, text: "ALLOW: x" }) });
  assert.equal((await r.find((x) => x.name === "kimi").run({ system: "s", user: "u" })).error, "no api key");
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/reviewers.mjs
import { parseVerdict } from "./panel-lib.mjs";
import { resolveConfig } from "./config-store.mjs";
import { review as defaultReview } from "./review-client.mjs";
const NAMES = { kimi: "Kimi", mimo: "MiMo" };
const STRICT = "\n\nIMPORTANT: respond with ONLY a first line of `ALLOW: <reason>` or `BLOCK: <reason>`. No preamble, no code fences.";

// Scan EVERY line (skip filler / code-fence / blank) for the first ALLOW:/BLOCK: line.
export function extractVerdict(text) {
  const s = String(text ?? "").trim();
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("ALLOW:") || t.startsWith("BLOCK:")) return parseVerdict(s.slice(s.indexOf(line)));
    // else: filler/fence/blank — keep scanning
  }
  return null;
}

export function resolveReviewers({ env = process.env, reviewImpl = defaultReview } = {}) {
  const cfg = resolveConfig({ env });
  return cfg.reviewers.map((name) => {
    const p = cfg.providers[name];
    const display = NAMES[name] || name;
    return {
      name,
      async run({ system, user }) {
        if (!p.apiKey) return { name: display, error: "no api key" };
        const call = (u) => reviewImpl({ baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, system, user: u });
        let r = await call(user);
        if (!r.ok) return { name: display, error: `${r.error.kind}: ${r.error.detail}` };
        let v = extractVerdict(r.text), raw = r.text;
        if (!v) { r = await call(user + STRICT); if (r.ok) { v = extractVerdict(r.text); raw = r.text; } }
        if (!v) return { name: display, error: "unparseable verdict", raw };
        return { name: display, verdict: v.verdict, firstLine: v.firstLine, raw, model: p.model, usage: r.usage ?? null };
      }
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/reviewers.mjs tests/reviewers.test.mjs
git commit -m "feat(reviewers): robust verdict extraction (scan past filler) + one retry"
```

---

## Phase 1 — Switch plan hooks, rename, content-only prompts, deploy

### Task 6: Rename plan hooks; content-only prompts via registry

**Files:** `git mv` both `codex-plan-*.mjs` → `plan-*.mjs`; modify both; Test `tests/plan-review.test.mjs`

- [ ] **Step 1: Rename (preserve history)**

```bash
git mv global-hooks/codex-plan-review.mjs global-hooks/plan-review.mjs
git mv global-hooks/codex-plan-file-review.mjs global-hooks/plan-file-review.mjs
```

- [ ] **Step 2: Write the failing test**

```javascript
// tests/plan-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../global-hooks/plan-review.mjs";
test("plan prompt is content-only (no repo-read claim)", () => {
  const { system } = buildPrompt("PLAN BODY");
  assert.doesNotMatch(system, /read access|verify.*against.*code|explore the/i);
  assert.match(system, /ALLOW:|BLOCK:/);
});
```

- [ ] **Step 3: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 4: Rewrite `plan-review.mjs` (prompt + registry + trace + main guard)**

Replace the imports/prompt/panel block; export `buildPrompt`; guard `main()`:

```javascript
import { combinePanel } from "./panel-lib.mjs";
import { resolveReviewers } from "./reviewers.mjs";
import { writeTrace } from "./trace-store.mjs";
export function buildPrompt(plan) {
  return { system: "You are reviewing an implementation plan from ONLY the text provided. Do not assume filesystem access. " +
      "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. BLOCK only for issues that would cause wrong " +
      "behavior or significant rework if executed as written; otherwise ALLOW (minor notes may follow).",
    user: `<plan>\n${plan}\n</plan>` };
}
// inside main(): replace the old Promise.all([runCodexReview, runBenchReview]) with:
const { system, user } = buildPrompt(plan);
const results = await Promise.all(resolveReviewers().map((r) => r.run({ system, user })));
const panel = combinePanel(results);
try { writeTrace(cwd, { gate: "plan", ws: cwd, reviewers: results.map(({ raw, ...m }) => m), systemPrompt: system, userPrompt: user,
  rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""])) }); } catch { /* best-effort */ }
```

Remove `latestCodexRoot`, `runCodexReview`, `runBenchReview`, `CODEX_*` imports/env. Keep the existing `decision(...)` allow/deny emit. Ensure the bottom is `if (import.meta.url === \`file://${process.argv[1]}\`) main();` (so `buildPrompt` can be imported without running the hook).

- [ ] **Step 5: Same content-only rewrite for `plan-file-review.mjs`**

Mirror Step 4: export `buildPrompt(filePath, content)` (system as above; user = `<plan_document file="${filePath}">\n${content}\n</plan_document>`), swap to `resolveReviewers`/`combinePanel`, add `writeTrace({gate:"plan-file",...})`, keep the approval-marker/lock + asyncRewake (exit 2), and guard `main()`.

- [ ] **Step 6: Run tests** — Run: `node --test 'tests/*.test.mjs'` — Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add -A global-hooks/ tests/plan-review.test.mjs
git commit -m "feat(plan-gate): rename off codex; content-only prompts via registry"
```

---

### Task 7: Deploy script for global hooks

**Files:** Create `scripts/deploy-global-hooks.mjs`; Test `tests/deploy-global-hooks.test.mjs`

**Interfaces:** `deploy({ src, dest }) -> { copied, backedUp }` copies `*.mjs` flat, backing up a differing pre-existing file once.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/deploy-global-hooks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { deploy } from "../scripts/deploy-global-hooks.mjs";
test("copies modules flat and backs up a differing existing file", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-")), dest = fs.mkdtempSync(path.join(os.tmpdir(), "dst-"));
  fs.writeFileSync(path.join(src, "panel-lib.mjs"), "export const v=2;\n");
  fs.writeFileSync(path.join(dest, "panel-lib.mjs"), "export const v=1;\n");
  const r = deploy({ src, dest });
  assert.ok(r.copied.includes("panel-lib.mjs"));
  assert.ok(r.backedUp.includes("panel-lib.mjs"));
  assert.ok(fs.existsSync(path.join(dest, "panel-lib.mjs.pre-panel.bak")));
  assert.equal(fs.readFileSync(path.join(dest, "panel-lib.mjs"), "utf8"), "export const v=2;\n");
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation** (activation `syncSettings` lands in Task 15)

```javascript
// scripts/deploy-global-hooks.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
export function deploy({ src, dest }) {
  fs.mkdirSync(dest, { recursive: true });
  const copied = [], backedUp = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".mjs"))) {
    const from = path.join(src, f), to = path.join(dest, f);
    if (fs.existsSync(to)) {
      const bak = `${to}.pre-panel.bak`;
      if (fs.readFileSync(to, "utf8") !== fs.readFileSync(from, "utf8") && !fs.existsSync(bak)) { fs.copyFileSync(to, bak); backedUp.push(f); }
    }
    fs.copyFileSync(from, to); copied.push(f);
  }
  return { copied, backedUp };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dest = path.join(os.homedir(), ".claude", "hooks");
  const r = deploy({ src: path.join(here, "..", "global-hooks"), dest });
  console.log(`Deployed ${r.copied.length} modules; backed up ${r.backedUp.length}.`);
  // Task 15 adds: pruneLegacy + syncSettings(...) here to remove codex-plan-* and register plan-*.
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-global-hooks.mjs tests/deploy-global-hooks.test.mjs
git commit -m "feat(deploy): flat deploy of global-hooks with backup"
```

---

## Phase 2 — Plan store, stop migration, auto-arm, disarm, status

### Task 8: `plan-store` (atomic, truncating)

**Files:** Create `global-hooks/plan-store.mjs`; Test `tests/plan-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/plan-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { savePlan, loadPlan, clearPlan } from "../global-hooks/plan-store.mjs";
test("save/load/clear + truncation marker", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
  savePlan(ws, { text: "x".repeat(20000), hash: "abc" });
  const p = loadPlan(ws);
  assert.equal(p.armed, true); assert.equal(p.hash, "abc");
  assert.ok(p.text.length <= 16 * 1024 + 64); assert.match(p.text, /\[plan truncated/);
  clearPlan(ws); assert.equal(loadPlan(ws), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/plan-store.mjs
import fs from "node:fs"; import path from "node:path";
import { workspaceStateDir } from "./config-store.mjs";
const PLAN_MAX = 16 * 1024;
const file = (ws) => path.join(workspaceStateDir(ws), "plan.json");
export function savePlan(ws, { text, hash }) {
  const dir = workspaceStateDir(ws); fs.mkdirSync(dir, { recursive: true });
  let body = String(text ?? ""); if (body.length > PLAN_MAX) body = `${body.slice(0, PLAN_MAX)}\n…[plan truncated at 16 KiB]`;
  const tmp = path.join(dir, `plan.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ text: body, hash, ts: new Date().toISOString(), armed: true }, null, 2)}\n`);
  fs.renameSync(tmp, file(ws));
}
export function loadPlan(ws) { try { return JSON.parse(fs.readFileSync(file(ws), "utf8")); } catch { return null; } }
export function clearPlan(ws) { try { fs.rmSync(file(ws), { force: true }); } catch { /* best-effort */ } }
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/plan-store.mjs tests/plan-store.test.mjs
git commit -m "feat(plan-store): atomic armed-plan persistence with truncation"
```

---

### Task 9: Auto-arm on ExitPlanMode ALLOW

**Files:** Modify `global-hooks/plan-review.mjs`; Test `tests/plan-review.test.mjs` (add)

- [ ] **Step 1: Write the failing test**

```javascript
// add to tests/plan-review.test.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { armOnAllow } from "../global-hooks/plan-review.mjs";
import { loadPlan } from "../global-hooks/plan-store.mjs";
test("armOnAllow stores the plan and arms", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arm-"));
  armOnAllow(ws, "THE PLAN");
  const p = loadPlan(ws);
  assert.equal(p.armed, true); assert.equal(p.text, "THE PLAN");
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement `armOnAllow`; call on ALLOW**

```javascript
// in global-hooks/plan-review.mjs
import { createHash } from "node:crypto";
import { savePlan } from "./plan-store.mjs";
export function armOnAllow(ws, planText) { savePlan(ws, { text: planText, hash: createHash("sha256").update(planText).digest("hex").slice(0, 16) }); }
```

In `main()`, on the `panel.decision === "allow"` branch (ExitPlanMode approved), call `armOnAllow(cwd, plan)` before emitting allow. Do NOT add arming to `plan-file-review.mjs`.

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add global-hooks/plan-review.mjs tests/plan-review.test.mjs
git commit -m "feat(auto-arm): arm + store plan on ExitPlanMode approval"
```

---

### Task 10: Migrate stop hook to registry + continuity + trace + main guard

**Files:** Modify `scripts/panel-stop-hook.mjs`; Test `tests/panel-stop-hook.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// add to tests/panel-stop-hook.test.mjs
import { buildStopUser } from "../scripts/panel-stop-hook.mjs";
test("stop prompt embeds plan when armed", () => {
  const u = buildStopUser({ status: "M f", diff: "diff", untracked: "", lastMsg: "did x", plan: "APPROVED THING" });
  assert.match(u, /APPROVED PLAN/); assert.match(u, /APPROVED THING/);
});
test("stop prompt omits plan block when not armed", () => {
  assert.doesNotMatch(buildStopUser({ status: "M", diff: "d", untracked: "", lastMsg: "x", plan: null }), /APPROVED PLAN/);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (importing must not run the hook — add a `main()` guard while you're here).
- [ ] **Step 3: Rewrite the review section + guard `main()`**

```javascript
import { resolveReviewers } from "../global-hooks/reviewers.mjs";
import { combinePanel } from "../global-hooks/panel-lib.mjs";
import { loadPlan } from "../global-hooks/plan-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";
export function buildStopUser({ status, diff, untracked, lastMsg, plan }) {
  const parts = ["Review the code changes from the previous turn (git diff + untracked below).",
    "BLOCK only for a concrete bug, regression, or unsafe change; otherwise ALLOW.",
    `\nPREVIOUS ASSISTANT MESSAGE:\n${lastMsg}`, `\nGIT STATUS:\n${status}`, `\nGIT DIFF:\n${diff}`, `\nUNTRACKED FILES:\n${untracked}`];
  if (plan) parts.push(`\nAPPROVED PLAN (review the diff for conformance; BLOCK on deviations, scope creep, or unfinished items):\n${plan}`);
  return parts.join("\n");
}
const SYSTEM = "Review from ONLY the content provided. Do not assume filesystem access. Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`.";
```

In `main()`: activate if `state.config.panelStops || loadPlan(ws)?.armed`; `const plan = loadPlan(ws)?.text ?? null;` `const user = buildStopUser({...});` `const results = await Promise.all(resolveReviewers().map((r)=>r.run({system:SYSTEM,user})));` `const panel = combinePanel(results);` write a `gate:"stop"` trace, capture its id; if `process.env.BENCH_COMPANION_DEBUG` write the prompt+responses to stderr; on `block` emit `{decision:"block", reason: panel.findings}`; else emit `{ systemMessage: \`⚡ panel: ${panel.summary} — expand: /bench:status ${id}\` }`. Keep the `stop_hook_active` guard + no-change early return. End with `if (import.meta.url === \`file://${process.argv[1]}\`) main();` (guarded — remove the old unconditional `main().catch`).

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/panel-stop-hook.mjs tests/panel-stop-hook.test.mjs
git commit -m "feat(stop): registry panel + plan continuity + trace + main guard"
```

---

### Task 11: `/bench:panel off` disarm + `/bench:status <id>` expand + main guard

**Files:** Modify `scripts/bench-runner.mjs`; Test `tests/runner.integration.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// add to tests/runner.integration.test.mjs
import { panelCommand, statusExpand } from "../scripts/bench-runner.mjs";
import { savePlan, loadPlan } from "../global-hooks/plan-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
test("panel off clears the armed plan", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "po-"));
  savePlan(ws, { text: "p", hash: "h" }); panelCommand(ws, "off");
  assert.equal(loadPlan(ws), null);
});
test("status expand renders prompt + raw responses", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "se-"));
  const id = writeTrace(ws, { gate: "stop", ws, reviewers: [{ name: "Kimi", verdict: "ALLOW" }], systemPrompt: "S", userPrompt: "U", rawResponses: { Kimi: "ALLOW: ok" } });
  const out = statusExpand(ws, id);
  assert.match(out, /S/); assert.match(out, /U/); assert.match(out, /ALLOW: ok/);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (and importing the runner must not run its CLI — add a `main()`/CLI guard).
- [ ] **Step 3: Implement + guard the CLI dispatch**

```javascript
// in scripts/bench-runner.mjs
import { clearPlan } from "../global-hooks/plan-store.mjs";
import { listTraces, readTrace } from "../global-hooks/trace-store.mjs";
export function panelCommand(ws, arg) {
  /* keep the existing panelStops on/off toggle */
  if (arg === "off") clearPlan(ws); // disarm continuity together with the toggle
  /* return the existing status string */
}
export function statusExpand(ws, id) {
  const t = readTrace(ws, id);
  if (!t) return `No trace ${id}`;
  const blocks = (t.reviewers || []).map((r) => `── ${r.name} (${r.model || "?"}, ${r.verdict || `err:${r.error}`}) ──\n${t.rawResponses?.[r.name] ?? ""}`);
  return [`Trace ${id} [${t.gate}] ${t.ts}`, `\nSYSTEM:\n${t.systemPrompt}`, `\nUSER:\n${t.userPrompt}`, "", ...blocks].join("\n");
}
```

In the `status` command handler: with an id arg, print `statusExpand(ws, id)`; else print `listTraces(ws)` rows. Wrap the top-level CLI dispatch in `if (import.meta.url === \`file://${process.argv[1]}\`) { ...dispatch... }` so importing helpers in tests does not execute the CLI.

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/bench-runner.mjs tests/runner.integration.test.mjs
git commit -m "feat(cli): panel off disarms; status <id> expands a trace; guard CLI"
```

---

## Phase 3 — Pre-push gate

### Task 12: `pre-push-lib` — `isGitPush`, range diff (empty-tree initial), panel

**Files:** Create `global-hooks/pre-push-lib.mjs`; Test `tests/pre-push-lib.test.mjs`

**Interfaces:** `isGitPush(command)`; `rangesFromRefLines(lines, remote)`; `reviewPushedRange({ cwd, ranges, env, gitImpl })` (gitImpl threaded everywhere, incl. `newRefBase`).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/pre-push-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rangesFromRefLines, isGitPush } from "../global-hooks/pre-push-lib.mjs";
const Z = "0".repeat(40);
test("normal update maps remote..local", () => assert.deepEqual(rangesFromRefLines([`refs/heads/main aaa refs/heads/main bbb`], "origin"), [{ from: "bbb", to: "aaa" }]));
test("new ref (remote zeros) flagged for base resolution", () => {
  const r = rangesFromRefLines([`refs/heads/feat aaa refs/heads/feat ${Z}`], "origin");
  assert.equal(r[0].to, "aaa"); assert.equal(r[0].newRef, true); assert.equal(r[0].remote, "origin");
});
test("deletion (local zeros) → allow", () => assert.deepEqual(rangesFromRefLines([`(delete) ${Z} refs/heads/x bbb`], "origin"), [{ allow: true }]));
test("isGitPush is command-anchored", () => {
  assert.equal(isGitPush("git push origin main"), true);
  assert.equal(isGitPush("git   push -u origin feat"), true);
  assert.equal(isGitPush("git status"), false);
  assert.equal(isGitPush("echo git push"), false);
  assert.equal(isGitPush("cd x && git push"), true);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// global-hooks/pre-push-lib.mjs
import { execFileSync } from "node:child_process";
import { resolveReviewers } from "./reviewers.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { loadPlan } from "./plan-store.mjs";
import { writeTrace } from "./trace-store.mjs";
const ZERO = /^0{40,64}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's well-known empty tree

// Command-anchored: matches `git push` only at start or after a shell separator (not after `echo `).
export function isGitPush(command) { return /(^|;|&&|\|\||\|)\s*git\s+push(\s|$)/.test(String(command || "")); }

export function rangesFromRefLines(lines, remote) {
  return lines.map((line) => {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (ZERO.test(localSha)) return { allow: true };                                 // deletion
    const branch = (remoteRef || "").replace(/^refs\/heads\//, "");                  // e.g. "feat"
    if (ZERO.test(remoteSha)) return { to: localSha, newRef: true, remote, branch }; // first push of this ref
    return { from: remoteSha, to: localSha };
  });
}
function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
// Base for a first push, best → fallback: the pushed branch on the remote, the
// configured upstream, the remote's default HEAD, then fork-point. null → caller uses empty tree.
function newRefBase(to, remote, branch, cwd, gitImpl) {
  const candidates = [];
  if (branch) candidates.push(`refs/remotes/${remote}/${branch}`, `${remote}/${branch}`);
  candidates.push("@{upstream}", `refs/remotes/${remote}/HEAD`, `${remote}/HEAD`);
  for (const ref of candidates) {
    try { const b = gitImpl(["merge-base", ref, to], cwd).trim(); if (b) return b; } catch { /* next */ }
  }
  try { const fp = gitImpl(["merge-base", "--fork-point", `${remote}/HEAD`, to], cwd).trim(); if (fp) return fp; } catch { /* none */ }
  return null;
}
export async function reviewPushedRange({ cwd, ranges, env = process.env, gitImpl = git }) {
  const diffs = [];
  for (const r of ranges) {
    if (r.allow) continue;
    let spec;
    if (r.newRef) { const base = newRefBase(r.to, r.remote, r.branch, cwd, gitImpl); spec = `${base || EMPTY_TREE}..${r.to}`; }
    else spec = `${r.from}..${r.to}`;
    try { diffs.push(gitImpl(["diff", spec], cwd)); }
    catch (e) { return { decision: "block", summary: "pre-push: cannot determine push range (fail closed)", findings: String(e).slice(0, 200), skipNotes: [] }; }
  }
  const diff = diffs.join("\n").slice(0, 200_000);
  if (!diff.trim()) return { decision: "allow", summary: "no diff to review", findings: "", skipNotes: [] };
  const plan = loadPlan(cwd)?.text ?? null;
  const system = "Review the to-be-pushed diff from ONLY the content provided. First line must be `ALLOW: <reason>` or `BLOCK: <reason>`.";
  const user = `GIT DIFF (being pushed):\n${diff}` + (plan ? `\n\nAPPROVED PLAN (BLOCK on deviations):\n${plan}` : "");
  const results = await Promise.all(resolveReviewers({ env }).map((r) => r.run({ system, user })));
  try { writeTrace(cwd, { gate: "pre-push", ws: cwd, reviewers: results.map(({ raw, ...m }) => m), systemPrompt: system, userPrompt: user, rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || ""])) }); } catch { /* best-effort */ }
  return combinePanel(results);
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS (4 tests).
- [ ] **Step 5: Commit**

```bash
git add global-hooks/pre-push-lib.mjs tests/pre-push-lib.test.mjs
git commit -m "feat(pre-push): isGitPush + range resolution (empty-tree initial) + review lib"
```

---

### Task 13: Pre-push entrypoints (git fail-closed, advisory, disarm) — all `main()`-guarded

**Files:** Create `scripts/pre-push-git.mjs`, `pre-push-review.mjs`, `pre-push-disarm.mjs`; Test `tests/pre-push-entrypoints.test.mjs`

**Interfaces:** `successFromToolResponse(tool_response)`. `isGitPush` is imported from `../global-hooks/pre-push-lib.mjs` by BOTH Bash entrypoints (never entrypoint-to-entrypoint, so no `main()` runs on import).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/pre-push-entrypoints.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGitPush } from "../global-hooks/pre-push-lib.mjs";
import { successFromToolResponse } from "../scripts/pre-push-disarm.mjs";
test("isGitPush matches real push commands only", () => {
  assert.equal(isGitPush("git push origin main"), true);
  assert.equal(isGitPush("git status"), false);
  assert.equal(isGitPush("echo git push"), false);
});
test("disarm only on explicit success", () => {
  assert.equal(successFromToolResponse({ exit_code: 0 }), true);
  assert.equal(successFromToolResponse({ exit_code: 1 }), false);
  assert.equal(successFromToolResponse({}), false);
  assert.equal(successFromToolResponse(undefined), false);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (importing `pre-push-disarm` must NOT read stdin → it must guard `main()`).
- [ ] **Step 3: Implement the three entrypoints (all guarded)**

`scripts/pre-push-git.mjs`:

```javascript
#!/usr/bin/env node
import fs from "node:fs";
import { rangesFromRefLines, reviewPushedRange } from "../global-hooks/pre-push-lib.mjs";
async function main() {
  const remote = process.argv[2] || "origin";
  const stdin = fs.readFileSync(0, "utf8").trim();
  const lines = stdin ? stdin.split(/\r?\n/) : [];
  if (!lines.length) process.exit(0);
  let panel;
  try { panel = await reviewPushedRange({ cwd: process.cwd(), ranges: rangesFromRefLines(lines, remote) }); }
  catch (e) { process.stderr.write(`pre-push review error (fail closed): ${e}\n`); process.exit(1); }
  if (panel.decision === "block") { process.stderr.write(`Push blocked:\n${panel.findings}\n`); process.exit(1); }
  if (panel.decision === "fail-open") { process.stderr.write(`pre-push: reviewers unavailable (fail closed): ${panel.summary}\n`); process.exit(1); }
  process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
```

`scripts/pre-push-review.mjs` (advisory, fail-open):

```javascript
#!/usr/bin/env node
import fs from "node:fs";
import { isGitPush, reviewPushedRange } from "../global-hooks/pre-push-lib.mjs";
function emit(o) { process.stdout.write(`${JSON.stringify(o)}\n`); }
async function main() {
  let input = {}; try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  if (!isGitPush(input.tool_input?.command)) return;
  const cwd = input.cwd || process.cwd();
  let panel; try { panel = await reviewPushedRange({ cwd, ranges: [{ from: "@{push}", to: "HEAD" }] }); } catch { return; }
  if (panel.decision === "block") emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: panel.findings } });
}
if (import.meta.url === `file://${process.argv[1]}`) main();
```

`scripts/pre-push-disarm.mjs`:

```javascript
#!/usr/bin/env node
import fs from "node:fs";
import { isGitPush } from "../global-hooks/pre-push-lib.mjs";
import { clearPlan } from "../global-hooks/plan-store.mjs";
export function successFromToolResponse(tr) { return !!tr && tr.exit_code === 0; }
function main() {
  let input = {}; try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  if (!isGitPush(input.tool_input?.command)) return;
  if (successFromToolResponse(input.tool_response)) clearPlan(input.cwd || process.cwd());
}
if (import.meta.url === `file://${process.argv[1]}`) main();
```

> The `@{push}..HEAD` advisory range is best-effort; if unresolvable, `reviewPushedRange`'s git call throws → caught → no-op (advisory fail-open). The authoritative fail-closed enforcement is the git hook. Confirm the §11 probe for the `tool_response` success field; the fail-safe (`exit_code !== 0` or absent → no disarm) holds regardless of field name — adjust `successFromToolResponse` if the harness key differs.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/pre-push-git.mjs scripts/pre-push-review.mjs scripts/pre-push-disarm.mjs tests/pre-push-entrypoints.test.mjs
git commit -m "feat(pre-push): guarded git (fail-closed) + advisory + disarm entrypoints"
```

---

### Task 14: `install-prepush` (stdin-buffering chaining shim) + hooks.json

**Files:** Create `scripts/install-prepush.mjs`; Modify `hooks/hooks.json`; Test `tests/install-prepush.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/install-prepush.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { install } from "../scripts/install-prepush.mjs";
test("chains an existing hook and is idempotent", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\necho existing\n");
  const r1 = install({ hooksDir: hooks, pluginRoot: "/plugin" });
  assert.equal(r1.chained, true);
  assert.ok(fs.existsSync(path.join(hooks, "pre-push.local")));
  const shim = fs.readFileSync(path.join(hooks, "pre-push"), "utf8");
  assert.match(shim, /pre-push\.local/); assert.match(shim, /pre-push-git\.mjs/); assert.match(shim, /input=\$\(cat\)/);
  assert.equal(install({ hooksDir: hooks, pluginRoot: "/plugin" }).chained, false);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/install-prepush.mjs
import fs from "node:fs"; import path from "node:path";
const MARK = "# peerbench pre-push shim";
const shim = (pluginRoot) => `#!/usr/bin/env sh
${MARK}
input=$(cat)
if [ -x "$(dirname "$0")/pre-push.local" ]; then
  printf '%s' "$input" | "$(dirname "$0")/pre-push.local" "$@" || exit $?
fi
printf '%s' "$input" | node "${pluginRoot}/scripts/pre-push-git.mjs" "$@"
`;
export function install({ hooksDir, pluginRoot }) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-push");
  let chained = false;
  if (fs.existsSync(hookPath)) {
    if (fs.readFileSync(hookPath, "utf8").includes(MARK)) return { hookPath, chained: false };
    fs.renameSync(hookPath, path.join(hooksDir, "pre-push.local"));
    fs.chmodSync(path.join(hooksDir, "pre-push.local"), 0o755);
    chained = true;
  }
  fs.writeFileSync(hookPath, shim(pluginRoot)); fs.chmodSync(hookPath, 0o755);
  return { hookPath, chained };
}
```

- [ ] **Step 4: Wire `hooks/hooks.json`** — add `PreToolUse`(Bash)→`pre-push-review.mjs` and `PostToolUse`(Bash)→`pre-push-disarm.mjs` per spec §6.1, keeping `Stop`.
- [ ] **Step 5: Run tests** — Run: `node --test 'tests/*.test.mjs'` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add scripts/install-prepush.mjs hooks/hooks.json tests/install-prepush.test.mjs
git commit -m "feat(pre-push): stdin-buffering chaining installer + Bash hook wiring"
```

---

### Task 15: Status command argument forwarding + deploy activation (legacy prune + register)

**Files:** Modify `commands/status.md`, `scripts/deploy-global-hooks.mjs`; Test `tests/deploy-global-hooks.test.mjs` (extend)

**Interfaces:** `syncSettings({ hooksDir, settingsPath }) -> { removedFiles, removedEntries, addedEntries }` — deletes deployed `codex-plan-*.mjs`, removes `settings.json` hook entries referencing them, and **adds** entries for `plan-review.mjs` (PreToolUse ExitPlanMode) + `plan-file-review.mjs` (PostToolUse Write|Edit) if missing. (Trace visibility: `/bench:status` reads the env-independent `trace-store`, never the env-dependent jobs store.)

- [ ] **Step 1: Update `commands/status.md` to forward `$ARGUMENTS`**

Change the command invocation to `node "${CLAUDE_PLUGIN_ROOT}/scripts/bench-runner.mjs" status $ARGUMENTS` and add to its description: `Pass a trace id (/bench:status <id>) to expand that review's full prompt and each model's raw response.`

- [ ] **Step 2: Write the failing test**

```javascript
// add to tests/deploy-global-hooks.test.mjs
import { syncSettings } from "../scripts/deploy-global-hooks.mjs";
test("syncSettings prunes legacy and registers new hooks", () => {
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "lh-"));
  fs.writeFileSync(path.join(hooks, "codex-plan-review.mjs"), "// old\n");
  const settingsPath = path.join(hooks, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "ExitPlanMode", hooks: [{ type: "command", command: "node ~/.claude/hooks/codex-plan-review.mjs" }] }
  ] } }, null, 2));
  const r = syncSettings({ hooksDir: hooks, settingsPath });
  assert.ok(r.removedFiles.includes("codex-plan-review.mjs"));
  assert.equal(fs.existsSync(path.join(hooks, "codex-plan-review.mjs")), false);
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const cmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(cmds.some((c) => c.includes("plan-review.mjs")));        // registered
  assert.ok(!cmds.some((c) => c.includes("codex-plan-review.mjs"))); // pruned
  assert.ok(s.hooks.PostToolUse.some((e) => e.hooks.some((h) => h.command.includes("plan-file-review.mjs"))));
});
```

- [ ] **Step 3: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 4: Implement `syncSettings` and call it from the deploy CLI**

```javascript
// add to scripts/deploy-global-hooks.mjs
const LEGACY = ["codex-plan-review.mjs", "codex-plan-file-review.mjs"];
function ensure(list, matcher, file) {
  const has = list.some((e) => e.matcher === matcher && (e.hooks || []).some((h) => String(h.command).includes(file)));
  if (!has) list.push({ matcher, hooks: [{ type: "command", command: `node ~/.claude/hooks/${file}` }] });
}
export function syncSettings({ hooksDir, settingsPath }) {
  const removedFiles = [];
  for (const f of LEGACY) { const p = path.join(hooksDir, f); if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removedFiles.push(f); } }
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { s = {}; }
  s.hooks = s.hooks || {}; s.hooks.PreToolUse = s.hooks.PreToolUse || []; s.hooks.PostToolUse = s.hooks.PostToolUse || [];
  let removedEntries = 0;
  for (const ev of Object.keys(s.hooks)) {
    const before = s.hooks[ev].length;
    s.hooks[ev] = s.hooks[ev].filter((e) => !(e.hooks || []).some((h) => LEGACY.some((f) => String(h.command || "").includes(f))));
    removedEntries += before - s.hooks[ev].length;
  }
  ensure(s.hooks.PreToolUse, "ExitPlanMode", "plan-review.mjs");
  ensure(s.hooks.PostToolUse, "Write|Edit", "plan-file-review.mjs");
  fs.writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`);
  return { removedFiles, removedEntries, addedEntries: 2 };
}
```

Call `syncSettings({ hooksDir: dest, settingsPath: path.join(os.homedir(), ".claude", "settings.json") })` in the deploy CLI block (after copy) and log the result.

- [ ] **Step 5: Run tests** — Run: `node --test 'tests/*.test.mjs'` — Expected: PASS (full suite).
- [ ] **Step 6: Commit**

```bash
git add commands/status.md scripts/deploy-global-hooks.mjs tests/deploy-global-hooks.test.mjs
git commit -m "feat(deploy): activate plan-* hooks (prune codex-plan-*, register, status arg)"
```

---

### Task 16: Installer CLI + legacy test migration (suite stays green)

**Files:** Modify `scripts/install-prepush.mjs` (add CLI), `global-hooks/panel-lib.mjs` (remove dead exports), `tests/panel-lib.test.mjs`, `tests/panel-stop-hook.test.mjs`, `tests/runner.integration.test.mjs`

This task makes `node --test 'tests/*.test.mjs'` pass after the migration and makes the installer actually install. `tests/bench-state.test.mjs` and `tests/bench-exec.test.mjs` stay UNCHANGED (the `/bench:task` delegation path via `bench-exec.mjs` is out of scope and keeps `runBench`/its `workspaceFingerprint`).

- [ ] **Step 1: Add a runnable CLI to `scripts/install-prepush.mjs`** (finding #1)

`install({hooksDir,pluginRoot})` is a library fn; add a guarded CLI that resolves the real hooks dir (honoring `core.hooksPath`) and the plugin root:

```javascript
// append to scripts/install-prepush.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (import.meta.url === `file://${process.argv[1]}`) {
  const cwd = process.cwd();
  // `git rev-parse --git-path hooks` honors core.hooksPath and resolves .git/hooks otherwise
  const hooksDir = path.resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" }).trim());
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const r = install({ hooksDir, pluginRoot });
  console.log(`pre-push installed at ${r.hookPath}${r.chained ? " (chained existing → pre-push.local)" : ""}`);
}
```

- [ ] **Step 2: Write the failing test for dead-export removal** (finding #3)

```javascript
// REPLACE tests/panel-lib.test.mjs entirely with parseVerdict + combinePanel(array) only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, combinePanel } from "../global-hooks/panel-lib.mjs";
import * as panel from "../global-hooks/panel-lib.mjs";

test("parseVerdict reads ALLOW/BLOCK first line", () => {
  assert.equal(parseVerdict("ALLOW: ok").verdict, "ALLOW");
  assert.equal(parseVerdict("BLOCK: no\n- x").verdict, "BLOCK");
  assert.equal(parseVerdict("hmm").verdict, null);
});
test("legacy Bench/Codex helpers are gone", () => {
  assert.equal(panel.runBenchReview, undefined);
  assert.equal(panel.runCodexReview, undefined);
  assert.equal(panel.buildBenchGateArgs, undefined);
});
test("combinePanel array: allow / block / fail-open", () => {
  assert.equal(combinePanel([{ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: a", raw: "ALLOW: a" }]).decision, "allow");
  assert.equal(combinePanel([{ name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: b", raw: "BLOCK: b" }]).decision, "block");
  assert.equal(combinePanel([{ name: "Kimi", error: "x" }]).decision, "fail-open");
});
```

- [ ] **Step 3: Run to verify it fails** — Run: `node --test tests/panel-lib.test.mjs` — Expected: FAIL (legacy helpers still exported).

- [ ] **Step 4: Remove the dead exports from `global-hooks/panel-lib.mjs`**

Delete `runCodexReview`, `runBenchReview`, `benchGateEnv`, `buildBenchGateArgs`, the `BENCH_REVIEW_PREAMBLE` const, `spawnCollect`, and panel-lib's own `workspaceFingerprint` (the review path no longer spawns CLIs or fingerprints — read-only is by API omission). Keep `parseVerdict` and `combinePanel`. Remove now-unused `node:child_process`/`node:crypto`/`fs`/`path` imports.

- [ ] **Step 5: Migrate the stop-hook / runner integration tests** (finding #4)

The old `tests/panel-stop-hook.test.mjs` and the stop-hook part of `tests/runner.integration.test.mjs` spawn the hook with `BENCH_BIN=tests/fixtures/fake-bench` and assert Bench-specific ALLOW/BLOCK. That path no longer exists. Replace that coverage:
- Keep/confirm the **`buildStopUser`** unit tests (Task 10) and the **registry** tests with injected `reviewImpl` (Task 5) as the behavioral coverage for review verdicts.
- In `tests/panel-stop-hook.test.mjs`, **remove the `fake-bench` spawn/ALLOW/BLOCK cases**; keep only the hook-logic tests that need no reviewer: `stop_hook_active` guard returns early, and the no-diff early return. For an end-to-end "reviewer errors → fail-open systemMessage (not block)" case, spawn the hook with **no API keys in env** so `resolveReviewers` returns no-key errors and the panel fails open — assert the output is a `systemMessage`, not a `decision:"block"`.
- In `tests/runner.integration.test.mjs`, drop any assertion that depends on the removed Bench review path; keep `panelCommand`/`statusExpand` tests (Task 11). `tests/fixtures/fake-bench` may be deleted if no remaining test references it (grep first: `grep -rl fake-bench tests/`).

- [ ] **Step 6: Run the full suite** — Run: `node --test 'tests/*.test.mjs'` — Expected: PASS (no references to removed exports; no orphan fake-bench assertions).

- [ ] **Step 7: Commit**

```bash
git add scripts/install-prepush.mjs global-hooks/panel-lib.mjs tests/panel-lib.test.mjs tests/panel-stop-hook.test.mjs tests/runner.integration.test.mjs
git commit -m "chore(migrate): installer CLI + drop dead Bench/Codex exports + migrate tests"
```

> **Sequencing:** run Task 16 Steps 4–5 (export/test removal) **together with Task 6** (which stops importing those helpers) so the suite is never left red between commits. Task 16 Step 1 (installer CLI) can land any time after Task 14.

---

### Task 17: Kimi self-review remediations (apply within the referenced tasks)

These corrections come from running this plan through the Kimi reviewer. Apply each to the file/task named — they are self-contained so order does not matter.

- [ ] **BLOCK 1 — trace ID collision (`global-hooks/trace-store.mjs`, Task 3).** The deterministic `rand6(now + JSON.stringify(reviewers))` seed collides when two gates fire in the same millisecond with the same reviewer set (second write overwrites the first). Use a real random suffix:

```javascript
import { randomBytes } from "node:crypto";          // replace the createHash import (rand6 is removed)
// ...
// inside writeTrace, replace the id line with:
const id = `${now}-${randomBytes(3).toString("hex")}`; // random 6-hex suffix; no same-ms collision
```

The existing test (`/^\d+-[0-9a-f]{6}$/`) still passes.

- [ ] **BLOCK 2 — advisory pre-push must not deny on git-config errors (`global-hooks/pre-push-lib.mjs` + `scripts/pre-push-git.mjs`, Tasks 12–13).** Range-resolution failure must be distinct from a review BLOCK, so the advisory hook never denies a push for an unconfigured `@{push}`. In `reviewPushedRange`, change the catch to return a distinct decision:

```javascript
catch (e) { return { decision: "range-error", summary: "pre-push: cannot determine push range", findings: String(e).slice(0, 200), skipNotes: [] }; }
```

Then: `pre-push-git.mjs` (authoritative) treats `range-error` as **fail-closed** (`exit 1`); `pre-push-review.mjs` (advisory) only emits `deny` on `decision === "block"`, so `range-error` and `fail-open` are **no-ops** (it already checks only `block` — keep it that way, add a comment). Update `pre-push-git.mjs`:

```javascript
if (panel.decision === "block" || panel.decision === "range-error") { process.stderr.write(`Push blocked (${panel.decision}):\n${panel.findings || panel.summary}\n`); process.exit(1); }
if (panel.decision === "fail-open") { process.stderr.write(`pre-push: reviewers unavailable (fail closed): ${panel.summary}\n`); process.exit(1); }
```

- [ ] **BLOCK 3 — settings path must be confirmed/aligned (`scripts/deploy-global-hooks.mjs`, Tasks 7/15).** The real Claude settings file is `~/.claude/settings.json`; the deploy CLI passes that absolute path to `syncSettings`, and the unit test injects a temp `settingsPath` (correct — the fn is path-injectable). Add the **integrated activation test** (also covers the earlier checklist gap): create a temp git repo + temp `hooksDir`/`settingsPath`, run `deploy` + `syncSettings` + `install`, then assert: `settings.json` has `plan-review.mjs`/`plan-file-review.mjs` entries with **absolute** command paths (no literal `~`), and `.git/hooks/pre-push` contains the shim. (Tilde does not reliably expand in hook execution — `ensure()` MUST write `${os.homedir()}/.claude/hooks/<file>`, not `~/.claude/...`, per the memory checklist.)

- [ ] **Minor 1 — `stream: false` (`global-hooks/review-client.mjs`, Task 1).** Some OpenAI-compatible providers default to streaming, which breaks `resp.json()`. Set it explicitly in the body:

```javascript
body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, stream: false }),
```

- [ ] **Minor 2 — `isGitPush` subshell (`global-hooks/pre-push-lib.mjs`, Task 12).** Add `\(` to the prefix alternation so `(git push)` matches: `/(^|;|&&|\|\||\||\()\s*git\s+push(\s|$)/`.

- [ ] **Minor 3 — pre-push diff truncation marker (`global-hooks/pre-push-lib.mjs`, Task 12).** Replace the silent `.slice(0, 200_000)` with a marked truncation and instruct the model to BLOCK on incompleteness:

```javascript
const joined = diffs.join("\n");
const diff = joined.length > 200_000 ? `${joined.slice(0, 200_000)}\n…[diff truncated — treat as incomplete]` : joined;
// system prompt gains: "If the diff appears truncated or context is incomplete, BLOCK."
```

- [ ] **Minor 4 — document plan-hash semantics (`global-hooks/plan-store.mjs`, Task 8).** Add a comment in `savePlan`: `// hash is of the caller's FULL plan text; stored text may be truncated for continuity context only`.

- [ ] **Minor 5 — rate limits.** v1 fails fast (no backoff) on parallel Kimi+MiMo calls; acceptable. Note it in `reviewers.mjs` as a known limitation.

- [ ] **Verify before go-live:** MiMo (`https://token-plan-sgp.xiaomimimo.com/v1`) returns standard `choices[0].message.content` + `usage` shapes (the §11 probe), and confirm the Bash `PostToolUse` `tool_response` success key (memory checklist item 4).

- [ ] **Commit** (fold into the commits of Tasks 1/3/12/13 as you implement them; no separate commit needed).

---

## Self-Review

**Spec coverage:** §2 no-tools/content-only → T1,T6; §3 env-independent config → T2; §5.3 N-ary panel → T4; §5.4 plan-store/continuity → T8,T10; §5.5 stop migration → T10; §5.6 auto-arm + disarm → T9,T11; §5.7 pre-push (git/advisory/disarm/installer/empty-tree base) → T12–14; §6.3 rename + §6.4 deploy/activation → T6,T7,T15; §8 reliability (typed errors, retry, scan-past-filler, no silent skip) → T1,T5; §9 observability (trace, status expand, DEBUG) → T3,T10,T11,T15. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands show expected output. ✓

**Type consistency:** `run()→{name,verdict,firstLine,raw,model,usage}|{name,error,raw?}` consumed by `combinePanel([])`; `writeTrace` reads `reviewers[].{name,model,verdict,firstLine,error}`+`rawResponses[name]`; `loadPlan().text` feeds continuity + pre-push; `isGitPush` defined once in `pre-push-lib.mjs` and imported by both Bash entrypoints; every entrypoint guards `main()`. ✓

**Executor notes:** T1–5 are independent of live gates (land first). After T6's rename run `node --test 'tests/*.test.mjs'` to catch any missed `codex-plan-*` reference. Activate with `node scripts/deploy-global-hooks.mjs` (once) and `node scripts/install-prepush.mjs` (per repo).
