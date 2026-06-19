// tests/gang-disable.test.mjs
// Tests for isGangDisabled/setGangDisabled (config-store) and gateToggleCommand (runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Use a fresh isolated root for every test so nothing bleeds across.
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gc-disable-"));
}
function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gc-ws-"));
}

// We import after setting GROK_COMPANION_ROOT so config-store picks it up.
// Because ESM caches modules, we override the root option on every call instead.
import { isGangDisabled, setGangDisabled } from "../global-hooks/config-store.mjs";
import { gateToggleCommand } from "../scripts/grok-runner.mjs";

test("workspace disable: off makes isGangDisabled true, on makes it false", () => {
  const root = freshRoot();
  const ws = freshWs();
  assert.equal(isGangDisabled(ws, { root }), false);
  setGangDisabled(ws, true, { scope: "workspace", root });
  assert.equal(isGangDisabled(ws, { root }), true);
  setGangDisabled(ws, false, { scope: "workspace", root });
  assert.equal(isGangDisabled(ws, { root }), false);
});

test("global disable: off makes isGangDisabled true for any workspace, on clears it", () => {
  const root = freshRoot();
  const ws1 = freshWs();
  const ws2 = freshWs();
  assert.equal(isGangDisabled(ws1, { root }), false);
  assert.equal(isGangDisabled(ws2, { root }), false);
  setGangDisabled(ws1, true, { scope: "global", root });
  // Any workspace sees global disable
  assert.equal(isGangDisabled(ws1, { root }), true);
  assert.equal(isGangDisabled(ws2, { root }), true);
  assert.equal(isGangDisabled(null, { root }), true);
  setGangDisabled(ws1, false, { scope: "global", root });
  assert.equal(isGangDisabled(ws1, { root }), false);
  assert.equal(isGangDisabled(ws2, { root }), false);
});

test("workspace disable does not affect another workspace", () => {
  const root = freshRoot();
  const ws1 = freshWs();
  const ws2 = freshWs();
  setGangDisabled(ws1, true, { scope: "workspace", root });
  assert.equal(isGangDisabled(ws1, { root }), true);
  assert.equal(isGangDisabled(ws2, { root }), false);
});

test("isGangDisabled is exception-safe with null/bogus ws", () => {
  const root = freshRoot();
  assert.doesNotThrow(() => isGangDisabled(null, { root }));
  assert.doesNotThrow(() => isGangDisabled(undefined, { root }));
  assert.equal(isGangDisabled(null, { root }), false);
});

test("setGangDisabled returns scope/disabled/file metadata", () => {
  const root = freshRoot();
  const ws = freshWs();
  const res = setGangDisabled(ws, true, { scope: "workspace", root });
  assert.equal(res.scope, "workspace");
  assert.equal(res.disabled, true);
  assert.ok(typeof res.file === "string" && res.file.length > 0);
});

test("gateToggleCommand off workspace: isGangDisabled becomes true", () => {
  const root = freshRoot();
  const ws = freshWs();
  // Override GROK_COMPANION_ROOT so the runner's setGangDisabled uses our root
  const prev = process.env.GROK_COMPANION_ROOT;
  process.env.GROK_COMPANION_ROOT = root;
  try {
    const out = gateToggleCommand(ws, ["off"]);
    assert.match(out, /disabled.*workspace/i);
    assert.equal(isGangDisabled(ws), true); // uses env root
  } finally {
    if (prev === undefined) delete process.env.GROK_COMPANION_ROOT;
    else process.env.GROK_COMPANION_ROOT = prev;
  }
});

test("gateToggleCommand on workspace: isGangDisabled becomes false", () => {
  const root = freshRoot();
  const ws = freshWs();
  const prev = process.env.GROK_COMPANION_ROOT;
  process.env.GROK_COMPANION_ROOT = root;
  try {
    gateToggleCommand(ws, ["off"]);
    assert.equal(isGangDisabled(ws), true);
    const out = gateToggleCommand(ws, ["on"]);
    assert.match(out, /enabled.*workspace/i);
    assert.equal(isGangDisabled(ws), false);
  } finally {
    if (prev === undefined) delete process.env.GROK_COMPANION_ROOT;
    else process.env.GROK_COMPANION_ROOT = prev;
  }
});

test("gateToggleCommand off --global: isGangDisabled true for unrelated ws", () => {
  const root = freshRoot();
  const ws = freshWs();
  const ws2 = freshWs();
  const prev = process.env.GROK_COMPANION_ROOT;
  process.env.GROK_COMPANION_ROOT = root;
  try {
    const out = gateToggleCommand(ws, ["off", "--global"]);
    assert.match(out, /disabled.*global/i);
    assert.equal(isGangDisabled(ws2), true);
  } finally {
    if (prev === undefined) delete process.env.GROK_COMPANION_ROOT;
    else process.env.GROK_COMPANION_ROOT = prev;
  }
});

test("gateToggleCommand on --global: clears global disable", () => {
  const root = freshRoot();
  const ws = freshWs();
  const prev = process.env.GROK_COMPANION_ROOT;
  process.env.GROK_COMPANION_ROOT = root;
  try {
    gateToggleCommand(ws, ["off", "--global"]);
    assert.equal(isGangDisabled(ws), true);
    const out = gateToggleCommand(ws, ["on", "--global"]);
    assert.match(out, /enabled.*global/i);
    assert.equal(isGangDisabled(ws), false);
  } finally {
    if (prev === undefined) delete process.env.GROK_COMPANION_ROOT;
    else process.env.GROK_COMPANION_ROOT = prev;
  }
});
