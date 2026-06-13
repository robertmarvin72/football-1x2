# CLAUDE.md — Football Pools Assistant

## What this project is

A Football Pools Assistant that uses match prediction as an input to improve coupon construction. No backend, no build step, no framework. Runs directly in the browser.

## Project Mission

Help the user answer:
- Which matches are safe singles?
- Which matches need doubles?
- Which matches deserve triples?
- Which fixtures are strong draw candidates?
- Which favourites look vulnerable?

## Success Criteria

Success means:
- Better coupon recommendations
- Better draw detection
- Better upset detection
- Better identification of uncertainty
- Improved backtest performance

Success does NOT mean:
- Maximizing betting ROI
- Beating bookmakers
- Predicting exact scores
- Adding complexity for its own sake

## Stack

- Vanilla JS (ES modules)
- Plain HTML + CSS
- No bundler, no npm, no dependencies

## Run it

```bash
npx serve .
# or just open index.html in a browser
```

## Historical data

Location: `/data/historical/{league}/{season}.json`

Leagues covered (use these codes everywhere — CLI args, folder names, JSON fields):

| League           | Code | football-data.org code |
|------------------|------|------------------------|
| Premier League   | PL   | PL                     |
| Championship     | ELC  | ELC                    |

Do not use "EPL". The code `PL` must match what `apiAdapter.js` uses to avoid mismatches.

Seasons: always `YYYY-YY` format — English seasons span two calendar years.
Five seasons are stored: `2020-21`, `2021-22`, `2022-23`, `2023-24`, `2024-25`.

Why five seasons only: football teams change managers, owners, squads, and playing styles over time. Data older than five seasons has diminishing predictive value for coupon decisions and risks encoding stale signals.

**Current state:** All ten files (`PL` × 5, `ELC` × 5) contain clearly marked demo data (`"demo": true`) with fake team names ("Team A", "Team B", …). Replace with real match data before meaningful backtesting.

### Canonical JSON shape

```json
{
  "league": "PL",
  "leagueName": "Premier League",
  "season": "2024-25",
  "fixtures": [
    {
      "id": "PL-2024-25-001",
      "date": "2024-08-16",
      "homeTeam": "Arsenal",
      "awayTeam": "Wolves",
      "homeGoals": 2,
      "awayGoals": 0,
      "result": "1"
    }
  ]
}
```

Rules:
- `result` is `"1"` (home win), `"X"` (draw), or `"2"` (away win) — must match the goals
- `homeGoals` / `awayGoals` are integers
- `date` is `YYYY-MM-DD`
- `id` is `{league}-{season}-{zero-padded 3-digit index}`
- Demo files add `"demo": true` at the top level

### Running backtests against historical data

```bash
node validateHistoricalData.js                           # validate all files first
node backtest.js --source historical                     # all leagues, all seasons
node backtest.js --source historical --league PL         # Premier League only
node backtest.js --source historical --league ELC        # Championship only
node backtest.js --source historical --seasons 2023-24,2024-25
node backtest.js                                         # original API backtest (unchanged)
```

Historical data supports coupon quality improvement — it is not used to measure betting ROI.

## File map

| File                        | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `app.js`                    | Demo data, rendering, filter state, startup fetch                        |
| `predict.js`                | Pure prediction engine (no DOM) — imported by app.js and backtest.js     |
| `apiAdapter.js`             | football-data.org adapter — normalises to canonical shape                |
| `backtest.js`               | Node.js backtest harness — API and historical modes                      |
| `historicalData.js`         | Loader for /data/historical/ JSON files; works in Node.js and browser    |
| `validateHistoricalData.js` | Validates all historical JSON files — run before backtesting             |
| `index.html`                | UI shell                                                                 |
| `style.css`                 | All styles                                                               |
| `package.json`              | `"type":"module"` only — enables ES imports in Node.js                   |
| `data/historical/PL/`       | Premier League season files (2020-21 … 2024-25)                         |
| `data/historical/ELC/`      | Championship season files (2020-21 … 2024-25)                           |

## Prediction model (current)

Inputs per team: `pointsPerGame`, `homePointsPerGame`, `awayPointsPerGame`, `goalsForPerGame`, `goalsAgainstPerGame`, `drawRate`, `position`, `restDays`, `recent` (last N results).

Three scores are computed (home, away, draw), passed through softmax to get probabilities. Confidence is assigned as an A+/A/B/C/D grade derived from the gap between the top and second outcome probabilities — see **Confidence grading** below.

Key weights are in `predictFixture()` in `predict.js`. Do not touch these without a reason — they are hand-tuned, not trained.

## Confidence grading

