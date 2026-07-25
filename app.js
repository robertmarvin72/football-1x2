import { predictFixture, confidenceFromProb } from './predict.js';

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
    { id: 1, league: "PL", home: "arsenal", away: "wolves" },
    { id: 2, league: "ELC", home: "leeds", away: "norwich" },
    { id: 3, league: "PL", home: "liverpool", away: "chelsea" }
  ]
};

const state = {
  league:     "all",
  confidence: "all",
  week:       null,   // Monday ISO date string "YYYY-MM-DD" of the selected week
};

let appData = demoData;
let teamById = Object.fromEntries(demoData.teams.map(team => [team.id, team]));

// Per-competition prediction files written by generatePredictions.js.
const PREDICTION_FILES = {
  PL:  './data/predictions/PL/2026-27.json',
  ELC: './data/predictions/ELC/2026-27.json',
};

const LEAGUE_DISPLAY = { PL: 'Premier League', ELC: 'Championship' };

// Saved predictions loaded from file — raw, unfiltered.
let loadedPredictions = [];
let loadedGeneratedAt = null;
let weekGroups        = new Map(); // mondayStr → prediction[]

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

// Grade order: lower index = stronger grade.
const GRADE_ORDER = { 'A+': 0, 'A': 1, 'B': 2, 'C': 3, 'D': 4 };

function passesFilters(prediction) {
  if (state.league !== "all" && prediction.fixture.league !== state.league) return false;
  // Confidence filter value is the weakest grade to include (cumulative downward).
  // e.g. state.confidence === "A" → show A+ and A only.
  if (state.confidence !== "all") {
    if (GRADE_ORDER[prediction.confidence] > GRADE_ORDER[state.confidence]) return false;
  }
  return true;
}

// ── ISO week helpers ──────────────────────────────────────────────────────────

// Returns the Monday date string ("YYYY-MM-DD") of the ISO week containing dateStr.
function mondayOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay() || 7; // 1=Mon … 7=Sun
  d.setUTCDate(d.getUTCDate() - dow + 1);
  return d.toISOString().slice(0, 10);
}

// Short month-day label, e.g. "21 Aug".
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// "14–16 Aug (10 matches)" from the actual fixture dates within the week.
function weekLabel(predictions) {
  const dates = predictions.map(p => p.fixture.date).filter(Boolean).sort();
  if (!dates.length) return '—';
  const f = new Date(dates[0] + 'T12:00:00Z');
  const l = new Date(dates[dates.length - 1] + 'T12:00:00Z');
  const fd = f.getUTCDate(), ld = l.getUTCDate();
  const fm = MONTHS[f.getUTCMonth()], lm = MONTHS[l.getUTCMonth()];
  const range = fm === lm ? `${fd}–${ld} ${fm}` : `${fd} ${fm} – ${ld} ${lm}`;
  const n = predictions.length;
  return `${range} (${n} match${n !== 1 ? 'es' : ''})`;
}

