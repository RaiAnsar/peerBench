// One-shot reset receipts for automatic review-cycle ceilings.
//
// A reset environment variable is often exported in a shell, not scoped to one command. Treating
// every truthy observation as a reset silently removes the ceiling forever. A receipt makes a
// given value effective exactly once for one gate/scope/session. Users who intentionally need a
// later reset can supply a different nonce (for example BENCH_*_CYCLE_RESET=2).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSessionId, workspaceStateDir } from "./config-store.mjs";

export function cycleResetRequested(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function consumeCycleReset(ws, {
  gate,
  sessionKey = null,
  value,
  fsImpl = fs
} = {}) {
  if (!cycleResetRequested(value) || !gate) return false;
  const session = normalizeSessionId(sessionKey) || "session-unscoped";
  const scope = digest(`${String(gate)}\0${session}`).slice(0, 32);
  const token = digest(String(value));
  const dir = path.join(workspaceStateDir(ws), "cycle-reset-receipts", scope);
  const receipt = path.join(dir, `${token}.json`);
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fsImpl.chmodSync?.(dir, 0o700); } catch { /* parent policy may own permissions */ }
    fsImpl.writeFileSync(receipt, `${JSON.stringify({ schema: 1, gate: String(gate), session, token, ts: Date.now() })}\n`, {
      flag: "wx",
      mode: 0o600
    });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    // If persistence fails, preserve the ceiling rather than accidentally granting an unbounded
    // reset on every invocation.
    return false;
  }
}
