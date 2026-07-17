#!/usr/bin/env node
// Native Git pre-push entrypoint. Git, not a hand-written shell parser, supplies the exact ref
// updates. Any non-zero exit aborts the push before refs are changed on the remote.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isBenchDisabled, writeReviewedHead } from "./config-store.mjs";
import { parsePrePushUpdates, reviewNativePush } from "./pre-push-lib.mjs";

function readStdin() { return fs.readFileSync(0, "utf8"); }
function workspaceRoot(cwd) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(); }
  catch { return cwd; }
}
function headSha(cwd) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim().toLowerCase(); }
  catch { return ""; }
}
function truthy(value) { return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase()); }

export async function runMain({
  cwd = process.cwd(),
  remoteName = process.argv[2] || "",
  remoteUrl = process.argv[3] || "",
  input,
  env = process.env,
  isBenchDisabledImpl = isBenchDisabled,
  reviewImpl = reviewNativePush,
  stderr = (message) => process.stderr.write(message),
  exit = (code) => process.exit(code)
} = {}) {
  const ws = workspaceRoot(cwd);
  // Nested reviewer processes and explicit bypasses must never recursively invoke the panel.
  if (truthy(env.BENCH_SUPPRESS_HOOKS) || truthy(env.PEERBENCH_SUPPRESS_HOOKS) || truthy(env.BENCH_NATIVE_PUSH_BYPASS)) {
    return exit(0);
  }
  if (isBenchDisabledImpl(ws)) return exit(0);

  let updates;
  try {
    updates = parsePrePushUpdates(input ?? readStdin());
  } catch (error) {
    stderr(`⛩ peerBench native pre-push: ${error instanceof Error ? error.message : String(error)}; push blocked because the exact updates could not be verified.\n`);
    return exit(1);
  }
  if (!updates.length) return exit(0);

  // A push launched from a direct Codex task inherits CODEX_THREAD_ID. Never ask Codex to review
  // its own commit in that case; resolveConfig will select the configured non-Codex panel (or its
  // non-Codex defaults). Claude-launched Codex reviewers already set BENCH_SUPPRESS_HOOKS and exit
  // above, so this does not weaken Claude's normal Codex-inclusive push panel.
  const reviewEnv = env.CODEX_THREAD_ID
    ? { ...env, BENCH_SUPPRESS_CODEX_REVIEWER: "1" }
    : env;
  let result;
  try {
    result = await reviewImpl({ cwd: ws, remoteName, remoteUrl, updates, env: reviewEnv });
  } catch (error) {
    stderr(`⛩ peerBench native pre-push: review crashed (${error instanceof Error ? error.message : String(error)}); push blocked. Retry, use BENCH_NATIVE_PUSH_BYPASS=1 git push for a peerBench-only bypass, or use git push --no-verify to bypass every hook.\n`);
    return exit(1);
  }

  if (result.decision === "allow") {
    const current = headSha(ws);
    if (current && updates.some((u) => u.localSha === current)) writeReviewedHead(ws, current);
    const cached = result.cached ? " (cached exact ref set)" : "";
    stderr(`⛩ peerBench native pre-push: ALLOW${cached}${result.badge ? ` [${result.badge}]` : ""} — ${result.summary || "review passed"}\n`);
    return exit(0);
  }

  if (result.decision === "unavailable") {
    stderr(`⛩ peerBench native pre-push: review unavailable — ${result.reason || result.summary || "quorum not met"}. Push blocked rather than calling a degraded one-reviewer result clean. Retry, use BENCH_NATIVE_PUSH_BYPASS=1 git push for a peerBench-only bypass, or use git push --no-verify to bypass every hook.\n`);
    return exit(1);
  }

  const cached = result.cached ? " (cached; reviewers were not rerun)" : "";
  const cycle = result.cycle ? ` cycle ${result.cycle}/${result.maxCycles || 3}` : "";
  const partial = result.partialUnavailable
    ? "\n\nReview was incomplete for additional ranges; confirmed exact-range results were retained and only unavailable/changed ranges will rerun."
    : "";
  stderr(`⛩ peerBench native pre-push BLOCKED${cached}${cycle}${result.badge ? ` [${result.badge}]` : ""}\n\n${result.findings || result.summary || "blocking findings"}${partial}\n\nFix the consolidated findings, then push again. Unchanged completed ranges are reused instantly.\n`);
  return exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMain().catch((error) => {
    process.stderr.write(`⛩ peerBench native pre-push: fatal error (${error instanceof Error ? error.message : String(error)}); push blocked. Use BENCH_NATIVE_PUSH_BYPASS=1 git push only if an explicit peerBench bypass is intended.\n`);
    process.exit(1);
  });
}
