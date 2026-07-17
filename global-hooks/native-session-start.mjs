#!/usr/bin/env node
// Arm Git's authoritative pre-push hook before an agent can issue its first push in a workspace.
// SessionStart is available to both Codex and Claude plugins; installation is idempotent.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  isBenchDisabled as defaultIsBenchDisabled,
  readReviewedHead as defaultReadReviewedHead,
  writeReviewedHead as defaultWriteReviewedHead
} from "./config-store.mjs";
import { ensureNativePrePushHook } from "./native-git-hook.mjs";

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

export function runMain({
  input: inputOverride,
  cwd = process.cwd(),
  ensureImpl = ensureNativePrePushHook,
  gitImpl = git,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  readReviewedHeadImpl = defaultReadReviewedHead,
  writeReviewedHeadImpl = defaultWriteReviewedHead,
  stdout = (value) => process.stdout.write(value)
} = {}) {
  const input = inputOverride ?? readInput();
  const target = input?.cwd || cwd;
  // Direct Codex sessions have SessionStart+Stop but may never invoke Claude's Bash PreToolUse hook.
  // Seed the pre-turn commit baseline here; runHookMain retains the same bootstrap as a mid-session
  // install/fallback path. Never replace an existing marker, which may represent unreviewed history.
  bootstrapReviewedHead(target, { gitImpl, isBenchDisabledImpl, readReviewedHeadImpl, writeReviewedHeadImpl });
  const result = ensureImpl(target);
  if (result?.ok && result?.installed) return result;
  // Opening Codex outside a Git repository is normal; there is nothing to arm and no warning needed.
  if (result?.reason === "not a Git repository") return result;
  stdout(`${JSON.stringify({
    continue: true,
    systemMessage: `⛩ peerBench could not arm this workspace's native pre-push gate (${result?.reason || "unknown error"}). Run peerbench setup before pushing.`
  })}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) runMain();
