#!/usr/bin/env node
// Load reviewer provider secrets/config from the git-ignored .keys file into the shared
// companion.json, so the gates/hunt pick them up (config-store reads env first, then companion.json).
// Idempotent: re-run whenever .keys changes. Never prints key VALUES.
//
//   node scripts/load-keys.mjs [path/to/.keys]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedRoot, PROVIDER_NAMES } from "../global-hooks/config-store.mjs";

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
  if (env[`${P}_API_KEY`]) out.apiKey = env[`${P}_API_KEY`];
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

const loaded = [];
for (const name of PROVIDERS) {
  const p = buildProvider(env, name);
  if (p.apiKey) { cur.providers[name] = { ...cur.providers[name], ...p }; loaded.push(name); }
}

fs.mkdirSync(sharedRoot(), { recursive: true });
const tmp = `${file}.tmp.${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`);
fs.renameSync(tmp, file);
console.log(`load-keys: wrote providers to companion.json → ${loaded.join(", ") || "(none found)"} (key values redacted)`);
