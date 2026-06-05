# AGENTS.md — Football Pools Assistant

## Product Goal

This project exists to improve English football pool coupons.
The primary output is not raw probabilities — it is actionable coupon advice.

For every fixture the system should aim to provide:
- Predicted outcome (1/X/2)
- Confidence score
- Draw probability
- Upset probability
- Coupon recommendation: Single / Double (1X, X2, 12) / Triple (1X2)

## Decision-Making Principles

When proposing changes:
1. Prioritize features that improve coupon construction.
2. Prioritize draw identification.
3. Prioritize uncertainty detection.
4. Prioritize upset detection.
5. Prefer transparent logic over black-box systems.
6. Require backtesting evidence before adding prediction factors.
7. Do not introduce machine learning unless it clearly improves results.

## Project context for agents

This is a single-page, no-build vanilla JS app. There is no test runner, no linter config, no CI. Read `CLAUDE.md` first for the full picture.

## How to verify your work

There is no automated test suite yet. After any change:

1. Open `index.html` in a browser (or `npx serve .`).
2. Check that all three fixtures render with probabilities that sum to ~100%.
3. Check that league and confidence filters work.
4. Check the browser console for errors.

For logic changes to `predictFixture()`, also manually verify:

- Probabilities are in (0, 1) and sum to 1.
- Confidence label matches the gap thresholds in `confidenceFromProb()`.
- The "Why" column contains at least one reason per fixture.
- Every fixture receives a coupon recommendation.
- Confidence levels remain sensible across fixtures.
- Draw candidates are surfaced correctly.
- High-risk fixtures are clearly identified.

## Where things live

- **Prediction logic**: `predictFixture()` in `predict.js` — signature is `predictFixture(fixture, teamById)`
- **Form scoring**: `formScore()` in `predict.js`
- **Filter state**: `state` object in `app.js`
- **Rendering**: `render()` in `app.js`
- **Data shape contract**: `apiAdapter.js` (comments) and `CLAUDE.md`
- **Backtesting**: `backtest.js` — run with `node backtest.js`

## Rules for code changes

- Prediction logic lives in `predict.js`. Do not duplicate it in `app.js` or `backtest.js`.
- `predictFixture(fixture, teamById)` takes `teamById` as a parameter — do not revert to a module-level closure.
- Do not change the canonical data shape without updating both `apiAdapter.js` (comments) and `CLAUDE.md`.
- Do not rename team ids — fixtures reference teams by id string.
- Weights in `predictFixture()` are intentional. If you change them, document why in the commit message.
- `softmax()` and `clamp()` are pure functions — keep them that way.

## Adding a real API adapter

1. Implement in `apiAdapter.js`. Export `fetchFootballData()` returning the canonical shape.
2. Set `DEMO_MODE = false`.
3. In `app.js`, replace the `demoData` reference with an `await fetchFootballData()` call at startup.
4. Do not mix normalization logic into `app.js`. All provider-specific mapping stays in `apiAdapter.js`.

## Adding a new team or fixture

Edit `demoData` in `app.js`. Both `teams` and `fixtures` arrays. Fixture `home`/`away` values must match a team `id`.

## Backtesting

`backtest.js` is implemented. Run with `node backtest.js` (requires Node.js 18+).

- Fetches all finished ELC matches for season 2025 from football-data.org.
- Evaluates each match using only data that was available before that match's date.
- Requires ≥ 5 prior matches per team; skips earlier fixtures.
- First run results are in `BACKTEST_RESULTS.md`.

When modifying the model in `predict.js`, re-run the backtest to confirm the hit rate does not regress.

## What agents should not do

- Do not add npm packages or a `package.json` unless explicitly asked.
- Do not refactor working UI code for style preferences.
- Do not add a framework.
- Do not modify `style.css` when fixing logic bugs.
- Do not add head-to-head data as a primary model input.
