// global-hooks/deep-review.mjs
// Shared PURE helpers for the deep spec/plan/push review — severity parsing, the (path,content)
// dedup key, result summarization, and the rewake threshold. The delivery mechanism (queue +
// asyncRewake Stop runner) lives in deep-queue.mjs + deep-review-runner.mjs; the old detached
// deep-result file channel + debounce markers were retired (they could never wake an idle agent).
import { createHash } from "node:crypto";

// Severity ladder — higher rank is more severe. Unknown/none → 0.
export const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Surface deep findings as a REWAKE (exit 2) when at/above this severity, or when there
// is at least one finding from a BLOCK verdict. Tunable in one place.
export const DEEP_REWAKE_SEVERITY = "high";

export function contentHash(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex").slice(0, 16);
}

// FIX 4: the deep debounce/result key. Keyed on (filePath, content) so two DIFFERENT
// spec files with byte-identical content do NOT collide (which would skip the second
// deep pass and clobber the first's result file). Use this everywhere a deep key is
// derived (launch debounce, the result hash, and the stale-check).
export function deepKey(filePath, content) {
  return contentHash(`${String(filePath)} ${String(content)}`);
}

export function severityRank(sev) {
  return SEVERITY_RANK[String(sev ?? "none").toLowerCase()] ?? 0;
}

// Extract the worst severity a reviewer declared from its raw text. Mirrors the
// severity logic in hunt.parseSpecFindings so the fast plan/spec gates and the deep
// pass read severity identically. A `SEVERITY: <x>` line wins; otherwise a BLOCK with
// no SEVERITY line defaults to "high" (safe — a BLOCK is treated as a real blocker),
// and a non-BLOCK with no line is "none". `verdict` is the already-parsed ALLOW/BLOCK.
export function parseSeverity(raw, verdict) {
  const s = String(raw ?? "");
  // Worst-wins: scan ALL line-start SEVERITY tokens and take the max-rank one, so a
  // genuine high/critical can never be silently downgraded by an earlier echoed/intermediate
  // `SEVERITY: none|low|medium` line (honors the "worst severity declared" contract).
  const matches = [...s.matchAll(/^\s*SEVERITY:\s*(none|low|medium|high|critical)\b/gim)];
  if (matches.length) {
    let best = "none";
    for (const m of matches) {
      if (severityRank(m[1]) > severityRank(best)) best = m[1].toLowerCase();
    }
    return best;
  }
  return verdict === "BLOCK" ? "high" : "none";
}

// Aggregate per-reviewer spec-review results into the machine-readable contract
// used by the surfacing gate. results: [{ name, verdict, findingCount, severity }]
export function summarizeSpecReview(results) {
  const list = Array.isArray(results) ? results : [];
  // Carry per-reviewer severity so the surfaced badge + statusline can render a
  // sub-threshold BLOCK as `~` (advisory) rather than the alarming `✗`.
  const reviewers = list.map((r) => ({ name: r.name, verdict: r.verdict ?? null, severity: r.severity ?? null }));
  const findingCount = list.reduce((n, r) => n + (Number(r.findingCount) || 0), 0);
  let maxSeverity = "none";
  for (const r of list) {
    if (severityRank(r.severity) > severityRank(maxSeverity)) maxSeverity = String(r.severity).toLowerCase();
  }
  return { reviewers, findingCount, maxSeverity };
}

// True when a deep result should rewake (exit 2) rather than just surface a note.
export function shouldRewake({ maxSeverity, findingCount } = {}) {
  return severityRank(maxSeverity) >= severityRank(DEEP_REWAKE_SEVERITY) && (Number(findingCount) || 0) > 0;
}

// Aggregate the per-reviewer `findings` of every BLOCKING reviewer into one string for delivery.
// NOTE: deep-panel result objects (hunt.mjs) carry `findings` (NOT `raw`/`firstLine`), so this does
// NOT route through combinePanel — it joins the blocking reviewers' `findings` directly.
export function aggregateFindings(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => String(r.verdict).toUpperCase() === "BLOCK")
    .map((r) => `[${r.name}]\n${String(r.findings || "").trim()}`)
    .join("\n\n")
    .trim();
}