// Build Map<mondayStr, prediction[]> sorted by Monday date.
function buildWeekGroups(predictions) {
  const map = new Map();
  for (const p of predictions) {
    const key = mondayOf(p.fixture.date);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return new Map([...map.entries()].sort());
}

// Populate #weekFilter <select> from groups.
function populateWeekSelector(groups) {
  const sel = document.querySelector("#weekFilter");
  sel.innerHTML = '';
  for (const [monday, preds] of groups) {
    const opt = document.createElement("option");
    opt.value = monday;
    opt.textContent = weekLabel(preds);
    sel.appendChild(opt);
  }
}

// First week whose Monday is >= today's Monday; falls back to last week if all past.
function defaultWeekKey(groups) {
  const todayMonday = mondayOf(new Date().toISOString().slice(0, 10));
  for (const monday of groups.keys()) {
    if (monday >= todayMonday) return monday;
  }
  const keys = [...groups.keys()];
  return keys[keys.length - 1] ?? null;
}

// ── shared renderer ───────────────────────────────────────────────────────────

function renderPredictions(predictions) {
  const tbody = document.querySelector("#predictionRows");
  tbody.innerHTML = "";

  if (predictions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No predictions match the current filters.</td></tr>';
    document.querySelector("#totalGames").textContent = "0";
    document.querySelector("#topPick").textContent = "-";
    document.querySelector("#avgConfidence").textContent = "-";
    return;
  }

  predictions.forEach(prediction => {
    const row = document.createElement("tr");
    const leagueDisplay = LEAGUE_DISPLAY[prediction.fixture.league] || prediction.fixture.league;
    const matchMeta = (prediction.fixture.matchday != null || prediction.fixture.date)
      ? `<span class="match-meta">${prediction.fixture.matchday != null ? `MD ${prediction.fixture.matchday}` : ''}${prediction.fixture.matchday != null && prediction.fixture.date ? ' · ' : ''}${fmtDay(prediction.fixture.date)}</span>`
      : '';

    if (prediction.status === 'unavailable') {
      row.className = 'row-unavailable';
      row.innerHTML = `
        <td>${leagueDisplay}</td>
        <td><strong>${prediction.home.name}</strong> vs <strong>${prediction.away.name}</strong>${matchMeta}</td>
        <td class="percent">—</td>
        <td class="percent">—</td>
        <td class="percent">—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="why">${prediction.reasons.join('; ')}</td>
      `;
    } else {
      row.innerHTML = `
        <td>${leagueDisplay}</td>
        <td>
          <strong>${prediction.home.name}</strong> vs <strong>${prediction.away.name}</strong>
          ${matchMeta}
        </td>
        <td class="percent">${formatPercent(prediction.probabilities["1"])}</td>
        <td class="percent">${formatPercent(prediction.probabilities["X"])}</td>
        <td class="percent">${formatPercent(prediction.probabilities["2"])}</td>
        <td><span class="pick">${prediction.pick}</span></td>
        <td><span class="conf" data-grade="${prediction.confidence}">${prediction.confidence}</span></td>
        <td class="coupon">${prediction.couponRec}</td>
        <td class="why">${prediction.reasons.join("; ")}</td>
      `;
    }
    tbody.appendChild(row);
  });

  // Summary stats describe only available predictions.
  const available = predictions.filter(p => p.status !== 'unavailable');
  document.querySelector("#totalGames").textContent = available.length;

  const top = [...available].sort((a, b) => b.topProbability - a.topProbability)[0];
  document.querySelector("#topPick").textContent = top
    ? `${top.home.name} vs ${top.away.name}: ${top.pick}`
    : "-";

  const avg = available.length
    ? available.reduce((sum, p) => sum + p.topProbability, 0) / available.length
    : 0;
  document.querySelector("#avgConfidence").textContent = available.length ? formatPercent(avg) : "-";
}

function setDataSource(text) {
  const el = document.querySelector("#dataSource");
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
}

// ── apply confidence filter and re-render loaded predictions ─────────────────

function applyAndRender() {
  // Week filter — apply first (cheapest reduction).
  let predictions = state.week
    ? (weekGroups.get(state.week) ?? [])
    : loadedPredictions;

  // Confidence filter — unavailable predictions always pass through.
  if (state.confidence !== 'all') {
    predictions = predictions.filter(p =>
      p.status === 'unavailable' ||
      GRADE_ORDER[p.confidence] <= GRADE_ORDER[state.confidence]
    );
  }

  renderPredictions(predictions);

  if (loadedGeneratedAt) {
    setDataSource(`Saved predictions · Generated ${new Date(loadedGeneratedAt).toLocaleString()}`);
  }

  // Update prev / next button enabled state.
  const keys = [...weekGroups.keys()];
  const idx  = state.week ? keys.indexOf(state.week) : -1;
  document.querySelector("#prevWeek").disabled = idx <= 0;
  document.querySelector("#nextWeek").disabled = idx < 0 || idx >= keys.length - 1;
}

// ── live render ───────────────────────────────────────────────────────────────

function render() {
  const predictions = appData.fixtures.map(f => predictFixture(f, teamById)).filter(passesFilters);
  renderPredictions(predictions);
  setDataSource(null);
}

// ── saved predictions loader ──────────────────────────────────────────────────

// Reconstruct { '1', 'X', '2' } probability map from the predictions.json shape.
function reconstructProbs(saved) {
  const top   = saved.confidence;      // topProbability stored as float
  const drawP = saved.drawProbability;
  const upset = saved.upsetProbability;

  if (saved.predictedOutcome === '1') return { '1': top,  'X': drawP, '2': upset };
  if (saved.predictedOutcome === '2') return { '1': upset, 'X': drawP, '2': top  };
  // 'X' pick: drawP is the highest. Remaining split between home/away is unknown,
  // so display as equal halves — the pick and draw% already carry the key info.
  const half = Math.max(0, 1 - drawP) / 2;
  return { '1': half, 'X': drawP, '2': half };
}

// Derive the confidence grade from a saved fixture's stored floats.
function savedConfidenceLabel(saved) {
  const top    = saved.confidence;
  const second = saved.predictedOutcome === 'X'
    ? saved.upsetProbability
    : Math.max(saved.drawProbability, saved.upsetProbability);
  return confidenceFromProb(top, second, saved.drawProbability);
}

// Adapt a predictions.json fixture entry to the shape renderPredictions() expects.
function transformSaved(saved) {
  if (saved.status === 'unavailable') {
    return {
      status:         'unavailable',
      fixture:        { league: saved.league, date: saved.date ?? null, matchday: saved.matchday ?? null },
      home:           { name: saved.homeTeam },
      away:           { name: saved.awayTeam },
      probabilities:  null,
      pick:           null,
      confidence:     null,
      topProbability: null,
      couponRec:      null,
      reasons:        [saved.reason ?? 'Unavailable'],
    };
  }
  const probs = reconstructProbs(saved);
  const conf  = savedConfidenceLabel(saved);
  return {
    status:         'available',
    fixture:        { league: saved.league, date: saved.date ?? null, matchday: saved.matchday ?? null },
    home:           { name: saved.homeTeam },
    away:           { name: saved.awayTeam },
    probabilities:  probs,
    pick:           saved.predictedOutcome,
    confidence:     conf,
    topProbability: saved.confidence,
    couponRec:      saved.couponRecommendation,
    reasons:        [],
  };
}

function resetSummary() {
  document.querySelector("#totalGames").textContent = "0";
  document.querySelector("#topPick").textContent = "-";
  document.querySelector("#avgConfidence").textContent = "-";
}

async function loadSavedPredictions() {
  const tbody = document.querySelector("#predictionRows");
  const codes = state.league === 'all' ? ['PL', 'ELC'] : [state.league];

  const settled = await Promise.allSettled(
    codes.map(code =>
      fetch(PREDICTION_FILES[code])
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    )
  );

  let allPredictions = [];
  const failedCodes  = [];
  let latestTimestamp = null;
  const seasons = new Set();

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const code   = codes[i];
    if (result.status === 'fulfilled') {
      const data = result.value;
      const fixturesArr = Array.isArray(data.fixtures) ? data.fixtures : [];
      allPredictions.push(...fixturesArr.map(transformSaved));
      if (data.generatedAt && (!latestTimestamp || data.generatedAt > latestTimestamp)) {
        latestTimestamp = data.generatedAt;
      }
      if (data.season?.label) seasons.add(data.season.label);
    } else {
      failedCodes.push(code);
    }
  }

  // Season indicator.
  const seasonEl = document.querySelector("#seasonLabel");
  if (seasons.size === 1) {
    seasonEl.textContent = [...seasons][0];
    seasonEl.classList.remove('warning');
  } else if (seasons.size > 1) {
    seasonEl.textContent = `⚠ ${[...seasons].join(' / ')}`;
    seasonEl.classList.add('warning');
  } else {
    seasonEl.textContent = '—';
    seasonEl.classList.remove('warning');
  }

  if (allPredictions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">'
      + 'No saved predictions found. Run: <code>node generatePredictions.js</code>'
      + '</td></tr>';
    setDataSource(failedCodes.length ? `Failed to load: ${failedCodes.join(', ')}` : null);
    resetSummary();
    loadedPredictions = [];
    loadedGeneratedAt = null;
    weekGroups = new Map();
    return;
  }

  loadedPredictions = allPredictions;
  loadedGeneratedAt = latestTimestamp;

  // Rebuild week groups and selector.
  const prevWeek = state.week;
  weekGroups = buildWeekGroups(allPredictions);
  populateWeekSelector(weekGroups);

  // Preserve the selected week if it still has fixtures, otherwise pick the default.
  state.week = (prevWeek && weekGroups.has(prevWeek)) ? prevWeek : defaultWeekKey(weekGroups);
  document.querySelector("#weekFilter").value = state.week ?? '';

  applyAndRender();

  if (failedCodes.length) {
    const ts = latestTimestamp ? new Date(latestTimestamp).toLocaleString() : 'unknown';
    setDataSource(
      `Saved predictions · Generated ${ts} · ⚠ Failed to load: ${failedCodes.join(', ')}`
    );
  }
}

