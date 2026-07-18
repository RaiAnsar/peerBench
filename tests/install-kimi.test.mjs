import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertSafeKimiInstalledSkillPath,
  kimiManagedStatePath,
  managedContentSha256,
  readKimiManagedState,
  renderKimiSourceFile,
  shellQuote,
  syncKimiSkill
} from "../scripts/deploy-global-hooks.mjs";
import { installKimiCommand, kimiSkillsDir, uninstallKimiSkill } from "../scripts/install-kimi.mjs";

const RUNNER = "/abs/bench/scripts/bench-runner.mjs";
const SKILL_REL = path.join("bench", "SKILL.md");
const LAUNCHER_REL = path.join("bench", "peerbench-launcher.sh");
const MANAGED_RELS = [LAUNCHER_REL, SKILL_REL];

function makeSrc() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skill-src-"));
  fs.mkdirSync(path.join(src, "bench"), { recursive: true });
  fs.writeFileSync(path.join(src, "bench", "SKILL.md"), [
    "---",
    "name: bench",
    "description: d",
    "---",
    "<!-- peerBench-managed-kimi-skill -->",
    '"${KIMI_SKILL_DIR}/peerbench-launcher.sh" review --json',
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(src, LAUNCHER_REL), [
    "#!/bin/sh",
    "set -eu",
    'exec node {{BENCH_RUNNER_SHELL}} "$@"',
    ""
  ].join("\n"), { mode: 0o755 });
  return src;
}

test("syncKimiSkill renders the nested skill tree and backs up drift", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-dest-"));
  fs.mkdirSync(path.join(dest, "bench"), { recursive: true });
  fs.writeFileSync(path.join(dest, "bench", "SKILL.md"), "old\n");

  const r = syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER });
  assert.deepEqual(r.copied, MANAGED_RELS);
  assert.deepEqual(r.backedUp, [SKILL_REL]);
  const rendered = fs.readFileSync(path.join(dest, "bench", "SKILL.md"), "utf8");
  assert.doesNotMatch(rendered, /\/abs\/bench\/scripts\/bench-runner\.mjs/);
  assert.doesNotMatch(rendered, /\{\{BENCH_RUNNER\}\}/);
  assert.match(fs.readFileSync(path.join(dest, LAUNCHER_REL), "utf8"), /\/abs\/bench\/scripts\/bench-runner\.mjs/);
  assert.equal(fs.statSync(path.join(dest, LAUNCHER_REL)).mode & 0o777, 0o755);
  assert.ok(fs.existsSync(path.join(dest, "bench", "SKILL.md.pre-peerbench.bak")));
  const statePath = kimiManagedStatePath(path.join(dest, "bench", "SKILL.md"));
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).schema, 2);
});

test("syncKimiSkill refuses a symlinked skills destination", () => {
  const src = makeSrc();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-real-"));
  const link = path.join(os.tmpdir(), `kimi-skills-link-${process.pid}`);
  fs.symlinkSync(real, link);
  try {
    assert.throws(() => syncKimiSkill({ srcDir: src, skillsDir: link, benchRunnerPath: RUNNER }), /symlink or non-directory component/);
  } finally {
    fs.unlinkSync(link);
  }
});

test("syncKimiSkill validates ancestors before recursive creation can follow a symlink", () => {
  const src = makeSrc();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-parent-link-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-parent-external-"));
  fs.symlinkSync(external, path.join(root, "linked-home"));
  const skillsDir = path.join(root, "linked-home", "new-kimi-home", "skills");

  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir, benchRunnerPath: RUNNER }),
    /symlink or non-directory component/
  );
  assert.equal(fs.existsSync(path.join(external, "new-kimi-home")), false, "no descendant is created through the link before validation");
});

test("syncKimiSkill rejects an existing destination reached through an intermediate symlink", () => {
  const src = makeSrc();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-existing-link-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-existing-external-"));
  fs.mkdirSync(path.join(external, "kimi-home", "skills"), { recursive: true });
  fs.symlinkSync(external, path.join(root, "linked"));

  assert.throws(
    () => syncKimiSkill({
      srcDir: src,
      skillsDir: path.join(root, "linked", "kimi-home", "skills"),
      benchRunnerPath: RUNNER
    }),
    /symlink or non-directory component/
  );
});

