// Confidence grading backtest — validates whether A+/A grades are meaningfully
// more accurate than B/C/D grades using historical fixture data.
//
// Run with:
//   node backtestConfidence.js
//   npm run backtest:confidence
//
// Options (process.argv only, no npm packages):
//   --league PL|ELC              default: both leagues
//   --seasons 2023-24,2024-25    default: all five seasons
//   --sample N                   sample rows to print (default: 20, 0 = none)

import { getRecentHistoricalFixtures } from './historicalData.js';
import {
  predictFixture,
  getPredictionConfidence,
  getPredictionGrade,
  getPredictedOutcome,
} from './predict.js';
import {
  buildHistoricalStandings,
  buildHistoricalTeamStats,
} from './historicalStats.js';
import { slugify } from './apiAdapter.js';

const MIN_PRIOR = 5;
const GRADES    = ['A+', 'A', 'B', 'C', 'D'];

const OUTCOME_LABEL = { '1': 'Home', 'X': 'Draw', '2': 'Away' };

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { league: null, seasons: null, sample: 20 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if      (flag === '--league')  result.league  = argv[++i];
    else if (flag === '--seasons') result.seasons = argv[++i].split(',').map(s => s.trim());
    else if (flag === '--sample')  result.sample  = parseInt(argv[++i], 10);
  }
  return result;
}

// ── formatting helpers ────────────────────────────────────────────────────────

function r(str, width) { return String(str).padStart(width); }
function l(str, width) { return String(str).padEnd(width);   }

function pct(n, d) {
  if (d === 0) return 'n/a';
  return `${Math.round((n / d) * 100)}%`;
}

