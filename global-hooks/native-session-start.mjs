#!/usr/bin/env node
// Arm Git's authoritative pre-push hook before an agent can issue its first push in a workspace.
// SessionStart is available to both Codex and Claude plugins; installation is idempotent.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  isBenchDisabled as defaultIsBenchDisabled,
  readReviewedHead as defaultReadReviewedHead,
  sessionKeyFromInput,
  writeReviewedHead as defaultWriteReviewedHead
} from "./config-store.mjs";
import { ensureNativePrePushHook } from "./native-git-hook.mjs";
import { recordSessionUntrackedBaseline } from "./session-untracked-baseline.mjs";

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function bootstrapReviewedHead(target, {
  gitImpl = git,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  readReviewedHeadImpl = defaultReadReviewedHead,
  writeReviewedHeadImpl = defaultWriteReviewedHead
} = {}) {
  try {
    const ws = gitImpl(["rev-parse", "--show-toplevel"], target);
    if (!ws || isBenchDisabledImpl(ws) || readReviewedHeadImpl(ws)) return;
    const head = gitImpl(["rev-parse", "--verify", "HEAD"], ws);
    if (head) writeReviewedHeadImpl(ws, head);
  } catch { /* outside Git, unborn HEAD, and marker failures are intentionally quiet */ }
}

function bootstrapUntrackedBaseline(target, input, {
  env = process.env,
  gitImpl = git,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  recordUntrackedBaselineImpl = recordSessionUntrackedBaseline
} = {}) {
  try {
    // Claude fires SessionStart for resume/compact too. If peerBench was installed mid-session—or
    // an earlier reservation could not be persisted—treating a later/source-less event as the
    // beginning would bless work the active session created. Fail safe: only true session starts
    // may create the immutable backlog baseline.
    if (input?.source !== "startup" && input?.source !== "clear") return;
    const sessionKey = sessionKeyFromInput(input, env);
    if (!sessionKey) return;
    const ws = gitImpl(["rev-parse", "--show-toplevel"], target);
    if (!ws || isBenchDisabledImpl(ws)) return;
    recordUntrackedBaselineImpl(ws, sessionKey);
  } catch { /* baseline capture is fail-safe: Stop reviews all untracked paths */ }
}

export function runMain({
  input: inputOverride,
  cwd = process.cwd(),
  ensureImpl = ensureNativePrePushHook,
  env = process.env,
  gitImpl = git,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  readReviewedHeadImpl = defaultReadReviewedHead,
  recordUntrackedBaselineImpl = recordSessionUntrackedBaseline,
  writeReviewedHeadImpl = defaultWriteReviewedHead,
  stdout = (value) => process.stdout.write(value)
} = {}) {
  const input = inputOverride ?? readInput();
  const target = input?.cwd || cwd;
  // Arming Git is the primary SessionStart invariant and must happen before the optional full-byte
  // backlog inventory. A very large untracked tree may consume the hook's time budget, but it must
  // never leave the authoritative pre-push dispatcher uninstalled.
  const result = ensureImpl(target);
  // Direct Codex sessions have SessionStart+Stop but may never invoke Claude's Bash PreToolUse hook.
  // Seed the pre-turn commit baseline here; runHookMain retains the same bootstrap as a mid-session
  // install/fallback path. Never replace an existing marker, which may represent unreviewed history.
  bootstrapReviewedHead(target, { gitImpl, isBenchDisabledImpl, readReviewedHeadImpl, writeReviewedHeadImpl });
  // Baseline only an explicitly identified session. Repeated SessionStart events (resume/compact)
  // preserve the first marker, so work created after startup can never be reclassified as backlog.
  if (result?.ok && result?.installed) {
    bootstrapUntrackedBaseline(target, input, {
      env,
      gitImpl,
      isBenchDisabledImpl,
      recordUntrackedBaselineImpl
    });
    return result;
  }
  // Opening Codex outside a Git repository is normal; there is nothing to arm and no warning needed.
  if (result?.reason === "not a Git repository") return result;
  stdout(`${JSON.stringify({
    continue: true,
    systemMessage: `⛩ peerBench could not arm this workspace's native pre-push gate (${result?.reason || "unknown error"}). Run peerbench setup before pushing.`
  })}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) runMain();
