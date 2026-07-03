import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withConcurrencyLimit } from "../global-hooks/concurrency-limit.mjs";

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "conclim-test-")); }

test("never lets more than `slots` run at once across many callers", async () => {
  const root = tmpRoot();
  let inFlight = 0, peak = 0;
  const task = () => withConcurrencyLimit({ name: "g", slots: 3, root, timeoutMs: 10_000 }, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return "done";
  });
  const res = await Promise.all(Array.from({ length: 15 }, task));
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(peak, 3);
  assert.equal(res.filter((r) => r === "done").length, 15);
});

test("slots=0 disables the limiter (runs unbounded, no lock dir)", async () => {
  const root = tmpRoot();
  let peak = 0, inFlight = 0;
  await Promise.all(Array.from({ length: 5 }, () => withConcurrencyLimit({ name: "g", slots: 0, root }, async () => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 10)); inFlight--;
  })));
  assert.equal(peak, 5);
  assert.equal(fs.existsSync(path.join(root, "locks")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("steals a stale slot left by a crashed holder", async () => {
  const root = tmpRoot();
  const dir = path.join(root, "locks", "g");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "slot-0"));            // simulate a crashed holder occupying the only slot
  let ran = false;
  // staleMs=0 → the occupied slot is immediately considered stale and stolen
  await withConcurrencyLimit({ name: "g", slots: 1, root, staleMs: 0, timeoutMs: 2000 }, async () => { ran = true; });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(ran, true);
});

test("fails open (runs anyway) if no slot frees before timeout", async () => {
  const root = tmpRoot();
  const dir = path.join(root, "locks", "g");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "slot-0"));            // hold the only slot, never release
  let ran = false;
  const t = Date.now();
  await withConcurrencyLimit({ name: "g", slots: 1, root, staleMs: 999_999, timeoutMs: 150, sleepImpl: (ms) => new Promise((r) => setTimeout(r, ms)) }, async () => { ran = true; });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(ran, true);                            // never blocks a review forever
  assert.ok(Date.now() - t >= 150);
});
