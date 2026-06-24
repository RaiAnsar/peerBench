import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ONE-TIME data-dir migration: pre-rename installs kept reviewer config + traces under
// 'grok-companion-shared'; move it to 'bench-shared' once. No-op on fresh installs or after
// migration. MUST run before anything that could create bench-shared (e.g. the snapshot backup
// dir) — otherwise the dir already exists and the real data is orphaned.
export function migrateDataDir({ base = path.join(os.homedir(), ".claude", "plugins", "data") } = {}) {
  const from = path.join(base, "grok-companion-shared");
  const to = path.join(base, "bench-shared");
  // Identify the REAL data by companion.json, not by the dir existing — a prior broken deploy could
  // have pre-created an EMPTY bench-shared (e.g. a snapshot backup dir) while the real config + traces
  // still sit in grok-companion-shared. Keying on the dir alone would skip that and orphan the data.
  const hasConfig = (d) => { try { return fs.existsSync(path.join(d, "companion.json")); } catch { return false; } };
  try {
    if (hasConfig(from) && !hasConfig(to)) {
      if (fs.existsSync(to)) {
        // bench-shared exists but is incomplete — merge the real data over it (legacy wins), then drop legacy.
        fs.cpSync(from, to, { recursive: true, force: true });
        fs.rmSync(from, { recursive: true, force: true });
        return { migrated: true, merged: true, from, to };
      }
      fs.renameSync(from, to);
      return { migrated: true, from, to };
    }
  } catch (e) { return { migrated: false, error: String(e?.message || e) }; }
  return { migrated: false };
}

// Copy every global-hooks/*.mjs FLAT into dest; back up a differing pre-existing file once.
export function deploy({ src, dest }) {
  fs.mkdirSync(dest, { recursive: true });
  const copied = [], backedUp = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".mjs"))) {
    const from = path.join(src, f), to = path.join(dest, f);
    if (fs.existsSync(to)) {
      const bak = `${to}.pre-panel.bak`;
      if (fs.readFileSync(to, "utf8") !== fs.readFileSync(from, "utf8") && !fs.existsSync(bak)) { fs.copyFileSync(to, bak); backedUp.push(f); }
    }
    fs.copyFileSync(from, to); copied.push(f);
  }
  return { copied, backedUp };
}

