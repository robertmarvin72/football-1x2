// Shared helpers for building team statistics from historical fixture data.
// Used by backtest.js and backtestConfidence.js.

export function buildHistoricalStandings(priorFixtures) {
  const pts = new Map();
  for (const f of priorFixtures) {
    if (!pts.has(f.homeTeam)) pts.set(f.homeTeam, 0);
    if (!pts.has(f.awayTeam)) pts.set(f.awayTeam, 0);
    if (f.result === '1')      pts.set(f.homeTeam, pts.get(f.homeTeam) + 3);
    else if (f.result === 'X') {
      pts.set(f.homeTeam, pts.get(f.homeTeam) + 1);
      pts.set(f.awayTeam, pts.get(f.awayTeam) + 1);
    } else                     pts.set(f.awayTeam, pts.get(f.awayTeam) + 3);
  }
  const sorted = [...pts.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([name], i) => [name, i + 1]));
}

export function historicalOutcome(fixture, teamName) {
  const isHome = fixture.homeTeam === teamName;
  if (fixture.result === 'X') return 'D';
  if (fixture.result === '1') return isHome ? 'W' : 'L';
  return isHome ? 'L' : 'W';
}

export function buildHistoricalTeamStats(teamName, priorFixtures, matchDate) {
  const teamFixtures = priorFixtures
    .filter(f => f.homeTeam === teamName || f.awayTeam === teamName)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (teamFixtures.length === 0) {
    return {
      pointsPerGame: 0, homePointsPerGame: 0, awayPointsPerGame: 0,
      goalsForPerGame: 0, goalsAgainstPerGame: 0,
      drawRate: 0, homeDrawRate: 0, awayDrawRate: 0,
      recent: [], restDays: 0,
    };
  }

  let totalPts = 0, homePts = 0, awayPts = 0;
  let homeGames = 0, awayGames = 0;
  let goalsFor = 0, goalsAgainst = 0, draws = 0, homeDraws = 0, awayDraws = 0;

  for (const f of teamFixtures) {
    const isHome = f.homeTeam === teamName;
    const gf = isHome ? f.homeGoals : f.awayGoals;
    const ga = isHome ? f.awayGoals : f.homeGoals;
    const outcome = historicalOutcome(f, teamName);
    const pts = outcome === 'W' ? 3 : outcome === 'D' ? 1 : 0;

    totalPts += pts;
    goalsFor += gf;
    goalsAgainst += ga;
    if (outcome === 'D') {
      draws++;
      if (isHome) homeDraws++;
      else        awayDraws++;
    }
    if (isHome) { homePts += pts; homeGames++; }
    else        { awayPts += pts; awayGames++; }
  }

  const n = teamFixtures.length;
  const recent = teamFixtures.slice(-6).map(f => historicalOutcome(f, teamName));
  const lastDate = new Date(teamFixtures[teamFixtures.length - 1].date);
  const restDays = Math.round((matchDate - lastDate) / 86_400_000);

  return {
    pointsPerGame:       totalPts / n,
    homePointsPerGame:   homeGames > 0 ? homePts / homeGames : 0,
    awayPointsPerGame:   awayGames > 0 ? awayPts / awayGames : 0,
    goalsForPerGame:     goalsFor / n,
    goalsAgainstPerGame: goalsAgainst / n,
    drawRate:            draws / n,
    homeDrawRate:        homeGames > 0 ? homeDraws / homeGames : draws / n,
    awayDrawRate:        awayGames > 0 ? awayDraws / awayGames : draws / n,
    recent,
    restDays,
  };
}
