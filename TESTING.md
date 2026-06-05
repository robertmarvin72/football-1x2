# TESTING.md — Verifying the football-data.org adapter

## 1. Get an API key

Register at https://www.football-data.org/client/register and copy the free-tier token from your dashboard.

## 2. Insert the key

Open `apiAdapter.js` and replace the placeholder on line 1:

```js
const API_KEY = "YOUR_API_KEY_HERE";
```

Replace `"YOUR_API_KEY_HERE"` with your actual token string.

## 3. Check the competition codes

The adapter uses:

| Variable | Code | League             |
| -------- | ---- | ------------------ |
| PL       | PL   | Premier League     |
| ELC      | ELC  | Championship       |

The free tier of football-data.org covers the Premier League (PL). The Championship (ELC) may require a paid plan — if it returns HTTP 403 you will see a clear error in the browser console and the app will fall back to demo data for that competition. Change the code in the `COMPETITIONS` array at the top of `apiAdapter.js` if needed.

## 4. Serve the app

```bash
npx serve .
```

Open http://localhost:3000 (or whichever port `serve` reports).

## 5. What to verify

Open the browser DevTools (F12) → Console tab before loading.

**Expected on success:**
- No errors in the console.
- The Predictions table shows real upcoming fixtures with team names from the current season.
- Probabilities in the 1 / X / 2 columns sum to ~100% per row.
- The League filter drop-down populates with "Premier League" and/or "Championship".
- The confidence filter works without breaking the table.

**Expected on a bad key (401):**
- Console warning: `Live data fetch failed — falling back to demo data. football-data.org … → HTTP 401`.
- App still renders using the hard-coded demo fixtures.

**Expected on a rate-limit hit (429):**
- Same fallback behaviour with HTTP 429 in the message.
- The free tier allows 10 requests per minute; the adapter makes 6 parallel requests at startup so you have plenty of headroom for normal use.

## 6. Spot-check the normalisation

In the console, run:

```js
// Paste after the page has loaded to inspect live data
const mod = await import('./apiAdapter.js');
const data = await mod.fetchFootballData();
console.table(data.teams.map(t => ({
  id: t.id, name: t.name, pos: t.position,
  ppg: t.pointsPerGame.toFixed(2),
  drawRate: t.drawRate.toFixed(2),
  recent: t.recent.join(''),
  rest: t.restDays
})));
console.log('fixtures:', data.fixtures.length);
```

Sanity checks:
- `pointsPerGame` is between 0 and 3 for all teams.
- `drawRate` is between 0 and 1.
- `recent` contains only "W", "D", "L" entries (up to 6).
- `restDays` is a non-negative integer.
- Every fixture's `home` and `away` value matches a `team.id` in the teams array.