test("syncKimiSkill refuses every symlinked destination ancestor before creating children", () => {
  const src = makeSrc();
  fs.mkdirSync(path.join(src, "bench", "assets"), { recursive: true });
  fs.writeFileSync(path.join(src, "bench", "assets", "guide.md"), "guide\n");
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-ancestor-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-external-"));
  fs.symlinkSync(external, path.join(dest, "bench"));

  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER }),
    /refusing to install through non-directory Kimi skill path/
  );
  assert.equal(fs.existsSync(path.join(external, "assets")), false, "validation must happen before mkdir traverses the symlink");
});

test("syncKimiSkill refuses to replace a symlinked skill file", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-target-link-"));
  const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-target-external-")), "SKILL.md");
  fs.writeFileSync(external, "external user skill\n");
  fs.mkdirSync(path.join(dest, "bench"));
  fs.symlinkSync(external, path.join(dest, "bench", "SKILL.md"));

  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER }),
    /refusing to replace symlinked Kimi skill target/
  );
  assert.equal(fs.readFileSync(external, "utf8"), "external user skill\n");
});

test("syncKimiSkill requires benchRunnerPath", () => {
  assert.throws(() => syncKimiSkill({ srcDir: makeSrc(), skillsDir: fs.mkdtempSync(path.join(os.tmpdir(), "d-")) }), /benchRunnerPath/);
});

test("syncKimiSkill fails when its packaged source tree is missing", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-missing-source-"));
  assert.throws(
    () => syncKimiSkill({ srcDir: path.join(dest, "absent"), skillsDir: dest, benchRunnerPath: RUNNER }),
    /source is not a regular directory/
  );
});

test("syncKimiSkill backs up a no-sidecar legacy-looking skill before replacing it", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-upgrade-"));
  const target = path.join(dest, "bench", "SKILL.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    "---",
    "name: bench",
    "description: old peerBench skill",
    "---",
    "peerBench is a read-only multi-reviewer panel for code review and bug hunts.",
    'node "/old/bench-runner.mjs" review --json "$ARGUMENTS"',
    ""
  ].join("\n"));

  const result = syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER });
  assert.deepEqual(result.backedUp, [SKILL_REL]);
  assert.equal(fs.existsSync(`${target}.pre-peerbench.bak`), true);
  assert.match(fs.readFileSync(`${target}.pre-peerbench.bak`, "utf8"), /old peerBench skill/);
  assert.match(fs.readFileSync(target, "utf8"), /peerBench-managed-kimi-skill/);
});

test("an exact copied skill without a sidecar is never owned or deleted by byte coincidence", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-exact-unmanaged-"));
  const target = path.join(dest, SKILL_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const exact = renderKimiSourceFile(fs.readFileSync(path.join(src, SKILL_REL), "utf8"), SKILL_REL, RUNNER);
  fs.writeFileSync(target, exact, { mode: 0o640 });

  const beforeInstall = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(beforeInstall.kept, [SKILL_REL]);
  assert.equal(fs.readFileSync(target, "utf8"), exact);

  const install = syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER });
  assert.deepEqual(install.backedUp, [SKILL_REL]);
  assert.equal(fs.readFileSync(`${target}.pre-peerbench.bak`, "utf8"), exact);
  const uninstall = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(uninstall.restored, [SKILL_REL]);
  assert.deepEqual(uninstall.removed, [LAUNCHER_REL]);
  assert.equal(fs.readFileSync(target, "utf8"), exact);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test("a no-sidecar managed marker plus custom policy is backed up and restored verbatim", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-marker-custom-"));
  const target = path.join(dest, SKILL_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const custom = "<!-- peerBench-managed-kimi-skill -->\nUSER CUSTOM POLICY: never upload source\n";
  fs.writeFileSync(target, custom, { mode: 0o600 });

  fs.writeFileSync(`${target}.pre-peerbench.bak`, "unrelated backup\n");
  const guarded = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(guarded.kept, [SKILL_REL], "marker heuristics never trigger legacy restoration");
  assert.equal(fs.readFileSync(target, "utf8"), custom);
  fs.rmSync(`${target}.pre-peerbench.bak`);

  const install = syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER });
  assert.deepEqual(install.backedUp, [SKILL_REL]);
  assert.equal(fs.readFileSync(`${target}.pre-peerbench.bak`, "utf8"), custom);
  const uninstall = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(uninstall.restored, [SKILL_REL]);
  assert.equal(fs.readFileSync(target, "utf8"), custom);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("uninstall narrowly restores the real double-quoted legacy rendering when its regular backup survives", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-legacy-restore-"));
  const target = path.join(dest, SKILL_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const template = fs.readFileSync(path.join(src, SKILL_REL), "utf8");
  const legacy = template.replaceAll(
    '"${KIMI_SKILL_DIR}/peerbench-launcher.sh"',
    `node "${RUNNER}"`
  );
  fs.writeFileSync(target, legacy);
  fs.writeFileSync(`${target}.pre-peerbench.bak`, "pre-peerBench user skill\n", { mode: 0o640 });

  const uninstall = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(uninstall.restored, [SKILL_REL]);
  assert.deepEqual(uninstall.kept, []);
  assert.equal(fs.readFileSync(target, "utf8"), "pre-peerBench user skill\n");
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(`${target}.pre-peerbench.bak`), false);
});

