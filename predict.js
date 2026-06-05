export function resultPoints(result) {
  if (result === "W") return 3;
  if (result === "D") return 1;
  return 0;
}

export function formScore(team) {
  if (!team.recent || team.recent.length === 0) return 5;
  const weighted = team.recent.reduce((sum, result, index) => {
    return sum + resultPoints(result) * (team.recent.length - index);
  }, 0);
  const max = team.recent.reduce((sum, _result, index) => {
    return sum + 3 * (team.recent.length - index);
  }, 0);
  return (weighted / max) * 10;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map(score => Math.exp(score - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(value => value / sum);
}

export function confidenceFromProb(topProb, secondProb) {
  const gap = topProb - secondProb;
  if (topProb >= 0.58 && gap >= 0.16) return "High";
  if (topProb >= 0.45 && gap >= 0.08) return "Medium";
  return "Low";
}

// teamById: { [teamId]: teamObject } — caller builds this from canonical team data.
export function predictFixture(fixture, teamById) {
  const home = teamById[fixture.home];
  const away = teamById[fixture.away];

  const homeForm = formScore(home);
  const awayForm = formScore(away);

  const tableDiffForHome = clamp((away.position - home.position) / 3, -4, 4);
  const tableDiffForAway = clamp((home.position - away.position) / 3, -4, 4);

  const homeRestEdge = clamp((home.restDays - away.restDays) * 0.35, -1.5, 1.5);
  const awayRestEdge = clamp((away.restDays - home.restDays) * 0.35, -1.5, 1.5);

  const homeScore =
    homeForm * 0.9 +
    home.homePointsPerGame * 2.4 +
    home.goalsForPerGame * 1.9 +
    away.goalsAgainstPerGame * 1.4 +
    tableDiffForHome +
    homeRestEdge +
    2.1; // home advantage

  const awayScore =
    awayForm * 0.9 +
    away.awayPointsPerGame * 2.4 +
    away.goalsForPerGame * 1.9 +
    home.goalsAgainstPerGame * 1.4 +
    tableDiffForAway +
    awayRestEdge;

  const strengthGap = Math.abs(homeScore - awayScore);
  const expectedGoals = home.goalsForPerGame + away.goalsForPerGame;
  const drawScore =
    6.8 -
    strengthGap * 0.55 +
    ((home.drawRate + away.drawRate) / 2) * 5 +
    (expectedGoals < 2.7 ? 1.2 : 0);

  const [homeProb, drawProb, awayProb] = softmax([
    homeScore / 4.2,
    drawScore / 4.2,
    awayScore / 4.2
  ]);

  const outcomes = [
    { key: "1", prob: homeProb },
    { key: "X", prob: drawProb },
    { key: "2", prob: awayProb }
  ].sort((a, b) => b.prob - a.prob);

  const confidence = confidenceFromProb(outcomes[0].prob, outcomes[1].prob);

  const reasons = [];
  if (homeForm > awayForm + 1) reasons.push(`${home.name} has stronger recent form`);
  if (awayForm > homeForm + 1) reasons.push(`${away.name} has stronger recent form`);
  if (home.homePointsPerGame > away.awayPointsPerGame + 0.35) reasons.push(`${home.name} is stronger at home`);
  if (away.awayPointsPerGame > home.homePointsPerGame + 0.25) reasons.push(`${away.name} travels well`);
  if (home.position + 4 < away.position) reasons.push(`${home.name} has a clear table edge`);
  if (away.position + 4 < home.position) reasons.push(`${away.name} has a clear table edge`);
  if (Math.abs(homeScore - awayScore) < 1.2) reasons.push("teams grade out similarly, draw risk is higher");
  if (reasons.length === 0) reasons.push("balanced profile, low model separation");

  return {
    fixture,
    home,
    away,
    probabilities: { "1": homeProb, "X": drawProb, "2": awayProb },
    pick: outcomes[0].key,
    confidence,
    topProbability: outcomes[0].prob,
    reasons
  };
}
