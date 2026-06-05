// tune_draw.js — one-shot calibration script. Delete after use.
// Fetches ELC 2025 data, computes sigmoid input distributions,
// then binary-searches for `a` (given b, c) so mean p_draw ≈ 0.27.
// Usage: node tune_draw.js

import { apiFetch, buildTeamStats, slugify } from './apiAdapter.js';
import { formScore, clamp } from './predict.js';

const COMPETITION = 'ELC';
const SEASON      = '2025';
const MIN_PRIOR   = 5;
const TARGET      = 0.27;

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function buildIdToSlug(matches) {
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.homeTeam.id)) seen.set(m.homeTeam.id, m.homeTeam.shortName || m.homeTeam.name);
    if (!seen.has(m.awayTeam.id)) seen.set(m.awayTeam.id, m.awayTeam.shortName || m.awayTeam.name);
  }
  return new Map([...seen.entries()].map(([id, name]) => [id, slugify(name)]));
}

function buildStandings(prior) {
  const pts = new Map();
  for (const m of prior) {
    const hg = m.score.fullTime.home, ag = m.score.fullTime.away;
    if (hg === null || ag === null) continue;
    if (!pts.has(m.homeTeam.id)) pts.set(m.homeTeam.id, 0);
    if (!pts.has(m.awayTeam.id)) pts.set(m.awayTeam.id, 0);
    if (hg > ag)       pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 3);
    else if (hg === ag){ pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 1);
                         pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 1); }
    else               pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 3);
  }
  return new Map([...pts.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]));
}

function priorCount(id, prior) {
  return prior.filter(m => (m.homeTeam.id === id || m.awayTeam.id === id) && m.score.fullTime.home !== null).length;
}

// Replicate predict.js score formula — must stay in sync if predict.js home/away weights change.
function computeStrengthGap(home, away) {
  const hf = formScore(home), af = formScore(away);
  const tdH = clamp((away.position - home.position) / 3, -4, 4);
  const tdA = clamp((home.position - away.position) / 3, -4, 4);
  const reH = clamp((home.restDays - away.restDays) * 0.35, -1.5, 1.5);
  const reA = clamp((away.restDays - home.restDays) * 0.35, -1.5, 1.5);

  const hs = hf*0.9 + home.homePointsPerGame*2.4 + home.goalsForPerGame*1.9
           + away.goalsAgainstPerGame*1.4 + tdH + reH + 2.1;
  const as_ = af*0.9 + away.awayPointsPerGame*2.4 + away.goalsForPerGame*1.9
            + home.goalsAgainstPerGame*1.4 + tdA + reA;

  return Math.abs(hs - as_);
}

async function main() {
  process.stdout.write('Fetching data… ');
  const raw = await apiFetch(`/competitions/${COMPETITION}/matches?status=FINISHED&season=${SEASON}`);
  const all = raw.matches
    .filter(m => m.score.fullTime.home !== null && m.score.fullTime.away !== null)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  console.log(`${all.length} matches`);

  const id2slug = buildIdToSlug(all);
  const inputs  = [];

  for (const match of all) {
    const hId = match.homeTeam.id, aId = match.awayTeam.id;
    if (!id2slug.has(hId) || !id2slug.has(aId)) continue;
    const dt    = new Date(match.utcDate);
    const prior = all.filter(m => new Date(m.utcDate) < dt);
    if (priorCount(hId, prior) < MIN_PRIOR || priorCount(aId, prior) < MIN_PRIOR) continue;

    const pos   = buildStandings(prior);
    const hTeam = { id: id2slug.get(hId), position: pos.get(hId) ?? 12, ...buildTeamStats(hId, prior, dt) };
    const aTeam = { id: id2slug.get(aId), position: pos.get(aId) ?? 12, ...buildTeamStats(aId, prior, dt) };

    const gap = computeStrengthGap(hTeam, aTeam);
    const eg  = hTeam.goalsForPerGame + aTeam.goalsForPerGame;

    inputs.push({
      avgDrawRate:  (hTeam.drawRate + aTeam.drawRate) / 2,
      closeness:    1 / (1 + gap),
      lowGoalGame:  eg < 2.7 ? 1 : 0,
    });
  }

  const n   = inputs.length;
  const eDR = inputs.reduce((s, x) => s + x.avgDrawRate, 0) / n;
  const eCL = inputs.reduce((s, x) => s + x.closeness,   0) / n;
  const eLG = inputs.reduce((s, x) => s + x.lowGoalGame, 0) / n;

  console.log(`\nn = ${n}`);
  console.log(`E[avgDrawRate]  = ${eDR.toFixed(4)}`);
  console.log(`E[closeness]    = ${eCL.toFixed(4)}   (1 / (1 + strengthGap))`);
  console.log(`E[lowGoalGame]  = ${eLG.toFixed(4)}   (fraction of low-goal matches)`);

  function meanPD(a, b, c) {
    return inputs.reduce((s, x) => s + sigmoid(a * x.avgDrawRate + b * x.closeness + c * x.lowGoalGame), 0) / n;
  }

  // For each (b, c) candidate, binary-search for a that hits TARGET
  function findA(b, c, tol = 1e-6) {
    let lo = -50, hi = 50;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      meanPD(mid, b, c) > TARGET ? (lo = mid) : (hi = mid);
      if (hi - lo < tol) break;
    }
    return (lo + hi) / 2;
  }

  console.log('\n--- Candidate constants (b, c fixed; a binary-searched) ---');
  const candidates = [
    { b: 2.0, c: 0.5 },
    { b: 2.0, c: 1.0 },
    { b: 3.0, c: 0.5 },
    { b: 1.5, c: 0.5 },
  ];
  for (const { b, c } of candidates) {
    const a    = findA(b, c);
    const mean = meanPD(a, b, c);
    // Compute p_draw range: 5th / 95th percentile
    const pds  = inputs.map(x => sigmoid(a * x.avgDrawRate + b * x.closeness + c * x.lowGoalGame)).sort((a, b) => a - b);
    const p5   = pds[Math.floor(n * 0.05)];
    const p95  = pds[Math.floor(n * 0.95)];
    console.log(`  b=${b.toFixed(1)}, c=${c.toFixed(1)} → a=${a.toFixed(3)}   mean=${mean.toFixed(4)}   p5..p95=[${p5.toFixed(3)},${p95.toFixed(3)}]`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
