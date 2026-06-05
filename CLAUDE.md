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

## File map

| File                   | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `app.js`               | Demo data, rendering, filter state, startup fetch            |
| `predict.js`           | Pure prediction engine (no DOM) — imported by app.js and backtest.js |
| `apiAdapter.js`        | football-data.org adapter — normalises to canonical shape    |
| `backtest.js`          | Node.js backtest harness — run with `node backtest.js`       |
| `index.html`           | UI shell                                                     |
| `style.css`            | All styles                                                   |
| `package.json`         | `"type":"module"` only — enables ES imports in Node.js       |

## Prediction model (current)

Inputs per team: `pointsPerGame`, `homePointsPerGame`, `awayPointsPerGame`, `goalsForPerGame`, `goalsAgainstPerGame`, `drawRate`, `position`, `restDays`, `recent` (last N results).

Three scores are computed (home, away, draw), passed through softmax to get probabilities. Confidence is derived from the gap between top and second outcome.

Key weights are in `predictFixture()` in `predict.js`. Do not touch these without a reason — they are hand-tuned, not trained.

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
