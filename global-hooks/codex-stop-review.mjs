#!/usr/bin/env node
// Codex Stop hook wrapper for peerBench.
// Direct Codex sessions are reviewed by the non-Codex bench panel. Codex sessions launched as
// reviewers/delegates from Claude are explicitly skipped so peerBench never reviews itself.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runMain } from "./stop-review.mjs";

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ bench codex stop: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

function truthy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function shouldSkipCodexStop(env = process.env) {
  if (truthy(env.BENCH_SUPPRESS_HOOKS) || truthy(env.PEERBENCH_SUPPRESS_HOOKS)) return true;
  if (env.CODEX_COMPANION_SESSION_ID) return true;
  if (path.basename(String(env.CODEX_HOME || "")) === ".codex-headless") return true;
  return false;
}

export function createCodexEmitter({ stdout = process.stdout, stderr = process.stderr } = {}) {
  let emitted = false;
  return {
    hasEmitted: () => emitted,
    emit(payload) {
      if (emitted) return false;
      const message = String(payload?.systemMessage ?? "").trim();
      if (message) {
        stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
        emitted = true;
      }
      return true;
    },
    block({ message }) {
      if (emitted) return false;
      stdout.write(`${JSON.stringify({ decision: "block", reason: message })}\n`);
      emitted = true;
      return true;
    }
  };
}

export async function runCodexStop({
  input = readInput(),
  env = process.env,
  emitter = createCodexEmitter(),
  resolveReviewersImpl,
  writeTraceImpl,
  isBenchDisabledImpl
} = {}) {
  if (shouldSkipCodexStop(env)) return;
  await runMain({
    input,
    env,
    agentName: "Codex",
    emitter,
    ...(resolveReviewersImpl ? { resolveReviewersImpl } : {}),
    ...(writeTraceImpl ? { writeTraceImpl } : {}),
    ...(isBenchDisabledImpl ? { isBenchDisabledImpl } : {}),
    blockHandler: ({ panel, message }) => emitter.block({ panel, message })
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodexStop().catch((error) => {
    process.stderr.write(`⛩ bench codex stop: hook error (turn allowed) — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
