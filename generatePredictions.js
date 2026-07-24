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
      if (!teamById[fixture.home] || !teamById[fixture.away]) {
        console.warn(`Warning: no team data for fixture ${fixture.id} — skipping`);
        continue;
      }
      const prediction = predictFixture(fixture, teamById);
      fixtureResults.push({
        id:                   String(fixture.id),
        league:               code,
        leagueName,
        date:                 fixture.date ?? null,
        matchday:             fixture.matchday ?? null,
        homeTeam:             teamById[fixture.home].name,
        awayTeam:             teamById[fixture.away].name,
        predictedOutcome:     prediction.pick,
        confidence:           parseFloat(prediction.topProbability.toFixed(4)),
        drawProbability:      parseFloat(prediction.probabilities['X'].toFixed(4)),
        upsetProbability:     parseFloat(upsetProb(prediction).toFixed(4)),
        drawCandidate:        prediction.drawCandidate,
        couponRecommendation: prediction.couponRec,
      });
    }

    const topPicks = fixtureResults
      .filter(f => f.couponRecommendation.startsWith('Single'))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);

    const drawCandidates = fixtureResults
      .filter(f => f.drawCandidate)
      .sort((a, b) => b.drawProbability - a.drawProbability)
      .slice(0, 10);

    const upsetCandidates = fixtureResults
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
        totalFixtures: fixtureResults.length,
        topPicks,
        drawCandidates,
        upsetCandidates,
      },
    };

    const outDir  = join(__dirname, 'data', 'predictions', code);
    const outFile = join(outDir, `${seasonLabel}.json`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(output, null, 2), 'utf8');
    console.log(`${code}: ${fixtureResults.length} predictions → data/predictions/${code}/${seasonLabel}.json`);
  }
}

main().catch(err => {
  console.error('generatePredictions failed:', err.message);
  process.exit(1);
});
