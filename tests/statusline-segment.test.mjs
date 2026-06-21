import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderSegment, latestTrace, latestTraceForDir, resolveDir } from "../global-hooks/statusline-segment.mjs";
import { workspaceStateDir } from "../global-hooks/config-store.mjs";

test("all-allow → green label, names with ✓", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "ALLOW" }] });
  assert.match(s, /⛩ plan:/); assert.match(s, /Kimi✓/); assert.match(s, /MiMo✓/);
});
test("a block → ✗ on the blocker", () => {
  const s = renderSegment({ gate: "stop", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }] });
  assert.match(s, /MiMo✗/); assert.match(s, /Kimi✓/);
});

// Severity-aware glyph: a BLOCK with a present sub-high severity is advisory (~), not ✗.
test("BLOCK with medium severity → ~ (advisory, not alarming ✗)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK", severity: "medium" }] });
  assert.match(s, /MiMo~/, "medium-severity BLOCK should render ~");
  assert.doesNotMatch(s, /MiMo✗/);
});
test("BLOCK with low severity → ~", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "low" }] });
  assert.match(s, /MiMo~/);
});
test("BLOCK with high severity → ✗ (real blocker)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "high" }] });
  assert.match(s, /MiMo✗/);
});
test("BLOCK with critical severity → ✗", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "critical" }] });
  assert.match(s, /MiMo✗/);
});
test("BLOCK with NO severity (stop/pre-push trace) → ✗ (strict, unchanged)", () => {
  const s = renderSegment({ gate: "stop", reviewers: [{ name: "MiMo", verdict: "BLOCK" }] });
  assert.match(s, /MiMo✗/);
});
// FIX 5: an UNKNOWN/malformed severity ranks 0 (< high) but must be treated as STRICT (✗),
// never softened to the advisory ~ — a corrupt severity must not hide a real BLOCK.
test("FIX 5: BLOCK with an UNKNOWN/malformed severity → ✗ (strict, not ~)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "bogus" }] });
  assert.match(s, /MiMo✗/, "an unknown severity must render the strict ✗");
  assert.doesNotMatch(s, /MiMo~/, "an unknown severity must NOT render the advisory ~");
});
test("FIX 5: BLOCK with an empty-string severity → ✗ (strict)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "" }] });
  assert.match(s, /MiMo✗/, "an empty severity is unknown → strict ✗");
});
test("errored reviewer → !", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", error: "timeout" }, { name: "MiMo", verdict: "ALLOW" }] });
  assert.match(s, /Kimi!/);
});
test("hunt trace: findings (no verdict, no error) → ✓; errored → !", () => {
  const s = renderSegment({ gate: "hunt", reviewers: [{ name: "Codex" }, { name: "Kimi" }, { name: "MiMo", error: "timeout" }] });
  assert.match(s, /⛩ hunt:/); assert.match(s, /Codex✓/); assert.match(s, /Kimi✓/); assert.match(s, /MiMo!/);
});
test("plan-file shortens to plan; pre-push to push", () => {
  assert.match(renderSegment({ gate: "plan-file", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ plan:/);
  assert.match(renderSegment({ gate: "pre-push", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ push:/);
});
test("no trace / empty reviewers → empty string", () => {
  assert.equal(renderSegment(null), ""); assert.equal(renderSegment({ reviewers: [] }), "");
});
test("stale trace (older than 45min) is dimmed with (idle)", () => {
  const t = { gate: "plan", ts: new Date(1000).toISOString(), reviewers: [{ name: "Kimi", verdict: "BLOCK" }, { name: "MiMo", verdict: "BLOCK" }] };
  const s = renderSegment(t, { now: 1000 + 60 * 60 * 1000 });   // 1h later
  assert.match(s, /\(idle\)/); assert.match(s, /\x1b\[2m/);      // dim
});
test("fresh trace is not dimmed/idle", () => {
  const t = { gate: "plan", ts: new Date(1000).toISOString(), reviewers: [{ name: "Kimi", verdict: "ALLOW" }] };
  assert.doesNotMatch(renderSegment(t, { now: 1000 + 5000 }), /\(idle\)/);
});
test("trace without ts renders fresh (back-compat)", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] });
  assert.match(s, /Kimi✓/); assert.doesNotMatch(s, /\(idle\)/);
});
test("latestTrace returns newest by filename", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  fs.writeFileSync(path.join(d, "100-aaa.json"), JSON.stringify({ id: "100-aaa", gate: "plan", reviewers: [{ name: "Kimi", verdict: "BLOCK" }] }));
  fs.writeFileSync(path.join(d, "200-bbb.json"), JSON.stringify({ id: "200-bbb", gate: "stop", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }));
  assert.equal(latestTrace(d).id, "200-bbb");
  assert.equal(latestTrace(path.join(d, "nope")), null);
});

// ===========================================================================
// "Same statusline under all projects" regression — the reader must resolve a
// DISTINCT project per call and never collapse onto one shared dir on bad input.
// ===========================================================================