test("syncKimiSkill refuses to clobber a user skill when a stale backup already exists", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-stale-backup-"));
  const target = path.join(dest, "bench", "SKILL.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "current user skill\n");
  fs.writeFileSync(`${target}.pre-peerbench.bak`, "older backup\n");

  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER }),
    /backup already exists/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "current user skill\n");
});

test("managed state survives a template/runner upgrade and uninstall restores the original skill", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-state-upgrade-"));
  const target = path.join(dest, SKILL_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "original user skill\n", { mode: 0o640 });

  syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: "/checkout-v1/bench-runner.mjs" });
  fs.appendFileSync(path.join(src, SKILL_REL), "\nNew managed template text.\n");
  const upgraded = syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: "/checkout-v2/bench-runner.mjs" });
  assert.deepEqual(upgraded.backedUp, [], "managed upgrade must not create a second backup");
  assert.match(fs.readFileSync(path.join(dest, LAUNCHER_REL), "utf8"), /checkout-v2/);

  const uninstall = uninstallKimiSkill({
    skillsDir: dest,
    srcDir: src,
    benchRunnerPath: "/checkout-v2/bench-runner.mjs"
  });
  assert.deepEqual(uninstall.restored, [SKILL_REL]);
  assert.deepEqual(uninstall.removed, [LAUNCHER_REL]);
  assert.equal(fs.readFileSync(target, "utf8"), "original user skill\n");
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(kimiManagedStatePath(target)), false);
});

test("managed state treats post-install edits as user content and refuses an upgrade", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-state-edit-"));
  const target = path.join(dest, SKILL_REL);
  syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER });
  fs.appendFileSync(target, "user edit\n");
  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: "/new/runner.mjs" }),
    /managed hash no longer matches/
  );
  const uninstall = uninstallKimiSkill({ skillsDir: dest, srcDir: src, benchRunnerPath: RUNNER });
  assert.deepEqual(uninstall.kept, [SKILL_REL]);
  assert.match(fs.readFileSync(target, "utf8"), /user edit/);
  assert.equal(fs.existsSync(kimiManagedStatePath(target)), true, "recovery metadata stays with user-edited content");
});

test("schema-v2 pending state recovers a crash after target replacement but before state commit", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-pending-recovery-"));
  const target = path.join(dest, LAUNCHER_REL);
  syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: "/checkout-v1/bench-runner.mjs" });
  const oldState = JSON.parse(fs.readFileSync(kimiManagedStatePath(target), "utf8"));
  const nextRunner = "/checkout-v2/bench-runner.mjs";
  const nextContent = renderKimiSourceFile(
    fs.readFileSync(path.join(src, LAUNCHER_REL), "utf8"),
    LAUNCHER_REL,
    nextRunner
  );
  const pending = {
    schema: 2,
    managedSha256: managedContentSha256(nextContent),
    managedMode: 0o755,
    restore: oldState.restore,
    pending: {
      previousExists: true,
      previousSha256: oldState.managedSha256,
      previousMode: 0o755,
      contentBase64: Buffer.from(nextContent, "utf8").toString("base64")
    }
  };
  // Exact crash window: the pending sidecar and target landed, but the committed sidecar did not.
  fs.writeFileSync(kimiManagedStatePath(target), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(target, nextContent, { mode: 0o755 });

  const recovered = readKimiManagedState(target);
  assert.equal(recovered.schema, 2);
  assert.equal(recovered.managedSha256, managedContentSha256(nextContent));
  assert.equal(recovered.pending, undefined);
  const stored = JSON.parse(fs.readFileSync(kimiManagedStatePath(target), "utf8"));
  assert.equal(stored.schema, 2);
  assert.equal("pending" in stored, false);
  assert.match(fs.readFileSync(target, "utf8"), /checkout-v2/);
});