// LAYER-3 BACKUP: snapshot the current live hooks + settings BEFORE we mutate them, so rollback.mjs can
// restore exactly. Snapshot EVERY live *.mjs in hooksDir (not a hardcoded list, which silently missed
// newly-added hooks like stop-review/pre-push-review — found by the bench's own hunt).
export function snapshot({ hooksDir, settingsPath, backupDir }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  let live = [];
  try { live = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")); } catch { live = []; }
  for (const f of live) {
    const p = path.join(hooksDir, f);
    try { fs.copyFileSync(p, path.join(backupDir, f)); files.push(f); } catch { /* skip unreadable */ }
  }
  let settingsBackedUp = false;
  if (fs.existsSync(settingsPath)) { fs.copyFileSync(settingsPath, path.join(backupDir, "settings.json")); settingsBackedUp = true; }
  return { files, settingsBackedUp, backupDir };
}

export function snapshotCodex({ hooksDir, hooksPath, backupDir }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  let live = [];
  try { live = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")); } catch { live = []; }
  for (const f of live) {
    const p = path.join(hooksDir, f);
    try { fs.copyFileSync(p, path.join(backupDir, f)); files.push(f); } catch { /* skip unreadable */ }
  }
  let hooksJsonBackedUp = false;
  if (fs.existsSync(hooksPath)) {
    fs.copyFileSync(hooksPath, path.join(backupDir, "hooks.json"));
    hooksJsonBackedUp = true;
  }
  return { files, hooksJsonBackedUp, backupDir };
}

const STATUSLINE_SESSION_LINE =
  `bench_session_id=$(printf '%s' "$input" | jq -r '.session_id // .sessionId // .workspace.session_id // .workspace.sessionId // empty')`;

// Existing user statusline wrappers usually read stdin once (`input=$(cat)`) and then invoke
// statusline-segment.mjs with only the project dir. Patch just that peerBench segment call so the
// wrapper keeps its custom UI but forwards Claude's per-chat session_id as argv3.
export function syncStatuslineSessionArg({
  statuslinePath = path.join(os.homedir(), ".claude", "statusline-command.sh")
} = {}) {
  let text;
  try { text = fs.readFileSync(statuslinePath, "utf8"); }
  catch { return { statuslinePath, updated: false, reason: "missing" }; }

  if (!text.includes("statusline-segment.mjs")) {
    return { statuslinePath, updated: false, reason: "no peerbench statusline segment" };
  }
  if (/statusline-segment\.mjs[^\n]*bench_session_id/.test(text)) {
    return { statuslinePath, updated: false, reason: "already session-aware" };
  }

  const lines = text.split("\n");
  let inserted = text.includes("bench_session_id=");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("statusline-segment.mjs") && !/^\s*#/.test(lines[i])) {
      if (!inserted) {
        lines.splice(i, 0, STATUSLINE_SESSION_LINE);
        inserted = true;
        i++;
      }
      const before = lines[i];
      lines[i] = lines[i]
        .replace(/"\$gate_dir"(?=\s*(?:2>|\)|$))/, `"$gate_dir" "$bench_session_id"`)
        .replace(/\$gate_dir(?=\s*(?:2>|\)|$))/, `$gate_dir "$bench_session_id"`);
      if (lines[i] !== before) replaced = true;
      break;
    }
  }
  if (!replaced) return { statuslinePath, updated: false, reason: "could not patch segment command" };

  fs.writeFileSync(statuslinePath, lines.join("\n"));
  return { statuslinePath, updated: true };
}

