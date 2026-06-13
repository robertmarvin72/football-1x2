// Run with: node backtest.js [options]
// Requires Node.js 18+ and package.json "type":"module".
//
// Options:
//   --source api|historical   default: api
//   --league PL|ELC           historical only; default: both leagues
//   --seasons 2023-24,2024-25 historical only; default: all five seasons
//
// Examples:
//   node backtest.js
//   node backtest.js --source historical
//   node backtest.js --source historical --league PL
//   node backtest.js --source historical --league ELC --seasons 2023-24,2024-25

import { apiFetch, buildTeamStats, slugify } from './apiAdapter.js';
import { predictFixture } from './predict.js';
import { getRecentHistoricalFixtures } from './historicalData.js';
import {
  buildHistoricalStandings,
  historicalOutcome,
  buildHistoricalTeamStats,
} from './historicalStats.js';

const API_COMPETITION = 'ELC';
const API_SEASON      = '2025';
const MIN_PRIOR       = 5;

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { source: 'api', league: null, seasons: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--source')  result.source  = argv[++i];
    else if (flag === '--league')  result.league  = argv[++i];
    else if (flag === '--seasons') result.seasons = argv[++i].split(',').map(s => s.trim());
  }
  return result;
}

// ── shared helpers ────────────────────────────────────────────────────────────

