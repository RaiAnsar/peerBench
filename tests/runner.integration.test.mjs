// tests/runner.integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, huntCommand } from "../scripts/grok-runner.mjs";
process.env.GROK_COMPANION_ROOT = process.env.GROK_COMPANION_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "gc-h-"));

const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "scripts", "grok-runner.mjs");

function freshWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: ws });
  return ws;
}

function run(args, { ws = freshWs(), envExtra = {} } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const out = execFileSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    cwd: ws,
    env: {
      ...process.env,
      GROK_COMPANION_ROOT: dataRoot,
      ...envExtra
    }
  });
  return { out, dataRoot, ws };
}

test("parseArgs: --base flag consumed correctly", () => {
  const { flags } = parseArgs(["--base", "main"]);
  assert.equal(flags.base, "main");
});

test("parseArgs: --base embedded in quoted arg lifted correctly", () => {
  const { flags } = parseArgs(["--base main"]);
  assert.equal(flags.base, "main");
});

test("setup reports gang health without throwing", () => {
  const { out } = run(["setup"]);
  assert.match(out, /Active reviewers/);
  assert.match(out, /Gang disabled/);
  assert.match(out, /KIMI_API_KEY/);
  assert.match(out, /MIMO_API_KEY/);
  assert.match(out, /Codex plugin/);
});

test("review subcommand runs panel and prints combined result (no-key fail-open)", () => {
  const ws = freshWs();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  fs.writeFileSync(path.join(ws, "change.ts"), "export const x = 1;\n");
  const out = execFileSync(process.execPath, [RUNNER, "review"], {
    encoding: "utf8",
    cwd: ws,
    env: {
      ...process.env,
      GROK_COMPANION_ROOT: dataRoot,
      KIMI_API_KEY: "",
      MIMO_API_KEY: ""
    }
  });
  assert.ok(out.length > 0);
  // No keys → reviewers fail-open; result line present
  assert.match(out, /Result:/i);
});

test("review with --base flag runs without error (fail-open when no keys)", () => {
  const ws = freshWs();
  fs.writeFileSync(path.join(ws, "feature.txt"), "NEEDLE_BRANCH_DIFF\n");
  execFileSync("git", ["checkout", "-qb", "feat"], { cwd: ws });
  execFileSync("git", ["add", "feature.txt"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat"], { cwd: ws });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const out = execFileSync(process.execPath, [RUNNER, "review", "--json", "--base main"], {
    encoding: "utf8",
    cwd: ws,
    env: { ...process.env, GROK_COMPANION_ROOT: dataRoot, KIMI_API_KEY: "", MIMO_API_KEY: "" }
  });
  const payload = JSON.parse(out);
  assert.ok(["allow", "block", "fail-open"].includes(payload.decision));
});

test("status shows no traces message when workspace has no traces", () => {
  const { out } = run(["status"]);
  assert.match(out, /No gang review traces/);
});

test("huntCommand formats findings per reviewer and records a trace", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hc-"));
  const huntImpl = async () => ([
    { name: "Codex", findings: "1. bug at a.ts:10", model: "gpt" },
    { name: "Kimi", findings: "1. bug at a.ts:10\n2. risk at b.ts:4", model: "kimi-for-coding" },
    { name: "MiMo", findings: "", error: "timeout" }
  ]);
  const out = await huntCommand(ws, "a monitor never alerted", { huntImpl });
  assert.match(out, /focus: a monitor never alerted/);
  assert.match(out, /═══ Codex ═══/); assert.match(out, /a\.ts:10/);
  assert.match(out, /═══ MiMo ═══/); assert.match(out, /no findings — timeout/);
});
test("huntCommand deep=true uses 'investigate' header and records gate='investigate' in trace", async () => {
  const { listTraces, readTrace } = await import("../global-hooks/trace-store.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hci-"));
  const huntImpl = async () => ([
    { name: "Codex", findings: "deep finding", model: "gpt" },
    { name: "Kimi", findings: "deep kimi finding", model: "kimi-for-coding" },
    { name: "MiMo", findings: "deep mimo finding", model: "mimo" }
  ]);
  const out = await huntCommand(ws, "why does uptime monitor never escalate", { huntImpl, deep: true });
  assert.match(out, /Investigation — focus: why does uptime monitor never escalate/);
  const [latest] = listTraces(ws, 1);
  assert.equal(latest.gate, "investigate");
  const t = readTrace(ws, latest.id);
  assert.equal(t.gate, "investigate");
});
test("huntCommand persists per-reviewer diag to the trace (for future debugging)", async () => {
  const { listTraces, readTrace } = await import("../global-hooks/trace-store.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hcd-"));
  const huntImpl = async () => ([
    { name: "Kimi", findings: "x", model: "kimi-for-coding", diag: { steps: 3, filesRead: ["a.ts"], toolBytes: 1234, lastReqBytes: 9000 } },
    { name: "MiMo", findings: "", error: "network: fetch failed", diag: { steps: 5, filesRead: [], toolBytes: 250000, lastReqBytes: 300000 } }
  ]);
  await huntCommand(ws, "x", { huntImpl });
  const [latest] = listTraces(ws, 1);
  const t = readTrace(ws, latest.id);
  const kimi = t.reviewers.find((r) => r.name === "Kimi");
  assert.equal(kimi.diag.steps, 3); assert.equal(kimi.diag.toolBytes, 1234);
  assert.equal(t.reviewers.find((r) => r.name === "MiMo").diag.lastReqBytes, 300000);
});