test("Kimi managed state refuses symlinks", () => {
  const src = makeSrc();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-state-link-"));
  const target = path.join(dest, SKILL_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "user skill\n");
  const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-state-external-")), "state.json");
  fs.writeFileSync(external, JSON.stringify({ schema: 1, managedSha256: "a".repeat(64) }));
  fs.symlinkSync(external, kimiManagedStatePath(target));
  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: RUNNER }),
    /managed state is not a regular file/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "user skill\n");
});

test("shellQuote renders hostile checkout paths as exactly one inert shell word", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-shell-quote-"));
  const sentinel = path.join(root, "should-not-exist");
  const value = `${root}/spaces ' quote $(touch ${sentinel}) \`touch ${sentinel}\` $HOME \\ runner.mjs`;
  const result = spawnSync("sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
  assert.equal(fs.existsSync(sentinel), false, "command substitutions in the path remain inert text");
});

test("checkout paths containing literal $ARGUMENTS stay out of SKILL.md and inert in the launcher", () => {
  const src = makeSrc();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-checkout-arguments-"));
  const dest = path.join(root, "skills");
  const runner = path.join(root, "checkout $ARGUMENTS", "scripts", "bench-runner.mjs");
  syncKimiSkill({ srcDir: src, skillsDir: dest, benchRunnerPath: runner });

  const skill = fs.readFileSync(path.join(dest, SKILL_REL), "utf8");
  assert.equal(skill.includes(runner), false);
  assert.match(skill, /\$\{KIMI_SKILL_DIR\}\/peerbench-launcher\.sh/);

  const bin = path.join(root, "bin");
  const capture = path.join(root, "argv.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\n", { mode: 0o755 });
  const result = spawnSync(path.join(dest, LAUNCHER_REL), ["status", "trace-1"], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(capture, "utf8").trim().split("\n"), [runner, "status", "trace-1"]);
});

test("unsafe installed skill paths fail closed before publishing SKILL.md", () => {
  const src = makeSrc();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-unsafe-install-path-"));
  const skillsDir = path.join(root, "skills-$ARGUMENTS");
  assert.throws(() => assertSafeKimiInstalledSkillPath(path.join(skillsDir, "bench")), /unsafe/);
  assert.throws(
    () => syncKimiSkill({ srcDir: src, skillsDir, benchRunnerPath: RUNNER }),
    /unsafe for \$\{KIMI_SKILL_DIR\} substitution/
  );
  assert.equal(fs.existsSync(path.join(skillsDir, SKILL_REL)), false);
});

test("kimiSkillsDir honors KIMI_CODE_HOME and falls back to ~/.kimi-code", () => {
  assert.equal(kimiSkillsDir({ home: "/h", env: { KIMI_CODE_HOME: "/x/kimi" } }), path.join("/x/kimi", "skills"));
  assert.equal(kimiSkillsDir({ home: "/h", env: {} }), path.join("/h", ".kimi-code", "skills"));
});

test("installKimiCommand installs the shipped skill, then status/uninstall behave", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-home-"));

  const install = installKimiCommand([], { skillsDir: dest });
  assert.equal(install.ok, true);
  assert.deepEqual(install.copied, MANAGED_RELS);
  const installedPath = path.join(dest, "bench", "SKILL.md");
  const rendered = fs.readFileSync(installedPath, "utf8");
  assert.equal(rendered.includes(path.join("scripts", "bench-runner.mjs")), false, "SKILL.md is checkout-independent");
  assert.ok(fs.readFileSync(path.join(dest, LAUNCHER_REL), "utf8").includes(path.join("scripts", "bench-runner.mjs")), "launcher carries the runner path");
  assert.doesNotMatch(rendered, /\{\{BENCH_RUNNER\}\}/);
  assert.match(rendered, /^name: bench$/m);
  assert.match(rendered, /^description: /m);

  const status = installKimiCommand(["--status"], { skillsDir: dest });
  assert.equal(status.ok, true);
  assert.equal(status.installed, status.total);

  // Drift is reported and never clobbered by uninstall.
  fs.appendFileSync(installedPath, "user edit\n");
  const drifted = installKimiCommand(["--status"], { skillsDir: dest });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.files.find((file) => file.name === SKILL_REL)?.state, "drifted");
  const un = installKimiCommand(["--uninstall"], { skillsDir: dest });
  assert.deepEqual(un.removed, [LAUNCHER_REL]);
  assert.deepEqual(un.kept, [SKILL_REL]);
  assert.ok(fs.existsSync(installedPath), "drifted file kept");

  // A current (undrifted) install is removed cleanly, including the empty skill dir.
  fs.rmSync(path.join(dest, "bench"), { recursive: true, force: true });
  installKimiCommand([], { skillsDir: dest });
  const un2 = installKimiCommand(["--uninstall"], { skillsDir: dest });
  assert.deepEqual(un2.removed, MANAGED_RELS);
  assert.equal(fs.existsSync(installedPath), false);
  assert.equal(fs.existsSync(path.join(dest, "bench")), false, "emptied skill dir removed");
});

