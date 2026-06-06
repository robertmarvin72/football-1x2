// Run with: node generatePredictions.js [options]
// Requires Node.js 18+ and package.json "type":"module".
//
// Options:
//   --league PL|ELC            default: both leagues
//   --output path/to/file.json default: predictions.json
//   --dry-run                  print to stdout, do not write file
//
// Examples:
//   node generatePredictions.js
//   node generatePredictions.js --league PL
//   node generatePredictions.js --league ELC
//   node generatePredictions.js --output path/to/custom.json
//   node generatePredictions.js --dry-run

import { fetchFootballData } from './apiAdapter.js';
import { predictFixture } from './predict.js';
import { writeFile } from 'node:fs/promises';

const LEAGUE_NAME_TO_CODE = {
  'Premier League': 'PL',
  'Championship': 'ELC',
};

function parseArgs(argv) {
  const result = { league: null, output: 'predictions.json', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--league')       result.league  = argv[++i];
    else if (flag === '--output')  result.output  = argv[++i];
    else if (flag === '--dry-run') result.dryRun  = true;
  }
  return result;
}

function resolveLeagueCode(fixture) {
  return fixture.leagueCode ?? LEAGUE_NAME_TO_CODE[fixture.league] ?? fixture.league;
}

// Probability of the non-favoured outcome (the "upset" scenario).
// For predicted "1": how likely is the away team to win?
// For predicted "2": how likely is the home team to win?
// For predicted "X": how likely is either side to win decisively?
function upsetProb(prediction) {
  const { pick, probabilities } = prediction;
  if (pick === '1') return probabilities['2'];
  if (pick === '2') return probabilities['1'];
  return Math.max(probabilities['1'], probabilities['2']);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('Fetching upcoming fixtures…');
  const { teams, fixtures } = await fetchFootballData();
  const teamById = Object.fromEntries(teams.map(t => [t.id, t]));

  // Warn per league if no upcoming fixtures were returned
  for (const code of ['PL', 'ELC']) {
    if (args.league && args.league !== code) continue;
    if (!fixtures.some(f => resolveLeagueCode(f) === code)) {
      console.warn(`Warning: no upcoming fixtures found for ${code}`);
    }
  }

  const selected = args.league
    ? fixtures.filter(f => resolveLeagueCode(f) === args.league)
    : fixtures;

  // Gameweek = lowest matchday among selected fixtures per league
  const gameweek = {};
  for (const f of selected) {
    const code = resolveLeagueCode(f);
    if (f.matchday != null && (gameweek[code] == null || f.matchday < gameweek[code])) {
      gameweek[code] = f.matchday;
    }
  }

  // Run predictions
  const fixtureResults = [];
  for (const fixture of selected) {
    if (!teamById[fixture.home] || !teamById[fixture.away]) {
      console.warn(`Warning: no team data for fixture ${fixture.id} — skipping`);
      continue;
    }

    const prediction = predictFixture(fixture, teamById);
    const code = resolveLeagueCode(fixture);

    fixtureResults.push({
      id: String(fixture.id),
      league: code,
      date: fixture.date ?? null,
      homeTeam: teamById[fixture.home].name,
      awayTeam: teamById[fixture.away].name,
      predictedOutcome: prediction.pick,
      confidence: parseFloat(prediction.topProbability.toFixed(4)),
      drawProbability: parseFloat(prediction.probabilities['X'].toFixed(4)),
      upsetProbability: parseFloat(upsetProb(prediction).toFixed(4)),
      drawCandidate: prediction.drawCandidate,
      couponRecommendation: prediction.couponRec,
    });
  }

  // Summary sections
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
    generated: new Date().toISOString(),
    gameweek,
    fixtures: fixtureResults,
    summary: {
      totalFixtures: fixtureResults.length,
      topPicks,
      drawCandidates,
      upsetCandidates,
    },
  };

  const json = JSON.stringify(output, null, 2);

  if (args.dryRun) {
    console.log(json);
  } else {
    await writeFile(args.output, json, 'utf8');
    console.log(`Saved ${fixtureResults.length} predictions → ${args.output}`);
    console.log(
      `Summary: ${topPicks.length} banker${topPicks.length !== 1 ? 's' : ''}, ` +
      `${drawCandidates.length} draw candidate${drawCandidates.length !== 1 ? 's' : ''}, ` +
      `${upsetCandidates.length} upset alert${upsetCandidates.length !== 1 ? 's' : ''}`
    );
  }
}

main().catch(err => {
  console.error('generatePredictions failed:', err.message);
  process.exit(1);
});
