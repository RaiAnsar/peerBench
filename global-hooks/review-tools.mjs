import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const READ_FILE_MAX = 50_000;     // chars
const GREP_MAX_LINES = 150;
const GLOB_MAX = 300;
const LIST_MAX = 300;

function realDir(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

// Read a [offset, offset+limit) line window WITHOUT loading the whole file (the 2MB guard only
// covered full reads, so offset/limit on a multi-GB file could OOM — found by the bench's own hunt).
function readLineRange(abs, offset, limit) {
  const start = Math.max(0, (Number.isInteger(offset) ? offset : 1) - 1);
  const want = Number.isInteger(limit) ? Math.max(0, limit) : Infinity;
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let leftover = "", lineNo = 0, scanned = 0; const out = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      scanned += n;
      const lines = (leftover + buf.toString("utf8", 0, n)).split("\n");
      leftover = lines.pop();
      for (const ln of lines) {
        if (lineNo >= start && out.length < want) out.push(ln);
        lineNo++;
      }
      if (out.length >= want) return out.join("\n");
      if (scanned > 64 * 1024 * 1024) break;   // hard safety cap for limit-less ranges
    }
    if (leftover && lineNo >= start && out.length < want) out.push(leftover);
    return out.join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function safePath(cwd, p) {
  const root = realDir(cwd);
  const abs = path.resolve(root, p ?? ".");
  // realpath the existing portion; for non-existent files, realpath the parent dir
  let probe = abs;
  try { probe = fs.realpathSync.native(abs); } catch {
    try { probe = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { probe = abs; }
  }
  if (probe !== root && !probe.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${p}`);
  return probe;
}

function safeGitPath(p, { allowRoot = false, pathspec = false } = {}) {
  const value = String(p ?? (allowRoot ? "." : ""));
  if (allowRoot && ["", "."].includes(value)) return ".";
  const slash = value.replaceAll("\\", "/");
  if (!slash || slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) throw new Error(`path escapes workspace: ${p}`);
  const parts = slash.split("/");
  if (parts.includes("..") || parts.includes(".git")) throw new Error(`path escapes workspace: ${p}`);
  if (!pathspec && parts.includes(".")) throw new Error(`path escapes workspace: ${p}`);
  return slash.replace(/^\.\//, "");
}

function lineRangeFromText(text, offset, limit) {
  const start = Math.max(0, (Number.isInteger(offset) ? offset : 1) - 1);
  const want = Number.isInteger(limit) ? Math.max(0, limit) : Infinity;
  return String(text).split(/\r?\n/).slice(start, start + want).join("\n");
}

// git's DEFAULT pathspec semantics (what `git ls-files -- <pattern>` applies), for filtering
// ls-tree output client-side: a wildcard-less pattern matches a file exactly or as a leading
// directory; with wildcards the WHOLE path is wildmatched with `*`/`?` crossing `/` (no
// FNM_PATHNAME) — `*.js` matches at any depth, `sub` matches everything under sub/.
function gitPathspecMatcher(pattern) {
  const pat = pattern.replace(/^\.\//, "");
  if (pat === "" || pat === ".") return () => true;               // repo-root pathspec matches everything
  if (!/[*?[]/.test(pat)) {
    const prefix = pat.endsWith("/") ? pat : `${pat}/`;
    return (file) => file === pat || file.startsWith(prefix);
  }
  const rx = new RegExp(`^${pat.split(/(\*+|\?|\[[^\]]*\])/).map((part) => {
    if (/^\*+$/.test(part)) return ".*";                        // `*` and `**` alike: no FNM_PATHNAME
    if (part === "?") return ".";
    if (part.startsWith("[") && part.endsWith("]")) return part[1] === "!" ? `[^${part.slice(2, -1)}]` : part;
    return part.replace(/[.*+?^${}()|\\]/g, "\\$&");
  }).join("")}$`);
  return (file) => rx.test(file);
}

export function createReviewTools(cwd, { execImpl = spawnSync, treeish = null } = {}) {
  if (treeish != null && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(treeish))) {
    throw new Error("review treeish must be an immutable object id");
  }
  const git = (argv, maxBuffer = 32 * 1024 * 1024) => execImpl("git", ["-c", "advice.graftFileDeprecated=false", "--no-replace-objects", ...argv], {
    cwd,
    encoding: "utf8",
    maxBuffer,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull }
  });

  const tools = {
    read_file({ path: p, offset, limit }) {
      if (treeish) {
        const gitPath = safeGitPath(p);
        const spec = `${treeish}:${gitPath}`;
        const sizeResult = git(["cat-file", "-s", spec]);
        if (sizeResult.status !== 0 || !/^\d+\s*$/.test(String(sizeResult.stdout || ""))) {
          throw new Error(`file does not exist in pushed tip: ${p}`);
        }
        const size = Number(String(sizeResult.stdout).trim());
        const hasRange = Number.isInteger(offset) || Number.isInteger(limit);
        if (!hasRange && size > 2_000_000) return `[file too large to read: ${size} bytes; use grep or read with offset/limit]`;
        if (hasRange && size > 64 * 1024 * 1024) return `[file too large for a bounded line read: ${size} bytes; use grep]`;
        const result = git(["cat-file", "blob", spec], Math.max(32 * 1024 * 1024, size + 1024));
        if (result.status !== 0) throw new Error(`could not read pushed-tip file: ${p}`);
        let text = hasRange ? lineRangeFromText(result.stdout || "", offset, limit) : String(result.stdout || "");
        let truncated = "";
        if (text.length > READ_FILE_MAX) { text = text.slice(0, READ_FILE_MAX); truncated = "\n…[truncated]"; }
        return text + truncated;
      }
      const abs = safePath(cwd, p);
      const hasRange = Number.isInteger(offset) || Number.isInteger(limit);
      let text;
      if (hasRange) {
        text = readLineRange(abs, offset, limit);   // streamed window — never loads the whole file
      } else {
        const size = fs.statSync(abs).size;
        if (size > 2_000_000) return `[file too large to read: ${size} bytes; use grep or read with offset/limit]`;
        text = fs.readFileSync(abs, "utf8");
      }
      let truncated = "";
      if (text.length > READ_FILE_MAX) { text = text.slice(0, READ_FILE_MAX); truncated = "\n…[truncated]"; }
      return text + truncated;
    },
    grep({ pattern, path: p }) {
      if (!pattern) throw new Error("grep requires a pattern");
      if (treeish) {
        if (p) safeGitPath(p, { pathspec: true });
      } else if (p) safePath(cwd, p);
      const r = git(["grep", "-n", "-I", "--no-color", "-e", String(pattern), ...(treeish ? [treeish] : []), ...(p ? ["--", p] : [])]);
      if (r.status !== 0 && !r.stdout) return r.status === 1 ? "(no matches)" : `grep error: ${(r.stderr || "").slice(0, 200)}`;
      const lines = String(r.stdout).split(/\r?\n/).filter(Boolean);
      const shown = lines.slice(0, GREP_MAX_LINES).join("\n");
      return lines.length > GREP_MAX_LINES ? `${shown}\n…[${lines.length - GREP_MAX_LINES} more matches]` : (shown || "(no matches)");
    },
    glob({ pattern }) {
      const requested = pattern || "*";
      if (treeish) safeGitPath(requested, { pathspec: true });
      // ls-tree does NOT support fnmatch pathspecs: `-- "*"` silently lists NOTHING and `:(glob)`
      // is fatal 128 — both surfaced as "(no files)", telling a push reviewer the pushed tree is
      // empty. List the whole tree and filter client-side with the same semantics ls-files uses.
      const r = treeish
        ? git(["ls-tree", "-r", "--name-only", treeish])
        : git(["ls-files", "--", requested]);
      if (r.status !== 0) throw new Error(`could not list ${treeish ? "pushed-tip" : "repository"} files: ${String(r.stderr || "").trim().slice(0, 200)}`);
      let files = String(r.stdout || "").split(/\r?\n/).filter(Boolean);
      if (treeish) files = files.filter(gitPathspecMatcher(requested));
      const shown = files.slice(0, GLOB_MAX).join("\n");
      return files.length > GLOB_MAX ? `${shown}\n…[${files.length - GLOB_MAX} more files]` : (shown || "(no files)");
    },
    list_dir({ path: p }) {
      if (treeish) {
        const gitPath = safeGitPath(p || ".", { allowRoot: true });
        const target = gitPath === "." ? treeish : `${treeish}:${gitPath}`;
        const r = git(["ls-tree", target]);
        if (r.status !== 0) throw new Error(`directory does not exist in pushed tip: ${p || "."}`);
        const entries = String(r.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, LIST_MAX).map((line) => {
          const match = line.match(/^\d+\s+(blob|tree|commit)\s+[0-9a-f]+\t([\s\S]+)$/);
          return match ? `${match[2]}${match[1] === "tree" ? "/" : ""}` : line;
        });
        return entries.join("\n") || "(empty)";
      }
      const abs = safePath(cwd, p || ".");
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .slice(0, LIST_MAX)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return entries.join("\n") || "(empty)";
    }
  };

  const schemas = [
    { type: "function", function: { name: "read_file", description: "Read a file in the repository (read-only).", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "1-based start line (optional)" }, limit: { type: "integer", description: "max lines (optional)" } }, required: ["path"] } } },
    { type: "function", function: { name: "grep", description: "Search the repository with git grep (read-only).", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "optional path/pathspec to limit the search" } }, required: ["pattern"] } } },
    { type: "function", function: { name: "glob", description: "List repository files matching a git pathspec.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
    { type: "function", function: { name: "list_dir", description: "List entries in a repository directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }
  ];

  async function execute(name, args) {
    const fn = tools[name];
    if (!fn) throw new Error(`unknown tool: ${name}`);
    return String(await fn(args || {}));
  }

  return { schemas, execute };
}