function pct(n, d) {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

function emptyStats() {
  return { total: 0, correct: 0 };
}

function printReport({ label, evaluated, skipped, hits, byConf, byPick, realDraws }) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Source : ${label}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Fixtures evaluated        : ${evaluated}`);
  console.log(`Skipped (< ${MIN_PRIOR} prior)     : ${skipped}`);
  console.log(`Hit rate                  : ${pct(hits, evaluated)}`);
  console.log('By confidence grade:');
  for (const conf of ['A+', 'A', 'B', 'C', 'D']) {
    const { correct, total } = byConf[conf];
    console.log(`  ${conf.padEnd(3)} ${correct}/${total} (${pct(correct, total)})`);
  }
  console.log('By predicted outcome:');
  console.log(`  Home (1): ${byPick["1"].correct}/${byPick["1"].total} (${pct(byPick["1"].correct, byPick["1"].total)})`);
  console.log(`  Draw (X): ${byPick["X"].correct}/${byPick["X"].total} (${pct(byPick["X"].correct, byPick["X"].total)})`);
  console.log(`  Away (2): ${byPick["2"].correct}/${byPick["2"].total} (${pct(byPick["2"].correct, byPick["2"].total)})`);
  console.log('Draw detection:');
  console.log(`  Real draws in sample    : ${realDraws} / ${evaluated} (${pct(realDraws, evaluated)})`);
  console.log(`  Draws predicted         : ${byPick["X"].total} / ${evaluated} (${pct(byPick["X"].total, evaluated)})`);
  console.log(`  Draw hit rate           : ${pct(byPick["X"].correct, byPick["X"].total)}`);
}

// ── API path helpers ──────────────────────────────────────────────────────────

function buildIdToSlug(matches) {
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.homeTeam.id)) seen.set(m.homeTeam.id, m.homeTeam.shortName || m.homeTeam.name);
    if (!seen.has(m.awayTeam.id)) seen.set(m.awayTeam.id, m.awayTeam.shortName || m.awayTeam.name);
  }
  return new Map([...seen.entries()].map(([id, name]) => [id, slugify(name)]));
}

function buildStandings(priorMatches) {
  const pts = new Map();
  for (const m of priorMatches) {
    const hg = m.score.fullTime.home;
    const ag = m.score.fullTime.away;
    if (hg === null || ag === null) continue;
    if (!pts.has(m.homeTeam.id)) pts.set(m.homeTeam.id, 0);
    if (!pts.has(m.awayTeam.id)) pts.set(m.awayTeam.id, 0);
    if (hg > ag)       pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 3);
    else if (hg === ag) {
      pts.set(m.homeTeam.id, pts.get(m.homeTeam.id) + 1);
      pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 1);
    } else             pts.set(m.awayTeam.id, pts.get(m.awayTeam.id) + 3);
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
  if (hg > ag)  return '1';
  if (hg === ag) return 'X';
  return '2';
}

// ── historical path helpers ───────────────────────────────────────────────────
// buildHistoricalStandings, historicalOutcome, buildHistoricalTeamStats
// are imported from historicalStats.js above.

// ── API backtest ──────────────────────────────────────────────────────────────

async function runApiBacktest() {
  console.log(`Fetching finished ${API_COMPETITION} ${API_SEASON} matches…`);
  const raw = await apiFetch(`/competitions/${API_COMPETITION}/matches?status=FINISHED&season=${API_SEASON}`);
  const allFinished = raw.matches
    .filter(m => m.score.fullTime.home !== null && m.score.fullTime.away !== null)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  console.log(`Fetched ${allFinished.length} completed matches.`);

  const idToSlug = buildIdToSlug(allFinished);
  let evaluated = 0, skipped = 0, hits = 0, realDraws = 0;
  const byConf = { 'A+': emptyStats(), 'A': emptyStats(), 'B': emptyStats(), 'C': emptyStats(), 'D': emptyStats() };
  const byPick = { '1': emptyStats(), 'X': emptyStats(), '2': emptyStats() };

  for (const match of allFinished) {
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;
    if (!idToSlug.has(homeId) || !idToSlug.has(awayId)) { skipped++; continue; }

    const matchDate    = new Date(match.utcDate);
    const priorMatches = allFinished.filter(m => new Date(m.utcDate) < matchDate);

    if (priorMatchCount(homeId, priorMatches) < MIN_PRIOR ||
        priorMatchCount(awayId, priorMatches) < MIN_PRIOR) { skipped++; continue; }

    const posMap    = buildStandings(priorMatches);
    const homeSlug  = idToSlug.get(homeId);
    const awaySlug  = idToSlug.get(awayId);

    const homeTeam = {
      id: homeSlug, name: match.homeTeam.shortName || match.homeTeam.name,
      league: 'Championship', position: posMap.get(homeId) ?? 12,
      ...buildTeamStats(homeId, priorMatches, matchDate)
    };
    const awayTeam = {
      id: awaySlug, name: match.awayTeam.shortName || match.awayTeam.name,
      league: 'Championship', position: posMap.get(awayId) ?? 12,
      ...buildTeamStats(awayId, priorMatches, matchDate)
    };

    const fixture   = { id: match.id, league: 'Championship', home: homeSlug, away: awaySlug };
    const teamById  = { [homeSlug]: homeTeam, [awaySlug]: awayTeam };
    const prediction = predictFixture(fixture, teamById);
    const actual     = actualOutcome(match);
    const correct    = prediction.pick === actual;

    evaluated++;
    if (actual === 'X') realDraws++;
    if (correct) hits++;
    byConf[prediction.confidence].total++;
    if (correct) byConf[prediction.confidence].correct++;
    byPick[prediction.pick].total++;
    if (correct) byPick[prediction.pick].correct++;
  }

  printReport({
    label: `API — ${API_COMPETITION} ${API_SEASON}`,
    evaluated, skipped, hits, byConf, byPick, realDraws
  });
}

// ── historical backtest ───────────────────────────────────────────────────────

async function runHistoricalBacktest({ league, seasons }) {
  const leagueLabel   = league   || 'PL + ELC';
  const seasonsLabel  = seasons  ? seasons.join(', ') : 'all five seasons';
  console.log(`Loading historical data — league: ${leagueLabel}, seasons: ${seasonsLabel}…`);

  const allFixtures = await getRecentHistoricalFixtures({ league, seasons });
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));
  console.log(`Loaded ${allFixtures.length} fixtures.`);

  let evaluated = 0, skipped = 0, hits = 0, realDraws = 0;
  const byConf = { 'A+': emptyStats(), 'A': emptyStats(), 'B': emptyStats(), 'C': emptyStats(), 'D': emptyStats() };
  const byPick = { '1': emptyStats(), 'X': emptyStats(), '2': emptyStats() };
  // diagnostic: drawProb → actual draw rate in each 10-bucket
  const dpBuckets = Array.from({ length: 10 }, () => ({ total: 0, draws: 0 }));

  for (const fixture of allFixtures) {
    const matchDate = new Date(fixture.date);

    // Prior fixtures: same league, same season, earlier date.
    // Same-season scope matches real-world usage: teams start fresh each season.
    const priorFixtures = allFixtures.filter(
      f => new Date(f.date) < matchDate
        && f.league  === fixture.league
        && f.season  === fixture.season
    );

    const homeCount = priorFixtures.filter(
      f => f.homeTeam === fixture.homeTeam || f.awayTeam === fixture.homeTeam
    ).length;
    const awayCount = priorFixtures.filter(
      f => f.homeTeam === fixture.awayTeam || f.awayTeam === fixture.awayTeam
    ).length;

    if (homeCount < MIN_PRIOR || awayCount < MIN_PRIOR) { skipped++; continue; }

    const standings = buildHistoricalStandings(priorFixtures);
    const homeStats = buildHistoricalTeamStats(fixture.homeTeam, priorFixtures, matchDate);
    const awayStats = buildHistoricalTeamStats(fixture.awayTeam, priorFixtures, matchDate);

    const homeSlug = slugify(fixture.homeTeam);
    const awaySlug = slugify(fixture.awayTeam);

    const homeTeam = {
      id: homeSlug, name: fixture.homeTeam, league: fixture.leagueName,
      position: standings.get(fixture.homeTeam) ?? 12,
      ...homeStats
    };
    const awayTeam = {
      id: awaySlug, name: fixture.awayTeam, league: fixture.leagueName,
      position: standings.get(fixture.awayTeam) ?? 12,
      ...awayStats
    };

    const predFixture = { id: fixture.id, league: fixture.leagueName, home: homeSlug, away: awaySlug };
    const teamById    = { [homeSlug]: homeTeam, [awaySlug]: awayTeam };
    const prediction  = predictFixture(predFixture, teamById);
    const correct     = prediction.pick === fixture.result;

    evaluated++;
    if (fixture.result === 'X') realDraws++;
    if (correct) hits++;
    byConf[prediction.confidence].total++;
    if (correct) byConf[prediction.confidence].correct++;
    byPick[prediction.pick].total++;
    if (correct) byPick[prediction.pick].correct++;

    const dp = prediction.probabilities['X'];
    const bi = Math.min(9, Math.floor(dp * 10));
    dpBuckets[bi].total++;
    if (fixture.result === 'X') dpBuckets[bi].draws++;
  }

  printReport({
    label: `historical — ${leagueLabel} — ${seasonsLabel}`,
    evaluated, skipped, hits, byConf, byPick, realDraws
  });

  // Signal-quality diagnostic: is drawProb ordinal w.r.t. actual draws?
  console.log('\nDraw signal diagnostic (actual draw rate by drawProb bucket):');
  dpBuckets.forEach((b, i) => {
    const lo = (i * 10).toString().padStart(2, ' ');
    const hi = ((i + 1) * 10).toString().padStart(2, ' ');
    const bar = b.total > 0 ? `${b.draws}/${b.total} (${pct(b.draws, b.total)})` : 'n/a';
    console.log(`  drawProb ${lo}-${hi}%: ${bar}`);
  });
}

// ── entry point ───────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.source === 'historical') {
  runHistoricalBacktest(args).catch(err => {
    console.error('Historical backtest failed:', err.message);
    process.exit(1);
  });
} else {
  runApiBacktest().catch(err => {
    console.error('API backtest failed:', err.message);
    process.exit(1);
  });
}
