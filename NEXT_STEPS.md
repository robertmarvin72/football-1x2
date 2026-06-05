# Next Build Notes

## Best next ticket

Add a real API adapter and normalize real football data into the local shape.

## Suggested data flow

API response
→ normalize teams
→ normalize fixtures
→ calculate rolling form
→ calculate home/away metrics
→ prediction engine
→ UI

## Important warning

Do not overfit head-to-head data.
For 1X2, team current strength matters more than what happened between the same clubs 3 years ago.

## Backtesting idea

For each historical fixture:
1. Pretend the fixture has not happened yet.
2. Build team stats only from earlier matches.
3. Predict 1/X/2.
4. Compare prediction to actual result.
5. Track hit rate and calibration.
