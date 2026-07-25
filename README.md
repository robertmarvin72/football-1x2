# 1X2 Football Predictor

A rule-based coupon assistant for English football pools. Predicts 1/X/2 outcomes for Premier League and Championship fixtures, grades confidence (A+→D), and recommends singles, doubles, or triples for each match.

No framework, no bundler, no npm dependencies — runs directly in the browser.

---

## Supported competitions

| Competition | Code |
|---|---|
| Premier League | `PL` |
| Championship | `ELC` |

---

## Setup

### 1. Get an API key

Register at [football-data.org](https://www.football-data.org) (free tier covers both competitions).

### 2. Create your local `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in your key:

```
FOOTBALL_DATA_API_KEY=your_key_here
STATS_SEASON=2025
```

`STATS_SEASON` controls which finished season is used to build team statistics. `2025` means the 2025/26 season; scheduled fixtures for 2026/27 are then fetched automatically.

### 3. Generate predictions

```bash
npm run predict
```

Output is written to:

```
data/predictions/PL/2026-27.json
data/predictions/ELC/2026-27.json
```

Each file contains all scheduled fixtures for that competition with predicted outcome, confidence grade, draw probability, and coupon recommendation per match.

---

## Open the UI

```bash
npx serve .
```

Or open `index.html` directly in a browser. Click **Load saved predictions** to display the last generated output.

---

## Other scripts

```bash
# Backtest and re-calibrate confidence thresholds against historical data
node backtestConfidence.js
# or:
npm run backtest:confidence
```

Historical data lives in `data/historical/{PL,ELC}/{season}.json`.

---

## How the model works

Three raw scores are computed per fixture (home win, draw, away win) and passed through softmax to get probabilities. Inputs include form, home/away strength, goals for/against, league position, rest days, and draw rate.

Confidence is graded from the gap between the top and second probability:

| Gap | Grade | Coupon recommendation |
|---|---|---|
| ≥ 0.45 | A+ | Single |
| ≥ 0.32 | A | Single |
| ≥ 0.18 | B | Single / Double |
| ≥ 0.09 | C | Double |
| < 0.09 | D | Triple (1X2) |

Teams that changed division (promoted or relegated) have their prior-season statistics scaled by division-adjustment factors before prediction. Teams with no usable statistics in either competition are marked `unavailable` and excluded from the coupon recommendations.
