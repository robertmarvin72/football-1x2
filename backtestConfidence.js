// Confidence grading backtest — validates and recalibrates A+/A/B/C/D thresholds.
//
// Run with:
//   node backtestConfidence.js
//   npm run backtest:confidence
//
// Options (process.argv only, no npm packages):
//   --league PL|ELC              default: both leagues
//   --seasons 2023-24,2024-25    default: all five seasons
//   --sample N                   sample rows to print (default: 20, 0 = none)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath }        from 'node:url';
import { dirname, join }        from 'node:path';

import { getRecentHistoricalFixtures } from './historicalData.js';
import {
  predictFixture,
  getPredictedOutcome,
  CONFIDENCE_THRESHOLDS,
} from './predict.js';
import {
  buildHistoricalStandings,
  buildHistoricalTeamStats,
} from './historicalStats.js';
import { slugify } from './apiAdapter.js';

const MIN_PRIOR = 5;
const GRADES    = ['A+', 'A', 'B', 'C', 'D'];

const OUTCOME_LABEL = { '1': 'Home', 'X': 'Draw', '2': 'Away' };

// Candidates for Step 2 gap threshold sweep (draw penalty fixed at current value).
// 'applied' reflects the values currently in predict.js.
const CANDIDATE_THRESHOLDS = [
  { label: 'v3-original', A_PLUS: 0.35, A: 0.25, B: 0.15, C: 0.08 },
  { label: 'tighter',     A_PLUS: 0.40, A: 0.30, B: 0.15, C: 0.08 },
  { label: 'wider',       A_PLUS: 0.30, A: 0.22, B: 0.14, C: 0.07 },
  { label: 'top-heavy',   A_PLUS: 0.45, A: 0.32, B: 0.18, C: 0.09 },
  { label: 'applied',     A_PLUS: CONFIDENCE_THRESHOLDS.A_PLUS,
                          A:      CONFIDENCE_THRESHOLDS.A,
                          B:      CONFIDENCE_THRESHOLDS.B,
                          C:      CONFIDENCE_THRESHOLDS.C },
];

// Candidates for Step 3 draw penalty sweep (gap thresholds fixed at applied values).
const DRAW_PENALTY_THRESHOLDS = [0.30, 0.33, 0.35, 0.38, 0.40];

// ── formatting helpers ────────────────────────────────────────────────────────

function r(str, w)  { return String(str).padStart(w); }
function l(str, w)  { return String(str).padEnd(w);   }

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

// ── sweep helpers ─────────────────────────────────────────────────────────────

// Re-grade a single fixture using arbitrary thresholds (no predictFixture re-run).
// `gap`   = topProb − secondProb (raw float, before any penalty).
// `draw`  = sigmoid drawProb (raw float).
// `predIsX` = whether simple-argmax predicted a draw.
function gradeFromGap(gap, draw, predIsX, t, penaltyT) {
  let grade;
  if      (gap >= t.A_PLUS) grade = 'A+';
  else if (gap >= t.A)      grade = 'A';
  else if (gap >= t.B)      grade = 'B';
  else if (gap >= t.C)      grade = 'C';
  else                       grade = 'D';

  if (!predIsX && draw > penaltyT && (grade === 'A+' || grade === 'A')) {
    grade = 'B';
  }
  return grade;
}

// Apply a threshold set to the full samples array, return per-grade { total, correct }.
function computeSweepStats(samples, thresholds, penaltyT) {
  const stats = Object.fromEntries(GRADES.map(g => [g, { total: 0, correct: 0 }]));
  for (const s of samples) {
    const g = gradeFromGap(s.gap, s.draw, s.predIsX, thresholds, penaltyT);
    stats[g].total++;
    if (s.correct) stats[g].correct++;
  }
  return stats;
}

// True when accuracy is strictly decreasing A+ → A → B → C → D
// (only grades with ≥ 10 fixtures are checked).
function isStrictlyDecreasing(stats) {
  const accs = GRADES
    .filter(g => stats[g].total >= 10)
    .map(g => stats[g].correct / stats[g].total);
  for (let i = 0; i < accs.length - 1; i++) {
    if (accs[i] <= accs[i + 1]) return false;
  }
  return true;
}

