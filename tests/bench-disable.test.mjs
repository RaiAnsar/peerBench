// tests/bench-disable.test.mjs
// Tests for isBenchDisabled/setBenchDisabled (config-store) and gateToggleCommand (runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CRITICAL: set BENCH_ROOT before importing config-store so sharedRoot() (used by the
// WORKSPACE disable marker via workspaceStateDir) points at a temp dir — otherwise
// workspace-scoped setBenchDisabled writes into the user's REAL data dir. ({root} only
// isolates the GLOBAL marker, not the per-workspace one.)
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-disable-root-"));
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bench-disable-codex-plugin-data-"));

// Use a fresh isolated root for every test so nothing bleeds across.
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gc-disable-"));
}
function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gc-ws-"));
}

// We import after setting BENCH_ROOT so config-store picks it up.
// Because ESM caches modules, we override the root option on every call instead.
import { isBenchDisabled, setBenchDisabled } from "../global-hooks/config-store.mjs";
import { gateToggleCommand } from "../scripts/bench-runner.mjs";

test("workspace disable: off makes isBenchDisabled true, on makes it false", () => {
  const root = freshRoot();
  const ws = freshWs();
  assert.equal(isBenchDisabled(ws, { root }), false);
  setBenchDisabled(ws, true, { scope: "workspace", root });
  assert.equal(isBenchDisabled(ws, { root }), true);
  setBenchDisabled(ws, false, { scope: "workspace", root });
  assert.equal(isBenchDisabled(ws, { root }), false);
});

test("global disable: off makes isBenchDisabled true for any workspace, on clears it", () => {
  const root = freshRoot();
  const ws1 = freshWs();
  const ws2 = freshWs();
  assert.equal(isBenchDisabled(ws1, { root }), false);
  assert.equal(isBenchDisabled(ws2, { root }), false);
  setBenchDisabled(ws1, true, { scope: "global", root });
  // Any workspace sees global disable
  assert.equal(isBenchDisabled(ws1, { root }), true);
  assert.equal(isBenchDisabled(ws2, { root }), true);
  assert.equal(isBenchDisabled(null, { root }), true);
  setBenchDisabled(ws1, false, { scope: "global", root });
  assert.equal(isBenchDisabled(ws1, { root }), false);
  assert.equal(isBenchDisabled(ws2, { root }), false);
});

test("workspace disable does not affect another workspace", () => {
  const root = freshRoot();
  const ws1 = freshWs();
  const ws2 = freshWs();
  setBenchDisabled(ws1, true, { scope: "workspace", root });
  assert.equal(isBenchDisabled(ws1, { root }), true);
  assert.equal(isBenchDisabled(ws2, { root }), false);
});

test("isBenchDisabled is exception-safe with null/bogus ws", () => {
  const root = freshRoot();
  assert.doesNotThrow(() => isBenchDisabled(null, { root }));
  assert.doesNotThrow(() => isBenchDisabled(undefined, { root }));
  assert.equal(isBenchDisabled(null, { root }), false);
});

test("setBenchDisabled returns scope/disabled/file metadata", () => {
  const root = freshRoot();
  const ws = freshWs();
  const res = setBenchDisabled(ws, true, { scope: "workspace", root });
  assert.equal(res.scope, "workspace");
  assert.equal(res.disabled, true);
  assert.ok(typeof res.file === "string" && res.file.length > 0);
});

test("gateToggleCommand off workspace: isBenchDisabled becomes true", () => {
  const root = freshRoot();
  const ws = freshWs();
  // Override BENCH_ROOT so the runner's setBenchDisabled uses our root
  const prev = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = root;
  try {
    const out = gateToggleCommand(ws, ["off"]);
    assert.match(out, /disabled.*workspace/i);
    assert.equal(isBenchDisabled(ws), true); // uses env root
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT;
    else process.env.BENCH_ROOT = prev;
  }
});

