if (typeof window !== 'undefined') {
  throw new Error('apiAdapter.js must only run in Node.js. Do not import in browser.');
}

const API_KEY = "2c65ee23070a41be93d84fd7ad5f0856";
const BASE_URL = "https://api.football-data.org/v4";
export const DEMO_MODE = false;

// In-memory cache for fetchFootballData
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedData = null;
let cacheTimestamp = null;

// football-data.org competition codes.
// Championship code on football-data.org is "ELC"; change if your account uses a different alias.
const COMPETITIONS = [
  { code: "PL", name: "Premier League" },
  { code: "ELC", name: "Championship" },
];

export async function apiFetch(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-Auth-Token": API_KEY },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(
      `football-data.org ${path} → HTTP ${response.status}: ${text}`,
    );
  }
  return response.json();
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+(fc|afc|sc|cf|&|utd)$/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function matchOutcome(match, teamId) {
  const isHome = match.homeTeam.id === teamId;
  const hg = match.score.fullTime.home;
  const ag = match.score.fullTime.away;
  if (hg === ag) return "D";
  if (isHome) return hg > ag ? "W" : "L";
  return ag > hg ? "W" : "L";
}

function outcomePoints(outcome) {
  return outcome === "W" ? 3 : outcome === "D" ? 1 : 0;
}

export function buildTeamStats(teamId, finishedMatches, today) {
  const matches = finishedMatches
    .filter(
      (m) =>
        (m.homeTeam.id === teamId || m.awayTeam.id === teamId) &&
        m.score.fullTime.home !== null &&
        m.score.fullTime.away !== null,
    )
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  if (matches.length === 0) {
    return {
      pointsPerGame: 0,
      homePointsPerGame: 0,
      awayPointsPerGame: 0,
      goalsForPerGame: 0,
      goalsAgainstPerGame: 0,
      drawRate: 0,
      recent: [],
      restDays: 0,
    };
  }

  let totalPts = 0,
    homePts = 0,
    awayPts = 0;
  let homeGames = 0,
    awayGames = 0;
  let goalsFor = 0,
    goalsAgainst = 0;
  let draws = 0;

  for (const m of matches) {
    const isHome = m.homeTeam.id === teamId;
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    const outcome = matchOutcome(m, teamId);
    const pts = outcomePoints(outcome);

    totalPts += pts;
    goalsFor += gf;
    goalsAgainst += ga;
    if (outcome === "D") draws++;

    if (isHome) {
      homePts += pts;
      homeGames++;
    } else {
      awayPts += pts;
      awayGames++;
    }
  }

  const n = matches.length;
  const recent = matches.slice(-6).map((m) => matchOutcome(m, teamId));
  const lastDate = new Date(matches[matches.length - 1].utcDate);
  const restDays = Math.round((today - lastDate) / 86_400_000);

  return {
    pointsPerGame: totalPts / n,
    homePointsPerGame: homeGames > 0 ? homePts / homeGames : 0,
    awayPointsPerGame: awayGames > 0 ? awayPts / awayGames : 0,
    goalsForPerGame: goalsFor / n,
    goalsAgainstPerGame: goalsAgainst / n,
    drawRate: draws / n,
    recent,
    restDays,
  };
}

async function fetchCompetition(competition) {
  const [standingsData, finishedData, scheduledData] = await Promise.all([
    apiFetch(`/competitions/${competition.code}/standings`),
    apiFetch(`/competitions/${competition.code}/matches?status=FINISHED`),
    apiFetch(`/competitions/${competition.code}/matches?status=SCHEDULED`),
  ]);

  const totalTable = standingsData.standings.find((s) => s.type === "TOTAL");
  if (!totalTable) {
    throw new Error(
      `No TOTAL standings row found for competition ${competition.code}`,
    );
  }

  const today = new Date();

  // Numeric API id → slug (used to cross-reference fixtures)
  const idToSlug = new Map(
    totalTable.table.map((row) => [
      row.team.id,
      slugify(row.team.shortName || row.team.name),
    ]),
  );

  const teams = totalTable.table.map((row) => ({
    id: idToSlug.get(row.team.id),
    name: row.team.shortName || row.team.name,
    league: competition.name,
    position: row.position,
    ...buildTeamStats(row.team.id, finishedData.matches, today),
  }));

  const fixtures = scheduledData.matches
    .filter((m) => idToSlug.has(m.homeTeam.id) && idToSlug.has(m.awayTeam.id))
    .map((m) => ({
      id: m.id,
      league: competition.name,
      leagueCode: competition.code,
      matchday: m.matchday ?? null,
      date: m.utcDate ? m.utcDate.slice(0, 10) : null,
      home: idToSlug.get(m.homeTeam.id),
      away: idToSlug.get(m.awayTeam.id),
    }));

  return { teams, fixtures };
}

// Returns the canonical { teams, fixtures } shape defined in CLAUDE.md.
export async function fetchFootballData(forceRefresh = false) {
  // Check cache validity
  if (!forceRefresh && cachedData !== null && cacheTimestamp !== null) {
    const now = Date.now();
    if (now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedData;
    }
  }

  // Fetch fresh data
  const results = await Promise.all(COMPETITIONS.map(fetchCompetition));
  const data = {
    teams: results.flatMap((r) => r.teams),
    fixtures: results.flatMap((r) => r.fixtures),
  };

  // Update cache
  cachedData = data;
  cacheTimestamp = Date.now();

  return data;
}
