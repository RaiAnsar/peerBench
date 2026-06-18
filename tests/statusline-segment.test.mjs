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
test("errored reviewer → !", () => {
  const s = renderSegment({ gate: "plan", reviewers: [{ name: "Kimi", error: "timeout" }, { name: "MiMo", verdict: "ALLOW" }] });
  assert.match(s, /Kimi!/);
});
test("plan-file shortens to plan; pre-push to push", () => {
  assert.match(renderSegment({ gate: "plan-file", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ plan:/);
  assert.match(renderSegment({ gate: "pre-push", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }), /⛩ push:/);
});
test("no trace / empty reviewers → empty string", () => {
  assert.equal(renderSegment(null), ""); assert.equal(renderSegment({ reviewers: [] }), "");
});
test("latestTrace returns newest by filename", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  fs.writeFileSync(path.join(d, "100-aaa.json"), JSON.stringify({ id: "100-aaa", gate: "plan", reviewers: [{ name: "Kimi", verdict: "BLOCK" }] }));
  fs.writeFileSync(path.join(d, "200-bbb.json"), JSON.stringify({ id: "200-bbb", gate: "stop", reviewers: [{ name: "Kimi", verdict: "ALLOW" }] }));
  assert.equal(latestTrace(d).id, "200-bbb");
  assert.equal(latestTrace(path.join(d, "nope")), null);
});