test("gateToggleCommand on workspace: isBenchDisabled becomes false", () => {
  const root = freshRoot();
  const ws = freshWs();
  const prev = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = root;
  try {
    gateToggleCommand(ws, ["off"]);
    assert.equal(isBenchDisabled(ws), true);
    const out = gateToggleCommand(ws, ["on"]);
    assert.match(out, /enabled.*workspace/i);
    assert.equal(isBenchDisabled(ws), false);
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT;
    else process.env.BENCH_ROOT = prev;
  }
});

test("gateToggleCommand on workspace disables the legacy Codex plugin gate", () => {
  const root = freshRoot();
  const ws = freshWs();
  let calledWith = null;
  const out = gateToggleCommand(ws, ["on"], {
    root,
    disableLegacyCodexWorkspaceImpl: (workspace) => {
      calledWith = workspace;
      return { changed: true };
    }
  });
  assert.equal(calledWith, ws);
  assert.match(out, /enabled.*workspace/i);
  assert.match(out, /Legacy Codex gate disabled/i);
});

test("gateToggleCommand off --global: isBenchDisabled true for unrelated ws", () => {
  const root = freshRoot();
  const ws = freshWs();
  const ws2 = freshWs();
  const prev = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = root;
  try {
    const out = gateToggleCommand(ws, ["off", "--global"]);
    assert.match(out, /disabled.*global/i);
    assert.equal(isBenchDisabled(ws2), true);
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT;
    else process.env.BENCH_ROOT = prev;
  }
});

test("gateToggleCommand on --global: clears global disable", () => {
  const root = freshRoot();
  const ws = freshWs();
  const prev = process.env.BENCH_ROOT;
  process.env.BENCH_ROOT = root;
  try {
    gateToggleCommand(ws, ["off", "--global"]);
    assert.equal(isBenchDisabled(ws), true);
    const out = gateToggleCommand(ws, ["on", "--global"]);
    assert.match(out, /enabled.*global/i);
    assert.equal(isBenchDisabled(ws), false);
  } finally {
    if (prev === undefined) delete process.env.BENCH_ROOT;
    else process.env.BENCH_ROOT = prev;
  }
});

// ── C1: /bench:on must not lie in either direction ───────────────────────────
test("C1: off --global then plain on → still disabled globally (honest message)", () => {
  const root = freshRoot();
  const ws = freshWs();
  setBenchDisabled(ws, true, { scope: "global", root });
  assert.equal(isBenchDisabled(ws, { root }), true);
  // A plain (workspace) `on` must NOT claim it's enabled while global still disables.
  const out = gateToggleCommand(ws, ["on"], { root });
  assert.equal(isBenchDisabled(ws, { root }), true, "global marker must remain");
  assert.match(out, /still disabled globally/i);
});

test("C1: off then plain on → isBenchDisabled false (workspace re-enable unchanged)", () => {
  const root = freshRoot();
  const ws = freshWs();
  setBenchDisabled(ws, true, { scope: "workspace", root });
  assert.equal(isBenchDisabled(ws, { root }), true);
  const out = gateToggleCommand(ws, ["on"], { root });
  assert.equal(isBenchDisabled(ws, { root }), false);
  assert.match(out, /enabled/i);
});

test("C1: off then off --global then on --global → message names remaining workspace disable", () => {
  const root = freshRoot();
  const ws = freshWs();
  setBenchDisabled(ws, true, { scope: "workspace", root });
  setBenchDisabled(ws, true, { scope: "global", root });
  assert.equal(isBenchDisabled(ws, { root }), true);
  // Clearing only the global marker leaves the workspace marker → still disabled.
  const out = gateToggleCommand(ws, ["on", "--global"], { root });
  assert.equal(isBenchDisabled(ws, { root }), true, "workspace marker must remain");
  assert.match(out, /workspace/i);
  assert.match(out, /still disabled|disabled/i);
});

test("C1: a workspace on never clears the global marker", () => {
  const root = freshRoot();
  const ws = freshWs();
  setBenchDisabled(ws, true, { scope: "global", root });
  gateToggleCommand(ws, ["on"], { root }); // workspace scope
  assert.equal(isBenchDisabled(ws, { root }), true, "global marker untouched by workspace on");
});
