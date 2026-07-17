#!/usr/bin/env node
// Install/status/uninstall the chain-safe native Git pre-push dispatcher for the current repository.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureNativePrePushHook,
  nativePrePushStatus,
  uninstallNativePrePushHook
} from "../global-hooks/native-git-hook.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(SCRIPT_DIR, "..", "global-hooks", "git-pre-push-review.mjs");

export function installPrePushCommand(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  if (argv.includes("--status")) return nativePrePushStatus(cwd);
  if (argv.includes("--uninstall")) return uninstallNativePrePushHook(cwd);
  return ensureNativePrePushHook(cwd, { runtimePath: RUNTIME });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const result = installPrePushCommand(argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok || (argv.includes("--status") && !result.installed)) process.exitCode = 1;
}
