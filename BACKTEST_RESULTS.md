# BACKTEST_RESULTS.md

## Run details

- **Date**: 2026-06-04
- **Competition**: ELC (Championship 2025/26 season)
- **Script**: `node backtest.js`
- **Source**: football-data.org — 557 fetched, 497 evaluated, 60 skipped (< 5 prior matches per team)

## Raw output

```
Total fixtures evaluated: 497
Skipped (insufficient data): 60
Hit rate: 45.5% (correct 1/X/2)
By confidence:
  High:   190/393 (48.3%)
  Medium: 26/64 (40.6%)
  Low:    10/40 (25.0%)
By outcome type:
  Home wins predicted: 142/286 (49.7%)
  Draws predicted:     1/5 (20.0%)
  Away wins predicted: 83/206 (40.3%)
```

## Observations

### Overall hit rate: 45.5%

Random baseline for 3-way 1X2 is ~33.3%. A 45.5% hit rate means the model is performing 12 percentage points above chance on the Championship 2025/26 season. That is a meaningful signal, not noise.

### Confidence tiers behave as expected — mostly

High and Medium tiers outperform the random baseline clearly. The Low tier (25.0%) is below random, which means Low-confidence predictions should be filtered out in live use, or treated as no-bet. This is expected model behaviour: when the model cannot separate the teams, its pick degrades to chance or worse.

### The draw problem

The model predicted only 5 draws out of 497 fixtures (1.0%), hitting just 1 of them (20%). In reality, roughly 25–27% of Championship matches end in a draw. This is the clearest calibration weakness: the model's `drawScore` formula needs its baseline raised or the draw-rate weight increased to push more X predictions through.

### Home vs away predictions

| Pick | Correct | Total | Hit rate |
| ---- | ------- | ----- | -------- |
| 1 (home win) | 142 | 286 | **49.7%** |
| X (draw)     |   1 |   5 | 20.0%   |
| 2 (away win) |  83 | 206 | **40.3%** |

Home-win predictions are the most reliable. Away-win predictions are still above the ~30% raw away-win frequency in the Championship, suggesting the model correctly identifies mismatches when it predicts away wins.

## Suggested next steps (priority order)

1. **Fix draw under-prediction**: Raise the `drawScore` formula baseline in `predict.js`. Target: predict X on ≥15% of fixtures before worrying about calibration.
2. **Filter out Low confidence in live view**: Add a default filter or visual indicator to de-emphasise Low picks, which perform below random.
3. **Run PL backtest**: Re-run with `COMPETITION = 'PL'` to see if the same patterns hold in the top flight.
4. **Log probabilities alongside picks**: Record `homeProb`, `drawProb`, `awayProb` in backtest output to enable Brier score and calibration curve analysis later.
