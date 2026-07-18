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

// The deep dedup / content key. Keyed on (filePath, content) so two DIFFERENT spec files with
// byte-identical content do NOT collide.
//
// CRITICAL invariant (2026-06-22): the spec contentKey must be keyed on the FULL file content —
// the SAME bytes the deep review (`runSpecReview` → `panelImpl`) actually evaluates — and computed
// the SAME way at enqueue (plan-file gate), at the run, and at the retire-check
// (deep-queue.currentContentKey). Do NOT cap the key independently of what the review reads:
//   - capping at enqueue but not at recompute → a large spec is falsely seen as "changed" → its
//     `.blocked` HIGH block is wrongly RETIRED (first stop-gate finding);
//   - capping the key but reviewing full → an edit beyond the cap changes the reviewed content but
//     not the key → a stale review is deduped / a stale `.blocked` stays "current" (pre-push finding).
// So: `deepKey(filePath, fullContent)` everywhere a spec key is derived.
export function deepKey(filePath, content) {
  return contentHash(`${String(filePath)} ${String(content)}`);
}

export function severityRank(sev) {
  return SEVERITY_RANK[String(sev ?? "none").toLowerCase()] ?? 0;
}

// Strip a reviewer's private <think>…</think> reasoning. Its verdict/severity/findings must come
// from the FINAL answer only — reasoning routinely echoes "Severity: high" while the actual verdict
// is ALLOW/low, which used to inflate the computed severity and fire false blocks.
export const stripThink = (s) => String(s ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "");

// Highest severity strictly BELOW the rewake floor (e.g. "medium" when the floor is "high"). A clean
// ALLOW is capped here so it stays advisory and can never trip a block on its own.
const SEVERITY_BELOW_FLOOR = Object.entries(SEVERITY_RANK)
  .filter(([, r]) => r < severityRank(DEEP_REWAKE_SEVERITY))
  .sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

// Extract the worst severity a reviewer declared from its raw text. Mirrors the
// severity logic in hunt.parseSpecFindings so the fast plan/spec gates and the deep
// pass read severity identically. A `SEVERITY: <x>` line wins; otherwise a BLOCK with
// no SEVERITY line defaults to "high" (safe — a BLOCK is treated as a real blocker),
// and a non-BLOCK with no line is "none". `verdict` is the already-parsed ALLOW/BLOCK.
export function parseSeverity(raw, verdict) {
  const s = stripThink(raw);   // ignore <think> reasoning — only the final answer counts
  // Worst-wins: scan ALL line-start SEVERITY tokens and take the max-rank one, so a
  // genuine high/critical can never be silently downgraded by an earlier echoed/intermediate
  // `SEVERITY: none|low|medium` line (honors the "worst severity declared" contract).
  const matches = [...s.matchAll(/^\s*SEVERITY:\s*(none|low|medium|high|critical)\b/gim)];
  let sev = "none";
  if (matches.length) {
    for (const m of matches) if (severityRank(m[1]) > severityRank(sev)) sev = m[1].toLowerCase();
  } else {
    sev = verdict === "BLOCK" ? "high" : "none";
  }
  // A clean ALLOW is a decision NOT to block — keep its severity advisory (below the rewake floor)
  // so `ALLOW: fine … SEVERITY: critical` cannot fire a false block. Only BLOCK drives real blocks.
  if (String(verdict).toUpperCase() === "ALLOW" && severityRank(sev) >= severityRank(DEEP_REWAKE_SEVERITY)) {
    sev = SEVERITY_BELOW_FLOOR;
  }
  return sev;
}

// Aggregate per-reviewer spec-review results into the machine-readable contract
// used by the surfacing gate. results: [{ name, verdict, findingCount, severity }]
export function summarizeSpecReview(results) {
  const list = Array.isArray(results) ? results : [];
  // Carry per-reviewer severity so the surfaced badge + statusline can render a
  // sub-threshold BLOCK as `~` (advisory) rather than the alarming `✗`. Errors
  // are part of the durable result contract too: dropping them made an all-error
  // panel indistinguishable from a clean review once only the summary survived.
  const reviewers = list.map((r) => ({
    name: r.name,
    verdict: r.verdict ?? null,
    severity: r.severity ?? null,
    error: r.error ?? null,
    ...(r.coverageComplete === false ? {
      coverageComplete: false,
      coverageError: r.coverageError || r.error || "incomplete bounded review coverage"
    } : {})
  }));
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

// Aggregate the per-reviewer `findings` that CAUSED the block into one string for delivery.
// Must mirror shouldRewake's criterion (severity ≥ DEEP_REWAKE_SEVERITY), NOT just verdict==BLOCK:
// a reviewer that writes `ALLOW: <none>` + `SEVERITY: critical` blocks the turn but has a non-BLOCK
// verdict, so keying on verdict alone returned "" and the wake delivered a bare count while the real
// findings sat unread in the trace's rawResponses. Include a reviewer on a BLOCK verdict OR a declared
// severity at/above the floor. NOTE: deep-panel results carry `findings` (not raw/firstLine).
export function aggregateFindings(results, minSeverity = DEEP_REWAKE_SEVERITY) {
  const floor = severityRank(minSeverity);
  return (Array.isArray(results) ? results : [])
    .filter((r) => String(r.verdict).toUpperCase() === "BLOCK" || severityRank(r.severity) >= floor)
    .map((r) => `[${r.name}]\n${String(r.findings || "").trim()}`)
    .join("\n\n")
    .trim();
}
