#!/usr/bin/env node
// Install/status/uninstall the peerBench "bench" skill for Kimi Code CLI
// (user-level skills: $KIMI_CODE_HOME/skills, default ~/.kimi-code/skills).
// The repo stays the source of truth. SKILL.md is checkout-independent; its sibling launcher gets
// the checkout's absolute runner path, outside Kimi's Markdown placeholder expansion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeKimiInstalledSkillPath,
  atomicWriteFile,
  ensureDirectoryPathNoSymlinks,
  kimiManagedStatePath,
  managedContentSha256,
  readKimiManagedState,
  renderKimiSourceFile,
  shellQuote,
  syncKimiSkill
} from "./deploy-global-hooks.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const SRC_DIR = path.join(ROOT, "kimi", "skills");
const BENCH_RUNNER = path.join(ROOT, "scripts", "bench-runner.mjs");

export function kimiSkillsDir({ home = os.homedir(), env = process.env } = {}) {
  return path.join(env.KIMI_CODE_HOME || path.join(home, ".kimi-code"), "skills");
}

function sourceRelFiles(srcDir) {
  const rels = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) rels.push(path.relative(srcDir, p));
    }
  };
  walk(srcDir);
  return rels.sort((a, b) => {
    const aSkill = path.basename(a) === "SKILL.md" ? 1 : 0;
    const bSkill = path.basename(b) === "SKILL.md" ? 1 : 0;
    return aSkill - bSkill || a.localeCompare(b);
  });
}

function renderedSource(srcDir, rel, benchRunnerPath) {
  const raw = fs.readFileSync(path.join(srcDir, rel), "utf8");
  return renderKimiSourceFile(raw, rel, benchRunnerPath);
}

function knownLegacyRenderedSources(srcDir, rel, benchRunnerPath) {
  if (path.basename(rel) !== "SKILL.md") return [];
  const currentTemplate = fs.readFileSync(path.join(srcDir, rel), "utf8");
  const launcherToken = '"${KIMI_SKILL_DIR}/peerbench-launcher.sh"';
  if (!currentTemplate.includes(launcherToken)) return [];
  // The immediately preceding peerBench Kimi template was byte-identical except that every command
  // embedded the runner directly. Released/development installers used these two exact quote forms.
  // Reconstruct only those full renderings; never use marker or substring heuristics, which would
  // misclassify custom user policies as owned content.
  return [
    currentTemplate.replaceAll(launcherToken, `node ${shellQuote(benchRunnerPath)}`),
    currentTemplate.replaceAll(launcherToken, `node "${String(benchRunnerPath)}"`)
  ];
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function kimiSkillStatus({ skillsDir = kimiSkillsDir(), srcDir = SRC_DIR, benchRunnerPath = BENCH_RUNNER } = {}) {
  const files = [];
  let installed = 0;
  const skillsDirExists = ensureDirectoryPathNoSymlinks(skillsDir, { create: false, label: "Kimi skills destination" });
  const sourceFiles = sourceRelFiles(srcDir);
  for (const rel of sourceFiles.filter((name) => path.basename(name) === "SKILL.md")) {
    assertSafeKimiInstalledSkillPath(path.dirname(path.join(skillsDir, rel)));
  }
  for (const rel of sourceFiles) {
    const rendered = renderedSource(srcDir, rel, benchRunnerPath);
    let state = "missing";
    const target = path.join(skillsDir, rel);
    if (!skillsDirExists || !ensureDirectoryPathNoSymlinks(path.dirname(target), { create: false, label: "Kimi skill path" })) {
      files.push({ name: rel, state });
      continue;
    }
    const managedState = readKimiManagedState(target); // validates and completes an interrupted transaction
    const targetStat = lstatOrNull(target);
    if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
      throw new Error(`Kimi skill target is not a regular file: ${target}`);
    }
    if (targetStat) {
      const current = fs.readFileSync(target);
      const currentSha256 = managedContentSha256(current);
      if (!managedState) state = "unmanaged";
      else if (currentSha256 !== managedState.managedSha256) state = "drifted";
      else if (managedState.schema === 2 && (targetStat.mode & 0o777) !== managedState.managedMode) state = "drifted";
      else state = current.equals(Buffer.from(rendered, "utf8")) ? "current" : "outdated";
      installed += 1;
    }
    files.push({ name: rel, state });
  }
  const ok = files.length > 0 && files.every((f) => f.state === "current");
  return { ok, installed, total: files.length, skillsDir, files };
}