// Violations = count of adjacent pairs where accuracy is NOT decreasing.
function countViolations(stats) {
  const accs = GRADES
    .filter(g => stats[g].total >= 10)
    .map(g => stats[g].correct / stats[g].total);
  let v = 0;
  for (let i = 0; i < accs.length - 1; i++) {
    if (accs[i] <= accs[i + 1]) v++;
  }
  return v;
}

// Largest accuracy drop between adjacent grades (lower = smoother curve).
function maxAdjacentDrop(stats) {
  const accs = GRADES
    .filter(g => stats[g].total >= 10)
    .map(g => stats[g].correct / stats[g].total);
  let max = 0;
  for (let i = 0; i < accs.length - 1; i++) {
    max = Math.max(max, accs[i] - accs[i + 1]);
  }
  return max;
}

// Compact inline summary: "A+: 57% (610) | A: 49% (220) | ..."
function sweepLine(stats) {
  return GRADES
    .map(g => `${g}: ${pct(stats[g].correct, stats[g].total)} (${stats[g].total})`)
    .join(' | ');
}

// ── calibration check (used for main accuracy table warning) ──────────────────

function checkCalibration(gradeStats) {
  const qualified = GRADES
    .filter(g => gradeStats[g].total >= 5)
    .map(g => ({ grade: g, acc: gradeStats[g].correct / gradeStats[g].total }));
  if (qualified.length < 3) return false;
  let violations = 0;
  for (let i = 0; i < qualified.length - 1; i++) {
    if (qualified[i].acc < qualified[i + 1].acc) violations++;
  }
  const spread = qualified[0].acc - qualified[qualified.length - 1].acc;
  return violations > 1 || spread < 0.05;
}

// ── predict.js updater ────────────────────────────────────────────────────────