function initFilters() {
  const leagueFilter = document.querySelector("#leagueFilter");

  // Fixed league list — option values are codes so state.league === PREDICTION_FILES key.
  [{ code: 'PL', name: 'Premier League' }, { code: 'ELC', name: 'Championship' }]
    .forEach(({ code, name }) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      leagueFilter.appendChild(opt);
    });

  leagueFilter.addEventListener("change", event => {
    state.league = event.target.value;
    loadSavedPredictions();
  });

  document.querySelector("#confidenceFilter").addEventListener("change", event => {
    state.confidence = event.target.value;
    applyAndRender();
  });

  document.querySelector("#weekFilter").addEventListener("change", event => {
    state.week = event.target.value || null;
    applyAndRender();
  });

  document.querySelector("#prevWeek").addEventListener("click", () => {
    const keys = [...weekGroups.keys()];
    const idx  = keys.indexOf(state.week);
    if (idx > 0) {
      state.week = keys[idx - 1];
      document.querySelector("#weekFilter").value = state.week;
      applyAndRender();
    }
  });

  document.querySelector("#nextWeek").addEventListener("click", () => {
    const keys = [...weekGroups.keys()];
    const idx  = keys.indexOf(state.week);
    if (idx >= 0 && idx < keys.length - 1) {
      state.week = keys[idx + 1];
      document.querySelector("#weekFilter").value = state.week;
      applyAndRender();
    }
  });

  document.querySelector("#runBtn").addEventListener("click", loadSavedPredictions);

  document.querySelector("#loadSavedBtn").addEventListener("click", loadSavedPredictions);
}

(async () => {
  initFilters();
  await loadSavedPredictions();
})();
