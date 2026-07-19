import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node canonicalizes symlinked executable paths (including macOS /var -> /private/var).
// Comparing raw file:// strings silently skips CLIs installed under either form or under spaces.
export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync.native(fileURLToPath(metaUrl)) === fs.realpathSync.native(argvPath);
  } catch {
    return metaUrl === pathToFileURL(path.resolve(argvPath)).href;
  }
}
