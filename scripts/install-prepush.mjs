#!/usr/bin/env node
import { ensureNativePrePushHook, nativePrePushStatus, uninstallNativePrePushHook } from "../global-hooks/native-git-hook.mjs";
import { isMainModule } from "../global-hooks/is-main.mjs";

export function installPrePushCommand(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  if (argv.includes("--status")) return nativePrePushStatus(cwd);
  if (argv.includes("--uninstall")) return uninstallNativePrePushHook(cwd);
  return ensureNativePrePushHook(cwd);
}

if (isMainModule(import.meta.url)) {
  const result = installPrePushCommand();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
