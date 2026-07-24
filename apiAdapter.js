if (typeof window !== 'undefined') {
  throw new Error('apiAdapter.js must only run in Node.js. Do not import in browser.');
}

const API_KEY      = "2c65ee23070a41be93d84fd7ad5f0856";
const BASE_URL     = "https://api.football-data.org/v4";
const STATS_SEASON = process.env.STATS_SEASON ?? '2025';
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
      hasStats: false,
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
    hasStats: true,
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

// League table positions from finished STATS_SEASON matches.
// Ranks all participants by pts desc, then goal difference desc.
// Returns Map<teamId, { position, pts, gd, played }>.
function computeTablePositions(finishedMatches) {
  const table = new Map();
  for (const m of finishedMatches) {
    const hId = m.homeTeam.id;
    const aId = m.awayTeam.id;
    if (!table.has(hId)) table.set(hId, { pts: 0, gd: 0, played: 0 });
    if (!table.has(aId)) table.set(aId, { pts: 0, gd: 0, played: 0 });
    const hg = m.score.fullTime.home;
    const ag = m.score.fullTime.away;
    if (hg === null || ag === null) continue;
    const hRow = table.get(hId);
    const aRow = table.get(aId);
    hRow.played++;
    aRow.played++;
    hRow.gd += hg - ag;
    aRow.gd += ag - hg;
    if (hg > ag)       { hRow.pts += 3; }
    else if (hg === ag) { hRow.pts += 1; aRow.pts += 1; }
    else                { aRow.pts += 3; }
  }
  const sorted = [...table.entries()]
    .sort(([, a], [, b]) => b.pts - a.pts || b.gd - a.gd);
  const posMap = new Map();
  sorted.forEach(([id, row], i) => posMap.set(id, { ...row, position: i + 1 }));
  return posMap;
}


// Fetch raw match data for one competition.
// upcoming  — SCHEDULED, no season param (API returns current/next season automatically)
// finished  — FINISHED for STATS_SEASON, filtered to REGULAR_SEASON only
//             (ELC returns ~5 play-off matches alongside the 552 league fixtures; exclude them)
//
// idToSlug is built from scheduled fixture participants — NOT from /standings.
// Standings were unreliable: PL standings (no season param) returned the 2025/26 composition
// (relegated teams still present) while 2026/27 scheduled fixtures already contained the
// three promoted replacements. Building from scheduled fixtures is always current-season-accurate.
async function fetchCompetition(competition) {
  const [finishedData, scheduledData] = await Promise.all([
    apiFetch(`/competitions/${competition.code}/matches?season=${STATS_SEASON}&status=FINISHED`),
    apiFetch(`/competitions/${competition.code}/matches?status=SCHEDULED`),
  ]);

  const finished = finishedData.matches.filter((m) => m.stage === 'REGULAR_SEASON');
  const upcoming = scheduledData.matches;

  // Build team name map from scheduled fixtures — authoritative roster for the current season.
  const idToName = new Map();
  for (const m of upcoming) {
    if (!idToName.has(m.homeTeam.id))
      idToName.set(m.homeTeam.id, m.homeTeam.shortName || m.homeTeam.name);
    if (!idToName.has(m.awayTeam.id))
      idToName.set(m.awayTeam.id, m.awayTeam.shortName || m.awayTeam.name);
  }

  const idToSlug = new Map([...idToName.entries()].map(([id, name]) => [id, slugify(name)]));
  const posMap   = computeTablePositions(finished);

  return { competition, idToSlug, idToName, upcoming, finished, posMap };
}

// Returns the canonical { teams, fixtures } shape defined in CLAUDE.md.
export async function fetchFootballData(forceRefresh = false) {
  if (!forceRefresh && cachedData !== null && cacheTimestamp !== null) {
    if (Date.now() - cacheTimestamp < CACHE_TTL_MS) return cachedData;
  }

  const results = await Promise.all(COMPETITIONS.map(fetchCompetition));
  const today   = new Date();

  const allTeams    = [];
  const allFixtures = [];

  // Cross-competition posMap for newcomer classification (set-membership only, no hard-coded IDs).
  const posByCode = new Map(results.map(r => [r.competition.code, r.posMap]));

  for (const { competition, idToSlug, idToName, upcoming, finished, posMap } of results) {
    const otherCode   = COMPETITIONS.find(c => c.code !== competition.code)?.code;
    const otherPosMap = posByCode.get(otherCode);

    const teams = [...idToSlug.entries()].map(([teamId, slug]) => {
      const posRow = posMap.get(teamId);
      let position, positionSource;

      if (posRow) {
        // Team appeared in this competition's prior-season finished matches.
        position       = posRow.position;
        positionSource = 'computed';
      } else if (competition.code === 'PL') {
        // Not in PL 2025/26 → promoted from ELC.
        position       = 18;
        positionSource = 'promoted';
      } else {
        // ELC newcomer: check whether they were in the PL last season.
        if (otherPosMap?.has(teamId)) {
          position       = 3;    // was in PL → relegated to ELC; expected to challenge
          positionSource = 'relegated';
        } else {
          position       = 18;   // in neither prior-season table → from League One
          positionSource = 'promoted';
        }
      }

      return {
        id:             slug,
        name:           idToName.get(teamId),
        league:         competition.name,
        position,
        positionSource,
        ...buildTeamStats(teamId, finished, today),
      };
    });

    // idToSlug is built from scheduled participants, so all fixtures resolve — no filter needed.
    const fixtures = upcoming.map((m) => ({
      id:          m.id,
      league:      competition.name,
      leagueCode:  competition.code,
      matchday:    m.matchday ?? null,
      date:        m.utcDate ? m.utcDate.slice(0, 10) : null,
      home:        idToSlug.get(m.homeTeam.id),
      away:        idToSlug.get(m.awayTeam.id),
    }));

    allTeams.push(...teams);
    allFixtures.push(...fixtures);
  }

  const data = { teams: allTeams, fixtures: allFixtures };
  cachedData = data;
  cacheTimestamp = Date.now();
  return data;
}
