// fetchHistoricalData.js
// One-off script: fetch completed fixtures from football-data.org and
// populate /data/historical/{league}/{season}.json.
//
// Run:
//   node fetchHistoricalData.js
//   node fetchHistoricalData.js --league PL
//   node fetchHistoricalData.js --league ELC
//   node fetchHistoricalData.js --seasons 2023-24,2024-25
//   node fetchHistoricalData.js --dry-run
//
// Makes at most 10 API calls (2 leagues × 5 seasons).
// Free-tier rate limit: 10 req/min → 7-second delay between calls (~70s total).
// Skips any file that already contains real data (no "demo": true).

import { apiFetch } from './apiAdapter.js';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEAGUE_NAMES = { PL: 'Premier League', ELC: 'Championship' };
const ALL_LEAGUES  = ['PL', 'ELC'];
const ALL_SEASONS  = ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25'];

// 7s keeps us safely under the 10 req/min free-tier limit.
const DELAY_MS = 7_000;

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { league: null, seasons: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if      (flag === '--league')   result.league  = argv[++i];
    else if (flag === '--seasons')  result.seasons = argv[++i].split(',').map(s => s.trim());
    else if (flag === '--dry-run')  result.dryRun  = true;
    else if (flag.startsWith('--')) {
      console.warn(`Unknown flag: ${flag}`);
    }
  }
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────────────

// "2024-25" → 2024  (football-data.org uses start year as season identifier)
function seasonToApiYear(season) {
  return parseInt(season.slice(0, 4), 10);
}

function deriveResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return '1';
  if (homeGoals === awayGoals) return 'X';
  return '2';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function filePath(league, season) {
  return join(__dirname, 'data', 'historical', league, `${season}.json`);
}

// Returns true if the file exists and contains real (non-demo) data.
async function hasRealData(league, season) {
  try {
    const raw  = await readFile(filePath(league, season), 'utf-8');
    const data = JSON.parse(raw);
    return data.demo !== true;
  } catch {
    return false; // missing or unreadable file → treat as no real data
  }
}

// ── transform ─────────────────────────────────────────────────────────────────

function transformMatches(league, season, matches) {
  const fixtures = [];
  let nullScoreSkips = 0;

  // Sort by date so IDs are assigned in chronological order.
  const sorted = [...matches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  for (const m of sorted) {
    const hg = m.score.fullTime.home;
    const ag = m.score.fullTime.away;

    if (hg === null || ag === null) {
      console.warn(`    WARN  null score — skipping: ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.utcDate.slice(0, 10)})`);
      nullScoreSkips++;
      continue;
    }

    const index = fixtures.length + 1;
    fixtures.push({
      id:        `${league}-${season}-${String(index).padStart(3, '0')}`,
      date:      m.utcDate.slice(0, 10),
      homeTeam:  m.homeTeam.name,
      awayTeam:  m.awayTeam.name,
      homeGoals: hg,
      awayGoals: ag,
      result:    deriveResult(hg, ag),
    });
  }

  return { fixtures, nullScoreSkips };
}

// ── fetch one season ──────────────────────────────────────────────────────────

async function fetchSeason(league, season, dryRun) {
  const label   = `${league}/${season}.json`;
  const apiYear = seasonToApiYear(season);

  if (await hasRealData(league, season)) {
    console.log(`  SKIP  Skipping ${label} — real data already exists`);
    return 'skipped';
  }

  const apiPath = `/competitions/${league}/matches?season=${apiYear}&status=FINISHED`;

  if (dryRun) {
    console.log(`  DRY   Would fetch: GET ${apiPath}`);
    return 'dry-run';
  }

  console.log(`  FETCH ${label} — GET ${apiPath}`);

  let raw;
  try {
    raw = await apiFetch(apiPath);
  } catch (err) {
    console.error(`  ERROR ${label}: ${err.message}`);
    return 'error';
  }

  const finished = (raw.matches || []).filter(m => m.status === 'FINISHED');
  const { fixtures, nullScoreSkips } = transformMatches(league, season, finished);

  if (fixtures.length === 0) {
    console.warn(`  WARN  ${label}: 0 valid fixtures returned by API — file not written`);
    return 'error';
  }

  const output = {
    league,
    leagueName: LEAGUE_NAMES[league],
    season,
    fixtures,
  };

  await writeFile(filePath(league, season), JSON.stringify(output, null, 2) + '\n', 'utf-8');

  const skipNote = nullScoreSkips > 0 ? `, ${nullScoreSkips} null-score match(es) skipped` : '';
  console.log(`  DONE  ${label} — ${fixtures.length} fixtures written${skipNote}`);
  return 'written';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = parseArgs(process.argv.slice(2));
  const leagues = args.league  ? [args.league]  : ALL_LEAGUES;
  const seasons = args.seasons ? args.seasons   : ALL_SEASONS;

  // Validate inputs
  for (const l of leagues) {
    if (!LEAGUE_NAMES[l]) {
      console.error(`Unknown league code: "${l}". Valid codes: PL, ELC`);
      process.exit(1);
    }
  }

  const pairs = leagues.flatMap(l => seasons.map(s => [l, s]));

  const estimatedCalls = pairs.length; // upper bound; skips reduce actual calls
  const estimatedSecs  = estimatedCalls * (DELAY_MS / 1000);

  console.log('Football Pools Assistant — historical data fetcher');
  console.log('──────────────────────────────────────────────────');
  console.log(`Leagues       : ${leagues.join(', ')}`);
  console.log(`Seasons       : ${seasons.join(', ')}`);
  console.log(`Mode          : ${args.dryRun ? 'dry-run (no writes)' : 'live'}`);
  console.log(`Max API calls : ${estimatedCalls} (~${estimatedSecs}s at 7s/call)`);
  console.log('──────────────────────────────────────────────────\n');

  let written  = 0;
  let skipped  = 0;
  let errors   = 0;
  let dryRuns  = 0;
  let apiCalls = 0; // track actual calls for delay logic

  for (let i = 0; i < pairs.length; i++) {
    const [league, season] = pairs[i];

    // Insert delay before each real API call after the first one.
    // Skipped files consume no rate-limit quota, so no delay is needed after them.
    if (apiCalls > 0 && !args.dryRun) {
      console.log(`  WAIT  ${DELAY_MS / 1000}s (rate limit)…`);
      await sleep(DELAY_MS);
    }

    const result = await fetchSeason(league, season, args.dryRun);

    if      (result === 'written')  { written++;  apiCalls++; }
    else if (result === 'skipped')  { skipped++; }
    else if (result === 'error')    { errors++;   apiCalls++; }
    else if (result === 'dry-run')  { dryRuns++; }
  }

  console.log('\n── Summary ──────────────────────────────────────────────────');
  if (args.dryRun) {
    console.log(`  Would fetch : ${dryRuns} file(s)`);
    console.log(`  Would skip  : ${skipped} (real data already present)`);
  } else {
    console.log(`  Written     : ${written}`);
    console.log(`  Skipped     : ${skipped} (real data already present)`);
    console.log(`  Errors      : ${errors}`);
  }
  console.log('─────────────────────────────────────────────────────────────');

  if (errors > 0) {
    console.error('\nSome files failed. Re-run with --league / --seasons to retry only those.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
