#!/usr/bin/env node
// global-hooks/pre-push-review.mjs
// PreToolUse(Bash) hook: when Claude runs `git push`, run the full repo-aware
// push review against the ahead-of-remote commits before the push is allowed.
// On a high/critical BLOCK: deny the Bash tool with findings so Claude fixes first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isBenchDisabled as defaultIsBenchDisabled, readReviewedHead, sessionKeyFromInput, writeReviewedHead } from "./config-store.mjs";
import { writeTrace as defaultWriteTrace } from "./trace-store.mjs";
import { resolveReviewers as defaultResolveReviewers } from "./reviewers.mjs";
import { combinePanel } from "./panel-lib.mjs";
import { deepKey, shouldRewake } from "./deep-review.mjs";
import { enqueue as defaultEnqueue } from "./deep-queue.mjs";
import { runPushReview as defaultRunPushReview } from "./spec-review-run.mjs";
import { ensureNativePrePushHook } from "./native-git-hook.mjs";

const DEFAULT_PUSH_GATE_BUDGET_MS = 90_000;   // hard cap on the INLINE gate → it can never freeze the session (env-tunable per invocation)
const MAX_PUSH_DIFF_BYTES = 200_000;

// Enqueue the DEEP async push review. Pins symbolic ranges to SHAs so a queued job survives the
// remote-tracking ref advancing after the push lands. runMain calls this so the thorough panel pass
// runs in the BACKGROUND (delivered by the deep-review-runner rewake) instead of freezing the push.
export function launchPushReview(ws, range, { gitImpl = gitTry, now = Date.now(), sessionKey = null, enqueueImpl = defaultEnqueue } = {}) {
  try {
    const [headSha] = gitImpl(["rev-parse", "HEAD"], ws);
    let reviewRange = range;
    const dd = range.indexOf("..");
    if (dd > 0) {
      const [baseSha, baseOk] = gitImpl(["rev-parse", range.slice(0, dd)], ws);
      const [srcSha, srcOk] = gitImpl(["rev-parse", range.slice(dd + 2)], ws);
      if (baseOk && srcOk && baseSha && srcSha) reviewRange = `${baseSha}..${srcSha}`;
    }
    const contentKey = deepKey(`push:${reviewRange}`, headSha);
    return enqueueImpl(ws, { kind: "push", range: reviewRange, contentKey }, { now, sessionKey });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: deep push-review enqueue failed (${e instanceof Error ? e.message : String(e)}); fast review stands.\n`);
    return false;
  }
}

// A regex can't reliably detect `git push` across compound commands: it missed trailing
// operators (`git push;cmd`), git global options (`git -C . push`), and shell control flow
// (`cd /x || git push`). We tokenize into shell segments instead. (Bugs found by the bench's own hunt.)

// Git global options that take a SEPARATE value token (so we skip the value when scanning for `push`).
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
// `git push` options that take a SEPARATE value token — skip the value so it isn't mistaken for the
// remote/refspec (e.g. `git push -o ci.skip origin br` must yield remote=origin, not remote=ci.skip).
// NOT here: `--repo <repo>` — its value IS the remote, so it must fall through as the `remote`
// positional (skipping it would make `git push --repo upstream main` resolve remote=main and review
// the wrong commits). `--force-with-lease`/`--force-if-includes` attach their value with `=` and are
// bare otherwise, so skipping a token would eat the remote.
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);
// git's canonical empty tree — a universal base when a branch has no ancestor on the remote (a first
// push / root commit). Verified: both `git log --oneline <empty>..HEAD` and `git diff <empty>..HEAD`
// accept it and yield the full branch history.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Split a compound command into segments on top-level shell operators (; && || | &),
// honoring single/double quotes so operators inside strings don't split. Each segment carries
// the `joiner` operator that PRECEDED it ("" for the first) — needed to reason about control flow.
export function shellSegments(command) {
  const segs = []; let cur = "", quote = null, joiner = "", esc = false;   // esc: cur ends in a \-escaped literal
  const cmd = String(command ?? "");
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], next = cmd[i + 1];
    if (quote) {
      // inside "…" a backslash keeps \" \\ literal — without this the string "closed" at an escaped
      // quote and a later REAL separator was treated as inside-string (a missed command split).
      // \<newline> is a line continuation even inside "…" (both chars vanish).
      if (quote === '"' && c === "\\" && next === "\n") { i++; continue; }
      if (quote === '"' && c === "\\" && next != null) { cur += c + next; i++; continue; }
      cur += c; if (c === quote) quote = null; continue;
    }
    if (c === "\\") {
      // \x is a LITERAL char, never an operator — `true \<& git push …` is a literal `<` word, a REAL
      // background &, then an unrelated push (a stop-gate catch: treating the & as `<&` kept one
      // segment and the push went entirely unreviewed). \<newline> is a line continuation (both vanish).
      if (next === "\n") { i++; continue; }
      if (next != null) { cur += c + next; i++; esc = true; continue; }
      cur += c; esc = false; continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; esc = false; continue; }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) { segs.push({ text: cur, joiner }); joiner = c + next; cur = ""; esc = false; i++; continue; }
    // An & or | that is part of a REDIRECT is not a command separator: `2>&1`/`>&2` and `<&0`/`3<&0`
    // (& right after an UNESCAPED > or <), `&>`/`&>>` (& right before >), `>|` (clobber). Splitting
    // inside `2>&1` tore the push segment apart BEFORE arg parsing ever ran — `git push origin main
    // 2>&1 develop` lost `develop` to the next segment and bypassed the multi-ref block (a stop-gate
    // catch; the input-FD `<&` form was a second catch).
    if (c === "&" && ((!esc && (cur.endsWith(">") || cur.endsWith("<"))) || next === ">")) { cur += c; esc = false; continue; }
    if (c === "|" && !esc && cur.endsWith(">")) { cur += c; esc = false; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") { segs.push({ text: cur, joiner }); joiner = c; cur = ""; esc = false; continue; }
    cur += c; esc = false;
  }
  segs.push({ text: cur, joiner });
  return segs.map((s) => ({ text: s.text.trim(), joiner: s.joiner })).filter((s) => s.text);
}

// ── POSIX-style lexer ────────────────────────────────────────────────────────
// Lex a command line into WORD and OPERATOR tokens the way a shell does, so arg parsing sees
// exactly the argv git receives. The stop gate caught three divergences a regex classifier
// could not close:
//   • a redirect starts MID-WORD: `git merge feature>/dev/null` hands git the ref `feature`
//     (`>` ends the word even without whitespace) — keeping `feature>/dev/null` whole made
//     rev-parse fail and the merge gate fail OPEN
//   • `2>` is one redirect (a word that is ONLY digits right before >/< is its fd number),
//     while `foo2>bar` is the word `foo2` plus `>bar`
//   • `<<`/`<<-` are heredocs (the delimiter word is consumed, never an arg), `<<<` a herestring
// Quoting defeats all of it: a deliberate `git merge "feature>old"` stays one WORD (a legal ref).
// Returns [{ text, op }]; op tokens are control operators (; & | && || |&) or redirects.
export function lexShellTokens(text) {
  const s = String(text ?? "");
  const out = [];
  let cur = "", started = false, quote = null, curQuoted = false;
  const flushWord = () => { if (started) { out.push({ text: cur, op: false }); cur = ""; started = false; curQuoted = false; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") {                // inside "…": \" \\ \$ \` are the escapable chars
        const n = s[i + 1];
        if (n === "\n") { i++; continue; }              // \<newline> is a line continuation INSIDE "…" too:
        if (n === '"' || n === "\\" || n === "$" || n === "`") { cur += n; i++; continue; }   // `git "pu\␤sh"` runs git push (a stop-gate catch)
        cur += c; continue;
      }
      if (c === quote) quote = null; else cur += c;
      continue;
    }
    if (c === "\\") {
      // \x is a LITERAL word char, never an operator (`ma\<in` is one word) — and it counts as
      // QUOTED, so a \-escaped digit is not an fd number (`echo \2>x` passes the arg "2", not fd 2)
      const n = s[i + 1];
      if (n === "\n") { i++; continue; }                // line continuation
      if (n != null) { cur += n; i++; started = true; curQuoted = true; continue; }
      cur += c; started = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; curQuoted = true; continue; }
    if (c === " " || c === "\t" || c === "\r") { flushWord(); continue; }
    if (c === "\n" || c === ";") { flushWord(); out.push({ text: ";", op: true }); continue; }
    if (c === "&" || c === "|") {
      if (c === "&" && s[i + 1] === ">") {                          // &> / &>> (stdout+stderr to file)
        flushWord();
        let op = "&>"; i++;
        if (s[i + 1] === ">") { op = "&>>"; i++; }
        out.push({ text: op, op: true });
        continue;
      }
      flushWord();
      let op = c;
      if (s[i + 1] === c) { op = c + c; i++; }                      // && ||
      else if (c === "|" && s[i + 1] === "&") { op = "|&"; i++; }   // |&
      out.push({ text: op, op: true });
      continue;
    }
    if (c === ">" || c === "<") {
      let fd = "";
      if (started && !curQuoted && /^\d+$/.test(cur)) { fd = cur; cur = ""; started = false; }
      else flushWord();
      let op = c;
      if (c === ">") {
        if (s[i + 1] === ">") { op = ">>"; i++; }
        else if (s[i + 1] === "|") { op = ">|"; i++; }
      } else if (s[i + 1] === "<") {
        op = "<<"; i++;
        if (s[i + 1] === "<") { op = "<<<"; i++; }
        else if (s[i + 1] === "-") { op = "<<-"; i++; }
      } else if (s[i + 1] === ">") { op = "<>"; i++; }
      if ((op === ">" || op === "<") && s[i + 1] === "&") {         // >& / <& fd duplication
        op += "&"; i++;
        const dup = /^(\d+|-)(?=$|[\s;|&<>])/.exec(s.slice(i + 1)); // 2>&1, >&2, 2>&- — self-contained
        if (dup) { op += dup[1]; i += dup[1].length; }
      }
      out.push({ text: fd + op, op: true });
      continue;
    }
    cur += c; started = true;
  }
  flushWord();
  return out;
}

