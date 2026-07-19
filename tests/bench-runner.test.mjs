import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BENCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-root-"));

import {
  codexPromptStatus,
  codexSetupStatus,
  gradeCommand,
  healthCommand,
  huntCommand,
  reviewersCommand,
  setupStatus,
  statusCommand
} from "../scripts/bench-runner.mjs";
import { resolveConfig } from "../global-hooks/config-store.mjs";
import { writeTrace } from "../global-hooks/trace-store.mjs";

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-ws-"));
}

function writeJson(obj, prefix = "bench-runner-json-") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "settings.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

function captureStdout(fn) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { output, result };
  } finally {
    process.stdout.write = original;
  }
}

test("reviewer registry ignores stale providers and keeps only Grok + MiMo", () => {
  fs.writeFileSync(path.join(process.env.BENCH_ROOT, "companion.json"), JSON.stringify({
    reviewers: ["codex", "kimi", "glm", "qwen", "minimax", "grok", "mimo"]
  }));

  assert.deepEqual(resolveConfig({ env: {} }).reviewers, ["grok", "mimo"]);
});

test("reviewersCommand rejects removed reviewer names without changing the panel", () => {
  const before = resolveConfig().reviewers.slice();
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const { output } = captureStdout(() => reviewersCommand(["kimi"]));
    assert.match(output, /Error:/);
    assert.match(output, /known: grok, mimo/i);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(resolveConfig().reviewers, before);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("reviewersCommand accepts the lightweight Grok + MiMo panel", () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const { output } = captureStdout(() => reviewersCommand(["grok", "mimo"]));
    assert.match(output, /Reviewers set to: grok, mimo/i);
    assert.doesNotMatch(output, /Error:/);
    assert.deepEqual(resolveConfig().reviewers, ["grok", "mimo"]);
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("statusCommand expands a Grok + MiMo trace", () => {
  const ws = freshWs();
  const id = writeTrace(ws, {
    gate: "review",
    ws,
    reviewers: [
      { name: "Grok", verdict: "ALLOW" },
      { name: "MiMo", verdict: "BLOCK" }
    ],
    systemPrompt: "SYSTEM-MARKER",
    userPrompt: "USER-MARKER",
    rawResponses: { Grok: "ALLOW: clean", MiMo: "BLOCK: concrete bug" }
  });

  const { output } = captureStdout(() => statusCommand(ws, [id]));
  assert.match(output, /Grok/);
  assert.match(output, /MiMo/);
  assert.match(output, /SYSTEM-MARKER/);
  assert.match(output, /USER-MARKER/);
  assert.match(output, /BLOCK: concrete bug/);
});

test("statusCommand reports unknown and empty trace sets without throwing", () => {
  const ws = freshWs();
  assert.match(captureStdout(() => statusCommand(ws, ["missing"])).output, /not found/i);
  assert.match(captureStdout(() => statusCommand(ws, [])).output, /No bench review traces/i);
});

test("setupStatus reports exactly one automatic hook: matcher-less Stop", () => {
  const output = setupStatus(writeJson({ hooks: {} }));
  assert.equal((output.match(/stop-review\.mjs/g) || []).length, 1);
  assert.match(output, /Stop\(matcher-less\).*stop-review\.mjs.*MISSING/i);
  assert.doesNotMatch(output, /plan-review|plan-file-review|pre-push-review|deep-review-runner/);
});

test("setupStatus recognizes the one registered Stop hook", () => {
  const output = setupStatus(writeJson({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/stop-review.mjs"' }] }]
    }
  }));

  assert.equal((output.match(/stop-review\.mjs/g) || []).length, 1);
  assert.match(output, /registered \(settings\)/i);
});

test("setupStatus recognizes a plugin-managed Stop hook", () => {
  const settingsPath = writeJson({ hooks: {} });
  const pluginHooksPath = writeJson({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/global-hooks/stop-review.mjs"' }] }]
    }
  }, "bench-runner-plugin-hooks-");

  assert.match(setupStatus(settingsPath, { pluginHooksPath }), /registered \(plugin\)/i);
});

test("setupStatus rejects a matcher-scoped Stop hook", () => {
  const output = setupStatus(writeJson({
    hooks: {
      Stop: [{ matcher: "SomeTool", hooks: [{ type: "command", command: 'node "/x/stop-review.mjs"' }] }]
    }
  }));
  assert.match(output, /MISREGISTERED/i);
});

test("setupStatus handles malformed or missing settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-bad-settings-"));
  const malformed = path.join(dir, "malformed.json");
  fs.writeFileSync(malformed, "{not json");
  const missing = path.join(dir, "missing.json");

  assert.match(setupStatus(malformed), /unable to check/i);
  assert.match(setupStatus(missing), /unable to check/i);
});

test("codexSetupStatus reports the single Codex Stop wrapper", () => {
  const output = codexSetupStatus(writeJson({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "/x/codex-stop-review.mjs"' }] }]
    }
  }));

  assert.match(output, /Stop\(matcher-less\).*codex-stop-review\.mjs.*registered/i);
  assert.equal((output.match(/codex-stop-review\.mjs/g) || []).length, 1);
});

