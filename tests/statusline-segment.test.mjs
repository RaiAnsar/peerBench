import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { renderSegment, latestTrace } from "../global-hooks/statusline-segment.mjs";

test("all-allow → green label, names with ✓", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "ALLOW" }] });
  assert.match(s, /⛩ plan:/); assert.match(s, /Kimi✓/); assert.match(s, /MiMo✓/);
});
test("a block → ✗ on the blocker", () => {
  const s = renderSegment({ gate: "stop", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK" }] });
  assert.match(s, /MiMo✗/); assert.match(s, /Kimi✓/);
});

// Severity-aware glyph: a BLOCK with a present sub-high severity is advisory (~), not ✗.
test("BLOCK with medium severity → ~ (advisory, not alarming ✗)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "Kimi", verdict: "ALLOW" }, { name: "MiMo", verdict: "BLOCK", severity: "medium" }] });
  assert.match(s, /MiMo~/, "medium-severity BLOCK should render ~");
  assert.doesNotMatch(s, /MiMo✗/);
});
test("BLOCK with low severity → ~", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "low" }] });
  assert.match(s, /MiMo~/);
});
test("BLOCK with high severity → ✗ (real blocker)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "high" }] });
  assert.match(s, /MiMo✗/);
});
test("BLOCK with critical severity → ✗", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "critical" }] });
  assert.match(s, /MiMo✗/);
});
test("BLOCK with NO severity (stop/pre-push trace) → ✗ (strict, unchanged)", () => {
  const s = renderSegment({ gate: "stop", reviewers: [{ name: "MiMo", verdict: "BLOCK" }] });
  assert.match(s, /MiMo✗/);
});
// FIX 5: an UNKNOWN/malformed severity ranks 0 (< high) but must be treated as STRICT (✗),
// never softened to the advisory ~ — a corrupt severity must not hide a real BLOCK.
test("FIX 5: BLOCK with an UNKNOWN/malformed severity → ✗ (strict, not ~)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "bogus" }] });
  assert.match(s, /MiMo✗/, "an unknown severity must render the strict ✗");
  assert.doesNotMatch(s, /MiMo~/, "an unknown severity must NOT render the advisory ~");
});
test("FIX 5: BLOCK with an empty-string severity → ✗ (strict)", () => {
  const s = renderSegment({ gate: "spec-review", reviewers: [{ name: "MiMo", verdict: "BLOCK", severity: "" }] });
  assert.match(s, /MiMo✗/, "an empty severity is unknown → strict ✗");
});
test("errored reviewer → !", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", error: "timeout" }, { name: "MiMo", verdict: "ALLOW" }] });
  assert.match(s, /Kimi!/);
});
test("hunt trace: findings (no verdict, no error) → ✓; errored → !", () => {
  const s = renderSegment({ gate: "hunt", reviewers: [{ name: "Codex" }, { name: "Kimi" }, { name: "MiMo", error: "timeout" }] });
  assert.match(s, /⛩ hunt:/); assert.match(s, /Codex✓/); assert.match(s, /Kimi✓/); assert.match(s, /MiMo!/);
});
test("plan-file shortens to plan; pre-push to push", () => {
  assert.match(renderSegment({ gate: "plan-file", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ plan:/);
  assert.match(renderSegment({ gate: "pre-push", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ push:/);
});
test("no trace / empty reviewers → empty string", () => {
  assert.equal(renderSegment(null), ""); assert.equal(renderSegment({ reviewers: [] }), "");
});
test("stale trace (older than 45min) is dimmed with (idle)", () => {
  const t = { gate: "plan", ts: new Date(1000).toISOString(), reviewers: [{ name: "Kimi", verdict: "BLOCK" }, { name: "MiMo", verdict: "BLOCK" }] };
  const s = renderSegment(t, { now: 1000 + 60 * 60 * 1000 });   // 1h later
  assert.match(s, /\(idle\)/); assert.match(s, /\x1b\[2m/);      // dim
});
test("fresh trace is not dimmed/idle", () => {
  const t = { gate: "plan", ts: new Date(1000).toISOString(), reviewers: [{ name: "Kimi", verdict: "ALLOW" }] };
  assert.doesNotMatch(renderSegment(t, { now: 1000 + 5000 }), /\(idle\)/);
});
test("trace without ts renders fresh (back-compat)", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] });
  assert.match(s, /Kimi✓/); assert.doesNotMatch(s, /\(idle\)/);
});
test("latestTrace returns newest by filename", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  fs.writeFileSync(path.join(d, "100-aaa.json"), JSON.stringify({ id: "100-aaa", gate: "plan", reviewers: [{ name: "Kimi", verdict: "BLOCK" }] }));
  fs.writeFileSync(path.join(d, "200-bbb.json"), JSON.stringify({ id: "200-bbb", gate: "stop", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }));
  assert.equal(latestTrace(d).id, "200-bbb");
  assert.equal(latestTrace(path.join(d, "nope")), null);
});