const CONTROL_OPS = new Set([";", "&", "|", "&&", "||", "|&"]);
// A redirect consumes the NEXT word (its file/heredoc-delimiter/herestring) unless it already
// carries an fd-duplication target (`2>&1`, `>&2`, `2>&-` — nothing follows).
const redirectTakesWord = (op) => !/&(\d+|-)$/.test(op);

// The argv WORDS of the first command in `text` — redirect operators and their target words are
// removed exactly as the shell removes them, and the scan stops at the first control operator
// (a NEW command starts there). Quotes are honored and stripped: `git -C "/a b/r" push` →
// ["git","-C","/a b/r","push"] (A1 — a split(/\s+/) broke spaced paths in two). Every git-command
// parser (push, merge, -C scanning) builds on this ONE view, so parsing can't diverge per caller.
export function shellTokenize(text) {
  const words = [];
  const toks = lexShellTokens(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.op) { words.push(t.text); continue; }
    if (CONTROL_OPS.has(t.text)) break;
    if (redirectTakesWord(t.text)) i++;   // the redirect's file/delimiter word is not an arg
  }
  return words;
}

// Locate `git` at COMMAND position in a word list, or -1. `git` as an ARGUMENT is not a command:
// `echo git push` prints, it doesn't push — and with escape normalization `echo g\it push` could
// SHADOW a real push in a LATER segment (findPushSegment returns the first match), reviewing the
// wrong command entirely (a stop-gate catch; the merge path failed OPEN through the fake ref).
// Skipped on the way to `git`: leading NAME=value assignments and exec-style wrappers that run
// their argv (`sudo git push`, `env -i git push`, `timeout 30 git push`). Common wrapper options are
// parsed with their documented value arity, including attached short values (`sudo -uroot`) and
// cwd-changing `env -C` / `sudo -D`. Unknown wrapper options remain deliberately unproven: the
// native armer must deny a plausible push instead of guessing which word is the command.
const EXEC_WRAPPERS = new Set(["sudo", "doas", "command", "env", "exec", "nohup", "nice", "ionice", "time", "timeout", "stdbuf", "chronic", "xcrun"]);
const commandBasename = (value) => path.basename(String(value || ""));

// Only option shapes that determine argv boundaries belong here. Effects are consumed later by the
// native target resolver; `chroot` is intentionally unprovable because an in-chroot path is not the
// same host path where the bootstrapper would install a hook.
const WRAPPER_OPTION_SPECS = {
  sudo: {
    shortFlags: "ABbEHikKlnPSsVve",
    shortFlagEffects: { e: "non-exec", l: "non-exec", V: "non-exec", v: "non-exec" },
    shortValues: { C: "value", D: "chdir", g: "value", h: "value", p: "value", R: "chroot", T: "value", u: "value", U: "value", r: "value", t: "value" },
    longFlags: ["askpass", "bell", "background", "edit", "help", "list", "login", "non-interactive", "preserve-env", "preserve-groups", "remove-timestamp", "reset-timestamp", "set-home", "shell", "stdin", "validate", "version"],
    longFlagEffects: { edit: "non-exec", help: "non-exec", list: "non-exec", validate: "non-exec", version: "non-exec" },
    longValues: { "close-from": "value", chdir: "chdir", group: "value", host: "value", prompt: "value", chroot: "chroot", "command-timeout": "value", user: "value", "other-user": "value", role: "value", type: "value" },
    selfContainedPrefixes: ["--preserve-env="]
  },
  doas: {
    shortFlags: "Lns",
    shortValues: { C: "non-exec", u: "value" },
    longFlags: [],
    longValues: {}
  },
  command: { shortFlags: "pvV", shortFlagEffects: { v: "non-exec", V: "non-exec" }, shortValues: {}, longFlags: [], longValues: {} },
  env: {
    shortFlags: "0iv",
    shortFlagEffects: { i: "clear-env" },
    shortValues: { C: "chdir", P: "value", S: "split-string", u: "unset-env" },
    longFlags: ["ignore-environment", "null"],
    longFlagEffects: { "ignore-environment": "clear-env" },
    longValues: { chdir: "chdir", "split-string": "split-string", unset: "unset-env", argv0: "value" }
  },
  exec: { shortFlags: "cl", shortValues: { a: "value" }, longFlags: [], longValues: {} },
  nohup: { shortFlags: "", shortValues: {}, longFlags: [], longValues: {} },
  nice: { shortFlags: "", shortValues: { n: "value" }, longFlags: [], longValues: { adjustment: "value" } },
  ionice: { shortFlags: "t", shortValues: { c: "value", n: "value", p: "value", P: "value", u: "value" }, longFlags: ["ignore"], longValues: { class: "value", classdata: "value", pid: "value", pgid: "value", uid: "value" } },
  time: { shortFlags: "apvl", shortValues: { f: "value", o: "value" }, longFlags: ["append", "portability", "verbose"], longValues: { format: "value", output: "value" } },
  timeout: { shortFlags: "fv", shortValues: { k: "value", s: "value" }, longFlags: ["foreground", "preserve-status", "verbose"], longValues: { "kill-after": "value", signal: "value" } },
  stdbuf: { shortFlags: "", shortValues: { i: "value", o: "value", e: "value" }, longFlags: [], longValues: { input: "value", output: "value", error: "value" } },
  chronic: { shortFlags: "", shortValues: {}, longFlags: [], longValues: {} },
  xcrun: {
    shortFlags: "hvlfrnk",
    shortFlagEffects: { h: "non-exec", f: "non-exec", k: "non-exec" },
    shortValues: {},
    longFlags: ["help", "version", "verbose", "log", "find", "run", "no-cache", "kill-cache", "show-sdk-path", "show-sdk-version", "show-sdk-build-version", "show-sdk-platform-path", "show-sdk-platform-version", "show-toolchain-path"],
    longFlagEffects: { help: "non-exec", version: "non-exec", find: "non-exec", "kill-cache": "non-exec", "show-sdk-path": "non-exec", "show-sdk-version": "non-exec", "show-sdk-build-version": "non-exec", "show-sdk-platform-path": "non-exec", "show-sdk-platform-version": "non-exec", "show-toolchain-path": "non-exec" },
    longValues: { sdk: "value", toolchain: "value" }
  }
};