export function uninstallKimiSkill({ skillsDir = kimiSkillsDir(), srcDir = SRC_DIR, benchRunnerPath = BENCH_RUNNER } = {}) {
  const removed = [], restored = [], kept = [], errors = [];
  if (!ensureDirectoryPathNoSymlinks(skillsDir, { create: false, label: "Kimi skills destination" })) {
    return { ok: true, skillsDir, removed, restored, kept, errors };
  }
  const sourceFiles = sourceRelFiles(srcDir);
  for (const rel of sourceFiles.filter((name) => path.basename(name) === "SKILL.md")) {
    assertSafeKimiInstalledSkillPath(path.dirname(path.join(skillsDir, rel)));
  }
  for (const rel of sourceFiles) {
    const to = path.join(skillsDir, rel);
    const backup = `${to}.pre-peerbench.bak`;
    const statePath = kimiManagedStatePath(to);
    if (!ensureDirectoryPathNoSymlinks(path.dirname(to), { create: false, label: "Kimi skill path" })) continue;
    let managedState;
    try { managedState = readKimiManagedState(to); }
    catch (error) {
      errors.push(`${rel}: ${error?.message || error}`);
      continue;
    }
    // Recovery may have completed a target and/or backup rename, so inspect the paths afterwards.
    const targetStat = lstatOrNull(to);
    const backupStat = lstatOrNull(backup);
    // Without a sidecar there is no proof peerBench owns the target. Byte-identical copies,
    // managed-looking markers, and backups are all user content until a transaction records them.
    if (!managedState) {
      const knownLegacy = targetStat?.isFile() && !targetStat.isSymbolicLink()
        ? knownLegacyRenderedSources(srcDir, rel, benchRunnerPath)
        : [];
      if (knownLegacy.length && backupStat?.isFile() && !backupStat.isSymbolicLink()
          && knownLegacy.includes(fs.readFileSync(to, "utf8"))) {
        atomicWriteFile(to, fs.readFileSync(backup), {
          mode: backupStat.mode & 0o777,
          rejectSymlink: true,
          label: "restored legacy Kimi skill"
        });
        fs.rmSync(backup, { force: true });
        restored.push(rel);
        continue;
      }
      if (targetStat || backupStat) kept.push(rel);
      continue;
    }
    if (backupStat && (!backupStat.isFile() || backupStat.isSymbolicLink())) {
      errors.push(`${rel}: backup is not a regular file`);
      kept.push(rel);
      continue;
    }
    let restore = managedState.schema === 2 ? managedState.restore : null;
    if (managedState.schema === 1 && backupStat) {
      restore = {
        sha256: managedContentSha256(fs.readFileSync(backup)),
        mode: backupStat.mode & 0o777
      };
    }
    if (managedState.schema === 2 && !restore && backupStat) {
      errors.push(`${rel}: managed state does not own the existing backup`);
      kept.push(rel);
      continue;
    }
    if (restore) {
      if (!backupStat) {
        errors.push(`${rel}: managed recovery backup is missing`);
        kept.push(rel);
        continue;
      }
      if (managedContentSha256(fs.readFileSync(backup)) !== restore.sha256) {
        errors.push(`${rel}: managed recovery backup has changed`);
        kept.push(rel);
        continue;
      }
    }
    if (!targetStat) {
      if (restore) {
        atomicWriteFile(to, fs.readFileSync(backup), {
          mode: restore.mode,
          rejectSymlink: true,
          label: "restored Kimi skill"
        });
        fs.rmSync(backup, { force: true });
        fs.rmSync(statePath, { force: true });
        restored.push(rel);
      } else {
        fs.rmSync(statePath, { force: true });
      }
      continue;
    }
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      kept.push(rel); // drifted from our managed content — never clobber a user edit
      continue;
    }
    const current = fs.readFileSync(to);
    const currentSha256 = managedContentSha256(current);
    const stateManaged = currentSha256 === managedState.managedSha256;
    if (!stateManaged) {
      kept.push(rel); // hash mismatch proves post-install edits; preserve them and their recovery data
      continue;
    }
    if (restore) {
      atomicWriteFile(to, fs.readFileSync(backup), {
        mode: restore.mode,
        rejectSymlink: true,
        label: "restored Kimi skill"
      });
      fs.rmSync(backup, { force: true });
      fs.rmSync(statePath, { force: true });
      restored.push(rel);
    } else {
      fs.rmSync(to, { force: true });
      fs.rmSync(statePath, { force: true });
      removed.push(rel);
    }
  }
  // Remove the directories we created, deepest first, only when left empty.
  const dirs = [...new Set(sourceFiles.map((rel) => path.dirname(path.join(skillsDir, rel))))]
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) { try { fs.rmdirSync(dir); } catch { /* not empty or absent — fine */ } }
  return { ok: errors.length === 0, skillsDir, removed, restored, kept, errors };
}

export function installKimiCommand(argv = process.argv.slice(2), { skillsDir } = {}) {
  const dest = skillsDir || kimiSkillsDir();
  if (argv.includes("--status")) return { command: "status", ...kimiSkillStatus({ skillsDir: dest }) };
  if (argv.includes("--uninstall")) return { command: "uninstall", ...uninstallKimiSkill({ skillsDir: dest }) };
  const sync = syncKimiSkill({ srcDir: SRC_DIR, skillsDir: dest, benchRunnerPath: BENCH_RUNNER });
  return { command: "install", ok: true, ...sync };
}

export function isEntrypoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    return fileURLToPath(metaUrl) === path.resolve(argv1);
  }
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const result = installKimiCommand(argv);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false || (argv.includes("--status") && !result.installed)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