function bar(acc, width = 20) {
  if (acc == null) return ' '.repeat(width);
  const filled = Math.round(acc * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ── grade separation check ────────────────────────────────────────────────────

function checkCalibration(gradeStats) {
  // Only evaluate grades that have enough fixtures to be meaningful.
  const qualified = GRADES
    .filter(g => gradeStats[g].total >= 5)
    .map(g => ({ grade: g, acc: gradeStats[g].correct / gradeStats[g].total }));

  if (qualified.length < 3) return false; // not enough data to judge

  // Count how many adjacent pairs respect the expected ordering (better grade = higher acc).
  let violations = 0;
  for (let i = 0; i < qualified.length - 1; i++) {
    if (qualified[i].acc < qualified[i + 1].acc) violations++;
  }

  const spread = qualified[0].acc - qualified[qualified.length - 1].acc;

  // Warn if more than one ordering violation OR the spread across grades is < 5 pp.
  return violations > 1 || spread < 0.05;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const leagueLabel  = args.league  || 'PL + ELC';
  const seasonsLabel = args.seasons ? args.seasons.join(', ') : 'all five seasons';

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Confidence Grading Backtest`);
  console.log(`Source  : historical — ${leagueLabel} — ${seasonsLabel}`);
  console.log(`${'─'.repeat(64)}`);

  console.log('Loading historical data…');
  const allFixtures = await getRecentHistoricalFixtures({
    league:  args.league,
    seasons: args.seasons,
  });
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));
  console.log(`Loaded ${allFixtures.length} fixtures.`);

  // ── per-grade counters ────────────────────────────────────────────────────
  const gradeStats = Object.fromEntries(
    GRADES.map(g => [g, { total: 0, correct: 0 }])
  );
  let evaluated = 0, skipped = 0;

  // Samples: store all evaluated rows, then slice + sort at print time.
  const samples = [];

  for (const fixture of allFixtures) {
    const matchDate = new Date(fixture.date);

    const priorFixtures = allFixtures.filter(
      f => new Date(f.date) < matchDate
        && f.league === fixture.league
        && f.season === fixture.season
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
      ...homeStats,
    };
    const awayTeam = {
      id: awaySlug, name: fixture.awayTeam, league: fixture.leagueName,
      position: standings.get(fixture.awayTeam) ?? 12,
      ...awayStats,
    };

    const predFixture = { id: fixture.id, league: fixture.leagueName, home: homeSlug, away: awaySlug };
    const teamById    = { [homeSlug]: homeTeam, [awaySlug]: awayTeam };
    const prediction  = predictFixture(predFixture, teamById);

    const { '1': p1, 'X': pX, '2': p2 } = prediction.probabilities;
    const outcome    = getPredictedOutcome(p1, pX, p2);
    const confidence = getPredictionConfidence(p1, pX, p2);
    const grade      = getPredictionGrade(confidence);
    const correct    = outcome === fixture.result;

    evaluated++;
    gradeStats[grade].total++;
    if (correct) gradeStats[grade].correct++;

    samples.push({
      match:      `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      prediction: OUTCOME_LABEL[outcome],
      confidence,
      grade,
      actual:     OUTCOME_LABEL[fixture.result],
      correct,
    });
  }

  // ── grade accuracy table ──────────────────────────────────────────────────
  console.log(`\nFixtures evaluated : ${evaluated}`);
  console.log(`Skipped (< ${MIN_PRIOR} prior)  : ${skipped}`);

  const totalCorrect = GRADES.reduce((sum, g) => sum + gradeStats[g].correct, 0);
  console.log(`Overall accuracy   : ${pct(totalCorrect, evaluated)}\n`);

  const COL = { grade: 6, matches: 9, correct: 9, accuracy: 10, bar: 22 };
  const header =
    l('Grade', COL.grade) +
    r('Matches', COL.matches) +
    r('Correct', COL.correct) +
    r('Accuracy', COL.accuracy) +
    '  ' + 'Distribution';

  console.log(header);
  console.log('─'.repeat(header.length));

  for (const g of GRADES) {
    const { total, correct } = gradeStats[g];
    const acc = total > 0 ? correct / total : null;
    console.log(
      l(g, COL.grade) +
      r(total,   COL.matches) +
      r(correct, COL.correct) +
      r(pct(correct, total), COL.accuracy) +
      '  ' + bar(acc)
    );
  }

  const divider = '─'.repeat(header.length);
  console.log(divider);
  console.log(
    l('Total', COL.grade) +
    r(evaluated,    COL.matches) +
    r(totalCorrect, COL.correct) +
    r(pct(totalCorrect, evaluated), COL.accuracy)
  );

  // ── calibration warning ───────────────────────────────────────────────────
  if (checkCalibration(gradeStats)) {
    console.log(`\n  ⚠  Warning: Confidence grading may need recalibration`);
    console.log(`     Higher grades are not consistently more accurate than lower grades.`);
    console.log(`     Consider adjusting the confidence formula or grade thresholds.`);
  }

  // ── sample predictions ────────────────────────────────────────────────────
  if (args.sample > 0) {
    const shown = [...samples]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, args.sample);

    const SC = { match: 38, pred: 6, conf: 5, grade: 6, actual: 6, correct: 7 };
    const sHeader =
      l('Match', SC.match) +
      l('Pred', SC.pred) +
      r('Conf', SC.conf) +
      l('  Grade', SC.grade + 2) +
      l('Actual', SC.actual + 2) +
      'Correct';

    console.log(`\nSample Predictions (top ${shown.length} by confidence):\n`);
    console.log(sHeader);
    console.log('─'.repeat(sHeader.length));

    for (const s of shown) {
      console.log(
        l(truncate(s.match, SC.match), SC.match) +
        l(s.prediction, SC.pred) +
        r(s.confidence, SC.conf) +
        l(`  ${s.grade}`, SC.grade + 2) +
        l(s.actual, SC.actual + 2) +
        (s.correct ? '✓' : '✗')
      );
    }
  }

  console.log('');
}

main().catch(err => {
  console.error('backtestConfidence failed:', err.message);
  process.exit(1);
});
