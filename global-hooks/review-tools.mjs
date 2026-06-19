import fs from "node:fs";
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

export function createReviewTools(cwd, { execImpl = spawnSync } = {}) {
  const git = (argv) => execImpl("git", argv, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

  const tools = {
    read_file({ path: p, offset, limit }) {
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
      if (p) safePath(cwd, p);
      const r = git(["grep", "-n", "-I", "--no-color", "-e", String(pattern), ...(p ? ["--", p] : [])]);
      if (r.status !== 0 && !r.stdout) return r.status === 1 ? "(no matches)" : `grep error: ${(r.stderr || "").slice(0, 200)}`;
      const lines = String(r.stdout).split(/\r?\n/).filter(Boolean);
      const shown = lines.slice(0, GREP_MAX_LINES).join("\n");
      return lines.length > GREP_MAX_LINES ? `${shown}\n…[${lines.length - GREP_MAX_LINES} more matches]` : (shown || "(no matches)");
    },
    glob({ pattern }) {
      const r = git(["ls-files", "--", pattern || "*"]);
      const files = String(r.stdout || "").split(/\r?\n/).filter(Boolean);
      const shown = files.slice(0, GLOB_MAX).join("\n");
      return files.length > GLOB_MAX ? `${shown}\n…[${files.length - GLOB_MAX} more files]` : (shown || "(no files)");
    },
    list_dir({ path: p }) {
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
