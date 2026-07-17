#!/usr/bin/env node
// Load reviewer provider secrets/config from the git-ignored .keys file into the shared
// companion.json, so the gates/hunt pick them up (config-store reads env first, then companion.json).
// Idempotent: re-run whenever .keys changes. Never prints key VALUES.
//
//   node scripts/load-keys.mjs [path/to/.keys]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDir, sharedRoot, PROVIDER_NAMES, writePrivateFileAtomic } from "../global-hooks/config-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keysPath = process.argv[2] || path.join(ROOT, ".keys");

// Parse simple KEY=VALUE lines (ignore blanks and # comments).
function parseKeys(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const PROVIDERS = PROVIDER_NAMES;   // derived from config-store DEFAULTS — adding a model needs no edit here
function buildProvider(env, name) {
  const P = name.toUpperCase();
  const out = {};
  if (env[`${P}_BASE_URL`]) out.baseURL = env[`${P}_BASE_URL`];
  if (env[`${P}_MODEL`]) out.model = env[`${P}_MODEL`];
  if (env[`${P}_API_KEY`]) {
    // <NAME>_API_KEY may be a comma-separated POOL (z.ai concurrency cap is per-key). Keep apiKey as
    // the first for back-compat/display; add apiKeys when there's more than one.
    const keys = env[`${P}_API_KEY`].split(",").map((s) => s.trim()).filter(Boolean);
    out.apiKey = keys[0];
    if (keys.length > 1) out.apiKeys = keys;
  }
  const temp = env[`${P}_TEMPERATURE`];
  if (temp !== undefined && temp !== "" && Number.isFinite(Number(temp))) out.temperature = Number(temp);
  if (env[`${P}_THINKING`] !== undefined) out.thinking = env[`${P}_THINKING`];
  if (env[`${P}_USER_AGENT`]) out.headers = { "User-Agent": env[`${P}_USER_AGENT`] };
  return out;
}

let text;
try { text = fs.readFileSync(keysPath, "utf8"); } catch {
  console.error(`load-keys: cannot read ${keysPath}`);
  process.exit(1);
}
const env = parseKeys(text);
const file = path.join(sharedRoot(), "companion.json");
let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cur = {}; }
cur.providers = cur.providers || {};

// The scalar fields load-keys OWNS (sourced from .keys). On reload these are cleared-then-set from
// .keys, so dropping a .keys override (e.g. KIMI_TEMPERATURE when K3 requires omitting it) actually
// takes effect — a plain merge kept the stale value alive forever. Fields NOT listed (timeoutMs,
// concurrencyPerKey) are PRESERVED. `headers` is handled separately: load-keys only sets the
// User-Agent from <NAME>_USER_AGENT, so it's MERGED over any custom companion headers, not replaced.
const MANAGED_FIELDS = ["baseURL", "model", "apiKey", "apiKeys", "temperature", "thinking"];

const loaded = [];
for (const name of PROVIDERS) {
  const p = buildProvider(env, name);
  if (p.apiKey) {
    const preserved = { ...cur.providers[name] };
    for (const f of MANAGED_FIELDS) delete preserved[f];        // clear stale managed scalars, keep the rest
    const headers = { ...(preserved.headers || {}), ...(p.headers || {}) };   // preserve custom headers, overlay .keys UA
    cur.providers[name] = { ...preserved, ...p, ...(Object.keys(headers).length ? { headers } : {}) };
    loaded.push(name);
  } else if (cur.providers[name]) {
    // Provider dropped from .keys entirely: strip the managed fields too, so a rotated-out or
    // compromised key goes dead instead of staying live in companion.json. Unmanaged fields and
    // custom headers are preserved, same as the reload path above.
    for (const f of MANAGED_FIELDS) delete cur.providers[name][f];
  }
}

ensurePrivateDir(sharedRoot());
writePrivateFileAtomic(file, `${JSON.stringify(cur, null, 2)}\n`);
console.log(`load-keys: wrote providers to companion.json → ${loaded.join(", ") || "(none found)"} (key values redacted)`);