Implemented in `confidenceFromProb()` in `predict.js`. Exported constants: `CONFIDENCE_THRESHOLDS`, `confidenceFromProb`.

### How it is calculated

```
gap = topProbability − secondProbability   (post-softmax, before draw penalty)

gap >= 0.45 → A+
gap >= 0.32 → A
gap >= 0.18 → B
gap >= 0.09 → C
else        → D
```

**Draw penalty:** if `p_draw > 0.30` AND the predicted outcome is home or away (not draw), cap grade at B. The penalty does not fire when draw is the top prediction — that would double-penalise a confident draw call.

### Coupon recommendation by grade

| Grade | Coupon recommendation      | Meaning                              |
|-------|---------------------------|--------------------------------------|
| A+    | Single                    | Clear favourite, high model separation |
| A     | Single                    | Solid pick, moderate draw risk       |
| B     | Single / Double (player's call) | Borderline — hedge if coupon allows |
| C     | Double                    | Prefer cover                         |
| D     | Triple (1X2)              | Too uncertain for singles or doubles |

### Final threshold values (`predict.js`)

```js
export const CONFIDENCE_THRESHOLDS = {
  A_PLUS: 0.45,
  A:      0.32,
  B:      0.18,
  C:      0.09,
};
const DRAW_PENALTY_THRESHOLD = 0.30;
```

### Why these values — not the original spec

The original Ticket #3 spec suggested lower thresholds (A_PLUS=0.35, A=0.25, B=0.15, C=0.08). A calibration sweep across 5 seasons of historical data (`backtestConfidence.js`) showed those produced identical accuracy for A and B (both 43%), making the B grade meaningless as a coupon signal.

The `top-heavy` set was the only candidate that produced strictly decreasing accuracy:

```
A+: 53%   (935 fixtures — high-confidence singles)
A:  41%   (173 fixtures)
B:  33%   (226 fixtures)
C:  32%   (159 fixtures)
D:  30%   (160 fixtures — doubles/triples territory)
```

The diagnostic also revealed why A and B converged: A-grade fixtures had Avg Draw% of 24% and B-grade 34% — elevated draw risk in both buckets was diluting accuracy at similar rates despite the larger gap in A. The `top-heavy` thresholds push more fixtures into A+, leaving A as a cleaner tier.

**Do not lower these thresholds without re-running `backtestConfidence.js` first.**

### Re-validating thresholds

```bash
node backtestConfidence.js
```

This prints the accuracy table, a per-grade diagnostic (Count / Accuracy / Avg Gap% / Avg Draw% / Min Gap% / Max Gap%), a gap threshold sweep over candidate sets, a draw penalty sweep, and applies the best-found thresholds to `predict.js` automatically.

If A and B accuracy converge (< 5pp apart), thresholds need tightening. Re-run after adding real season data.

## Data shape (canonical)

```js
{
  teams: [
    {
      id,              // string key, e.g. "arsenal"
      name,            // display name
      league,          // e.g. "Premier League"
      position,        // league table position (integer)
      pointsPerGame,
      goalsForPerGame,
      goalsAgainstPerGame,
      homePointsPerGame,
      awayPointsPerGame,
      drawRate,        // fraction, e.g. 0.24
      recent,          // array of "W"/"D"/"L", most recent last
      restDays         // days since last match
    }
  ],
  fixtures: [
    { id, league, home, away }  // home/away are team ids
  ]
}
```

Any real API adapter must normalize to this shape before passing data to the engine.

## Engineering Principles

- Explainability is more important than complexity.
- Simpler models are preferred when performance is similar.
- Every new factor must justify itself through backtesting.
- Avoid feature creep.
- The final output should help fill in a coupon.

## What NOT to do

- Do not add head-to-head history as a primary signal. Current team strength matters more than H2H from 2–3 years ago.
- Do not add a build step unless strictly necessary. Keep it runnable with `open index.html`.
- Do not split `predictFixture()` further — it already lives in `predict.js`.
- Do not add a framework (React, Vue, etc.) for UI that is already working.

## Next priorities (in order)

1. Draw candidate detection — improve draw probability signal; surface likely draws prominently in the UI.
2. Coupon recommendation engine — output a Single / Double (1X, X2, 12) / Triple (1X2) recommendation per fixture.
3. Upset detection — flag fixtures where the underdog has a meaningful win probability.
4. Real API adapter — normalize a provider (football-data.org, API-Football, or Sportmonks) into the canonical shape.
5. Historical fixture store — save past fixtures as JSON for backtesting.
6. Backtesting harness — see `NEXT_STEPS.md` for the procedure.
7. Weight calibration — tune model weights against backtested hit rate.
8. Odds comparison — map prediction probability to bookmaker implied probability.