// --- resolveDir: a bad/missing argv must never collapse every project onto one dir ---
test("resolveDir: a valid argv2 passes through", () => {
  assert.equal(resolveDir("/a/b", {}, "/cwd"), "/a/b");
});
test("resolveDir: missing/empty argv2 → CLAUDE_PROJECT_DIR, then cwd", () => {
  assert.equal(resolveDir("", { CLAUDE_PROJECT_DIR: "/proj" }, "/cwd"), "/proj");
  assert.equal(resolveDir(undefined, {}, "/cwd"), "/cwd");
});
test("resolveDir: the jq sentinels 'null'/'undefined' are rejected (the same-statusline bug)", () => {
  // `jq -r` on an absent .workspace.current_dir emits the literal string "null". If that were
  // treated as a real path, EVERY project would resolve to the same (nonexistent) state dir →
  // the same statusline everywhere. It must be rejected like an empty arg.
  assert.equal(resolveDir("null", { CLAUDE_PROJECT_DIR: "/proj" }, "/cwd"), "/proj");
  assert.equal(resolveDir("undefined", {}, "/cwd"), "/cwd");
  assert.equal(resolveDir("null", {}, "/cwd"), "/cwd");
});

// --- latestTrace: numeric (not lexical) ordering + filename validation (Kimi findings) ---
test("latestTrace orders by NUMERIC timestamp across digit-length boundaries", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trn-"));
  fs.writeFileSync(path.join(d, "999999999999-aaa.json"), JSON.stringify({ id: "999999999999-aaa", gate: "plan", reviewers: [{ name: "K", verdict: "BLOCK" }] }));
  fs.writeFileSync(path.join(d, "1000000000000-bbb.json"), JSON.stringify({ id: "1000000000000-bbb", gate: "stop", reviewers: [{ name: "K", verdict: "ALLOW" }] }));
  // Lexically "999..." > "1000..." ('9' > '1'); numerically 1000000000000 is newer and must win.
  assert.equal(latestTrace(d).id, "1000000000000-bbb", "newest by numeric ts, not lexical");
});
test("latestTrace ignores stray non-trace .json files", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trs-"));
  fs.writeFileSync(path.join(d, "README.json"), JSON.stringify({ not: "a trace" }));
  fs.writeFileSync(path.join(d, "backup-2025.json"), JSON.stringify({ also: "not" }));
  fs.writeFileSync(path.join(d, "100-abc.json"), JSON.stringify({ id: "100-abc", gate: "plan", reviewers: [{ name: "K", verdict: "ALLOW" }] }));
  assert.equal(latestTrace(d).id, "100-abc", "only well-formed <ts>-<hex>.json traces count");
  fs.rmSync(path.join(d, "100-abc.json"));
  assert.equal(latestTrace(d), null, "a dir with only stray .json files yields no trace");
});

// --- latestTraceForDir: per-project isolation + numeric newest across roots ---
test("latestTraceForDir resolves DISTINCT traces for distinct projects (no cross-project leak)", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sl-root-")));
  const prev = process.env.BENCH_ROOT; process.env.BENCH_ROOT = root;
  try {
    const wsA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wsA-")));
    const wsB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wsB-")));
    const write = (ws, id, gate) => {
      const td = path.join(workspaceStateDir(ws), "traces");
      fs.mkdirSync(td, { recursive: true });
      fs.writeFileSync(path.join(td, `${id}.json`), JSON.stringify({ id, gate, reviewers: [{ name: "K", verdict: "ALLOW" }] }));
    };
    write(wsA, "100-aaa", "hunt");
    write(wsB, "200-bbb", "stop");
    const gitTop = (d) => d;   // each ws is its own git root
    assert.equal(latestTraceForDir(wsA, gitTop).gate, "hunt", "project A shows A's trace");
    assert.equal(latestTraceForDir(wsB, gitTop).gate, "stop", "project B shows B's trace — NOT A's");
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT; else process.env.BENCH_ROOT = prev;
  }
});
test("latestTraceForDir picks the chronologically-newest across git-top and cwd roots", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sl-root2-")));
  const prev = process.env.BENCH_ROOT; process.env.BENCH_ROOT = root;
  try {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "top-")));
    const sub = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sub-")));
    const write = (ws, id) => {
      const td = path.join(workspaceStateDir(ws), "traces");
      fs.mkdirSync(td, { recursive: true });
      fs.writeFileSync(path.join(td, `${id}.json`), JSON.stringify({ id, gate: "stop", reviewers: [{ name: "K", verdict: "ALLOW" }] }));
    };
    write(top, "100-aaa");
    write(sub, "300-ccc");
    // gitTop(sub) → top; roots = [top, sub]; newest id (300) wins, compared numerically.
    assert.equal(latestTraceForDir(sub, () => top).id, "300-ccc");
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT; else process.env.BENCH_ROOT = prev;
  }
});
