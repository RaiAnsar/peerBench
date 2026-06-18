// global-hooks/reviewers.mjs
import { parseVerdict } from "./panel-lib.mjs";
import { resolveConfig } from "./config-store.mjs";
import { review as defaultReview } from "./review-client.mjs";
const NAMES = { kimi: "Kimi", mimo: "MiMo" };
const STRICT = "\n\nIMPORTANT: respond with ONLY a first line of `ALLOW: <reason>` or `BLOCK: <reason>`. No preamble, no code fences.";

// Scan EVERY line (skip filler / code-fence / blank) for the first ALLOW:/BLOCK: line.
export function extractVerdict(text) {
  const s = String(text ?? "").trim();
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("ALLOW:") || t.startsWith("BLOCK:")) return parseVerdict(s.slice(s.indexOf(line)));
    // else: filler/fence/blank — keep scanning
  }
  return null;
}

// NOTE (v1 limitation): parallel Kimi+MiMo calls fail-fast on rate limits; no backoff/retry beyond the one verdict-format retry below.
export function resolveReviewers({ env = process.env, reviewImpl = defaultReview } = {}) {
  const cfg = resolveConfig({ env });
  return cfg.reviewers.map((name) => {
    const p = cfg.providers[name];
    const display = NAMES[name] || name;
    return {
      name,
      async run({ system, user }) {
        if (!p.apiKey) return { name: display, error: "no api key" };
        const call = (u) => reviewImpl({ baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, system, user: u });
        let r = await call(user);
        if (!r.ok) return { name: display, error: `${r.error.kind}: ${r.error.detail}` };
        let v = extractVerdict(r.text), raw = r.text;
        if (!v) { r = await call(user + STRICT); if (r.ok) { v = extractVerdict(r.text); raw = r.text; } }
        if (!v) return { name: display, error: "unparseable verdict", raw };
        return { name: display, verdict: v.verdict, firstLine: v.firstLine, raw, model: p.model, usage: r.usage ?? null };
      }
    };
  });
}