test("codexPromptStatus reports the ten installed manual commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-prompts-"));
  for (const name of [
    "bench-debug.md",
    "bench-hunt.md",
    "bench-investigate.md",
    "bench-off.md",
    "bench-on.md",
    "bench-review.md",
    "bench-reviewers.md",
    "bench-scorecard.md",
    "bench-setup.md",
    "bench-status.md"
  ]) {
    fs.writeFileSync(path.join(dir, name), `node "/x/scripts/bench-runner.mjs" ${name}\n`);
  }

  assert.match(codexPromptStatus(dir), /10 registered/);
  fs.writeFileSync(path.join(dir, "bench-hunt.md"), "{{BENCH_RUNNER}}\n");
  assert.match(codexPromptStatus(dir), /MISSING.*bench-hunt\.md/);
});

test("huntCommand uses injected Grok + MiMo findings and survives trace failure", async () => {
  const ws = freshWs();
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const output = await huntCommand(ws, "a monitor missed an alert", {
      huntImpl: async () => [
        { name: "Grok", findings: "found a race at monitor.ts:10" },
        { name: "MiMo", findings: "found a retry bug at queue.ts:4" }
      ],
      writeTraceImpl: () => { throw new Error("disk full"); }
    });
    assert.match(output, /Grok/);
    assert.match(output, /MiMo/);
    assert.match(output, /monitor\.ts:10/);
    assert.match(stderr.join(""), /trace write failed.*disk full/i);
  } finally {
    process.stderr.write = original;
  }
});

test("gradeCommand records valid Grok + MiMo grades through its fake", () => {
  const calls = [];
  const { output } = captureStdout(() => gradeCommand(
    ["trace-1", "Grok:tp", "MiMo:fp", "--note", "verified"],
    { recordImpl: (entry) => calls.push(entry) }
  ));

  assert.deepEqual(calls.map((entry) => `${entry.reviewer}:${entry.grade}`), ["Grok:tp", "MiMo:fp"]);
  assert.equal(calls[0].note, "verified");
  assert.match(output, /Graded trace-1/);
});

test("healthCommand probes only Grok + MiMo through injected fakes", async () => {
  const calls = [];
  const cfg = {
    reviewers: ["grok", "mimo"],
    providers: {
      mimo: { apiKey: "fake", baseURL: "https://invalid.example/v1", model: "mimo-v2.5-pro", headers: {} }
    }
  };
  const result = await healthCommand({
    cfg,
    grokImpl: () => {
      calls.push("grok");
      return { status: 0, stdout: "OK", stderr: "" };
    },
    fetchImpl: async () => {
      calls.push("mimo");
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.sort(), ["grok", "mimo"]);
  assert.match(result.text, /✓ Grok/);
  assert.match(result.text, /✓ MiMo/);
  assert.doesNotMatch(result.text, /Codex|Kimi|GLM|Qwen|MiniMax/);
});

test("healthCommand --all probes inactive supported reviewers, including Grok", async () => {
  const calls = [];
  const result = await healthCommand({
    all: true,
    platform: "darwin",
    cfg: {
      reviewers: ["mimo"],
      providers: {
        mimo: { apiKey: "fake", apiKeys: ["fake"], baseURL: "https://invalid.example/v1", model: "mimo-v2.5-pro", headers: {} }
      }
    },
    grokImpl: () => {
      calls.push("grok");
      return { status: 0, stdout: "OK", stderr: "" };
    },
    reviewImpl: async () => {
      calls.push("mimo");
      return { ok: true, text: "OK" };
    }
  });

  assert.deepEqual(calls.sort(), ["grok", "mimo"]);
  assert.deepEqual(result.results.map((entry) => entry.name), ["grok", "mimo"]);
  assert.match(result.text, /all supported/i);
  assert.match(result.text, /Grok\s+inactive/i);
  assert.equal(result.ok, true, "an inactive reviewer does not fail active-panel health");
});

test("healthCommand fails when an active MiMo fake fails", async () => {
  const cfg = {
    reviewers: ["grok", "mimo"],
    providers: {
      mimo: { apiKey: "fake", baseURL: "https://invalid.example/v1", model: "mimo-v2.5-pro", headers: {} }
    }
  };
  const result = await healthCommand({
    cfg,
    grokImpl: () => ({ status: 0, stdout: "OK", stderr: "" }),
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "overloaded" })
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /✗ MiMo.*HTTP 429/);
});

test("healthCommand redacts a provider key echoed in diagnostics", async () => {
  const secret = "fake-health-secret-123456";
  const result = await healthCommand({
    cfg: {
      reviewers: ["mimo"],
      providers: { mimo: { apiKey: secret, apiKeys: [secret], baseURL: "https://invalid.example/v1", model: "mimo-v2.5-pro", headers: {} } }
    },
    fetchImpl: async () => ({ ok: false, status: 402, text: async () => `payment required: ${secret}` })
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, new RegExp(secret));
  assert.match(result.text, /\[redacted\]/);
});

test("healthCommand refuses an unsandboxed Grok probe off macOS", async () => {
  let called = false;
  const result = await healthCommand({
    platform: "linux",
    env: {},
    cfg: { reviewers: ["grok"], providers: {} },
    grokImpl: () => { called = true; return { status: 0, stdout: "OK", stderr: "" }; }
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.match(result.text, /hard read-only containment is only available on macOS/i);
});

test("healthCommand redacts configured Grok credentials echoed by the CLI", async () => {
  const secret = "fake-grok-health-token-123456";
  const result = await healthCommand({
    platform: "darwin",
    env: { GROK_ACCESS_TOKEN: secret },
    cfg: { reviewers: ["grok"], providers: {} },
    grokImpl: () => ({ status: 1, stdout: "", stderr: `authentication failed for ${secret}` })
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, new RegExp(secret));
  assert.match(result.text, /\[redacted\]/);
});
