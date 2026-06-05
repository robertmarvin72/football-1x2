// Run with: node backtest.js
// Requires Node.js 18+ (uses built-in fetch) and package.json "type":"module".

import { apiFetch, buildTeamStats, slugify } from './apiAdapter.js';
import { predictFixture } from './predict.js';

const COMPETITION = 'ELC';
const SEASON = '2025';
const MIN_PRIOR = 5;

// ── helpers ──────────────────────────────────────────────────────────────────

function buildIdToSlug(matches) {
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.homeTeam.id)) seen.set(m.homeTeam.id, m.homeTeam.shortName || m.homeTeam.name);
    if (!seen.has(m.awayTeam.id)) seen.set(m.awayTeam.id, m.awayTeam.shortName || m.awayTeam.name);
  }
  return new Map([...seen.entries()].map(([id, name]) => [id, slugify(name)]));
}

// Dynamic league table from matches played before a cutoff date.
// Returns Map<numericTeamId, position (1-based)>.
function buildStandings(priorMatches) {
  const pts = new Map();
  for (const m of priorMatches) {
    const hg = m.score.fullTime.home;
    const ag = m.score.fullTime.away;
    if (hg === null || ag === null) continue;
    if (!pts.has(m.homeTeam.id)) pts.set(m.homeTeam.id, 0);
    if (!pts.has(m.awayTeam.id)) pts.set(m.awayTeam.id, 0);
    if (hg > ag)      pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 3);
    else if (hg === ag) {
      pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 1);
      pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 1);
    } else            pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 3);
  }
  const sorted = [...pts.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([id], i) => [id, i + 1]));
}

function priorMatchCount(teamId, priorMatches) {
  return priorMatches.filter(
    m => (m.homeTeam.id === teamId || m.awayTeam.id === teamId)
      && m.score.fullTime.home !== null
      && m.score.fullTime.away !== null
  ).length;
}

function actualOutcome(match) {
  const hg = match.score.fullTime.home;
  const ag = match.score.fullTime.away;
  if (hg > ag)  return "1";
  if (hg === ag) return "X";
  return "2";
}

function pct(n, d) {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching finished ${COMPETITION} ${SEASON} matches…`);
  const raw = await apiFetch(`/competitions/${COMPETITION}/matches?status=FINISHED&season=${SEASON}`);
  const allFinished = raw.matches
    .filter(m => m.score.fullTime.home !== null && m.score.fullTime.away !== null)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  console.log(`Fetched ${allFinished.length} completed matches.\n`);

  const idToSlug = buildIdToSlug(allFinished);

  let evaluated = 0;
  let skipped   = 0;
  let hits      = 0;

  const byConf = {
    High:   { total: 0, correct: 0 },
    Medium: { total: 0, correct: 0 },
    Low:    { total: 0, correct: 0 }
  };
  const byPick = {
    "1": { total: 0, correct: 0 },
    "X": { total: 0, correct: 0 },
    "2": { total: 0, correct: 0 }
  };

  for (const match of allFinished) {
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;

    if (!idToSlug.has(homeId) || !idToSlug.has(awayId)) { skipped++; continue; }

    const matchDate   = new Date(match.utcDate);
    const priorMatches = allFinished.filter(m => new Date(m.utcDate) < matchDate);

    if (priorMatchCount(homeId, priorMatches) < MIN_PRIOR ||
        priorMatchCount(awayId, priorMatches) < MIN_PRIOR) {
      skipped++;
      continue;
    }

    const posMap   = buildStandings(priorMatches);
    const homeSlug = idToSlug.get(homeId);
    const awaySlug = idToSlug.get(awayId);

    const homeTeam = {
      id:       homeSlug,
      name:     match.homeTeam.shortName || match.homeTeam.name,
      league:   'Championship',
      position: posMap.get(homeId) ?? 12,
      ...buildTeamStats(homeId, priorMatches, matchDate)
    };
    const awayTeam = {
      id:       awaySlug,
      name:     match.awayTeam.shortName || match.awayTeam.name,
      league:   'Championship',
      position: posMap.get(awayId) ?? 12,
      ...buildTeamStats(awayId, priorMatches, matchDate)
    };

    const fixture  = { id: match.id, league: 'Championship', home: homeSlug, away: awaySlug };
    const teamById = { [homeSlug]: homeTeam, [awaySlug]: awayTeam };

    const prediction = predictFixture(fixture, teamById);
    const actual     = actualOutcome(match);
    const correct    = prediction.pick === actual;

    evaluated++;
    if (correct) hits++;

    byConf[prediction.confidence].total++;
    if (correct) byConf[prediction.confidence].correct++;

    byPick[prediction.pick].total++;
    if (correct) byPick[prediction.pick].correct++;
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`Total fixtures evaluated: ${evaluated}`);
  console.log(`Skipped (insufficient data): ${skipped}`);
  console.log(`Hit rate: ${pct(hits, evaluated)} (correct 1/X/2)`);
  console.log('By confidence:');
  console.log(`  High:   ${byConf.High.correct}/${byConf.High.total} (${pct(byConf.High.correct, byConf.High.total)})`);
  console.log(`  Medium: ${byConf.Medium.correct}/${byConf.Medium.total} (${pct(byConf.Medium.correct, byConf.Medium.total)})`);
  console.log(`  Low:    ${byConf.Low.correct}/${byConf.Low.total} (${pct(byConf.Low.correct, byConf.Low.total)})`);
  console.log('By outcome type:');
  console.log(`  Home wins predicted: ${byPick["1"].correct}/${byPick["1"].total} (${pct(byPick["1"].correct, byPick["1"].total)})`);
  console.log(`  Draws predicted:     ${byPick["X"].correct}/${byPick["X"].total} (${pct(byPick["X"].correct, byPick["X"].total)})`);
  console.log(`  Away wins predicted: ${byPick["2"].correct}/${byPick["2"].total} (${pct(byPick["2"].correct, byPick["2"].total)})`);
}

main().catch(err => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
