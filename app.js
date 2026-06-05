import { fetchFootballData } from './apiAdapter.js';
import { predictFixture } from './predict.js';

const demoData = {
  teams: [
    {
      id: "arsenal",
      name: "Arsenal",
      league: "Premier League",
      position: 2,
      pointsPerGame: 2.21,
      goalsForPerGame: 2.1,
      goalsAgainstPerGame: 0.8,
      homePointsPerGame: 2.35,
      awayPointsPerGame: 1.95,
      drawRate: 0.21,
      recent: ["W", "W", "D", "W", "L", "W"],
      restDays: 6
    },
    {
      id: "wolves",
      name: "Wolves",
      league: "Premier League",
      position: 15,
      pointsPerGame: 1.05,
      goalsForPerGame: 1.1,
      goalsAgainstPerGame: 1.8,
      homePointsPerGame: 1.25,
      awayPointsPerGame: 0.85,
      drawRate: 0.26,
      recent: ["L", "D", "L", "W", "L", "D"],
      restDays: 5
    },
    {
      id: "leeds",
      name: "Leeds",
      league: "Championship",
      position: 3,
      pointsPerGame: 1.92,
      goalsForPerGame: 1.85,
      goalsAgainstPerGame: 1.05,
      homePointsPerGame: 2.15,
      awayPointsPerGame: 1.68,
      drawRate: 0.23,
      recent: ["W", "D", "W", "W", "L", "W"],
      restDays: 4
    },
    {
      id: "norwich",
      name: "Norwich",
      league: "Championship",
      position: 10,
      pointsPerGame: 1.48,
      goalsForPerGame: 1.55,
      goalsAgainstPerGame: 1.45,
      homePointsPerGame: 1.75,
      awayPointsPerGame: 1.18,
      drawRate: 0.28,
      recent: ["D", "W", "L", "D", "W", "L"],
      restDays: 4
    },
    {
      id: "liverpool",
      name: "Liverpool",
      league: "Premier League",
      position: 1,
      pointsPerGame: 2.35,
      goalsForPerGame: 2.3,
      goalsAgainstPerGame: 0.95,
      homePointsPerGame: 2.55,
      awayPointsPerGame: 2.05,
      drawRate: 0.18,
      recent: ["W", "W", "W", "D", "W", "W"],
      restDays: 3
    },
    {
      id: "chelsea",
      name: "Chelsea",
      league: "Premier League",
      position: 6,
      pointsPerGame: 1.74,
      goalsForPerGame: 1.75,
      goalsAgainstPerGame: 1.35,
      homePointsPerGame: 1.9,
      awayPointsPerGame: 1.55,
      drawRate: 0.24,
      recent: ["W", "L", "W", "D", "W", "L"],
      restDays: 6
    }
  ],
  fixtures: [
    { id: 1, league: "Premier League", home: "arsenal", away: "wolves" },
    { id: 2, league: "Championship", home: "leeds", away: "norwich" },
    { id: 3, league: "Premier League", home: "liverpool", away: "chelsea" }
  ]
};

const state = {
  league: "all",
  confidence: "all"
};

let appData = demoData;
let teamById = Object.fromEntries(demoData.teams.map(team => [team.id, team]));

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function passesFilters(prediction) {
  if (state.league !== "all" && prediction.fixture.league !== state.league) return false;
  if (state.confidence === "High" && prediction.confidence !== "High") return false;
  if (state.confidence === "Medium" && prediction.confidence === "Low") return false;
  return true;
}

function render() {
  const predictions = appData.fixtures.map(f => predictFixture(f, teamById)).filter(passesFilters);
  const tbody = document.querySelector("#predictionRows");
  tbody.innerHTML = "";

  predictions.forEach(prediction => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${prediction.fixture.league}</td>
      <td><strong>${prediction.home.name}</strong> vs <strong>${prediction.away.name}</strong></td>
      <td class="percent">${formatPercent(prediction.probabilities["1"])}</td>
      <td class="percent">${formatPercent(prediction.probabilities["X"])}</td>
      <td class="percent">${formatPercent(prediction.probabilities["2"])}</td>
      <td><span class="pick">${prediction.pick}</span></td>
      <td><span class="conf ${prediction.confidence}">${prediction.confidence}</span></td>
      <td class="why">${prediction.reasons.join("; ")}</td>
    `;
    tbody.appendChild(row);
  });

  document.querySelector("#totalGames").textContent = predictions.length;

  const top = [...predictions].sort((a, b) => b.topProbability - a.topProbability)[0];
  document.querySelector("#topPick").textContent = top
    ? `${top.home.name} vs ${top.away.name}: ${top.pick}`
    : "-";

  const avg = predictions.length
    ? predictions.reduce((sum, p) => sum + p.topProbability, 0) / predictions.length
    : 0;
  document.querySelector("#avgConfidence").textContent = predictions.length ? formatPercent(avg) : "-";
}

function initFilters() {
  const leagueFilter = document.querySelector("#leagueFilter");
  const leagues = [...new Set(appData.fixtures.map(fixture => fixture.league))];

  leagues.forEach(league => {
    const option = document.createElement("option");
    option.value = league;
    option.textContent = league;
    leagueFilter.appendChild(option);
  });

  leagueFilter.addEventListener("change", event => {
    state.league = event.target.value;
    render();
  });

  document.querySelector("#confidenceFilter").addEventListener("change", event => {
    state.confidence = event.target.value;
    render();
  });

  document.querySelector("#runBtn").addEventListener("click", async () => {
    appData = await fetchFootballData(true);
    teamById = Object.fromEntries(appData.teams.map(t => [t.id, t]));
    render();
  });
}

(async () => {
  try {
    appData = await fetchFootballData();
    teamById = Object.fromEntries(appData.teams.map(t => [t.id, t]));
  } catch (err) {
    console.warn("Live data fetch failed — falling back to demo data.", err.message);
  }
  initFilters();
  render();
})();
