// Run with: node generatePredictions.js [options]
// Requires Node.js 18+ and package.json "type":"module".
//
// Options:
//   --league PL|ELC   default: both leagues
//
// Output:
//   data/predictions/PL/{season}.json
//   data/predictions/ELC/{season}.json

import { fetchFootballData, STATS_SEASON } from './apiAdapter.js';
import { predictFixture } from './predict.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMPETITION_NAMES = {
  PL:  'Premier League',
  ELC: 'Championship',
};

const LEAGUE_NAME_TO_CODE = {
  'Premier League': 'PL',
  'Championship':   'ELC',
};

function parseArgs(argv) {
  const result = { league: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--league') result.league = argv[++i];
  }
  return result;
}

function resolveLeagueCode(fixture) {
  return fixture.leagueCode ?? LEAGUE_NAME_TO_CODE[fixture.league] ?? fixture.league;
}

function upsetProb(prediction) {
  const { pick, probabilities } = prediction;
  if (pick === '1') return probabilities['2'];
  if (pick === '2') return probabilities['1'];
  return Math.max(probabilities['1'], probabilities['2']);
}

// Numeric fields that must be finite for a team to be usable.
const NUMERIC_METRICS = [
  'pointsPerGame', 'homePointsPerGame', 'awayPointsPerGame',
  'goalsForPerGame', 'goalsAgainstPerGame', 'drawRate',
];

// Returns a problem description string if the team cannot be used, null if OK.
function teamMissing(team, fallbackName) {
  if (!team)          return `${fallbackName} (not found)`;
  if (!team.hasStats) return `${team.name} (no stats)`;
  if (NUMERIC_METRICS.some(k => !isFinite(team[k]))) return `${team.name} (non-finite metric)`;
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Scheduled season is one year ahead of the stats season:
  // STATS_SEASON='2025' → finished data from 2025/26 → schedule for 2026/27.
  const statsYear     = parseInt(STATS_SEASON, 10);
  const schedYear     = statsYear + 1;
  const seasonLabel   = `${schedYear}-${String(schedYear + 1).slice(-2)}`;   // "2026-27"
  const seasonDisplay = `${schedYear}/${String(schedYear + 1).slice(-2)}`;    // "2026/27"

  console.log('Fetching upcoming fixtures…');
  const { teams, fixtures } = await fetchFootballData();
  const teamById = Object.fromEntries(teams.map(t => [t.id, t]));

  const codes = args.league ? [args.league] : Object.keys(COMPETITION_NAMES);

  for (const code of codes) {
    const leagueName = COMPETITION_NAMES[code];
    if (!leagueName) {
      console.error(`Unknown league code: ${code}`);
      continue;
    }

    const selected = fixtures.filter(f => resolveLeagueCode(f) === code);
    if (selected.length === 0) {
      console.warn(`Warning: no upcoming fixtures found for ${code}`);
    }

    let matchday = null;
    for (const f of selected) {
      if (f.matchday != null && (matchday == null || f.matchday < matchday)) {
        matchday = f.matchday;
      }
    }

    const fixtureResults = [];
    for (const fixture of selected) {
      const homeTeam = teamById[fixture.home];
      const awayTeam = teamById[fixture.away];

      // Pre-prediction validation: both teams must exist and have trusted statistics.
      const missingH = teamMissing(homeTeam, fixture.home);
      const missingA = teamMissing(awayTeam, fixture.away);
      const missing  = [missingH, missingA].filter(Boolean);

      if (missing.length > 0) {
        fixtureResults.push({
          id:        String(fixture.id),
          league:    code,
          leagueName,
          date:      fixture.date ?? null,
          matchday:  fixture.matchday ?? null,
          homeTeam:  homeTeam?.name ?? fixture.home,
          awayTeam:  awayTeam?.name ?? fixture.away,
          status:    'unavailable',
          reason:    'Insufficient trusted statistics',
          missing,
        });
        continue;
      }

      const prediction = predictFixture(fixture, teamById);

      // Post-prediction probability sanity: all finite, non-negative, sum ≈ 100%.
      const p1 = prediction.probabilities['1'];
      const pX = prediction.probabilities['X'];
      const p2 = prediction.probabilities['2'];
      if (![p1, pX, p2].every(p => isFinite(p) && p >= 0) ||
          Math.abs((p1 + pX + p2) * 100 - 100) > 0.5) {
        fixtureResults.push({
          id:        String(fixture.id),
          league:    code,
          leagueName,
          date:      fixture.date ?? null,
          matchday:  fixture.matchday ?? null,
          homeTeam:  homeTeam.name,
          awayTeam:  awayTeam.name,
          status:    'unavailable',
          reason:    'Prediction output failed probability sanity check',
          missing:   [],
        });
        continue;
      }

      fixtureResults.push({
        id:                   String(fixture.id),
        status:               'available',
        league:               code,
        leagueName,
        date:                 fixture.date ?? null,
        matchday:             fixture.matchday ?? null,
        homeTeam:             homeTeam.name,
        homeStatsSource:      homeTeam.statsSource,
        awayTeam:             awayTeam.name,
        awayStatsSource:      awayTeam.statsSource,
        predictedOutcome:     prediction.pick,
        confidence:           parseFloat(prediction.topProbability.toFixed(4)),
        drawProbability:      parseFloat(prediction.probabilities['X'].toFixed(4)),
        upsetProbability:     parseFloat(upsetProb(prediction).toFixed(4)),
        drawCandidate:        prediction.drawCandidate,
        couponRecommendation: prediction.couponRec,
      });
    }

    // Summary lists and counts only cover available predictions.
    const available   = fixtureResults.filter(f => f.status === 'available');
    const unavailable = fixtureResults.filter(f => f.status === 'unavailable');

    const topPicks = available
      .filter(f => f.couponRecommendation.startsWith('Single'))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);

    const drawCandidates = available
      .filter(f => f.drawCandidate)
      .sort((a, b) => b.drawProbability - a.drawProbability)
      .slice(0, 10);

    const upsetCandidates = available
      .filter(f => f.predictedOutcome === '1' && f.upsetProbability >= 0.30)
      .sort((a, b) => b.upsetProbability - a.upsetProbability)
      .slice(0, 10);

    const output = {
      competition: { code, name: leagueName },
      season:      { startYear: schedYear, label: seasonDisplay },
      generatedAt: new Date().toISOString(),
      statsBasis:  { season: STATS_SEASON, quality: 'previous-season' },
      gameweek:    matchday != null ? { [code]: matchday } : {},
      fixtures:    fixtureResults,
      summary: {
        totalFixtures:          fixtureResults.length,
        predictionsGenerated:   available.length,
        predictionsUnavailable: unavailable.length,
        topPicks,
        drawCandidates,
        upsetCandidates,
      },
    };

    const outDir  = join(__dirname, 'data', 'predictions', code);
    const outFile = join(outDir, `${seasonLabel}.json`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(output, null, 2), 'utf8');
    console.log(`${code}: ${fixtureResults.length} fixtures → ${available.length} generated, ${unavailable.length} unavailable → data/predictions/${code}/${seasonLabel}.json`);
  }
}

main().catch(err => {
  console.error('generatePredictions failed:', err.message);
  process.exit(1);
});
