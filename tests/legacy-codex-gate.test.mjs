import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  disableLegacyCodexStopGateForWorkspace,
  disableLegacyCodexStopGateStates,
  enableLegacyCodexStopGateStates
} from "../global-hooks/legacy-codex-gate.mjs";

function keyFor(ws) {
  let canonical = ws;
  try { canonical = fs.realpathSync.native(ws); } catch { canonical = ws; }
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

test("disableLegacyCodexStopGateForWorkspace flips only stopReviewGate and preserves jobs", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-codex-ws-"));
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-codex-data-"));
  const dir = path.join(pluginDataDir, "state", keyFor(ws));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    config: { stopReviewGate: true, other: "keep" },
    jobs: [{ id: "job-1" }]
  }, null, 2));

  const result = disableLegacyCodexStopGateForWorkspace(ws, { pluginDataDir });
  assert.equal(result.changed, true);
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(next.config.stopReviewGate, false);
  assert.equal(next.config.other, "keep");
  assert.deepEqual(next.jobs, [{ id: "job-1" }]);
});

test("disableLegacyCodexStopGateStates disables every existing legacy state file", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-codex-all-"));
  const root = path.join(pluginDataDir, "state");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }, null, 2));
  fs.writeFileSync(path.join(root, "b", "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] }, null, 2));

  const result = disableLegacyCodexStopGateStates({ pluginDataDir });
  assert.equal(result.scanned, 2);
  assert.equal(result.changed, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "a", "state.json"), "utf8")).config.stopReviewGate, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "b", "state.json"), "utf8")).config.stopReviewGate, false);
});

test("enableLegacyCodexStopGateStates re-enables every existing state file (restore), preserving jobs", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-codex-en-"));
  const root = path.join(pluginDataDir, "state");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: false, other: "keep" }, jobs: [{ id: "j" }] }, null, 2));
  fs.writeFileSync(path.join(root, "b", "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }, null, 2));

  const result = enableLegacyCodexStopGateStates({ pluginDataDir });
  assert.equal(result.scanned, 2);
  assert.equal(result.changed, 1);   // only `a` flipped false→true; `b` already enabled
  const a = JSON.parse(fs.readFileSync(path.join(root, "a", "state.json"), "utf8"));
  assert.equal(a.config.stopReviewGate, true);
  assert.equal(a.config.other, "keep");
  assert.deepEqual(a.jobs, [{ id: "j" }]);
});
