// historicalData.js
// Loader utility for historical fixture JSON files stored under /data/historical/.
//
// Loading strategy:
//   Node.js (backtest.js)  — uses fs/promises.readFile; path resolved from import.meta.url.
//   Browser (app.js / UI) — uses fetch() against static JSON served by a local web server.
//                           Requires: npx serve . or python3 -m http.server
//
// Environment is detected at call time via process.versions.node.
// No static imports of Node-only modules so this file is safe to import in the browser.

export const SEASONS = ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25'];
export const LEAGUES = ['PL', 'ELC'];
export const LEAGUE_NAMES = { PL: 'Premier League', ELC: 'Championship' };

function isNode() {
  return typeof process !== 'undefined' && process.versions?.node != null;
}

async function readSeasonFile(league, season) {
  if (isNode()) {
    const { readFile } = await import('fs/promises');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(dir, 'data', 'historical', league, `${season}.json`);
    return JSON.parse(await readFile(filePath, 'utf-8'));
  }
  const url = `/data/historical/${league}/${season}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot load ${url}: HTTP ${res.status}`);
  return res.json();
}

// Returns the full season object: { league, leagueName, season, demo?, fixtures }
export async function loadHistoricalSeason(league, season) {
  return readSeasonFile(league, season);
}

// Returns an array of season objects for all SEASONS in a given league.
export async function loadHistoricalLeague(league) {
  return Promise.all(SEASONS.map(s => readSeasonFile(league, s)));
}

// Returns a flat array of all fixtures across every league and season.
// Each fixture is augmented with { league, leagueName, season }.
export async function loadAllHistoricalFixtures() {
  const pairs = LEAGUES.flatMap(l => SEASONS.map(s => [l, s]));
  const seasons = await Promise.all(pairs.map(([l, s]) => readSeasonFile(l, s)));
  return seasons.flatMap(s =>
    s.fixtures.map(f => ({ ...f, league: s.league, leagueName: s.leagueName, season: s.season }))
  );
}

// Returns a flat array of fixtures filtered by league and/or seasons.
// Options:
//   league  — 'PL' | 'ELC' | null (all)
//   seasons — ['2023-24', '2024-25'] | null (all five)
export async function getRecentHistoricalFixtures({ league = null, seasons = null } = {}) {
  const leaguesToLoad = league ? [league] : LEAGUES;
  const seasonsToLoad = seasons || SEASONS;
  const pairs = leaguesToLoad.flatMap(l => seasonsToLoad.map(s => [l, s]));
  const loaded = await Promise.all(pairs.map(([l, s]) => readSeasonFile(l, s)));
  return loaded.flatMap(s =>
    s.fixtures.map(f => ({ ...f, league: s.league, leagueName: s.leagueName, season: s.season }))
  );
}