async function applyToPredict(t, penalty) {
  const dir  = dirname(fileURLToPath(import.meta.url));
  const path = join(dir, 'predict.js');
  let   src  = await readFile(path, 'utf-8');

  // Replace individual threshold values — patterns are stable across edits.
  src = src.replace(/A_PLUS: [\d.]+/, `A_PLUS: ${t.A_PLUS.toFixed(2)}`);
  src = src.replace(/(  A:[ ]+)[\d.]+/, `$1${t.A.toFixed(2)}`);
  src = src.replace(/(  B:[ ]+)[\d.]+/, `$1${t.B.toFixed(2)}`);
  src = src.replace(/(  C:[ ]+)[\d.]+/, `$1${t.C.toFixed(2)}`);
  src = src.replace(/const DRAW_PENALTY_THRESHOLD = [\d.]+/, `const DRAW_PENALTY_THRESHOLD = ${penalty.toFixed(2)}`);

  await writeFile(path, src, 'utf-8');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const leagueLabel  = args.league  || 'PL + ELC';
  const seasonsLabel = args.seasons ? args.seasons.join(', ') : 'all five seasons';

  console.log(`\n${'═'.repeat(68)}`);
  console.log(`Confidence Threshold Analysis & Recalibration`);
  console.log(`Source : historical — ${leagueLabel} — ${seasonsLabel}`);
  console.log(`${'═'.repeat(68)}`);

  console.log('\nLoading historical data…');
  const allFixtures = await getRecentHistoricalFixtures({
    league:  args.league,
    seasons: args.seasons,
  });
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));
  console.log(`Loaded ${allFixtures.length} fixtures.`);

  // ── per-grade accumulators (current predict.js thresholds) ────────────────
  const gradeStats = Object.fromEntries(
    GRADES.map(g => [g, {
      total: 0, correct: 0,
      sumGap: 0, sumDraw: 0,
      minGap: Infinity, maxGap: -Infinity,
    }])
  );
  let evaluated = 0, skipped = 0;
  const samples = [];  // raw data for sweep (no re-prediction needed)

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
      position: standings.get(fixture.homeTeam) ?? 12, ...homeStats,
    };
    const awayTeam = {
      id: awaySlug, name: fixture.awayTeam, league: fixture.leagueName,
      position: standings.get(fixture.awayTeam) ?? 12, ...awayStats,
    };

    const predFixture = { id: fixture.id, league: fixture.leagueName, home: homeSlug, away: awaySlug };
    const teamById    = { [homeSlug]: homeTeam, [awaySlug]: awayTeam };
    const prediction  = predictFixture(predFixture, teamById);

    const { '1': p1, 'X': pX, '2': p2 } = prediction.probabilities;
    const sortedProbs = [p1, pX, p2].sort((a, b) => b - a);
    const rawGap  = sortedProbs[0] - sortedProbs[1];  // pre-penalty gap
    const outcome = getPredictedOutcome(p1, pX, p2);  // simple argmax
    const grade   = prediction.confidence;             // from current predict.js thresholds
    const correct = outcome === fixture.result;

    const gs = gradeStats[grade];
    gs.total++;
    if (correct) gs.correct++;
    gs.sumGap  += rawGap;
    gs.sumDraw += pX;
    if (rawGap < gs.minGap) gs.minGap = rawGap;
    if (rawGap > gs.maxGap) gs.maxGap = rawGap;

    samples.push({
      gap:    rawGap,
      draw:   pX,
      predIsX: outcome === 'X',
      correct,
      // for sample display only
      match:  `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      pred:   OUTCOME_LABEL[outcome],
      grade,
      actual: OUTCOME_LABEL[fixture.result],
    });
    evaluated++;
  }

  // ── § 0  Main accuracy table (current thresholds) ────────────────────────
  console.log(`\nFixtures evaluated : ${evaluated}`);
  console.log(`Skipped (< ${MIN_PRIOR} prior)  : ${skipped}`);

  const totalCorrect = GRADES.reduce((s, g) => s + gradeStats[g].correct, 0);
  console.log(`Overall accuracy   : ${pct(totalCorrect, evaluated)}\n`);

  const COL = { grade: 6, matches: 9, correct: 9, accuracy: 10 };
  const hdr =
    l('Grade', COL.grade) + r('Matches', COL.matches) +
    r('Correct', COL.correct) + r('Accuracy', COL.accuracy) +
    '  Distribution';
  console.log(hdr);
  console.log('─'.repeat(hdr.length));
  for (const g of GRADES) {
    const { total, correct } = gradeStats[g];
    const acc = total > 0 ? correct / total : null;
    console.log(
      l(g, COL.grade) + r(total, COL.matches) + r(correct, COL.correct) +
      r(pct(correct, total), COL.accuracy) + '  ' + bar(acc)
    );
  }
  console.log('─'.repeat(hdr.length));
  console.log(
    l('Total', COL.grade) + r(evaluated, COL.matches) +
    r(totalCorrect, COL.correct) + r(pct(totalCorrect, evaluated), COL.accuracy)
  );

  if (checkCalibration(gradeStats)) {
    console.log(`\n  ⚠  Calibration warning: higher grades are not consistently more accurate.`);
  }

  // ── § 1  DIAGNOSTIC TABLE ─────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`§1  Diagnostic  (current thresholds: A+≥${CONFIDENCE_THRESHOLDS.A_PLUS} A≥${CONFIDENCE_THRESHOLDS.A} B≥${CONFIDENCE_THRESHOLDS.B} C≥${CONFIDENCE_THRESHOLDS.C})`);
  console.log('─'.repeat(68));

  const DC = { grade: 6, count: 7, acc: 9, avgGap: 10, avgDraw: 11, minGap: 9, maxGap: 9 };
  const diagHdr =
    l('Grade', DC.grade) + r('Count', DC.count) + r('Accuracy', DC.acc) +
    r('Avg Gap%', DC.avgGap) + r('Avg Draw%', DC.avgDraw) +
    r('Min Gap%', DC.minGap) + r('Max Gap%', DC.maxGap);
  console.log(diagHdr);
  console.log('─'.repeat(diagHdr.length));

  for (const g of GRADES) {
    const s = gradeStats[g];
    const n = s.total;
    if (n === 0) {
      console.log(l(g, DC.grade) + r(0, DC.count) + r('n/a', DC.acc) +
        r('n/a', DC.avgGap) + r('n/a', DC.avgDraw) + r('n/a', DC.minGap) + r('n/a', DC.maxGap));
      continue;
    }
    console.log(
      l(g, DC.grade) +
      r(n, DC.count) +
      r(pct(s.correct, n), DC.acc) +
      r(`${(s.sumGap / n * 100).toFixed(1)}%`, DC.avgGap) +
      r(`${(s.sumDraw / n * 100).toFixed(1)}%`, DC.avgDraw) +
      r(`${(s.minGap * 100).toFixed(1)}%`, DC.minGap) +
      r(`${(s.maxGap * 100).toFixed(1)}%`, DC.maxGap)
    );
  }

  // ── § 2  GAP THRESHOLD SWEEP ─────────────────────────────────────────────
  const CURRENT_PENALTY = 0.35; // fixed while sweeping gap thresholds
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`§2  Gap Threshold Sweep  (draw penalty fixed at ${CURRENT_PENALTY})`);
  console.log('─'.repeat(68));

  const sweepResults = [];
  for (const cand of CANDIDATE_THRESHOLDS) {
    const stats  = computeSweepStats(samples, cand, CURRENT_PENALTY);
    const valid  = isStrictlyDecreasing(stats);
    const aPlusN = stats['A+'].total;
    const mark   = valid ? '✓' : '✗';
    console.log(`[${mark}] ${l(cand.label, 12)} ${sweepLine(stats)}`);
    sweepResults.push({ cand, stats, valid, aPlusN });
  }

  // ── § 3  DRAW PENALTY SWEEP ───────────────────────────────────────────────
  const FIXED_T = CONFIDENCE_THRESHOLDS; // current predict.js gap thresholds
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`§3  Draw Penalty Sweep  (gap thresholds: A+≥${FIXED_T.A_PLUS} A≥${FIXED_T.A} B≥${FIXED_T.B} C≥${FIXED_T.C})`);
  console.log('─'.repeat(68));

  const penaltyResults = [];
  for (const penT of DRAW_PENALTY_THRESHOLDS) {
    const stats = computeSweepStats(samples, FIXED_T, penT);
    const valid  = isStrictlyDecreasing(stats);
    const mark   = valid ? '✓' : '✗';
    console.log(`[${mark}] penalty=${penT.toFixed(2)}  ${sweepLine(stats)}`);
    penaltyResults.push({ penT, stats, valid });
  }

  // ── § 4  SELECTION & APPLICATION ─────────────────────────────────────────
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`§4  Selection & Application`);
  console.log('─'.repeat(68));

  // Pick best gap thresholds from §2: prefer strictly decreasing, A+≥200, smoothest.
  const validGap = sweepResults.filter(r => r.valid && r.aPlusN >= 200);
  let bestGap;
  if (validGap.length > 0) {
    // Minimise the largest accuracy drop between any two adjacent grades.
    bestGap = validGap.reduce((best, r) =>
      maxAdjacentDrop(r.stats) < maxAdjacentDrop(best.stats) ? r : best
    );
  } else {
    // No strictly valid candidate — pick the one with fewest violations and A+≥200.
    const withCount = sweepResults.filter(r => r.aPlusN >= 200);
    const pool = withCount.length > 0 ? withCount : sweepResults;
    bestGap = pool.reduce((best, r) => {
      const rv = countViolations(r.stats);
      const bv = countViolations(best.stats);
      return rv < bv || (rv === bv && maxAdjacentDrop(r.stats) < maxAdjacentDrop(best.stats))
        ? r : best;
    });
  }

  // Pick best draw penalty from §3: prefer strictly decreasing, then fewest violations.
  const validPen = penaltyResults.filter(r => r.valid);
  let bestPen;
  if (validPen.length > 0) {
    // Among valid penalties, prefer the one that leaves most fixtures in A+.
    bestPen = validPen.reduce((best, r) =>
      r.stats['A+'].total > best.stats['A+'].total ? r : best
    );
  } else {
    bestPen = penaltyResults.reduce((best, r) =>
      countViolations(r.stats) < countViolations(best.stats) ? r : best
    );
  }

  const chosenT       = bestGap.cand;
  const chosenPenalty = bestPen.penT;

  console.log(`\nChosen gap thresholds : ${chosenT.label}`);
  console.log(`  A_PLUS = ${chosenT.A_PLUS}  A = ${chosenT.A}  B = ${chosenT.B}  C = ${chosenT.C}`);
  console.log(`Chosen draw penalty   : ${chosenPenalty}`);

  const bestGapViolations = countViolations(bestGap.stats);
  const penaltyViolations = countViolations(bestPen.stats);
  console.log(`Justification:`);
  if (bestGapViolations === 0) {
    console.log(`  Gap thresholds produce strictly decreasing accuracy (0 violations).`);
  } else {
    console.log(`  Gap thresholds have ${bestGapViolations} violation(s) — best available.`);
    console.log(`  Consider collecting more seasons to reduce noise.`);
  }
  if (penaltyViolations === 0) {
    console.log(`  Draw penalty ${chosenPenalty} produces strictly decreasing accuracy.`);
  } else {
    console.log(`  Draw penalty ${chosenPenalty} has ${penaltyViolations} violation(s) — best available.`);
  }
  console.log(`  A+ count = ${bestGap.aPlusN} (threshold: ≥200).`);
  console.log(`  Largest adjacent accuracy drop = ${(maxAdjacentDrop(bestGap.stats) * 100).toFixed(1)}pp.`);

  // Confirm: apply best gap thresholds + best draw penalty together.
  const confirmedStats = computeSweepStats(samples, chosenT, chosenPenalty);
  console.log(`\nConfirmed results (${chosenT.label} thresholds + penalty=${chosenPenalty}):`);
  console.log(`  ${sweepLine(confirmedStats)}`);
  console.log(`  Strictly decreasing: ${isStrictlyDecreasing(confirmedStats) ? 'yes ✓' : 'no ✗'}`);

  // Apply to predict.js only if the thresholds are actually different from current.
  const unchanged =
    chosenT.A_PLUS === CONFIDENCE_THRESHOLDS.A_PLUS &&
    chosenT.A      === CONFIDENCE_THRESHOLDS.A      &&
    chosenT.B      === CONFIDENCE_THRESHOLDS.B      &&
    chosenT.C      === CONFIDENCE_THRESHOLDS.C      &&
    chosenPenalty  === CURRENT_PENALTY;

  if (unchanged) {
    console.log(`\npredict.js already has optimal thresholds — no change needed.`);
  } else {
    console.log(`\nUpdating predict.js…`);
    await applyToPredict(chosenT, chosenPenalty);
    console.log(`Done.  predict.js updated with chosen thresholds.`);
  }

  // ── sample predictions ────────────────────────────────────────────────────
  if (args.sample > 0) {
    const GRADE_ORDER = { 'A+': 0, 'A': 1, 'B': 2, 'C': 3, 'D': 4 };
    const shown = [...samples]
      .sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || b.gap - a.gap)
      .slice(0, args.sample);

    const SC = { match: 38, pred: 5, grade: 6, gap: 5, draw: 7, actual: 6 };
    const sHeader =
      l('Match', SC.match) + l('Pred', SC.pred) + l('Grade', SC.grade) +
      r('Gap%', SC.gap) + r('Draw%', SC.draw) + '  ' + l('Actual', SC.actual) + 'OK';

    console.log(`\nSample Predictions (top ${shown.length}, sorted by grade then gap):\n`);
    console.log(sHeader);
    console.log('─'.repeat(sHeader.length + 2));

    for (const s of shown) {
      console.log(
        l(truncate(s.match, SC.match), SC.match) + l(s.pred, SC.pred) +
        l(s.grade, SC.grade) + r(Math.round(s.gap * 100), SC.gap) +
        r(`${Math.round(s.draw * 100)}%`, SC.draw) +
        '  ' + l(s.actual, SC.actual) + (s.correct ? '✓' : '✗')
      );
    }
  }

  console.log('');
}

main().catch(err => {
  console.error('backtestConfidence failed:', err.message);
  process.exit(1);
});
