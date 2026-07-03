// global-hooks/concurrency-limit.mjs
// Cross-process counting semaphore. peerBench fires GLM from many independent gate processes (Stop
// hooks across projects, hunts, etc.); without coordination they burst past z.ai's ~3-concurrent-per-key
// cap and get shed as 429/529. OpenCode never hits that cap because it is implicitly serialized — one
// in-flight request per session. This makes peerBench behave the same way: only `slots` calls run at
// once across ALL processes; the rest wait for a free slot instead of erroring.
//
// Mechanism: atomic mkdir as the lock primitive (POSIX-atomic, works across processes). One dir per
// slot. A holder that crashes leaves a stale slot; the next acquirer steals it once it is older than
// staleMs. Fails OPEN — if no slot frees within timeoutMs we run anyway rather than block a review
// forever (worst case is a 429 the caller already retries).
//
// `fn` receives the acquired slot index (0..slots-1, or null when the limiter is disabled / failed
// open). Callers map the slot to a specific API key (key = slotIndex ÷ perKeyCap) so the PER-KEY cap
// is enforced, not just a global one — z.ai sheds per key, so a global cap with random key choice
// still overloads one key.
import fs from "node:fs";
import path from "node:path";
import { sharedRoot } from "./config-store.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withConcurrencyLimit(opts, fn) {
  const { name, slots, staleMs = 300_000, timeoutMs = 300_000, sleepImpl = defaultSleep, root = sharedRoot(), now = () => Date.now() } = opts || {};
  if (!slots || slots < 1 || !name) return fn(null);          // limiter disabled → run unbounded
  const dir = path.join(root, "locks", name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return fn(null); }  // can't make lock dir → fail open
  const deadline = now() + timeoutMs;
  let held = null, heldIdx = null;
  while (!held) {
    for (let i = 0; i < slots; i++) {
      const slot = path.join(dir, `slot-${i}`);
      try { fs.mkdirSync(slot); held = slot; heldIdx = i; break; }   // claimed a free slot
      catch (e) {
        if (e?.code !== "EEXIST") { return fn(null); }        // unexpected fs error → fail open
        try {                                                 // occupied: steal only if stale (crashed holder)
          if (now() - fs.statSync(slot).mtimeMs > staleMs) { fs.rmdirSync(slot); fs.mkdirSync(slot); held = slot; heldIdx = i; break; }
        } catch { /* lost the race or vanished — loop and retry */ }
      }
    }
    if (held) break;
    if (now() >= deadline) return fn(null);                   // fail open rather than block a review forever
    await sleepImpl(50 + Math.floor((now() % 150)));          // brief jittered wait for a slot to free
  }
  try { return await fn(heldIdx); }
  finally { try { fs.rmdirSync(held); } catch { /* already stolen/removed */ } }
}

// Self-check: assert the limiter never lets more than `slots` run at once. Run: node concurrency-limit.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conclim-"));
  let inFlight = 0, peak = 0;
  const task = () => withConcurrencyLimit({ name: "t", slots: 3, root, timeoutMs: 10_000 }, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
  });
  await Promise.all(Array.from({ length: 20 }, task));
  fs.rmSync(root, { recursive: true, force: true });
  if (peak > 3) { console.error(`FAIL: peak in-flight ${peak} > 3`); process.exit(1); }
  console.log(`ok: 20 tasks, slots=3, peak in-flight=${peak}`);
}
