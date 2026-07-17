import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-reset-root-"));

import { consumeCycleReset, cycleResetRequested } from "../global-hooks/cycle-reset.mjs";

test("cycle reset values are durable one-shot nonces per gate and session", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-reset-ws-"));
  assert.equal(consumeCycleReset(ws, { gate: "plan", sessionKey: "chat-a", value: "1" }), true);
  assert.equal(consumeCycleReset(ws, { gate: "plan", sessionKey: "chat-a", value: "1" }), false,
    "an inherited reset value cannot erase the ceiling repeatedly");
  assert.equal(consumeCycleReset(ws, { gate: "plan", sessionKey: "chat-a", value: "2" }), true,
    "a changed nonce intentionally authorizes one fresh cycle");
  assert.equal(consumeCycleReset(ws, { gate: "plan", sessionKey: "chat-b", value: "1" }), true);
  assert.equal(consumeCycleReset(ws, { gate: "stop", sessionKey: "chat-a", value: "1" }), true);
});

test("cycle reset false-like values never create a receipt", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-reset-false-ws-"));
  for (const value of [undefined, "", "0", "false", "no", "off"]) {
    assert.equal(cycleResetRequested(value), false);
    assert.equal(consumeCycleReset(ws, { gate: "plan", sessionKey: "chat", value }), false);
  }
});
