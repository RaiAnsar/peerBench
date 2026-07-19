// tests/panel-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseVerdict, combinePanel, spawnCollect, untrackedBlock } from "../global-hooks/panel-lib.mjs";

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

test("spawnCollect kills a reviewer that exceeds the bounded output capture", async () => {
  const result = await spawnCollect(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"
  ], {
    cwd: os.tmpdir(),
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024
  });
  assert.equal(result.status, 125);
  assert.match(result.stderr, /bounded capture limit/i);
});

test("combinePanel: both allow", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: also ok", raw: "ALLOW: also ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /Grok.*ok/);
  assert.match(r.summary, /MiMo.*also ok/);
});

test("combinePanel: either blocks -> block with labeled findings", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bad", raw: "BLOCK: bad\n- finding" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.findings, /\[MiMo\]/);
  assert.doesNotMatch(r.findings, /\[Grok\]/);
});

test("combinePanel: one errored -> working reviewer decides, note attached", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", error: "no api key" }
  ]);
  assert.equal(r.decision, "allow");
  assert.match(r.summary, /MiMo review skipped/);
});

test("combinePanel: both errored -> fail open", () => {
  const r = combinePanel([{ name: "Grok", error: "quota" }, { name: "MiMo", error: "down" }]);
  assert.equal(r.decision, "fail-open");
});

test("combinePanel: single reviewer (array of 1) allows", () => {
  const r = combinePanel([{ name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: fine", raw: "ALLOW: fine" }]);
  assert.equal(r.decision, "allow");
});

test("combinePanel: one reviewer errors while the other blocks", () => {
  const r = combinePanel([
    { name: "Grok", error: "boom" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" }
  ]);
  assert.equal(r.decision, "block");
  assert.match(r.summary, /MiMo: BLOCK/);
});

// --- F: verdict badge across all decision branches ---

test("F: combinePanel badge — Grok+MiMo ALLOW", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }
  ]);
  assert.equal(r.decision, "allow");
  assert.equal(r.badge, "Grok✓ MiMo✓");
});

test("F: combinePanel badge — mixed Grok-ALLOW/MiMo-BLOCK", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\n- x" }
  ]);
  assert.equal(r.decision, "block");
  assert.equal(r.badge, "Grok✓ MiMo✗");
});

test("F: combinePanel badge — fail-open (all error) → all !", () => {
  const r = combinePanel([
    { name: "Grok", error: "quota" },
    { name: "MiMo", error: "down" }
  ]);
  assert.equal(r.decision, "fail-open");
  assert.equal(r.badge, "Grok! MiMo!");
});

test("F: lightweight panel badge contains only Grok+MiMo", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" }
  ]);
  assert.equal(r.badge, "Grok✓ MiMo✓");
});

// --- Severity-gating: combinePanel({ blockMinSeverity }) ---
// The fast plan/spec gates pass blockMinSeverity:"high" so a BLOCK below high becomes
// an ADVISORY (allow + note + `~` badge), not a hard block. Stop/pre-push pass nothing
// (UNCHANGED — any BLOCK blocks).

test("severity-gate: a medium-severity BLOCK → decision allow + advisory + badge ~", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: medium\n- a minor nit" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "allow", "a sub-threshold BLOCK must NOT block");
  assert.ok(Array.isArray(r.advisories) && r.advisories.length === 1, "the medium BLOCK is carried as an advisory");
  assert.match(r.advisories[0], /MiMo/);
  assert.match(r.advisories[0], /medium/);
  assert.match(r.summary, /MiMo/, "advisory surfaces in the summary");
  assert.equal(r.badge, "Grok✓ MiMo~", "sub-threshold BLOCK renders as ~");
});

test("severity-gate: a high-severity BLOCK → decision block + badge ✗", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "ALLOW", firstLine: "ALLOW: ok", raw: "ALLOW: ok" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: real bug", raw: "BLOCK: real bug\nSEVERITY: high\n- broken build" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "a high BLOCK still blocks");
  assert.match(r.findings, /\[MiMo\]/);
  assert.equal(r.badge, "Grok✓ MiMo✗", "high BLOCK renders as ✗");
});

