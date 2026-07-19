import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import after isolating the shared state root. These tests must never touch the
// user's installed peerBench state.
process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-disable-root-"));

import { isBenchDisabled, setBenchDisabled, workspaceStateDir } from "../global-hooks/config-store.mjs";
import { gateToggleCommand } from "../scripts/bench-runner.mjs";

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-disable-"));
}

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-ws-"));
}

test("workspace disable is isolated to one workspace", () => {
  const root = freshRoot();
  const wsA = freshWs();
  const wsB = freshWs();

  assert.equal(isBenchDisabled(wsA, { root }), false);
  setBenchDisabled(wsA, true, { scope: "workspace", root });
  assert.equal(isBenchDisabled(wsA, { root }), true);
  assert.equal(isBenchDisabled(wsB, { root }), false);
  assert.equal(isBenchDisabled(null, { root }), false);

  setBenchDisabled(wsA, false, { scope: "workspace", root });
  assert.equal(isBenchDisabled(wsA, { root }), false);
});

test("setBenchDisabled reports workspace metadata for the default scope", () => {
  const root = freshRoot();
  const ws = freshWs();
  const result = setBenchDisabled(ws, true, { root });

  assert.equal(result.scope, "workspace");
  assert.equal(result.disabled, true);
  assert.equal(result.file, path.join(workspaceStateDir(ws), "disabled"));
  assert.equal(fs.existsSync(result.file), true);
});

test("explicit global disable applies to every workspace", () => {
  const root = freshRoot();
  const wsA = freshWs();
  const wsB = freshWs();

  const result = setBenchDisabled(wsA, true, { scope: "global", root });
  assert.equal(result.scope, "global");
  assert.equal(result.file, path.join(root, "disabled-global"));
  assert.equal(isBenchDisabled(wsA, { root }), true);
  assert.equal(isBenchDisabled(wsB, { root }), true);

  setBenchDisabled(wsB, false, { scope: "global", root });
  assert.equal(isBenchDisabled(wsA, { root }), false);
  assert.equal(isBenchDisabled(wsB, { root }), false);
});

test("isBenchDisabled is exception-safe without a workspace", () => {
  const root = freshRoot();
  assert.doesNotThrow(() => isBenchDisabled(null, { root }));
  assert.doesNotThrow(() => isBenchDisabled(undefined, { root }));
  assert.equal(isBenchDisabled(null, { root }), false);
});

test("plain bench off/on toggles only the current workspace", () => {
  const root = freshRoot();
  const wsA = freshWs();
  const wsB = freshWs();

  const offOutput = gateToggleCommand(wsA, ["off"], { root });
  assert.match(offOutput, /disabled.*workspace/i);
  assert.equal(isBenchDisabled(wsA, { root }), true);
  assert.equal(isBenchDisabled(wsB, { root }), false);

  const onOutput = gateToggleCommand(wsA, ["on"], { root });
  assert.match(onOutput, /enabled.*workspace/i);
  assert.equal(isBenchDisabled(wsA, { root }), false);
});

test("--global toggles the explicit global kill switch", () => {
  const root = freshRoot();
  const wsA = freshWs();
  const wsB = freshWs();

  assert.match(gateToggleCommand(wsA, ["off", "--global"], { root }), /disabled.*global/i);
  assert.equal(isBenchDisabled(wsA, { root }), true);
  assert.equal(isBenchDisabled(wsB, { root }), true);
  assert.match(gateToggleCommand(wsB, ["on", "--global"], { root }), /enabled.*global/i);
  assert.equal(isBenchDisabled(wsA, { root }), false);
  assert.equal(isBenchDisabled(wsB, { root }), false);
});

test("workspace on does not silently clear the global kill switch", () => {
  const root = freshRoot();
  const ws = freshWs();
  gateToggleCommand(ws, ["off", "--global"], { root });

  const output = gateToggleCommand(ws, ["on"], { root });
  assert.equal(isBenchDisabled(ws, { root }), true);
  assert.match(output, /still disabled globally/i);
});

test("toggle output contains no legacy Codex-gate side effects", () => {
  const root = freshRoot();
  const ws = freshWs();
  const output = `${gateToggleCommand(ws, ["off"], { root })}\n${gateToggleCommand(ws, ["on"], { root })}`;

  assert.doesNotMatch(output, /legacy|Codex gate|single.gate/i);
});