const LEGACY = ["codex-plan-review.mjs", "codex-plan-file-review.mjs"];
// Register our hook canonically AND de-dupe: remove any existing entries referencing this hook
// FILE (matched by basename, so it catches ANY path form — $HOME, absolute, different quoting),
// then add exactly one absolute-path entry. Idempotent + self-healing against duplicates.
// matcher === undefined → Stop-style (no matcher): scan all blocks, add to the first (keeping
// other Stop hooks like a codex multi-repo gate intact).
function register(list, matcher, absCmd, extra = {}) {
  const base = path.basename(absCmd);
  for (const b of list) {
    if (!Array.isArray(b.hooks)) continue;
    if (matcher !== undefined && b.matcher !== matcher) continue;   // matcher-scoped: only same-matcher blocks
    b.hooks = b.hooks.filter((h) => !String(h.command || "").includes(base));
  }
  const cmd = { type: "command", command: `node "${absCmd}"`, ...extra };
  if (matcher !== undefined) {
    const block = list.find((b) => b.matcher === matcher);
    if (block) { block.hooks = block.hooks || []; block.hooks.push(cmd); } else list.push({ matcher, hooks: [cmd] });
  } else {
    // matcher-less (Stop-style): only a MATCHER-LESS hooks-block is a valid home — a matcher-scoped
    // block (e.g. {matcher:"SomeTool"}) would bury this hook so it only fires for that tool's events.
    const block = list.find((b) => Array.isArray(b.hooks) && !b.matcher);
    if (block) { block.hooks = block.hooks || []; block.hooks.push(cmd); } else list.push({ hooks: [cmd] });
  }
}
// Remove ONLY the matching legacy hook COMMANDS (not whole entries unless they become empty); register the new plan-*.mjs with ABSOLUTE paths.
export function syncSettings({ hooksDir, settingsPath }) {
  const removedFiles = [];
  for (const f of LEGACY) { const p = path.join(hooksDir, f); if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removedFiles.push(f); } }
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { s = {}; }
  s.hooks = s.hooks || {};
  let removedEntries = 0;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    for (const entry of s.hooks[ev]) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !LEGACY.some((f) => String(h.command || "").includes(f)));
      removedEntries += before - entry.hooks.length;
    }
    s.hooks[ev] = s.hooks[ev].filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0); // drop now-empty entries
  }
  s.hooks.PreToolUse = s.hooks.PreToolUse || [];
  s.hooks.PostToolUse = s.hooks.PostToolUse || [];
  s.hooks.Stop = s.hooks.Stop || [];
  // statusMessage → the gate is VISIBLE in the spinner while it runs (~30–60s panel), so it never
  // looks like "nothing happened". ABSOLUTE homedir paths (no ~).
  register(s.hooks.PreToolUse, "ExitPlanMode", path.join(hooksDir, "plan-review.mjs"), {
    statusMessage: "⛩ bench: reviewing plan…"
  });
  register(s.hooks.PostToolUse, "Write|Edit", path.join(hooksDir, "plan-file-review.mjs"), {
    statusMessage: "⛩ bench: reviewing plan/spec…"
  });
  register(s.hooks.PreToolUse, "Bash", path.join(hooksDir, "pre-push-review.mjs"), {
    statusMessage: "⛩ bench: reviewing push…",
    timeout: 1320,
    // Perf: only spawn on git commands instead of EVERY Bash. The `if` permission rule checks
    // subcommands and FAILS OPEN (runs the hook anyway) if it can't parse — so compound pushes
    // like `cd x && git push` are still covered; we just stop spawning Node for `ls`/`npm`/etc.
    if: "Bash(git *)"
  });
  register(s.hooks.Stop, undefined, path.join(hooksDir, "stop-review.mjs"), {
    timeout: 900, asyncRewake: true,
    statusMessage: "⛩ bench: reviewing turn…",
    rewakeMessage: "⛩ bench stop gate (Kimi+MiMo) found issues in this turn's code changes. Fix them, then stop again to re-review:",
    rewakeSummary: "⛩ bench stop"
  });
  // The deep-review runner: a SECOND matcher-less Stop entry (register appends it alongside
  // stop-review, each entry keeping its own opts). asyncRewake + exit 2 delivers a HIGH deep-review
  // block even to an idle agent; timeout 1320s > the 20-min deep budget. Runs concurrently with stop-review.
  register(s.hooks.Stop, undefined, path.join(hooksDir, "deep-review-runner.mjs"), {
    timeout: 1320, asyncRewake: true,
    statusMessage: "⛩ bench: deep review…",
    rewakeMessage: "⛩ bench deep review found blocking issues. Address them, then continue:",
    rewakeSummary: "⛩ bench deep review"
  });
  // Drop any blocks left empty by de-duping.
  for (const ev of ["PreToolUse", "PostToolUse", "Stop"]) {
    s.hooks[ev] = (s.hooks[ev] || []).filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`);
  return { removedFiles, removedEntries };
}

export function syncCodexHooks({
  hooksDir,
  hooksPath = path.join(os.homedir(), ".codex", "hooks.json")
}) {
  let s = {}; try { s = JSON.parse(fs.readFileSync(hooksPath, "utf8")); } catch { s = {}; }
  s.hooks = s.hooks || {};
  s.hooks.Stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  register(s.hooks.Stop, undefined, path.join(hooksDir, "codex-stop-review.mjs"), {
    timeout: 900,
    statusMessage: "⛩ bench: reviewing turn…"
  });
  s.hooks.Stop = s.hooks.Stop.filter((b) => !Array.isArray(b.hooks) || b.hooks.length > 0);
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(s, null, 2)}\n`);
  return { hooksPath, stopHook: path.join(hooksDir, "codex-stop-review.mjs") };
}

