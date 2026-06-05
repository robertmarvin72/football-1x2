// validateHistoricalData.js
// Validates every historical fixture JSON file under /data/historical/.
// Run with: node validateHistoricalData.js
// Exits with code 1 if any file fails validation.

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEAGUES  = ['PL', 'ELC'];
const SEASONS  = ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25'];
const SEASON_RE = /^\d{4}-\d{2}$/;
const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const TODAY     = new Date();

let errorCount = 0;

function fail(label, msg) {
  console.error(`  FAIL [${label}]: ${msg}`);
  errorCount++;
}

function expectedResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return '1';
  if (homeGoals === awayGoals) return 'X';
  return '2';
}

async function validateFile(league, season) {
  const filePath = join(__dirname, 'data', 'historical', league, `${season}.json`);
  const label = `${league}/${season}.json`;

  let data;
  try {
    const raw = await readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    fail(label, `Cannot read or parse file: ${err.message}`);
    return;
  }

  if (typeof data.league !== 'string' || !data.league.trim()) {
    fail(label, 'league must be a non-empty string');
  }
  if (typeof data.season !== 'string' || !SEASON_RE.test(data.season)) {
    fail(label, `season must match YYYY-YY format, got: ${JSON.stringify(data.season)}`);
  }
  if (!Array.isArray(data.fixtures) || data.fixtures.length === 0) {
    fail(label, 'fixtures must be a non-empty array');
    return;
  }

  if (data.demo) {
    console.log(`  NOTE [${label}]: demo file — replace with real data before backtesting`);
  }

  for (let i = 0; i < data.fixtures.length; i++) {
    const f = data.fixtures[i];
    const fid = `${label}#${i + 1}`;

    if (!f.date) {
      fail(fid, 'missing date');
    } else {
      if (!DATE_RE.test(f.date)) fail(fid, `date must be YYYY-MM-DD, got: ${f.date}`);
      const matchDate = new Date(f.date);
      if (isNaN(matchDate.getTime())) {
        fail(fid, `date is not a valid calendar date: ${f.date}`);
      } else if (matchDate > TODAY) {
        fail(fid, `date ${f.date} is in the future — historical files must not contain upcoming fixtures`);
      }
    }

    if (!f.homeTeam || typeof f.homeTeam !== 'string') fail(fid, 'homeTeam must be a non-empty string');
    if (!f.awayTeam || typeof f.awayTeam !== 'string') fail(fid, 'awayTeam must be a non-empty string');

    const hg = f.homeGoals;
    const ag = f.awayGoals;
    if (hg === undefined || hg === null) fail(fid, 'homeGoals is missing');
    else if (!Number.isInteger(hg) || hg < 0) fail(fid, `homeGoals must be a non-negative integer, got: ${hg}`);

    if (ag === undefined || ag === null) fail(fid, 'awayGoals is missing');
    else if (!Number.isInteger(ag) || ag < 0) fail(fid, `awayGoals must be a non-negative integer, got: ${ag}`);

    if (!f.result) {
      fail(fid, 'result is missing');
    } else if (!['1', 'X', '2'].includes(f.result)) {
      fail(fid, `result must be "1", "X", or "2", got: ${JSON.stringify(f.result)}`);
    } else if (Number.isInteger(hg) && Number.isInteger(ag)) {
      const exp = expectedResult(hg, ag);
      if (f.result !== exp) {
        fail(fid, `result "${f.result}" does not match score ${hg}-${ag} (expected "${exp}")`);
      }
    }
  }
}

async function main() {
  console.log('Validating historical fixture files…\n');
  const tasks = LEAGUES.flatMap(l => SEASONS.map(s => validateFile(l, s)));
  await Promise.all(tasks);

  const fileCount = LEAGUES.length * SEASONS.length;
  console.log(`\n${fileCount} files checked.`);
  if (errorCount === 0) {
    console.log('All files valid.');
    process.exit(0);
  } else {
    console.error(`${errorCount} error(s) found. Fix before backtesting.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Validator crashed:', err.message);
  process.exit(1);
});
