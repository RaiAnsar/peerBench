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
