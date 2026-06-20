// tests/panel-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseVerdict, combinePanel, untrackedBlock } from "../global-hooks/panel-lib.mjs";

test("untrackedBlock embeds a real untracked file but NEVER follows a symlink out of the workspace", () => {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ub-")));
  execFileSync("git", ["init", "-q"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "real.txt"), "REAL_UNTRACKED_CONTENT");
  const secret = path.join(os.tmpdir(), `ub-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, "TOP_SECRET_SHOULD_NOT_LEAK");
  fs.symlinkSync(secret, path.join(ws, "leak.txt"));   // untracked symlink pointing OUTSIDE the workspace
  const out = untrackedBlock(ws);
  assert.match(out, /REAL_UNTRACKED_CONTENT/, "the real untracked file content is included");
  assert.doesNotMatch(out, /TOP_SECRET_SHOULD_NOT_LEAK/, "symlink target content must NOT leak");
  assert.match(out, /symlink skipped/, "the symlink is reported as skipped");
});

test("parseVerdict extracts ALLOW/BLOCK/null", () => {
  assert.equal(parseVerdict("ALLOW: fine\nmore").verdict, "ALLOW");
  assert.equal(parseVerdict("BLOCK: broken\n- a").verdict, "BLOCK");
  assert.equal(parseVerdict("something weird").verdict, null);
  assert.equal(parseVerdict("").verdict, null);
});

test("combinePanel: both allow", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: also ok", raw: "ALLOW: also ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Codex.*ok/);
  assert.match(r.summary, /Kimi.*also ok/);
});

test("combinePanel: either blocks -> block with labeled findings", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- finding" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.findings, /\[Kimi\]/);
  assert.doesNotMatch(r.findings, /\[Codex\]/);
});

test("combinePanel: one errored -> working reviewer decides, note attached", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", error: "no api key" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Kimi review skipped/);
});

test("combinePanel: both errored -> fail open", () => {
  const r = combinePanel([{ name: "Codex", error: "quota" }, { name: "Kimi", error: "down" }]);
  assert.equal(r.decision, "fail-open");
});

test("combinePanel: single reviewer (array of 1) allows", () => {
  const r = combinePanel([{ name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: fine", raw: "ALLOW: fine" }]);
  assert.equal(r.decision, "allow");
});

test("combinePanel: N=3 with one error, one block -> block", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: a", raw: "ALLOW: a" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" },
    { name: "Extra", error: "boom" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.summary, /MiMo: BLOCK/);
});

// --- F: verdict badge across all decision branches ---

test("F: combinePanel badge — 4-reviewer ALLOW → Codex✓ Kimi✓ MiMo✓ GLM✓", () => {
  const r = combinePanel([
    { name: "Codex", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "GLM", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.equal(r.badge, "Codex✓ Kimi✓ MiMo✓ GLM✓");
});

test("F: combinePanel badge — mixed Kimi-ALLOW/MiMo-BLOCK/GLM-error → Kimi✓ MiMo✗ GLM!", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" },
    { name: "GLM", error: "down" }
  ]);
  assert.equal(r.decision, "block");
  assert.equal(r.badge, "Kimi✓ MiMo✗ GLM!");
});

test("F: combinePanel badge — fail-open (all error) → all !", () => {
  const r = combinePanel([
    { name: "Kimi", error: "quota" },
    { name: "MiMo", error: "down" },
    { name: "GLM", error: "timeout" }
  ]);
  assert.equal(r.decision, "fail-open");
  assert.equal(r.badge, "Kimi! MiMo! GLM!");
});

test("F: combinePanel badge — stop-gate (no Codex) omits the Codex glyph", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "GLM", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }
  ]);
  assert.equal(r.badge, "Kimi✓ MiMo✓ GLM✓");
  assert.doesNotMatch(r.badge, /Codex/);
});

// --- Severity-gating: combinePanel({ blockMinSeverity }) ---
// The fast plan/spec gates pass blockMinSeverity:"high" so a BLOCK below high becomes
// an ADVISORY (allow + note + `~` badge), not a hard block. Stop/pre-push pass nothing
// (UNCHANGED — any BLOCK blocks).

test("severity-gate: a medium-severity BLOCK → decision allow + advisory + badge ~", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: medium\n- a minor nit" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "allow", "a sub-threshold BLOCK must NOT block");
  assert.ok(Array.isArray(r.advisories) && r.advisories.length === 1, "the medium BLOCK is carried as an advisory");
  assert.match(r.advisories[0], /MiMo/);
  assert.match(r.advisories[0], /medium/);
  assert.match(r.summary, /MiMo/, "advisory surfaces in the summary");
  assert.equal(r.badge, "Kimi✓ MiMo~", "sub-threshold BLOCK renders as ~");
});

test("severity-gate: a high-severity BLOCK → decision block + badge ✗", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: real bug", raw: "BLOCK: real bug\nSEVERITY: high\n- broken build" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "a high BLOCK still blocks");
  assert.match(r.findings, /\[MiMo\]/);
  assert.equal(r.badge, "Kimi✓ MiMo✗", "high BLOCK renders as ✗");
});

test("severity-gate: a BLOCK with an unknown/corrupt severity → STRICT (block + ✗), never advisory", () => {
  // Defense-in-depth: a non-standard severity must not let a real BLOCK slip through as ~.
  const r = combinePanel([
    { name: "Codex", verdict: "BLOCK", firstLine: "BLOCK: x", raw: "BLOCK: x", severity: "bogus" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "unknown severity is treated strictly → blocks");
  assert.equal(r.badge, "Codex✗", "unknown-severity BLOCK renders as ✗, not ~");
});

test("severity-gate: a critical BLOCK → block (above the high threshold)", () => {
  const r = combinePanel([
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: data loss", raw: "BLOCK: data loss\nSEVERITY: critical\n- drops rows" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block");
  assert.equal(r.badge, "MiMo✗");
});

test("severity-gate: a BLOCK with NO SEVERITY line defaults to high → blocks", () => {
  const r = combinePanel([
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- some finding" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "no SEVERITY line on a BLOCK defaults to high (safe)");
  assert.equal(r.badge, "MiMo✗");
});

test("severity-gate: mixed — one medium (advisory) + one high (blocks) → block", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: low\n- tiny" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\nSEVERITY: high\n- real" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "any real (>= high) blocker blocks even with advisories present");
  assert.equal(r.badge, "Kimi~ MiMo✗", "low BLOCK is ~, high BLOCK is ✗");
});

test("severity-gate: all advisory (only sub-threshold BLOCKs) → allow with advisories", () => {
  const r = combinePanel([
    { name: "Kimi", verdict: "BLOCK", firstLine: "BLOCK: a", raw: "BLOCK: a\nSEVERITY: low\n- a" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: b", raw: "BLOCK: b\nSEVERITY: medium\n- b" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "allow");
  assert.equal(r.advisories.length, 2);
  assert.equal(r.badge, "Kimi~ MiMo~");
});

test("severity-gate UNCHANGED default: a medium BLOCK with NO blockMinSeverity still blocks (stop/pre-push)", () => {
  const r = combinePanel([
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: medium\n- a minor nit" }
  ]);
  assert.equal(r.decision, "block", "without blockMinSeverity, ANY BLOCK blocks (stop/pre-push strict)");
  assert.equal(r.badge, "MiMo✗", "no severity-gating → ✗ for a BLOCK");
  assert.equal(r.advisories === undefined || r.advisories.length === 0, true, "no advisories without severity-gating");
});