test("severity-gate: a BLOCK with an unknown/corrupt severity → STRICT (block + ✗), never advisory", () => {
  // Defense-in-depth: a non-standard severity must not let a real BLOCK slip through as ~.
  const r = combinePanel([
    { name: "Grok", verdict: "BLOCK", firstLine: "BLOCK: x", raw: "BLOCK: x", severity: "bogus" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "unknown severity is treated strictly → blocks");
  assert.equal(r.badge, "Grok✗", "unknown-severity BLOCK renders as ✗, not ~");
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
    { name: "Grok", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: low\n- tiny" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: bug", raw: "BLOCK: bug\nSEVERITY: high\n- real" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "block", "any real (>= high) blocker blocks even with advisories present");
  assert.equal(r.badge, "Grok~ MiMo✗", "low BLOCK is ~, high BLOCK is ✗");
});

test("severity-gate: all advisory (only sub-threshold BLOCKs) → allow with advisories", () => {
  const r = combinePanel([
    { name: "Grok", verdict: "BLOCK", firstLine: "BLOCK: a", raw: "BLOCK: a\nSEVERITY: low\n- a" },
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: b", raw: "BLOCK: b\nSEVERITY: medium\n- b" }
  ], { blockMinSeverity: "high" });
  assert.equal(r.decision, "allow");
  assert.equal(r.advisories.length, 2);
  assert.equal(r.badge, "Grok~ MiMo~");
});

test("severity-gate UNCHANGED default: a medium BLOCK with NO blockMinSeverity still blocks (stop/pre-push)", () => {
  const r = combinePanel([
    { name: "MiMo", verdict: "BLOCK", firstLine: "BLOCK: nit", raw: "BLOCK: nit\nSEVERITY: medium\n- a minor nit" }
  ]);
  assert.equal(r.decision, "block", "without blockMinSeverity, ANY BLOCK blocks (stop/pre-push strict)");
  assert.equal(r.badge, "MiMo✗", "no severity-gating → ✗ for a BLOCK");
  assert.equal(r.advisories === undefined || r.advisories.length === 0, true, "no advisories without severity-gating");
});

test("runGrokTask/runGrokReview spawn the grok CLI headless read-only and honor timeoutMs", async () => {
  const { runGrokTask, runGrokReview } = await import("../global-hooks/panel-lib.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cli-"));
  const fake = path.join(dir, "fake-grok.mjs");
  // Fake grok: asserts headless read-only flags, prints a verdict. args[0] must be -p.
  fs.writeFileSync(fake, [
    "const a = process.argv.slice(2);",
    "if (a[0] !== '-p' || !a.includes('--permission-mode') || a[a.indexOf('--permission-mode')+1] !== 'default') { console.error('bad flags: '+a.join(' ')); process.exit(3); }",
    "if (!a.includes('--sandbox') || a[a.indexOf('--sandbox')+1] !== 'read-only') { console.error('missing read-only sandbox: '+a.join(' ')); process.exit(5); }",
    "if (process.env.BENCH_SUPPRESS_HOOKS !== '1') { console.error('hooks not suppressed'); process.exit(4); }",
    "const compat = ['CLAUDE','CURSOR','CODEX'].flatMap(v => ['SKILLS','RULES','AGENTS','MCPS','HOOKS','SESSIONS'].map(s => `GROK_${v}_${s}_ENABLED`));",
    "if (compat.some(k => process.env[k] !== 'false') || process.env.GROK_MANAGED_MCPS_ENABLED !== 'false' || process.env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED !== 'false') { console.error('vendor compatibility not disabled'); process.exit(6); }",
    "if (a[1] === 'review this' && (!a.includes('--tools') || !a.includes('--disallowed-tools') || !a.includes('--deny') || process.cwd() === process.env.EXPECTED_REPO_CWD || process.env.HOME !== process.cwd() || process.env.GROK_HOME !== process.cwd())) { console.error('review not tool-free/isolated: '+a.join(' ')); process.exit(7); }",
    "if (a[1] === 'hunt this' && (a.includes('--tools') || process.cwd() !== process.env.EXPECTED_REPO_CWD)) { console.error('hunt lost repo-aware mode: '+a.join(' ')); process.exit(8); }",
    "console.log('ALLOW: grok healthy');",
    ""
  ].join("\n"));
  const wrap = path.join(dir, "grok");
  fs.writeFileSync(wrap, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(wrap, 0o755);
  const localEnv = { BENCH_GROK_UNSANDBOXED: "1", EXPECTED_REPO_CWD: fs.realpathSync.native(dir) };
  const rv = await runGrokReview({ prompt: "review this", cwd: dir, env: localEnv, bin: wrap, platform: "linux" });
  assert.equal(rv.verdict, "ALLOW");
  const rt = await runGrokTask({ prompt: "hunt this", cwd: dir, env: localEnv, bin: wrap, platform: "linux" });
  assert.match(rt.raw, /ALLOW: grok healthy/);
  // timeout: a sleeper wrapper must be killed near the cap
  const sleeper = path.join(dir, "sleeper");
  fs.writeFileSync(sleeper, `#!/bin/sh\nsleep 60\n`); fs.chmodSync(sleeper, 0o755);
  const t0 = Date.now();
  const rslow = await runGrokTask({ prompt: "x", cwd: dir, env: localEnv, timeoutMs: 200, bin: sleeper, platform: "linux" });
  assert.ok(rslow.error, "timed-out grok returns an error");
  assert.ok(Date.now() - t0 < 5000, "killed near the cap");
});

test("runGrokTask reports a missing grok CLI with the install hint", async () => {
  const { runGrokTask } = await import("../global-hooks/panel-lib.mjs");
  // platform:"linux" → unwrapped spawn so the ENOENT surfaces as our 127 path (pure, darwin-independent)
  const r = await runGrokTask({ prompt: "x", cwd: process.cwd(), env: { BENCH_GROK_UNSANDBOXED: "1" }, bin: "/nonexistent/grok-bin", platform: "linux" });
  assert.match(r.error, /grok CLI not found/);
});

test("runGrokTask refuses non-macOS execution unless unsandboxed mode is explicitly enabled", async () => {
  const { runGrokTask } = await import("../global-hooks/panel-lib.mjs");
  const r = await runGrokTask({ prompt: "x", cwd: process.cwd(), env: {}, bin: "/must-not-run", platform: "linux" });
  assert.match(r.error, /hard read-only containment is only available on macOS/);
});

test("grokSpawnSpec: darwin wraps grok in Seatbelt (sandbox-exec) with the read-only profile", async () => {
  const { grokSpawnSpec, GROK_SEATBELT_PROFILE } = await import("../global-hooks/panel-lib.mjs");
  const d = grokSpawnSpec("review", { bin: "grok", platform: "darwin", tmpDir: "/private/tmp/grok-bench-x" });
  assert.equal(d.cmd, "/usr/bin/sandbox-exec", "darwin must be OS-sandboxed — grok's own sandbox is a verified no-op");
  assert.equal(d.args[0], "-p");
  assert.equal(d.args[1], GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x"));
  assert.match(d.args[1], /\(deny file-write\*\)/, "profile denies writes");
  assert.equal(d.args[2], "grok");
  assert.ok(d.args.includes("--no-leader"), "must not attach to a (possibly unsandboxed) shared leader");
  const l = grokSpawnSpec("review", { bin: "grok", platform: "linux" });
  assert.equal(l.cmd, "grok", "non-darwin spawns bare (fail-open stderr check is the net)");
});

test("GROK_VERDICT_SCHEMA pins the review verdict shape (ALLOW|BLOCK enum, reason, both required)", async () => {
  const { GROK_VERDICT_SCHEMA } = await import("../global-hooks/panel-lib.mjs");
  const s = JSON.parse(GROK_VERDICT_SCHEMA);
  assert.deepEqual(s.properties.verdict.enum, ["ALLOW", "BLOCK"], "only the two verdicts parseVerdict accepts");
  assert.deepEqual(s.required.sort(), ["reason", "verdict"], "a verdict without a reason is useless to the gate");
});

test("grokSpawnSpec: jsonSchema appends --json-schema (review path); absent by default (task path stays free-form)", async () => {
  const { grokSpawnSpec, GROK_TOOL_FREE_DENY, GROK_VERDICT_SCHEMA } = await import("../global-hooks/panel-lib.mjs");
  const review = grokSpawnSpec("review", { platform: "darwin", tmpDir: "/tmp/t", toolFree: true, jsonSchema: GROK_VERDICT_SCHEMA });
  const i = review.args.indexOf("--json-schema");
  assert.ok(i > 0, "schema flag present when requested");
  assert.equal(review.args[i + 1], GROK_VERDICT_SCHEMA, "schema value rides along");
  assert.equal(review.args[review.args.indexOf("--tools") + 1], "todo_write", "allowlist disables default tool injection");
  assert.equal(review.args[review.args.indexOf("--disallowed-tools") + 1], GROK_TOOL_FREE_DENY, "selected tool and MCP meta-tools are removed");
  assert.equal(review.args[review.args.indexOf("--deny") + 1], "*", "permission fallback denies any surviving tool");
  assert.equal(review.args[review.args.indexOf("--max-turns") + 1], "1", "tool-free review is a single model turn");
  const task = grokSpawnSpec("hunt", { platform: "darwin", tmpDir: "/tmp/t" });
  assert.ok(!task.args.includes("--json-schema"), "task/hunt runs must NOT be verdict-constrained — their findings are prose");
  assert.ok(!task.args.includes("--tools"), "explicit repo hunt retains its inspection toolset");
  assert.equal(task.args[task.args.indexOf("--max-turns") + 1], "40");
});

test("grokStructuredVerdict: extracts the schema-constrained verdict; null degrades to the text fallback", async () => {
  const { grokStructuredVerdict } = await import("../global-hooks/panel-lib.mjs");
  assert.equal(grokStructuredVerdict(JSON.stringify({ structuredOutput: { verdict: "BLOCK", reason: "bug in x" }, text: "ignored" })), "BLOCK: bug in x");
  assert.equal(grokStructuredVerdict(JSON.stringify({ structuredOutput: { verdict: "ALLOW", reason: "" } })), "ALLOW: ", "empty reason is still a valid verdict");
  // Constraint failure → CLI emits structuredOutput:null + structuredOutputError — fall back, don't throw.
  assert.equal(grokStructuredVerdict(JSON.stringify({ structuredOutput: null, structuredOutputError: "boom", text: "ALLOW: ok" })), null);
  assert.equal(grokStructuredVerdict(JSON.stringify({ text: "ALLOW: ok" })), null, "no structuredOutput → text fallback");
  assert.equal(grokStructuredVerdict(JSON.stringify({ structuredOutput: { verdict: "MAYBE", reason: "x" } })), null, "unknown verdict never synthesizes a line");
  assert.equal(grokStructuredVerdict("plain narration, not json"), null);
  assert.equal(grokStructuredVerdict(undefined), null);
});

test("GROK_SEATBELT_PROFILE grants writes ONLY to the ephemeral tmpdir + /dev — all of ~/.grok is read-only", async () => {
  const { GROK_SEATBELT_PROFILE } = await import("../global-hooks/panel-lib.mjs");
  const p = GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x");
  // Default-deny with a SINGLE base deny; grok's writable state is redirected to the tmpdir via
  // GROK_HOME (see grokChildEnv), so the profile needs no ~/.grok grants at all.
  assert.equal((p.match(/deny file-write/g) || []).length, 1, "exactly one base deny");
  // NOTHING under ~/.grok is writable — not the data, not the code, not the model-routing cache.
  assert.ok(!p.includes(".grok"), "profile must not reference ~/.grok at all — the whole dir is read-only");
  for (const surface of ["bin", "downloads", "vendor", "skills", "bundled", "installed-plugins",
                         "marketplace-cache", "completions", "config.toml", "sandbox.toml",
                         "user-settings.json", "models_cache.json", "auth.json", "sessions"]) {
    assert.ok(!p.includes(surface), `~/.grok/${surface} must NOT be writable (redirected to GROK_HOME)`);
  }
  // The ONLY write grants are the per-run private tmpdir and /dev; the shared TMPDIR root is NOT granted.
  assert.ok(p.includes('(subpath "/private/tmp/grok-bench-x")'), "per-run tmp is writable");
  assert.ok(p.includes('(subpath "/dev")'), "/dev is writable");
  assert.ok(!p.includes('"/private/var/folders"'), "must NOT grant the shared TMPDIR root (other processes' temp)");
});

test("grokChildEnv redirects grok's whole state into the ephemeral tmpdir with read-only auth", async () => {
  const { grokChildEnv, GROK_VENDOR_COMPAT_DISABLED_ENV } = await import("../global-hooks/panel-lib.mjs");
  const noHeadless = { fsImpl: { existsSync: () => false } };
  const e = grokChildEnv({
    PATH: "/usr/bin",
    HOME: "/Users/u",
    BENCH_SUPPRESS_HOOKS: "0",
    GROK_CLAUDE_SKILLS_ENABLED: "true",
    GROK_CURSOR_RULES_ENABLED: "true",
    GROK_CODEX_AGENTS_ENABLED: "true"
  }, "/private/tmp/grok-bench-x", "/Users/u", noHeadless);
  assert.equal(e.HOME, "/private/tmp/grok-bench-x", "HOME hides ~/.claude, ~/.cursor, and ~/.agents from reviewer discovery");
  assert.equal(e.GROK_HOME, "/private/tmp/grok-bench-x", "GROK_HOME redirects all writes into the ephemeral tmpdir");
  assert.equal(e.TMPDIR, "/private/tmp/grok-bench-x", "TMPDIR shares the same ephemeral dir");
  assert.equal(e.GROK_AUTH_PATH, "/Users/u/.grok/auth.json", "no gate auth home → falls back to the real (read-only) auth.json");
  assert.equal(e.BENCH_SUPPRESS_HOOKS, "1", "grok must not fire Claude Code hooks");
  for (const name of Object.keys(GROK_VENDOR_COMPAT_DISABLED_ENV)) {
    assert.equal(e[name], "false", `${name} cannot be re-enabled by the ambient environment`);
  }
  assert.equal(e.PATH, "/usr/bin", "passes through the caller env");
  // Gate auth home present → auth points THERE (writable, refresh persists, chain independent of ~/.grok).
  const hasHeadless = { fsImpl: { existsSync: (p) => p === "/Users/u/.grok-headless/auth.json" } };
  const e3 = grokChildEnv({}, "/private/tmp/grok-bench-x", "/Users/u", hasHeadless);
  assert.equal(e3.GROK_AUTH_PATH, "/Users/u/.grok-headless/auth.json", "gate auth home wins when it exists");
  // Without a tmpdir (mkdtemp failed) we must NOT set GROK_HOME to ~/.grok — leave it unset. The
  // runners then refuse (fail-closed); grokChildEnv itself never points GROK_HOME at ~/.grok.
  const e2 = grokChildEnv({}, null, "/Users/u", noHeadless);
  assert.ok(!("HOME" in e2), "no tmpdir → HOME is not replaced with a nonexistent containment root");
  assert.ok(!("GROK_HOME" in e2), "no tmpdir → GROK_HOME unset (never falls back to ~/.grok writes)");
});

test("grokAuthPath precedence: inline token > caller path (writable!) > gate auth home > original home read-only", async () => {
  const { grokAuthPath } = await import("../global-hooks/panel-lib.mjs");
  const noFs = { fsImpl: { existsSync: () => false } };
  const yesFs = { fsImpl: { existsSync: () => true } };
  assert.equal(grokAuthPath({ GROK_AUTH: "tok" }, "/Users/u", yesFs), null, "inline token → nothing to inject or grant");
  // A caller's custom auth file must be WRITABLE — grok's rotating tokens persist back to it;
  // respecting the path while denying the write 401s custom-auth users.
  const caller = grokAuthPath({ GROK_AUTH_PATH: "/c/a.json" }, "/Users/u", yesFs);
  assert.deepEqual(caller, { path: "/c/a.json", writable: true, callerManaged: true }, "custom path → writable, caller-managed");
  const gate = grokAuthPath({}, "/Users/u", yesFs);
  assert.deepEqual(gate, { path: "/Users/u/.grok-headless/auth.json", writable: true }, "gate home → writable");
  const fb = grokAuthPath({}, "/Users/u", noFs);
  assert.deepEqual(fb, { path: "/Users/u/.grok/auth.json", writable: false }, "fallback → read-only");
  const fbCustomHome = grokAuthPath({ GROK_HOME: "/custom/gh" }, "/Users/u", noFs);
  assert.deepEqual(fbCustomHome, { path: "/custom/gh/auth.json", writable: false }, "fallback honors the caller's original GROK_HOME");
});

test("grokFailureMessage (darwin/sandboxed): every auth-source 401 gets its EFFECTIVE recovery", async () => {
  const { grokFailureMessage } = await import("../global-hooks/panel-lib.mjs");
  const r401 = { stderr: "Error: Unauthorized (401) … no auth context" };
  const rGrant = { stderr: "Internal error: invalid_grant (auth_kind=bearer)" };
  const setupHint = /grok gate auth not set up/;
  const rotateHint = /UNSET GROK_AUTH_PATH and run/;
  const dar = (r, auth) => grokFailureMessage(r, auth, "darwin");   // pin platform → deterministic

  // Read-only fallback (no gate home) → set the gate home up.
  assert.match(dar(r401, { path: "/Users/u/.grok/auth.json", writable: false }), setupHint, "read-only fallback → gate-home setup hint");

  // Caller-managed, SAFE path (writable, literals) → atomic refresh is denied under Seatbelt → MUST get
  // rotation guidance for the knowingly degraded caller-managed path.
  const callerWritable = dar(rGrant, { path: "/c/a.json", writable: true, callerManaged: true });
  assert.match(callerWritable, rotateHint, "writable caller 401 → rotation recovery (unset + gate home)");
  assert.match(callerWritable, /atomic token-rotation|can't create the temp file/i, "explains WHY rotation fails for a caller path");
  assert.doesNotMatch(callerWritable, setupHint, "not the bare gate-home setup hint (ineffective while GROK_AUTH_PATH is set)");

  // Caller-managed, UNSAFE path → also steered to unset+gate-home, and explains the path is unsafe.
  const callerUnsafe = dar(r401, { path: "/c/a.json", writable: false, callerManaged: true });
  assert.match(callerUnsafe, rotateHint, "unsafe caller 401 → still steered to the gate home (unset first)");
  assert.match(callerUnsafe, /can't be granted sandbox write access/i, "explains the path is unsafe");

  // Gate home writable but still 401 → its token is dead → re-auth the gate home (not "not set up").
  const gate401 = dar(r401, { path: "/Users/u/.grok-headless/auth.json", writable: true });
  assert.match(gate401, /gate.*token expired|Re-auth/i, "gate-home 401 → re-auth, not setup");
  assert.doesNotMatch(gate401, setupHint, "gate-home 401 is not a 'not set up' case");

  // Inline token / non-auth → no recovery appended.
  assert.doesNotMatch(dar(r401, null), /→/, "inline token 401 = bad token, no recovery line");
  assert.doesNotMatch(dar({ stderr: "some other crash" }, { writable: false }), /→/, "non-auth failures never append recovery");
});

test("grokFailureMessage (off darwin / unsandboxed): 401 is just an expired token — NO sandbox guidance", async () => {
  const { grokFailureMessage } = await import("../global-hooks/panel-lib.mjs");
  const rGrant = { stderr: "Internal error: invalid_grant (auth_kind=bearer)" };
  const lin = (auth) => grokFailureMessage(rGrant, auth, "linux");
  // Off darwin grokSpawnSpec runs grok BARE — no write restriction, rotation works. The darwin-only
  // "sandbox can't create the temp file / unset GROK_AUTH_PATH" guidance would be wrong here.
  const caller = lin({ path: "/c/a.json", writable: true, callerManaged: true });
  assert.match(caller, /expired|re-auth/i, "off darwin → generic re-auth");
  assert.doesNotMatch(caller, /UNSET GROK_AUTH_PATH/, "MUST NOT tell an unsandboxed caller to unset GROK_AUTH_PATH");
  assert.doesNotMatch(caller, /sandbox|atomic token-rotation|temp file/i, "MUST NOT claim the sandbox blocks rotation (there is none)");
  // Gate home off darwin → generic re-auth, may point at the gate-home command.
  const gate = lin({ path: "/Users/u/.grok-headless/auth.json", writable: true });
  assert.match(gate, /re-auth/i, "off-darwin gate-home 401 → re-auth");
  assert.doesNotMatch(gate, /sandbox|atomic/i, "no sandbox claims off darwin");
});

test("GROK_SEATBELT_PROFILE gate-managed auth grants the auth PARENT DIR (atomic OAuth write needs it)", async () => {
  const { GROK_SEATBELT_PROFILE } = await import("../global-hooks/panel-lib.mjs");
  // gateManaged=true → the bench-controlled ~/.grok-headless: parent-dir grant is safe + needed.
  const p = GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x", "/Users/u/.grok-headless/auth.json", true);
  // Grok persists tokens via sibling temp + rename. Literal-only grants allow open/write on the
  // existing file but deny creating auth.json.tmp → "disk write failed: Operation not permitted"
  // → RT rotates in-memory, disk keeps the dead RT → re-auth loop on every post-expiry gate.
  assert.ok(!p.includes("(literal "), "literals alone are insufficient; grant is the parent subpath");
  // Parse the actual subpath grants and check membership EXACTLY, rather than substring-matching the
  // profile text: a bare `p.includes('/Users/u/.grok')` would false-positive on `.grok-headless`, and a
  // negative substring assertion is easy to misread even when correct (a reviewer flagged this exact
  // line as inverted — it is not: the closing quote makes `(subpath ".../.grok")` distinct from
  // `(subpath ".../.grok-headless")`, verified false — but the structural check removes the ambiguity).
  const grants = [...p.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(grants.includes("/Users/u/.grok-headless"), "gate auth home parent is writable so atomic temp+rename can land");
  assert.ok(!grants.includes("/Users/u/.grok"), "user's interactive ~/.grok is NEVER a write grant — only the gate home");
  assert.deepEqual(grants.filter((g) => g.includes("/.grok")), ["/Users/u/.grok-headless"], "the only .grok* write surface is the gate home");
});

test("GROK_SEATBELT_PROFILE caller-managed auth grants ONLY the file literals — never the parent dir (write isolation)", async () => {
  const { GROK_SEATBELT_PROFILE } = await import("../global-hooks/panel-lib.mjs");
  // A caller's GROK_AUTH_PATH has an ARBITRARY parent — granting it as a subpath would disable the
  // sandbox's write isolation. gateManaged=false → exact file + .lock literals, no dir.
  const p = GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x", "/Users/u/.config/foo/auth.json", false);
  assert.ok(p.includes('(literal "/Users/u/.config/foo/auth.json")'), "the caller's exact auth file is writable");
  assert.ok(p.includes('(literal "/Users/u/.config/foo/auth.json.lock")'), "its lock is writable");
  const subpaths = [...p.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(!subpaths.includes("/Users/u/.config/foo"), "the caller's parent dir must NOT be granted as a subpath");
  // The dangerous cases: a broad parent must never become a write grant.
  for (const broad of ["/Users/u/auth.json" /* $HOME */, "/auth.json" /* filesystem root */, "/Users/u/.grok/auth.json" /* interactive grok */]) {
    const prof = GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x", broad, false);
    const sp = [...prof.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(sp, ["/private/tmp/grok-bench-x", "/dev"], `caller auth ${broad} grants no dir subpath — only tmp + /dev`);
    assert.ok(prof.includes(`(literal "${broad}")`), "the exact caller file is still writable (bounded)");
  }
});

test("grokSpawnSpec routes gate auth to a parent-dir grant and caller auth to literals (authGateManaged)", async () => {
  const { grokSpawnSpec } = await import("../global-hooks/panel-lib.mjs");
  const gate = grokSpawnSpec("x", { platform: "darwin", tmpDir: "/tmp/t", authWrite: "/Users/u/.grok-headless/auth.json", authGateManaged: true });
  assert.ok(gate.args[1].includes('(subpath "/Users/u/.grok-headless")'), "gate-managed → parent-dir grant");
  const caller = grokSpawnSpec("x", { platform: "darwin", tmpDir: "/tmp/t", authWrite: "/home/x/auth.json", authGateManaged: false });
  assert.ok(caller.args[1].includes('(literal "/home/x/auth.json")') && !caller.args[1].includes('(subpath "/home/x")'), "caller → literals, no parent dir");
});

test("sbplPathSafe rejects anything that could break out of an SBPL string literal", async () => {
  const { sbplPathSafe } = await import("../global-hooks/panel-lib.mjs");
  assert.equal(sbplPathSafe("/Users/u/.grok-headless/auth.json"), true, "normal absolute path is safe");
  assert.equal(sbplPathSafe('/tmp/x") (allow file-write* (subpath "/'), false, "double-quote breakout rejected");
  assert.equal(sbplPathSafe("/tmp/x\\y"), false, "backslash rejected");
  assert.equal(sbplPathSafe("/tmp/x\ny"), false, "newline rejected");
  assert.equal(sbplPathSafe("/tmp/x\x00y"), false, "NUL rejected");
  assert.equal(sbplPathSafe("relative/path"), false, "non-absolute rejected");
  assert.equal(sbplPathSafe(""), false, "empty rejected");
  assert.equal(sbplPathSafe(undefined), false, "undefined rejected");
});

test("GROK_SEATBELT_PROFILE: a malicious authWrite cannot INJECT sandbox rules (SBPL injection)", async () => {
  const { GROK_SEATBELT_PROFILE } = await import("../global-hooks/panel-lib.mjs");
  // Attacker-shaped path that tries to close the literal and add an allow-write-everywhere rule.
  const evil = '/tmp/x") (allow file-write* (subpath "/")) ;';
  const p = GROK_SEATBELT_PROFILE("/private/tmp/grok-bench-x", evil);
  assert.ok(!p.includes('subpath "/")'), "the injected root grant must NOT appear");
  assert.ok(!p.includes(evil), "the raw payload must not be interpolated at all");
  // Exactly the safe grants remain: the tmpdir and /dev, nothing from the payload.
  assert.equal((p.match(/\(literal /g) || []).length, 0, "no literal grants when authWrite is unsafe");
  assert.ok(p.includes('(subpath "/private/tmp/grok-bench-x")') && p.includes('(subpath "/dev")'), "only the safe grants survive");
  // A safe tmpDir but unsafe authWrite → tmp grant kept, auth grant dropped (fail-safe, not fail-open).
  assert.equal((p.match(/deny file-write/g) || []).length, 1, "still exactly one base deny");
});

test("grokAuthPath: an unsafe caller GROK_AUTH_PATH degrades to read-only (no write grant injected)", async () => {
  const { grokAuthPath } = await import("../global-hooks/panel-lib.mjs");
  const evil = grokAuthPath({ GROK_AUTH_PATH: '/x") (allow file-write* (subpath "/' }, "/Users/u", { fsImpl: { existsSync: () => false } });
  assert.equal(evil.writable, false, "unsafe caller path must NOT be marked writable");
  assert.equal(evil.callerManaged, true, "still honored (grok reads it) — just read-only");
});

test("grokChildEnv respects caller-provided auth (never clobbers a custom GROK_AUTH_PATH / GROK_AUTH)", async () => {
  const { grokChildEnv } = await import("../global-hooks/panel-lib.mjs");
  // Custom explicit auth path → left untouched, our default NOT injected.
  const e1 = grokChildEnv({ GROK_AUTH_PATH: "/custom/auth.json" }, "/tmp/t", "/Users/u");
  assert.equal(e1.GROK_AUTH_PATH, "/custom/auth.json", "must not overwrite a caller GROK_AUTH_PATH");
  // Inline token → we must not set GROK_AUTH_PATH at all (it would shadow the token).
  const e2 = grokChildEnv({ GROK_AUTH: "tok-123" }, "/tmp/t", "/Users/u");
  assert.equal(e2.GROK_AUTH, "tok-123", "inline token passes through");
  assert.ok(!("GROK_AUTH_PATH" in e2), "must not inject GROK_AUTH_PATH when a GROK_AUTH token is provided");
  // Custom GROK_HOME (no explicit auth) → default auth path comes from THAT home, not ~/.grok.
  const e3 = grokChildEnv({ GROK_HOME: "/custom/grokhome" }, "/tmp/t", "/Users/u");
  assert.equal(e3.GROK_AUTH_PATH, "/custom/grokhome/auth.json", "auth default derives from the caller's original GROK_HOME");
  assert.equal(e3.GROK_HOME, "/tmp/t", "GROK_HOME is still redirected to the ephemeral tmpdir for containment");
});

test("runGrokReview fails CLOSED when the private tmpdir can't be created (no unsandboxed spawn, any platform)", async () => {
  const { runGrokReview, runGrokTask } = await import("../global-hooks/panel-lib.mjs");
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = "/nonexistent-bench-tmpdir-abc123/nope";  // makeGrokTmpDir → mkdtemp throws → null
  try {
    // platform:"linux" = NO Seatbelt; the refusal is the ONLY thing preventing an unsandboxed grok write.
    const env = { BENCH_GROK_UNSANDBOXED: "1" };
    const r = await runGrokReview({ prompt: "x", cwd: process.cwd(), env, bin: "grok", platform: "linux" });
    assert.equal(r.name, "Grok");
    assert.match(r.error, /tmpdir could not be created|refusing unsandboxed/i);
    const t = await runGrokTask({ prompt: "x", cwd: process.cwd(), env, bin: "grok", platform: "linux" });
    assert.match(t.error, /tmpdir could not be created|refusing unsandboxed/i);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  }
});

test("runGrokTask fail-closes when grok reports its sandbox could not be applied", async () => {
  const { runGrokTask } = await import("../global-hooks/panel-lib.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sbxwarn-"));
  const fake = path.join(dir, "grok");
  fs.writeFileSync(fake, `#!/bin/sh\necho "warning: sandbox could not be applied: whatever" >&2\necho '{"text":"ALLOW: fine"}'\n`);
  fs.chmodSync(fake, 0o755);
  const r = await runGrokTask({ prompt: "x", cwd: dir, env: { BENCH_GROK_UNSANDBOXED: "1" }, bin: fake, platform: "linux" });
  assert.match(r.error, /sandbox could not be applied/, "an unsandboxed run must be REFUSED, not accepted");
});