function wrapperOption(toks, index, wrapper) {
  const spec = WRAPPER_OPTION_SPECS[wrapper];
  const token = toks[index];
  if (!spec || token === "--") return null;
  if (spec.selfContainedPrefixes?.some((prefix) => token.startsWith(prefix))) {
    return { consumed: 1, effects: [] };
  }
  if (token.startsWith("--")) {
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const effect = spec.longValues?.[name];
    if (effect) {
      const value = equals >= 0 ? body.slice(equals + 1) : toks[index + 1];
      return { consumed: equals >= 0 ? 1 : 2, effects: [{ kind: effect, value }], missing: value == null || value === "" };
    }
    if (spec.longFlags?.includes(name)) {
      const flagEffect = spec.longFlagEffects?.[name];
      return { consumed: 1, effects: flagEffect ? [{ kind: flagEffect, value: null }] : [] };
    }
    return null;
  }
  if (!token.startsWith("-") || token === "-") return null;

  // POSIX short options may be clustered. The first option that takes a value consumes the rest of
  // the cluster, or the following argv word when no attached value remains.
  const cluster = token.slice(1);
  const effects = [];
  for (let offset = 0; offset < cluster.length; offset++) {
    const option = cluster[offset];
    if (spec.shortFlags?.includes(option)) {
      const flagEffect = spec.shortFlagEffects?.[option];
      if (flagEffect) effects.push({ kind: flagEffect, value: null });
      continue;
    }
    const effect = spec.shortValues?.[option];
    if (!effect) return null;
    const attached = cluster.slice(offset + 1);
    const value = attached || toks[index + 1];
    effects.push({ kind: effect, value });
    return { consumed: attached ? 1 : 2, effects, missing: value == null || value === "" };
  }
  return { consumed: 1, effects };
}

function scanGitCommand(toks) {
  let wrapper = null;
  let wrapperSeen = false;
  let uncertainOption = false;
  const effects = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const command = commandBasename(t);
    if (command === "git") {
      const nonExecuting = effects.some((effect) => effect.kind === "non-exec");
      return uncertainOption || nonExecuting
        ? { index: -1, candidateIndex: i, wrapper, wrapperSeen, effects, uncertain: uncertainOption, nonExecuting }
        : { index: i, candidateIndex: i, wrapper, wrapperSeen, effects, uncertain: false, nonExecuting: false };
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;   // env-assignment prefix
    if (EXEC_WRAPPERS.has(command)) { wrapper = command; wrapperSeen = true; continue; }
    if (wrapper) {
      const option = wrapperOption(toks, i, wrapper);
      if (option) {
        if (option.missing) return { index: -1, wrapper, wrapperSeen, effects, stopIndex: i, uncertain: true };
        for (const effect of option.effects || []) effects.push({ wrapper, index: i, ...effect });
        i += option.consumed - 1;
        continue;
      }
      if (t === "--") continue;
      if (wrapper === "nice" && /^-\d+$/.test(t)) continue;  // legacy `nice -10 command`
      if (t.startsWith("-")) { uncertainOption = true; continue; }
      if (wrapper === "timeout" && (/^\d+(\.\d+)?[smhd]?$/.test(t) || t === "infinity")) continue;
    }
    return { index: -1, wrapper, wrapperSeen, effects, stopIndex: i, uncertain: uncertainOption };
  }
  return { index: -1, wrapper, wrapperSeen, effects, stopIndex: -1, uncertain: uncertainOption };
}

export function gitCommandIndex(toks) {
  return scanGitCommand(toks).index;
}

// True if a single segment is a real `git push` (allowing leading env assignments and git
// global options before the `push` subcommand). Excludes `--help`/`-h` and `--dry-run`/`-n`.
export function isGitPushSegment(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = gitCommandIndex(toks);
  if (i < 0) return false;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
  if (toks[i] !== "push") return false;
  const rest = toks.slice(i + 1);
  if (rest.some((t) => t === "--help" || t === "-h" || t === "--dry-run" || t === "-n")) return false;
  return true;
}

// Parse a git push segment into { remote, refspecs[], flags[] }. Remote defaults to "origin".
// Positional non-flag tokens after `push`: the first is the remote, the rest are refspecs.
// Used by resolvePushRange (A2) to compute the correct <base>..<source> range.
export function parsePushCommand(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = gitCommandIndex(toks);
  const flags = [];
  const positionals = [];
  if (i >= 0) {
    i++;
    // skip git global options (and their value tokens) up to `push`
    while (i < toks.length && toks[i].startsWith("-")) { const t = toks[i]; i++; if (GIT_VALUE_OPTS.has(t)) i++; }
    if (toks[i] === "push") {
      i++;
      // Redirects and control operators are already handled by shellTokenize (the lexer strips
      // them exactly as the shell does), so every remaining token is a real git argv word.
      for (; i < toks.length; i++) {
        const t = toks[i];
        if (t.startsWith("-")) { flags.push(t); if (PUSH_VALUE_FLAGS.has(t)) i++; }   // skip a value-flag's separate value token
        else positionals.push(t);
      }
    }
  }
  const remote = positionals.length > 0 ? positionals[0] : "origin";
  const refspecs = positionals.slice(1);
  return { remote, refspecs, flags };
}

// Extract -C target directories (in order) from a push segment, for review-cwd resolution (A1).
function dashCTargets(text) {
  const toks = shellTokenize(text).filter(Boolean);
  let i = gitCommandIndex(toks);
  const targets = [];
  if (i < 0) return targets;
  i++;
  while (i < toks.length && toks[i].startsWith("-")) {
    const t = toks[i];
    if (t === "-C" && i + 1 < toks.length) { targets.push(toks[i + 1]); i += 2; continue; }
    i++;
    if (GIT_VALUE_OPTS.has(t)) i++;
  }
  return targets;
}