export function syncCodexPrompts({
  srcDir,
  promptsDir = path.join(os.homedir(), ".codex", "prompts"),
  benchRunnerPath
}) {
  if (!benchRunnerPath) throw new Error("syncCodexPrompts requires benchRunnerPath");
  fs.mkdirSync(promptsDir, { recursive: true });
  const copied = [], backedUp = [];
  let files = [];
  try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md")).sort(); } catch { files = []; }
  for (const f of files) {
    const from = path.join(srcDir, f);
    const to = path.join(promptsDir, f);
    const rendered = fs.readFileSync(from, "utf8").replaceAll("{{BENCH_RUNNER}}", benchRunnerPath);
    if (fs.existsSync(to) && fs.readFileSync(to, "utf8") !== rendered) {
      const bak = `${to}.pre-peerbench.bak`;
      if (!fs.existsSync(bak)) { fs.copyFileSync(to, bak); backedUp.push(f); }
    }
    fs.writeFileSync(to, rendered);
    copied.push(f);
  }
  return { promptsDir, copied, backedUp };
}

function gitOrNull(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

export function compareLocalWithOrigin({ cwd, remote = "origin", branch } = {}) {
  const repo = gitOrNull(["rev-parse", "--show-toplevel"], cwd);
  if (!repo) return { ok: false, reason: "not a git repository" };
  const localHead = gitOrNull(["rev-parse", "HEAD"], repo);
  const currentBranch = branch || gitOrNull(["branch", "--show-current"], repo);
  if (!localHead || !currentBranch) return { ok: false, repo, reason: "could not resolve local branch/head" };
  const remoteLine = gitOrNull(["ls-remote", "--heads", remote, currentBranch], repo);
  if (!remoteLine) return { ok: false, repo, branch: currentBranch, localHead, reason: `could not resolve ${remote}/${currentBranch}` };
  const remoteHead = remoteLine.split(/\s+/)[0] || "";
  const status = gitOrNull(["status", "--short"], repo) || "";
  const dirty = status.split(/\r?\n/).filter(Boolean).length;
  const same = localHead === remoteHead;
  return {
    ok: true,
    repo,
    remote,
    branch: currentBranch,
    localHead,
    remoteHead,
    dirty,
    status: same ? (dirty ? "same-as-origin-with-local-changes" : "same-as-origin") : "differs-from-origin"
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hooksDir = path.join(os.homedir(), ".claude", "hooks");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const codexHooksDir = path.join(os.homedir(), ".codex", "hooks");
  const codexHooksPath = path.join(os.homedir(), ".codex", "hooks.json");
  const backupDir = path.join(os.homedir(), ".claude", "plugins", "data", "bench-shared", `backup-${Date.now()}`);
  const migrate = migrateDataDir();   // FIRST — before snapshot's backupDir can create bench-shared
  const origin = compareLocalWithOrigin({ cwd: path.join(here, "..") });
  const snap = snapshot({ hooksDir, settingsPath, backupDir });
  const dep = deploy({ src: path.join(here, "..", "global-hooks"), dest: hooksDir });
  const sync = syncSettings({ hooksDir, settingsPath });
  const statusline = syncStatuslineSessionArg();
  const codexSnapshot = snapshotCodex({ hooksDir: codexHooksDir, hooksPath: codexHooksPath, backupDir: path.join(backupDir, "codex") });
  const codexDeploy = deploy({ src: path.join(here, "..", "global-hooks"), dest: codexHooksDir });
  const codexSync = syncCodexHooks({ hooksDir: codexHooksDir, hooksPath: codexHooksPath });
  const codexPrompts = syncCodexPrompts({
    srcDir: path.join(here, "..", "codex-prompts"),
    benchRunnerPath: path.join(here, "bench-runner.mjs")
  });
  console.log(JSON.stringify({ origin, migrate, snapshot: snap, deploy: dep, sync, statusline, codex: { snapshot: codexSnapshot, deploy: codexDeploy, sync: codexSync, prompts: codexPrompts } }, null, 2));
}
