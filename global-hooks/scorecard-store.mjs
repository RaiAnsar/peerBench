// global-hooks/scorecard-store.mjs
// Reviewer performance scorecard — two layers:
//   1) AUTO layer: objective stats scanned from every per-workspace trace under sharedRoot/state
//      (participation, error/quota rate, blocks, UNIQUE blocks — blocked when no one else did).
//   2) JUDGMENT layer: TP/FP/miss grades appended by Claude after VERIFYING findings, so a
//      "unique block" becomes a confirmed catch or a false alarm. Append-only event log;
//      aggregates are computed on read (never stored stale).
// Cross-project by construction: it reads the shared root, so `bench grade` from ANY project
// updates one global scorecard.
import fs from "node:fs";
import path from "node:path";
import { sharedRoot, PROVIDER_NAMES, displayName } from "./config-store.mjs";

const TRACE_RE = /^\d+-[0-9a-f]+\.json$/i;
const GRADES = ["tp", "fp", "miss"];
const norm = (s) => String(s ?? "").trim();
const upper = (s) => norm(s).toUpperCase();

// Canonicalize a reviewer name to ONE display form (derived from config-store), so historical
// traces that stored a different case ("glm" vs "GLM") don't split into two scorecard rows.
const CANON = (() => {
  const map = {};
  for (const id of [...PROVIDER_NAMES, "codex"]) { const d = displayName(id); map[id.toLowerCase()] = d; map[d.toLowerCase()] = d; }
  return map;
})();
const canon = (name) => CANON[norm(name).toLowerCase()] || norm(name);
const scorecardFile = (root) => path.join(root || sharedRoot(), "scorecard.json");

export function loadScorecard({ root } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(scorecardFile(root), "utf8"));
    return { events: Array.isArray(j.events) ? j.events : [] };
  } catch { return { events: [] }; }
}

// Append one judgment-layer grade. Atomic. grade ∈ {tp,fp,miss}.
export function recordGrade({ traceId, reviewer, grade, note = "", ws = null, gate = null }, { root, now } = {}) {
  const g = norm(grade).toLowerCase();
  if (!GRADES.includes(g)) throw new Error(`grade must be one of ${GRADES.join("|")}, got '${grade}'`);
  if (!norm(reviewer)) throw new Error("reviewer is required");
  const r = root || sharedRoot();
  const file = scorecardFile(r);
  const cur = loadScorecard({ root: r });
  const ts = now ?? Date.now();
  const event = {
    id: `${ts}-${cur.events.length}`, ts,
    traceId: norm(traceId) || null, ws: ws || null, gate: gate || null,
    reviewer: norm(reviewer), grade: g, note: norm(note), by: "claude"
  };
  cur.events.push(event);
  fs.mkdirSync(r, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ events: cur.events }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return event;
}

// AUTO layer — scan all per-workspace traces. Keyed by reviewer DISPLAY name (as stored on traces).
export function autoStatsFromTraces({ root } = {}) {
  const stateDir = path.join(root || sharedRoot(), "state");
  const models = {};
  const ensure = (n) => (models[n] ||= { name: n, participated: 0, verdicts: 0, errors: 0, blocks: 0, uniqueBlocks: 0 });
  let dirs = [];
  try { dirs = fs.readdirSync(stateDir); } catch { return models; }
  for (const d of dirs) {
    const td = path.join(stateDir, d, "traces");
    let files = [];
    try { files = fs.readdirSync(td).filter((f) => TRACE_RE.test(f)); } catch { continue; }
    for (const f of files) {
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(td, f), "utf8")); } catch { continue; }
      if (!Array.isArray(t.reviewers)) continue;
      for (const rv of t.reviewers) {
        const m = ensure(canon(rv.name) || "?");
        m.participated++;
        if (rv.error) { m.errors++; continue; }
        if (rv.verdict) {
          m.verdicts++;
          if (upper(rv.verdict) === "BLOCK") {
            m.blocks++;
            const others = t.reviewers.filter((x) => x !== rv);
            // unique = it blocked and NO other reviewer in the same panel blocked (its marginal value)
            if (others.length && !others.some((x) => upper(x.verdict) === "BLOCK")) m.uniqueBlocks++;
          }
        }
      }
    }
  }
  return models;
}

// Transparent starting rubric (tunable). Reliability + verified precision + confirmed unique value.
export function letterGrade(m) {
  if (!m.participated) return "—";
  let score = 0;
  if (m.errorRate <= 0.02) score += 2; else if (m.errorRate <= 0.10) score += 1;           // reliability
  if (m.precision != null) {                                                                  // verified precision
    if (m.precision >= 0.9) score += 2; else if (m.precision >= 0.6) score += 1; else score -= 1;
  }
  if (m.uniqueBlocks > 0 && (m.precision == null || m.precision >= 0.5)) score += 1;          // confirmed unique value
  return score >= 4 ? "A" : score >= 3 ? "B" : score >= 2 ? "C" : score >= 1 ? "D" : "F";
}

// Merge both layers → per-model aggregate with derived precision/grade.
export function computeScorecard({ root, now } = {}) {
  const models = autoStatsFromTraces({ root });
  const ensure = (n) => (models[n] ||= { name: n, participated: 0, verdicts: 0, errors: 0, blocks: 0, uniqueBlocks: 0 });
  const { events } = loadScorecard({ root });
  for (const e of events) {
    const m = ensure(canon(e.reviewer));
    m.tp ||= 0; m.fp ||= 0; m.miss ||= 0;
    if (e.grade === "tp") m.tp++; else if (e.grade === "fp") m.fp++; else if (e.grade === "miss") m.miss++;
  }
  for (const m of Object.values(models)) {
    m.tp ||= 0; m.fp ||= 0; m.miss ||= 0;
    m.errorRate = m.participated ? m.errors / m.participated : 0;
    const graded = m.tp + m.fp;
    m.precision = graded ? m.tp / graded : null;   // null = not yet graded
    m.grade = letterGrade(m);
  }
  return { models, gradedEvents: events.length, generatedAt: now ?? null };
}

// Pure renderer for `/bench:scorecard`.
export function renderScorecard(card) {
  const rows = Object.values(card.models).sort((a, b) => b.participated - a.participated);
  if (!rows.length) return "⛩ Reviewer scorecard: no traces yet.";
  const pct = (x) => `${Math.round(x * 100)}%`;
  const prec = (p) => (p == null ? "—" : pct(p));
  const head = ["model", "reviews", "err%", "blocks", "uniq", "TP", "FP", "miss", "prec", "grade"];
  const data = rows.map((m) => [
    m.name, String(m.participated), pct(m.errorRate), String(m.blocks),
    String(m.uniqueBlocks), String(m.tp), String(m.fp), String(m.miss), prec(m.precision), m.grade
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  const lines = [
    `⛩ Reviewer scorecard (auto from traces + ${card.gradedEvents} graded finding${card.gradedEvents === 1 ? "" : "s"})`,
    fmt(head), fmt(w.map((n) => "─".repeat(n))), ...data.map(fmt),
    `uniq = blocked when NO other reviewer did · prec = TP/(TP+FP) once graded · grade is a tunable rubric`
  ];
  return lines.join("\n");
}