test("uninstall restores a pre-existing skill that install displaced", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-restore-"));
  const installedPath = path.join(dest, "bench", "SKILL.md");
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(installedPath, "original user skill\n", { mode: 0o640 });

  const install = installKimiCommand([], { skillsDir: dest });
  assert.deepEqual(install.backedUp, [SKILL_REL]);
  const uninstall = installKimiCommand(["--uninstall"], { skillsDir: dest });
  assert.equal(uninstall.ok, true);
  assert.deepEqual(uninstall.restored, [SKILL_REL]);
  assert.equal(fs.readFileSync(installedPath, "utf8"), "original user skill\n");
  assert.equal(fs.statSync(installedPath).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(`${installedPath}.pre-peerbench.bak`), false);
});

test("Kimi status and uninstall never read or remove a skill through a symlinked parent", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-uninstall-link-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-skills-uninstall-external-"));
  const externalSkill = path.join(external, "SKILL.md");
  fs.writeFileSync(externalSkill, "external user content\n");
  fs.symlinkSync(external, path.join(dest, "bench"));

  assert.throws(() => installKimiCommand(["--status"], { skillsDir: dest }), /symlink or non-directory component/);
  assert.throws(() => installKimiCommand(["--uninstall"], { skillsDir: dest }), /symlink or non-directory component/);
  assert.equal(fs.readFileSync(externalSkill, "utf8"), "external user content\n");
});

test("the shipped Kimi skill routes subcommands instead of hardcoding review", () => {
  const skill = fs.readFileSync(path.join("kimi", "skills", "bench", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /review --json "\$ARGUMENTS"/);
  assert.doesNotMatch(skill, /BENCH_RUNNER|bench-runner\.mjs/);
  assert.match(skill, /"\$\{KIMI_SKILL_DIR\}\/peerbench-launcher\.sh" status \[trace-id\]/);
  assert.match(skill, /"\$\{KIMI_SKILL_DIR\}\/peerbench-launcher\.sh" health \[--all\]/);
  assert.match(skill, /Do not append\s+the raw `\$ARGUMENTS` string after a hardcoded `review`/);
  const launcher = fs.readFileSync(path.join("kimi", "skills", "bench", "peerbench-launcher.sh"), "utf8");
  assert.match(launcher, /exec node \{\{BENCH_RUNNER_SHELL\}\} "\$@"/);
});

test("install-kimi direct entrypoint works through a symlinked path containing spaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-entrypoint-"));
  const linkedScripts = path.join(root, "scripts with spaces");
  fs.symlinkSync(path.resolve("scripts"), linkedScripts);
  const kimiHome = path.join(root, "kimi home");
  const result = spawnSync(process.execPath, [path.join(linkedScripts, "install-kimi.mjs"), "--status"], {
    cwd: path.resolve("."),
    env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    encoding: "utf8"
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "status");
  assert.equal(output.ok, false);
});

test("legacy deploy entrypoint finds install.mjs through a symlinked path containing spaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-entrypoint-link-"));
  const linkedDir = path.join(root, "scripts with spaces");
  fs.mkdirSync(linkedDir);
  const linkedScript = path.join(linkedDir, "deploy global hooks.mjs");
  fs.symlinkSync(path.resolve("scripts", "deploy-global-hooks.mjs"), linkedScript);
  const result = spawnSync(process.execPath, [linkedScript, "--help"], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: 5_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/install\.mjs/);
});