// Resolve the repository whose native hook Git will actually invoke for a push. This is only a
// bootstrap aid: Git's pre-push stdin remains the authoritative source of refs. The important
// property here is that we never install in input.cwd and then silently allow a push whose static
// shell context points at another repository.
//
// Keep this deliberately conservative. If a directory depends on shell expansion/state that this
// hook cannot prove (for example `cd "$REPO"`, `pushd +1`, or command substitution), callers deny
// the push with an actionable message instead of pretending this is a complete shell parser.
function staticShellPath(value, cwd, env) {
  const raw = String(value ?? "");
  // The lexer intentionally strips quotes, so it cannot distinguish `~/repo` (shell-expanded) from
  // "~/repo" (literal path below cwd). Treat either as unproven instead of arming the wrong repo.
  if (!raw || raw === "-" || raw === "~" || raw.startsWith("~/") || /[$`*?\[\]{}]/.test(raw)) return null;
  return path.resolve(cwd, raw);
}

function stripStaticGrouping(text) {
  let out = String(text ?? "").trim();
  while (out.startsWith("(") || out.startsWith("{")) out = out.slice(1).trimStart();
  while (out.endsWith(")") || out.endsWith("}")) out = out.slice(0, -1).trimEnd();
  return out;
}

function applyWrapperEffects(analysis, shellCwd, env) {
  let cwd = shellCwd;
  for (const effect of analysis.effects || []) {
    if (effect.kind === "chroot") {
      return { proven: false, cwd, reason: `${effect.wrapper} chroot changes host path semantics` };
    }
    if (effect.kind === "split-string") {
      return { proven: false, cwd, reason: `${effect.wrapper} split-string command cannot be resolved safely` };
    }
    if (effect.kind !== "chdir") continue;
    const resolved = staticShellPath(effect.value, cwd, env);
    if (!resolved) {
      return { proven: false, cwd, reason: `could not resolve ${effect.wrapper} chdir ${effect.value || "(missing path)"}` };
    }
    cwd = resolved;
  }
  return { proven: true, cwd };
}

const NESTED_SHELLS = new Set(["sh", "bash", "dash", "ksh", "zsh"]);

function exactGitPushCandidate(toks) {
  for (let i = 0; i < toks.length; i++) {
    if (commandBasename(toks[i]) !== "git") continue;
    if (toks.slice(i + 1).includes("push")) return i;
  }
  return -1;
}

// If a known argv wrapper has an option we do not understand, a later literal `git ... push`
// remains plausibly executable. Do not silently classify it as "no push". Conversely, once wrapper
// parsing reaches a definite non-Git command (`sudo echo "git push"`), later words are its argv and
// must not trigger a denial. Explicit query modes (`command -v`, `xcrun --find`) are non-executing.
function plausibleWrappedGitPush(toks) {
  const analysis = scanGitCommand(toks);
  if (analysis.index >= 0 || !analysis.wrapperSeen || analysis.nonExecuting) return false;
  const candidate = analysis.candidateIndex ?? exactGitPushCandidate(toks);
  if (candidate < 0) return false;
  return analysis.uncertain === true;
}

function nestedShellPayload(toks) {
  const analysis = scanGitCommand(toks);
  if (analysis.index >= 0 || analysis.stopIndex < 0) return null;
  const command = commandBasename(toks[analysis.stopIndex]);
  if (command === "eval") {
    const payload = toks.slice(analysis.stopIndex + 1).join(" ");
    return payload ? { payload, analysis, command } : null;
  }
  if (!NESTED_SHELLS.has(command)) return null;
  for (let i = analysis.stopIndex + 1; i < toks.length; i++) {
    const option = toks[i];
    if (option === "--") continue;
    if (option === "-c" || (/^-[^-]+$/.test(option) && option.slice(1).includes("c"))) {
      const payload = toks[i + 1];
      return payload == null ? null : { payload, analysis, command };
    }
    if (!option.startsWith("-")) break;   // script path: its contents are not visible here
    if (option === "-O" || option === "-o") i++; // common shell options with a separate value
  }
  return null;
}

function nativeTargetFromPushSegment(text, shellCwd, env) {
  const toks = shellTokenize(text).filter(Boolean);
  const analysis = scanGitCommand(toks);
  const gitIndex = analysis.index;
  if (gitIndex < 0) return { proven: false, reason: "could not identify the git invocation" };

  const wrapperTarget = applyWrapperEffects(analysis, shellCwd, env);
  if (!wrapperTarget.proven) return wrapperTarget;
  let gitCwd = wrapperTarget.cwd;
  let gitDir = null;
  let workTree = null;

  // Inline assignments (`GIT_DIR=/repo/.git git push`) and env's `-i`/`-u` options are applied in
  // argv order. This matters for opposite forms such as `GIT_DIR=x env -i git push` (cleared) and
  // `env -i GIT_DIR=x git push` (restored explicitly).
  const assignments = { GIT_DIR: env.GIT_DIR, GIT_WORK_TREE: env.GIT_WORK_TREE };
  const envEvents = (analysis.effects || [])
    .filter((effect) => effect.kind === "clear-env" || effect.kind === "unset-env")
    .map((effect) => ({ index: effect.index, effect }));
  const assignmentEvents = [];
  for (let index = 0; index < gitIndex; index++) {
    const token = toks[index];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (match && (match[1] === "GIT_DIR" || match[1] === "GIT_WORK_TREE")) {
      assignmentEvents.push({ index, name: match[1], value: match[2] });
    }
  }
  for (const event of [...envEvents, ...assignmentEvents].sort((a, b) => a.index - b.index)) {
    if (event.effect?.kind === "clear-env") {
      assignments.GIT_DIR = undefined;
      assignments.GIT_WORK_TREE = undefined;
    } else if (event.effect?.kind === "unset-env") {
      if (event.effect.value === "GIT_DIR" || event.effect.value === "GIT_WORK_TREE") assignments[event.effect.value] = undefined;
    } else {
      assignments[event.name] = event.value;
    }
  }

  for (let i = gitIndex + 1; i < toks.length && toks[i] !== "push"; i++) {
    const token = toks[i];
    if (token === "-C") {
      const next = toks[++i];
      const resolved = staticShellPath(next, gitCwd, env);
      if (!resolved) return { proven: false, reason: `could not resolve git -C ${next || "(missing path)"}` };
      gitCwd = resolved;
      continue;
    }
    if (token === "--git-dir" || token === "--work-tree") {
      const next = toks[++i];
      if (!next) return { proven: false, reason: `${token} has no path` };
      if (token === "--git-dir") gitDir = next;
      else workTree = next;
      continue;
    }
    if (token.startsWith("--git-dir=")) gitDir = token.slice("--git-dir=".length);
    else if (token.startsWith("--work-tree=")) workTree = token.slice("--work-tree=".length);
    else if (token === "-c" || token === "--namespace" || token === "--exec-path" || token === "--super-prefix") i++;
  }

  gitDir ??= assignments.GIT_DIR || null;
  workTree ??= assignments.GIT_WORK_TREE || null;
  const resolvedGitDir = gitDir == null ? null : staticShellPath(gitDir, gitCwd, env);
  if (gitDir != null && !resolvedGitDir) return { proven: false, reason: "GIT_DIR/--git-dir is dynamic" };
  if (workTree != null && !staticShellPath(workTree, gitCwd, env)) {
    return { proven: false, reason: "GIT_WORK_TREE/--work-tree is dynamic" };
  }

  // Hooks belong to the Git directory, not the work tree. A conventional /repo/.git can be fed to
  // the installer as /repo (friendlier status/output); unusual and bare git dirs are valid cwd
  // targets themselves and resolveGitHooksDir handles them correctly.
  let target = resolvedGitDir || gitCwd;
  if (resolvedGitDir && path.basename(resolvedGitDir) === ".git") target = path.dirname(resolvedGitDir);
  return { proven: true, cwd: target };
}

export function resolveNativePushTarget(command, fallbackCwd, { env = process.env, nestedDepth = 0 } = {}) {
  const segments = shellSegments(command);
  let cwd = path.resolve(fallbackCwd);
  const directoryStack = [];
  let sawUnprovenDirectoryChange = null;
  let subshellDepth = 0;
  const scopedDirectoryChanges = [];
  let conditionalDirectoryChain = false;

  for (let index = 0; index < segments.length; index++) {
    const rawSegment = String(segments[index].text ?? "").trim();
    const leadingParens = /^\(+/.exec(rawSegment)?.[0].length || 0;
    const trailingParens = /\)+$/.exec(rawSegment)?.[0].length || 0;
    subshellDepth += leadingParens;
    const segment = stripStaticGrouping(rawSegment);
    const closeTrailingSubshells = () => {
      if (trailingParens === 0) return;
      const depthAfter = Math.max(0, subshellDepth - trailingParens);
      if (scopedDirectoryChanges.some((depth) => depth > depthAfter)) {
        sawUnprovenDirectoryChange ||= "directory change was confined to a closed subshell";
      }
      subshellDepth = depthAfter;
    };

    // A directory change that was itself conditional is useful only while the same && chain is
    // intact. Once `;`, `||`, `&`, or a pipeline breaks that chain, Git may run even though the
    // change never did (`false && cd /other; git push`). We cannot prove the cwd in that case.
    if (conditionalDirectoryChain && segments[index].joiner !== "&&") {
      sawUnprovenDirectoryChange ||= "conditional directory change may not have executed";
    }
    const preWords = shellTokenize(segment).filter(Boolean);
    const envIndex = preWords.findIndex((token) => commandBasename(token) === "env");
    if (envIndex >= 0) {
      for (let i = envIndex + 1; i < preWords.length; i++) {
        const token = preWords[i];
        const payload = token === "-S" || token === "--split-string"
          ? preWords[i + 1]
          : (token.startsWith("--split-string=") ? token.slice("--split-string=".length) : null);
        if (payload != null) {
          const payloadResult = nestedDepth < 4
            ? resolveNativePushTarget(payload, cwd, { env, nestedDepth: nestedDepth + 1 })
            : { push: /(?:^|\s)(?:[^\s/]+\/)*git(?:\s|$)[\s\S]*\bpush\b/.test(payload) };
          if (payloadResult.push) {
            return { push: true, proven: false, reason: "env split-string command cannot be resolved safely", segmentText: payloadResult.segmentText || payload };
          }
        }
      }
    }

    // A static `bash -c 'git … push'` or `eval 'git … push'` still exposes its exact command
    // argument, so recurse through a small bounded number of literal nesting layers. A script path,
    // alias, function, make target, or expansion does not expose its body and cannot be inferred
    // here; those repos must already have the persistent native hook installed (documented below).
    const nested = nestedShellPayload(preWords);
    if (nested) {
      const wrapperTarget = applyWrapperEffects(nested.analysis, cwd, env);
      const nestedResult = nestedDepth < 4
        ? resolveNativePushTarget(nested.payload, wrapperTarget.cwd, { env, nestedDepth: nestedDepth + 1 })
        : { push: /(?:^|\s)(?:[^\s/]+\/)*git(?:\s|$)[\s\S]*\bpush\b/.test(nested.payload), proven: false, reason: "nested shell command exceeds the static resolution limit" };
      if (nestedResult.push) {
        if (sawUnprovenDirectoryChange) {
          return { push: true, proven: false, reason: sawUnprovenDirectoryChange, segmentText: nestedResult.segmentText || nested.payload };
        }
        if (!wrapperTarget.proven) {
          return { push: true, proven: false, reason: wrapperTarget.reason, segmentText: nestedResult.segmentText || nested.payload };
        }
        return nestedResult;
      }
    }
    if (isGitPushSegment(segment)) {
      if (sawUnprovenDirectoryChange) return { push: true, proven: false, reason: sawUnprovenDirectoryChange, segmentText: segment };
      return { push: true, ...nativeTargetFromPushSegment(segment, cwd, env), segmentText: segment };
    }
    if (plausibleWrappedGitPush(preWords)) {
      return {
        push: true,
        proven: false,
        reason: "wrapper options make the git command position ambiguous",
        segmentText: segment
      };
    }

    const words = preWords;
    const commandName = words[0];
    if (commandName === "cd" || commandName === "pushd") {
      const args = words.slice(1).filter((word) => word !== "--");
      const stackSelector = commandName === "pushd" && args.length === 1 && /^[+-]\d+$/.test(args[0]);
      const target = args.length === 1 && !stackSelector ? staticShellPath(args[0], cwd, env) : null;
      const previousJoiner = segments[index].joiner;
      const nextJoiner = segments[index + 1]?.joiner;
      const nextSegment = stripStaticGrouping(segments[index + 1]?.text || "");
      const nextIsPush = isGitPushSegment(nextSegment);

      if (previousJoiner === "||" || previousJoiner === "|") {
        sawUnprovenDirectoryChange ||= `${commandName} execution depends on prior shell control flow`;
      } else if (previousJoiner === "&&") {
        conditionalDirectoryChain = true;
      }
      if (nextJoiner === "&" || nextJoiner === "|") {
        sawUnprovenDirectoryChange ||= `${commandName} runs in a background or pipeline scope`;
      }

      // The one provable failure branch is `cd target || git push`: if the push runs, cd failed and
      // cwd is unchanged. With any intervening command, a later unconditional push could instead
      // observe either cwd, so fail closed.
      if (nextJoiner === "||") {
        if (commandName !== "cd" || !nextIsPush) {
          sawUnprovenDirectoryChange ||= `${commandName} success across || makes the later cwd ambiguous`;
        }
        closeTrailingSubshells();
        continue;
      }
      if (!target) {
        sawUnprovenDirectoryChange = `${commandName} target is dynamic or state-dependent`;
        closeTrailingSubshells();
        continue;
      }
      if (commandName === "pushd") directoryStack.push(cwd);
      cwd = target;
      if (subshellDepth > 0) scopedDirectoryChanges.push(subshellDepth);
      closeTrailingSubshells();
      continue;
    }
    if (commandName === "popd") {
      if (segments[index].joiner === "||" || segments[index].joiner === "|" || segments[index + 1]?.joiner === "&" || segments[index + 1]?.joiner === "|") {
        sawUnprovenDirectoryChange ||= "popd execution or scope is ambiguous";
      } else if (segments[index].joiner === "&&") {
        conditionalDirectoryChain = true;
      }
      if (words.length !== 1 || directoryStack.length === 0) {
        sawUnprovenDirectoryChange = "popd target is state-dependent";
      } else {
        cwd = directoryStack.pop();
      }
    }

    closeTrailingSubshells();
  }
  return { push: false, proven: true, cwd: commandCwd(command, fallbackCwd) };
}

// The first segment that is a real git push, or null. Also detects a subshell-wrapped push
// (`(git push)`) by stripping a balanced leading `(` / trailing `)` and re-checking (A3).
export function findPushSegment(command) {
  for (const s of shellSegments(command)) {
    if (isGitPushSegment(s.text)) return s;
    const stripped = s.text.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    if (stripped !== s.text && isGitPushSegment(stripped)) return { text: stripped, joiner: s.joiner };
  }
  return null;
}

// Derive the effective working directory of the push from `cd` segments before it (umbrella/multi-repo
// `cd subrepo && git push`). A `cd` is only honored if the NEXT segment isn't joined by `||` — i.e. the
// `cd` succeeded; `cd /missing || git push` runs the push in the ORIGINAL dir, so we must NOT use /missing.
export function cdTargetBeforePush(command, fallbackCwd) {
  const segs = shellSegments(command);
  let cwd = fallbackCwd;
  for (let k = 0; k < segs.length; k++) {
    if (isGitPushSegment(segs[k].text)) return cwd;
    const m = segs[k].text.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    if (m) {
      const target = m[1] || m[2] || m[3];
      const next = segs[k + 1];
      if (!(next && next.joiner === "||")) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    }
  }
  return cwd;
}

// Resolve the repo a git command actually OPERATES in: follow `cd` segments up to the FIRST git
// segment, then apply that segment's `git -C <dir>` targets. Mirrors the push path's cwd resolution
// but generalized to any git subcommand, so the reviewed-head bootstrap marks the repo the command
// TOUCHES (`git -C /other commit`, `cd /other && git add`) — not a stale input.cwd (the wrong repo).
//
// We deliberately do NOT follow GIT_DIR / GIT_WORK_TREE env redirects: the stop gate runs plain git
// in its cwd and doesn't follow them either, so honoring them here would bootstrap a workspace the
// stop gate never reviews — and `git rev-parse` run WITHOUT those vars can't resolve such a detached
// work tree anyway (wrong repo, or none). Env prefixes are skipped only so the git INVOCATION (and
// its `-C`) is still recognized; their values are ignored.
export function commandCwd(command, fallbackCwd) {
  const segs = shellSegments(command);
  let cwd = fallbackCwd;
  for (let k = 0; k < segs.length; k++) {
    const toks = shellTokenize(segs[k].text).filter(Boolean);
    // Same command-position rule as isGitPushSegment/dashCTargets: env prefixes and exec wrappers
    // are skipped, but `git` as an ARGUMENT (`echo git …`) is not a git invocation.
    if (gitCommandIndex(toks) >= 0) {
      for (const target of dashCTargets(segs[k].text)) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      return cwd;                                  // resolve to the first git segment (where work lands)
    }
    const m = segs[k].text.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    if (m) {
      const target = m[1] || m[2] || m[3];
      const next = segs[k + 1];
      if (!(next && next.joiner === "||")) cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    }
  }
  return cwd;
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`⛩ pre-push: could not parse hook input (${e instanceof Error ? e.message : String(e)}); treating as empty.\n`);
    return {};
  }
}

const MAX_ASSISTANT_CONTEXT_CHARS = 8000;

export function assistantContextFromInput(input) {
  const value =
    input?.last_assistant_message
    ?? input?.lastAssistantMessage
    ?? input?.assistant?.last_message
    ?? input?.assistant?.lastMessage
    ?? input?.transcript?.last_assistant_message
    ?? input?.transcript?.lastAssistantMessage
    ?? "";
  return typeof value === "string" ? value.trim().slice(0, MAX_ASSISTANT_CONTEXT_CHARS) : "";
}

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

function gitTry(args, cwd) {
  // Returns [output, ok] — ok=false means the command exited non-zero or threw.
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return [out.trim(), true];
  } catch {
    return ["", false];
  }
}

// Invocation-scoped emit-once guard. Claude Code reads only the FIRST JSON line on stdout, so a
// second emit (e.g. the top-level .catch firing after runMain already decided) is silently dropped.
// MUST be created per runMain invocation — a module-level flag would suppress emits on later
// invocations in the same process and break the suite (A4 — found by the bench's own hunt).
export function createEmitter() {
  let emitted = false;
  return {
    hasEmitted: () => emitted,
    emit(payload) {
      if (emitted) return false;
      emitted = true;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return true;
    }
  };
}

function decisionPayload(permissionDecision, reason, systemMessage) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason
    }
  };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

function hasReviewerVerdict(review) {
  return Array.isArray(review?.reviewers) && review.reviewers.some((r) => {
    const verdict = String(r?.verdict || "").toUpperCase();
    return verdict === "ALLOW" || verdict === "BLOCK";
  });
}

function refExists(ref, cwd) {
  const [, ok] = gitTry(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return ok;
}

// Resolve push range (commits ahead of remote) from the PARSED push command. Returns
// { range, ok, note, deleteOnly }. ok=false means no reviewable range. Delete-only pushes are
// clean no-ops; other unresolved ranges are denied by runMain so commits are not pushed unreviewed.
//
//  - <src>:<dst>  → source = local <src> (HEAD if <src>=="HEAD"); base = <remote>/<dst> if it exists
//                   (else the base-chain below). Explicit refspecs take precedence over @{u}.
//  - bare <ref>   → src = dst = <ref> → <remote>/<ref>..<ref>
//  - :<dst>       → delete → no commits → clean allow (deleteOnly).
//  - no refspec   → source = HEAD; base chain: @{u} → <remote>/<branch> → <remote>/HEAD →
//                   <remote>/main → <remote>/master → <remote>/master..HEAD as last resort.
//  - --all/--tags/--mirror, or >1 refspec → can't scope an EXACT range, so review the current
//    branch's ahead-commits (fallbackRange) as a best effort rather than skipping review.
export function resolvePushRange(cwd, parsed) {
  const { remote = "origin", refspecs = [], flags = [] } = parsed || {};

  // A single delete refspec (:<dst>) pushes no commits → clean allow, no review.
  if (refspecs.length === 1 && refspecs[0].startsWith(":")) {
    return { range: "", ok: false, deleteOnly: true };
  }

  // A push that spans SEVERAL refs — multiple refspecs (`git push beta main develop`) or whole-ref
  // flags (--all/--branches/--tags/--mirror) — can't be scoped to peerBench's ONE reviewable diff
  // range. The old "best effort" reviewed only the current branch and then ALLOWED, silently shipping
  // the OTHER refs' commits unreviewed (a stop-gate catch). Fail CLOSED: block with an actionable note
  // (push each ref on its own so every commit is reviewed). Carve-out below for a harmless tags push.
  const wholeRefFlag = ["--all", "--branches", "--tags", "--mirror"].find((f) => flags.includes(f));   // --branches = git 2.50 alias for --all
  if (wholeRefFlag || refspecs.length > 1) {
    // Tags-only push (`git push --tags`, no branch refspecs) that introduces NO new commits — tags
    // reference commits already on the remote (i.e. already-reviewed branches). Nothing to review →
    // clean allow, so the common release flow (push branch, then push --tags) stays unblocked.
    if (wholeRefFlag === "--tags" && refspecs.length === 0) {
      const [newTagCommits, ok] = gitTry(["rev-list", "--tags", "--not", `--remotes=${remote}`], cwd);
      if (ok && !newTagCommits.trim()) return { range: "", ok: false, cleanAllow: true };
      // else: a tag points at commits not yet on the remote → they'd ship unreviewed → block below.
    }
    const why = wholeRefFlag ? `${wholeRefFlag} pushes multiple refs` : `${refspecs.length} refspecs`;
    return { range: "", ok: false, note: `⛩ pre-push: ${why} — peerBench reviews one commit range and can't scope a multi-ref push, so it can't confirm every ref's commits are reviewed; push each ref on its own (git push ${remote} <ref>) so all commits are reviewed.` };
  }

  // Single explicit refspec.
  if (refspecs.length === 1) {
    const spec = refspecs[0];
    const colon = spec.indexOf(":");
    if (colon >= 0) {
      const src = spec.slice(0, colon);
      const dst = spec.slice(colon + 1);
      const source = src === "HEAD" ? "HEAD" : src;
      const baseRef = `${remote}/${dst}`;
      if (refExists(baseRef, cwd)) return { range: `${baseRef}..${source}`, ok: true };
      // No remote-tracking ref for the dst — keep the explicit source against a guessed base, else
      // scope the fallback to THAT SOURCE (never HEAD — HEAD may be a different branch → wrong commits).
      const chain = baseChain(cwd, remote);
      if (chain) return { range: `${chain}..${source}`, ok: true, note: `pre-push: guessed base ${chain} for ${spec}` };
      const ahead = remoteAheadRange(cwd, remote, source);
      return ahead.ok
        ? { ...ahead, note: `⛩ pre-push: no remote base for ${spec} — reviewing ${source}'s commits not on ${remote} (${ahead.range}).` }
        : { range: "", ok: false, note: `⛩ pre-push: could not resolve a base for ${spec}; push blocked until peerBench can review a commit range.` };
    }
    // bare <ref> → src = dst = <ref>
    const baseRef = `${remote}/${spec}`;
    if (refExists(baseRef, cwd)) return { range: `${baseRef}..${spec}`, ok: true };
    const chain = baseChain(cwd, remote);
    if (chain) return { range: `${chain}..${spec}`, ok: true, note: `pre-push: guessed base ${chain} for ${spec}` };
    // Scope to <spec> (the pushed ref), NOT HEAD — the push may not be of the current branch.
    const ahead = remoteAheadRange(cwd, remote, spec);
    return ahead.ok
      ? { ...ahead, note: `⛩ pre-push: no remote-tracking ref for ${spec} — reviewing its commits not on ${remote} (${ahead.range}).` }
      : { range: "", ok: false, note: `⛩ pre-push: no remote-tracking ref for ${spec}; push blocked until peerBench can review a commit range.` };
  }

  // No explicit refspec (`git push`) → the current branch's ahead-commits from a CHEAP base. This
  // stays FAIL-CLOSED (no always-ok remote-ahead tier) because a bare push is NOT guaranteed HEAD-only:
  // `push.default=matching` or a `remote.<remote>.push` refspec can transmit other branches, which a
  // HEAD-scoped range would silently skip (a push-gate catch). The new-branch fix lives on the EXPLICIT
  // refspec path (`git push -u origin <branch>`), which scopes to the named source — the common form,
  // and the one actually reported. A bare push that can't resolve a base blocks with a clear note
  // (use the explicit `git push origin <branch>` form, or set an upstream).
  const fb = currentBranchBaseRange(cwd, remote);
  return fb.ok ? fb : { range: "", ok: false, note: "⛩ pre-push: no upstream to diff against; push blocked until peerBench can review a commit range (push an explicit `<remote> <branch>` so the range can be scoped)." };
}

// The CURRENT branch's ahead-commits from a CHEAP base only: @{u}, else a guessed <remote>/<branch|
// HEAD|main|master>. ok:false when neither exists. Used where scoping to HEAD is the RIGHT best-effort
// but an always-success tier would UNDER-review (multi-ref / --all / bare pushes can carry commits on
// refs OTHER than HEAD, so a HEAD-only fallback would silently skip them → fail-closed instead).
function currentBranchBaseRange(cwd, remote) {
  const [upstreamFull, upOk] = gitTry(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  if (upOk && upstreamFull) return { range: "@{u}..HEAD", ok: true };
  const chain = baseChain(cwd, remote);
  if (chain) return { range: `${chain}..HEAD`, ok: true, note: `pre-push: guessed base ${chain} (no @{u})` };
  return { range: "", ok: false };
}

// Commits on <source> (default HEAD) that NO tracking ref of <remote> contains = exactly what a push
// of that source would send, regardless of branch naming or which refs are fetched. Base = the oldest
// such commit's parent (the divergence point, which IS on the remote); a root commit (empty remote /
// first push ever) has none, so git's empty tree is the base and the whole history is reviewed.
// The <source> MUST be the ref actually being pushed — passing HEAD for an explicit non-HEAD refspec
// would review the wrong commits (a push-gate catch). Returns { range, ok }; ok:false only when
// git itself can't enumerate (source doesn't resolve / rev-list errors) → caller fail-closes.
function remoteAheadRange(cwd, remote, source = "HEAD") {
  const [list, ok] = gitTry(["rev-list", "--reverse", "--topo-order", source, "--not", `--remotes=${remote}`], cwd);
  if (!ok) return { range: "", ok: false };
  const commits = list.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!commits.length) return { range: `${source}..${source}`, ok: true };   // nothing ahead → empty range → clean allow downstream
  const [base, hasBase] = gitTry(["rev-parse", "--verify", "--quiet", `${commits[0]}^`], cwd);
  const baseRef = (hasBase && base) ? base : EMPTY_TREE;
  return { range: `${baseRef}..${source}`, ok: true, note: `pre-push: reviewing ${commits.length} commit(s) on ${source} not on any ${remote} ref (no upstream)` };
}

// Base-ref precedence for a named remote with no explicit refspec / no @{u}:
// <remote>/<current-branch> → <remote>/HEAD → <remote>/main → <remote>/master. null if none.
function baseChain(cwd, remote) {
  const [branch, brOk] = gitTry(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const candidates = [];
  if (brOk && branch && branch !== "HEAD") candidates.push(`${remote}/${branch}`);
  candidates.push(`${remote}/HEAD`, `${remote}/main`, `${remote}/master`);
  for (const c of candidates) if (refExists(c, cwd)) return c;
  return null;
}

export function buildPrompt(commits, diff) {
  const system =
    "You are reviewing a set of commits about to be pushed. Review based ONLY on the content " +
    "provided in this message. Do NOT use any tools or explore the filesystem. " +
    "Your first line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`. " +
    "BLOCK only if there is a concrete bug, regression, security issue, or unsafe change " +
    "that must be fixed before these commits are pushed; otherwise ALLOW " +
    "(minor notes may follow the first line).";
  const user = [
    "<commits>",
    commits || "(no commit list available)",
    "</commits>",
    "",
    "<diff>",
    diff || "(no diff available)",
    "</diff>"
  ].join("\n");
  return { system, user };
}

function bootstrapReviewedHead(command, input, env, isBenchDisabledImpl) {
  // This must run from the production arming entrypoint as well as the explicitly-invoked legacy
  // preflight. The Bash hook is the only lifecycle point guaranteed to run BEFORE `git commit`; if
  // production merely installs the native pre-push hook, a first clean committed turn in a repo with
  // no upstream has no earlier base and Stop incorrectly treats it as a no-op.
  try {
    const bootWs = workspaceRoot(commandCwd(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (!isBenchDisabledImpl(bootWs) && !readReviewedHead(bootWs)) {
      const [head, ok] = gitTry(["rev-parse", "HEAD"], bootWs);
      if (ok && head.trim()) writeReviewedHead(bootWs, head.trim());
    }
  } catch { /* baseline bootstrap is best-effort — it must not affect the Git command */ }
}

export async function runMain({
  resolveReviewersImpl = defaultResolveReviewers,
  pushReviewImpl = defaultRunPushReview,
  writeTraceImpl = defaultWriteTrace,
  isBenchDisabledImpl = defaultIsBenchDisabled,
  enqueueImpl = defaultEnqueue,
  env = process.env,
  input: inputOverride,
  emitter = createEmitter(),
  exit = (code) => process.exit(code)
} = {}) {
  // All decisions route through this invocation's emit-once guard (A4).
  const decision = (permissionDecision, reason, systemMessage) =>
    emitter.emit(decisionPayload(permissionDecision, reason, systemMessage));

  const input = inputOverride ?? readInput();
  const sessionKey = sessionKeyFromInput(input, env);
  const assistantContext = assistantContextFromInput(input);   // used by the blocking-mode deep review

  const command = String(input.tool_input?.command ?? "");

  // 0. Bootstrap the stop gate's reviewed-head baseline on the FIRST `git` command of a session
  // (this hook fires on every `git *` via its matcher), BEFORE any commit lands — so that
  // committed-AND-pushed work is still reviewed on the first stop, where `@{upstream}` would
  // already have advanced past it. Resolve the repo the command actually TOUCHES (cd + `git -C`),
  // not a stale input.cwd. Only WRITES when the marker is missing; best-effort, never affects the
  // git command itself.
  bootstrapReviewedHead(command, input, env, isBenchDisabledImpl);

  // 1. Only act on a real `git push` (not help/dry-run, not another git command, not a quoted mention).
  const pushSeg = findPushSegment(command);
  if (!pushSeg) {
    // Not a git push — silent allow.
    return;
  }

  // Resolve the review cwd: shell `cd` segments first, then `git -C <dir>` targets applied in order
  // like git itself (A1) — so `git -C "/path with space/repo" push` reviews THAT repo.
  let baseCwd = cdTargetBeforePush(command, input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  for (const target of dashCTargets(pushSeg.text)) {
    baseCwd = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
  }
  const ws = workspaceRoot(baseCwd);

  // 2. Bench disabled check.
  if (isBenchDisabledImpl(ws)) {
    return exit(0);
  }

  // 3. Compute push range from the PARSED command. If a real push might transmit commits but
  // peerBench cannot resolve a review range, fail closed instead of allowing an unreviewed push.
  const parsed = parsePushCommand(pushSeg.text);
  const { range, ok: rangeOk, note: rangeNote, deleteOnly, cleanAllow } = resolvePushRange(ws, parsed);
  if (!rangeOk) {
    if (deleteOnly || cleanAllow) {
      // No commits transmitted (delete refspec, or a tags-only push referencing already-pushed
      // commits) → clean allow, no review, no noisy note.
      return;
    }
    const note = rangeNote || "⛩ pre-push: no reviewable commit range; push blocked.";
    decision(
      "deny",
      `${note} Retry after setting an upstream/remote tracking ref, or run /bench:off if you intentionally need to bypass peerBench.`,
      note
    );
    return;
  }

  // 4. Get commits in range; if nothing to push, allow quietly. Use gitTry so a git ERROR
  //    (not "no commits") is distinguishable and surfaced as a ⛩ note (A2).
  const [commits, commitsOk] = gitTry(["log", "--oneline", range], ws);
  if (!commitsOk) {
    decision(
      "deny",
      `⛩ pre-push: git log ${range} failed; push blocked because peerBench could not inspect the commits. Retry, or run /bench:off if you intentionally need to bypass peerBench.`,
      `⛩ pre-push: git log ${range} failed; push blocked.`
    );
    return;
  }
  if (!commits.trim()) {
    decision("allow", "pre-push: nothing to push (no commits ahead of remote); allowed");
    return;
  }

  const rangeNoteSuffix = rangeNote ? ` (${rangeNote})` : "";
  // DEFAULT = blocking (Rai's call 2026-07-14): a full repo-aware review runs INLINE and the push is
  // BLOCKED until it finishes (fail-closed). It freezes the session for the whole review (no Ctrl+B /
  // no input), but the thorough findings are worth it — the fast 90s content-only pass produced
  // findings not worth the shallowness. Opt into the fast + async-panel mode with BENCH_PUSH_GATE_MODE=fast.
  const mode = String(env.BENCH_PUSH_GATE_MODE || "blocking").toLowerCase();

  if (mode !== "fast") {
    let review;
    try {
      review = await pushReviewImpl(range, ws, { sessionKey, writeTraceImpl, assistantContext });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      decision("deny", `⛩ bench pre-push: full push review errored (${msg}); push blocked. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review errored; push blocked.`);
      return;
    }
    if (review?.retry) {
      decision("deny", `⛩ bench pre-push: full push review could not inspect ${range} (${review.reason || "retry requested"}); push blocked. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review unavailable; push blocked.`);
      return;
    }
    if (!hasReviewerVerdict(review)) {
      decision("deny", `⛩ bench pre-push: full push review produced no reviewer verdicts; push blocked so commits do not leave unreviewed. Retry, or run /bench:off if you intentionally need to bypass peerBench.`, `⛩ bench pre-push: full review unavailable; push blocked.`);
      return;
    }
    if (shouldRewake(review)) {
      const detail = review.findings || review.summary || "(no details)";
      decision("deny", `[${review.badge || "push-review"}] Full push review found issues that must be fixed before pushing:\n\n${detail}\n\nFix the issues above, then run git push again.`, `⛩ bench pre-push BLOCKED [${review.badge || "push-review"}]${rangeNoteSuffix}\n${detail.slice(0, 1200)}${review.traceId ? `\n\n↳ full findings: /bench:show ${review.traceId}` : ""}`);
      return;
    }
    decision("allow", `⛩ bench pre-push: ALLOW [${review.badge || "push-review"}] — ${review.summary || "full push review passed"}${rangeNoteSuffix}`, `⛩ bench pre-push: ALLOW [${review.badge || "push-review"}] — ${(review.summary || "full push review passed").slice(0, 220)}`);
    return;
  }

  // ── FAST mode (opt-in: BENCH_PUSH_GATE_MODE=fast) ────────────────────────────────────────────
  // 5. Enqueue the DEEP async panel review FIRST (best-effort). The thorough repo-aware Codex/Grok/MiMo
  // pass now runs in the BACKGROUND — delivered by the deep-review-runner via the visible rewake at the
  // next stop (non-blocking, backgroundable). This is what lets the inline gate below stay FAST: the slow
  // exhaustive review no longer runs INSIDE this PreToolUse hook, so it can't freeze the session.
  // (History: pushes were full-reviewed inline here — a 15–20 min block with no way to Ctrl+B or send
  // input while Codex/Grok/MiMo churned. The fast-inline-cap + async-panel split fixes exactly that.)
  try {
    launchPushReview(ws, range, { sessionKey, enqueueImpl });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: deep review enqueue failed (${e instanceof Error ? e.message : String(e)}); fast gate stands.\n`);
  }

  // 6. Fast content-only inline review, HARD-capped. On timeout/error/no-verdict → FAIL OPEN (allow):
  // the deep review is already queued, so a slow review can never wedge the push or freeze the session.
  // A fast, confident high/critical finding still BLOCKS — obvious problems stop before the push leaves.
  const budgetMs = Number(env.BENCH_PUSH_GATE_BUDGET_MS) || DEFAULT_PUSH_GATE_BUDGET_MS;
  let diff = gitTry(["diff", range], ws)[0] || "";
  if (diff.length > MAX_PUSH_DIFF_BYTES) diff = diff.slice(0, MAX_PUSH_DIFF_BYTES) + "\n\n[... diff truncated at 200 000 bytes ...]";
  const { system, user } = buildPrompt(commits, diff);

  let results = null;
  let budgetTimer = null;
  try {
    const reviewers = resolveReviewersImpl({ env });
    const reviewPromise = Promise.all(reviewers.map((r) => r.run({ system, user, cwd: ws, env })));
    const timeout = new Promise((resolve) => { budgetTimer = setTimeout(() => resolve("TIMEOUT"), budgetMs); });
    results = await Promise.race([reviewPromise, timeout]);
  } catch {
    results = null;
  } finally {
    // CRITICAL: clear the budget timer the instant the panel returns. A pending setTimeout is a REF'd
    // handle that keeps the hook PROCESS alive until it fires — so on a fast ALLOW the hook would linger
    // the full budget and Claude Code (which waits for the hook to EXIT) freezes ~90s on EVERY push,
    // defeating the whole fast-mode point (caught by the Codex gate). On the timeout branch the timer has
    // already fired; the LOSING reviewer promise still holds sockets open, so that path exit(0)s below.
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (results === "TIMEOUT" || !Array.isArray(results) || !hasReviewerVerdict({ reviewers: results })) {
    const why = results === "TIMEOUT" ? `fast review didn't finish in ${(budgetMs / 1000) | 0}s` : "fast review unavailable";
    decision(
      "allow",
      `⛩ bench pre-push: ${why}; push allowed — a deep review is queued (delivered at the next stop). Run /bench:review ${range} for a full pass now.${rangeNoteSuffix}`,
      `⛩ bench pre-push: ${why} (${range}); push allowed — deep review queued.`
    );
    return exit(0);   // reviewers lost the race but their sockets are still open — force-exit
  }

  const panel = combinePanel(results, { blockMinSeverity: "high" });
  try {
    writeTraceImpl(ws, {
      gate: "push-review", ws, sessionKey,
      reviewers: results.map((r) => ({ name: r.name, verdict: r.verdict || null, error: r.error || null })),
      systemPrompt: system, userPrompt: user.slice(0, 2000),
      rawResponses: Object.fromEntries(results.map((r) => [r.name, r.raw || r.error || ""]))
    });
  } catch (e) {
    process.stderr.write(`⛩ pre-push: trace write failed (${e instanceof Error ? e.message : String(e)}); review continues.\n`);
  }

  // 7. Decision. High/critical findings block (fast); lower severity is advisory (shared threshold
  // with plan/spec). The thorough deep pass is already queued regardless.
  if (panel.decision === "block") {
    const detail = panel.findings || panel.summary || "(no details)";
    decision(
      "deny",
      `[${panel.badge}] Fast pre-push review found issues that must be fixed before pushing:\n\n${detail}\n\n` +
      `Fix the issues above, then run git push again. (A deep review is also queued.)`,
      // USER-VISIBLE: a pre-push block is never "off the eyes" — surface the badge + trimmed findings.
      `⛩ bench pre-push BLOCKED [${panel.badge}]${rangeNoteSuffix}\n${detail.slice(0, 1200)}`
    );
    return;
  }

  decision(
    "allow",
    `⛩ bench pre-push: ALLOW [${panel.badge}] — ${panel.summary || "fast push review passed"} (a deep review is queued for the thorough pass)${rangeNoteSuffix}`,
    `⛩ bench pre-push: ALLOW [${panel.badge}] — ${(panel.summary || "push review passed").slice(0, 200)}`
  );
}

// Production entrypoint: install/refresh Git's authoritative native hook and otherwise stay out of
// the way. The legacy shell-string preflight remains exported (and can be explicitly enabled) for a
// degraded fallback when native hook installation is impossible, but it is no longer the security
// boundary. This also fixes compound `git add && git commit --amend && git push`: Git invokes the
// native hook after the amend, so reviewers see the commit that will actually leave.
export async function runHookMain({
  env = process.env,
  input: inputOverride,
  ensureNativeHookImpl = ensureNativePrePushHook,
  ...legacyOptions
} = {}) {
  const input = inputOverride ?? readInput();
  const command = String(input.tool_input?.command ?? "");
  const baseCwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const isBenchDisabledImpl = legacyOptions.isBenchDisabledImpl ?? defaultIsBenchDisabled;

  // Production no longer runs the shell-string review, but it still owns the pre-command baseline
  // needed by Stop. Do this before any commit/push can advance HEAD; the native Git hook runs too late
  // to reconstruct where this task began.
  bootstrapReviewedHead(command, input, env, isBenchDisabledImpl);

  const pushSeg = findPushSegment(command);
  const target = resolveNativePushTarget(command, baseCwd, { env });
  const emitter = legacyOptions.emitter || createEmitter();
  const bypassEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
  let nativeBypass = env.BENCH_NATIVE_PUSH_BYPASS;
  const hasPotentialPush = !!pushSeg || target.push;
  const pushTexts = [command, target.segmentText].filter((value, index, all) => value && all.indexOf(value) === index);
  for (const text of pushTexts) {
    for (const segment of shellSegments(text)) {
      const tokens = shellTokenize(segment.text).filter(Boolean);
      const analysis = scanGitCommand(tokens);
      const boundary = analysis.candidateIndex >= 0
        ? analysis.candidateIndex
        : (analysis.stopIndex >= 0 ? analysis.stopIndex : tokens.length);
      for (const token of tokens.slice(0, boundary)) {
        const assignment = /^BENCH_NATIVE_PUSH_BYPASS=(.*)$/.exec(token);
        if (assignment) nativeBypass = assignment[1];
      }
    }
  }
  // This bypass skips peerBench only; Git still runs every other pre-push hook in the chain.
  if (hasPotentialPush && bypassEnabled(nativeBypass)) return;
  // Git itself skips pre-push hooks for this explicit flag. Treat it as the documented deliberate
  // all-hooks bypass here too; otherwise our repair message would recommend a flag that the
  // bootstrap hook immediately denied before Git could honor it.
  if (hasPotentialPush && pushTexts.some((text) => shellTokenize(text).includes("--no-verify"))) return;
  if (target.push && !target.proven) {
    emitter.emit(decisionPayload(
      "deny",
      `peerBench could not prove which repository this push targets (${target.reason || "dynamic shell context"}). Push blocked before bootstrap. Run peerbench setup inside the target repository or use a static cd/git -C/GIT_DIR path. For a deliberate one-off bypass, prefix the git command with BENCH_NATIVE_PUSH_BYPASS=1 to skip peerBench only; git push --no-verify skips all pre-push hooks.`,
      "⛩ peerBench: push target is dynamic; native pre-push gate could not be armed."
    ));
    return;
  }
  const hookCwd = target.cwd;
  let install;
  try {
    install = ensureNativeHookImpl(workspaceRoot(hookCwd));
  } catch (error) {
    install = { ok: false, installed: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const forceLegacy = ["1", "true", "yes", "on"].includes(String(env.BENCH_LEGACY_PUSH_PREFLIGHT || "").toLowerCase());
  if (install?.ok && install?.installed && !forceLegacy) return;

  if (forceLegacy) {
    return runMain({ ...legacyOptions, emitter, env, input });
  }

  // An advisory shell-string review is not a substitute for the native gate. If installation is
  // conflicted/unwritable, fail closed with a direct repair path instead of reviewing the wrong
  // repository or the pre-mutation commit and then allowing the push.
  if (target.push || pushSeg) {
    const reason = install?.reason || "native hook installation failed";
    emitter.emit(decisionPayload(
      "deny",
      `peerBench could not arm the authoritative native pre-push hook (${reason}). Push blocked. Run peerbench setup inside the target repository and resolve the reported hook conflict. For a deliberate one-off bypass, prefix the git command with BENCH_NATIVE_PUSH_BYPASS=1 to skip peerBench only; git push --no-verify skips all pre-push hooks.`,
      `⛩ peerBench: native pre-push gate not armed (${reason}).`
    ));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = createEmitter();
  runHookMain({ emitter }).catch((error) => {
    // Top-level catch → fail closed. Only emit if runMain hasn't already decided — a 2nd stdout
    // line would be dropped by the harness (A4). Else log to stderr.
    const msg = error instanceof Error ? error.message : String(error);
    if (!emitter.hasEmitted()) {
      emitter.emit(decisionPayload(
        "deny",
        `⛩ pre-push: hook errored (${msg}); push blocked so commits do not leave unreviewed. Retry, use BENCH_NATIVE_PUSH_BYPASS=1 git push to skip peerBench only, or use git push --no-verify to skip every hook.`
      ));
    } else {
      process.stderr.write(`⛩ pre-push: error after decision already emitted — ${msg}\n`);
    }
  });
}
