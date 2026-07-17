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

test("a slow holder's release does NOT delete a stolen-and-reacquired live slot", async () => {
  const root = tmpRoot();
  const slot = path.join(root, "locks", "g", "slot-0");
  const waitFor = async (cond) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    assert.ok(cond(), "timed out waiting for the limiter");
  };
  // A acquires the only slot and runs "too long" (outlives the stealer's staleMs).
  let aHolding = false, finishA;
  const aDone = withConcurrencyLimit({ name: "g", slots: 1, root, staleMs: 60_000, timeoutMs: 2000 },
    () => new Promise((r) => { aHolding = true; finishA = r; }));
  await waitFor(() => aHolding);
  // B steals the (by its clock, stale) slot and keeps holding it.
  let bHolding = false, finishB;
  const bDone = withConcurrencyLimit({ name: "g", slots: 1, root, staleMs: 0, timeoutMs: 2000 },
    () => new Promise((r) => { bHolding = true; finishB = r; }));
  await waitFor(() => bHolding);
  // The slow finisher's release must not rmdir the slot the stealer now owns (that would let a
  // third process mkdir the same slot and exceed the per-key cap).
  finishA(); await aDone;
  assert.ok(fs.existsSync(slot), "stale holder's release deleted the live stolen slot");
  finishB(); await bDone;
  assert.ok(!fs.existsSync(slot), "the rightful owner's release still frees the slot");
  fs.rmSync(root, { recursive: true, force: true });
});
