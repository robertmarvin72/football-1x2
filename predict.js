// ── Confidence / grading helpers ─────────────────────────────────────────────
// These operate on raw probabilities and are independent of predictFixture().
// They are used by backtestConfidence.js and can feed a future UI grade badge.

// Simple argmax on the three outcome probabilities.
// Note: predictFixture() applies a draw-pick threshold for coupon purposes;
// this function returns the pure probability winner.
export function getPredictedOutcome(homeProb, drawProb, awayProb) {
  if (drawProb >= homeProb && drawProb >= awayProb) return 'X';
  if (homeProb >= awayProb) return '1';
  return '2';
}

// Composite confidence score in the range [0, 100].
// Formula: (highestProb * 0.7) + (margin * 0.3), scaled to integer percent.
// The margin term rewards decisive gaps over flat probability distributions.
export function getPredictionConfidence(homeProb, drawProb, awayProb) {
  const sorted = [homeProb, drawProb, awayProb].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  return Math.round((sorted[0] * 0.7 + margin * 0.3) * 100);
}

// Letter grade based on confidence score.
export function getPredictionGrade(confidence) {
  if (confidence >= 80) return 'A+';
  if (confidence >= 70) return 'A';
  if (confidence >= 60) return 'B';
  if (confidence >= 50) return 'C';
  return 'D';
}

// ── Core prediction helpers ───────────────────────────────────────────────────

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
  // qualityGap removes the +2.1 home advantage offset from the balance measure.
  // strengthGap is biased +2.1 for every fixture; qualityGap is a purer measure
  // of whether the two sides are genuinely matched on quality alone.
  const qualityGap  = Math.abs((homeScore - 2.1) - awayScore);
  const expectedGoals = home.goalsForPerGame + away.goalsForPerGame;

  // ── Draw probability (independent of home/away softmax) ──────────────────
  //
  // WHY THE OLD APPROACH COLLAPSED:
  // The previous code fed drawScore (~5-8) into a 3-way softmax alongside
  // homeScore/awayScore (~15-18). After dividing all three by 4.2, the gap
  // between home (~3.9) and draw (~1.5) scores was ~2.4. In the exponent:
  // exp(2.4) ≈ 11×, so draw received only ~5-8% of the probability mass in
  // almost every fixture — far below the real-world ~27% draw rate.
  //
  // FIX: compute p_draw via a sigmoid on draw-specific signals, independent
  // of homeScore/awayScore. Home and away then split (1 − p_draw).
  const formDiff = Math.abs(homeForm - awayForm);

  // Use home-specific / away-specific draw rates when available (set by backtest.js).
  // Falls back to aggregate drawRate for live app data.
  const homeContextDR = home.homeDrawRate ?? home.drawRate;
  const awayContextDR = away.awayDrawRate ?? away.drawRate;
  const contextualDR  = (homeContextDR + awayContextDR) / 2;

  // Recent draw tendency: fraction of recent results that were draws.
  // This is responsive to current-season form and is a stronger near-term signal
  // than the season-long draw rate, which converges toward the ~25% baseline.
  const homeRecentDR = home.recent.filter(r => r === 'D').length / Math.max(home.recent.length, 1);
  const awayRecentDR = away.recent.filter(r => r === 'D').length / Math.max(away.recent.length, 1);
  const recentDR     = (homeRecentDR + awayRecentDR) / 2;

  // Each term is independently interpretable and was tuned against backtest.
  //
  // Iteration history:
  //   avgDrawRate * 1.50, base -0.75  → 11.4% draw rate (too low)
  //   threshold 0.31                  → 32.7% rate, 25.7% hit (hit too low)
  //   threshold raised to 0.335       → 25.3% rate, 25.8% hit (hit still low)
  //   avgDrawRate * 6.0, base -2.0    → 35.4% rate, 26.5% hit (rate too high, hit still low)
  //   contextualDR * 4.0, base -1.20  → 31.5% rate, 25.0% hit (near-random)
  //   qualityGap replaces strengthGap → 22.5% rate, 24.5% hit
  //   recentDR added (sigmoid)        → 36.1% rate, 25.6% hit
  //   additive model clamped 0.15-0.45→ 32.2% rate, 25.3% hit
  //   → All approaches converge at ~25% draw hit. Root cause: real draw rate
  //     varies only 21-31% across any feature bucket. Strongest separating
  //     feature is qualityGap (quality balance without home advantage bias).
  //     Using sigmoid with strong qualityGap penalty + moderate contextualDR,
  //     capping recentDR to avoid the anti-draw high tail.
  //
  // -0.80 : base — lands typical balanced match near the decision boundary
  // -0.22 : per unit of qualityGap — primary suppressor; mismatched teams draw less
  // -0.04 : per unit of formDiff  — form disparity suppresses draws
  // +2.50 : contextualDR          — home/away draw history (supporting signal)
  // +1.00 : recentDR              — capped signal; prevents anti-draw tail
  // scoringFactor: max(0, 2.9 - xGoals) * 0.25 — aggregate low-scoring bonus
  // mutualAttWeak: min(homeAttack, awayAttack) weakness * 0.50 — both teams struggling
  //   to score is a genuine draw predictor (0-0, 1-1 patterns); min() ensures
  //   it only fires when BOTH sides are weak, not just one.
  const cappedRecentDR = Math.min(recentDR, 0.33);
  const scoringFactor  = Math.max(0, 2.9 - expectedGoals) * 0.25;
  const homeAttWeak    = Math.max(0, 1.5 - home.goalsForPerGame);
  const awayAttWeak    = Math.max(0, 1.5 - away.goalsForPerGame);
  const mutualAttWeak  = Math.min(homeAttWeak, awayAttWeak) * 0.50;
  const drawTendency =
    -0.80
    - qualityGap    * 0.22
    - formDiff      * 0.04
    + contextualDR  * 2.50
    + cappedRecentDR * 1.00
    + scoringFactor
    + mutualAttWeak;

  const drawProb = 1 / (1 + Math.exp(-drawTendency));

  // Home and away split the remaining probability proportionally.
  // /4.2 controls softmax temperature (unchanged from original).
  const [homeFrac, awayFrac] = softmax([homeScore / 4.2, awayScore / 4.2]);
  const homeProb = (1 - drawProb) * homeFrac;
  const awayProb = (1 - drawProb) * awayFrac;

  // Draw candidate: draw probability meets or exceeds the coupon threshold.
  // Separate from the pick threshold — used for coupon recommendation only.
  const drawCandidate = drawProb >= 0.28;

  // ── Outcome ranking & pick ───────────────────────────────────────────────
  // Because homeProb is always boosted by home advantage, drawProb never
  // "wins" a naive max() comparison in most fixtures even when the match is
  // genuinely balanced. We therefore use a fixed pick threshold: if drawProb
  // is elevated enough to be actionable (≥ 0.31), call X regardless of
  // whether homeProb is nominally higher. For coupon purposes, a 31%+ draw
  // probability is too important to hide behind a home-win prediction.
  //
  // DRAW_PICK_THRESHOLD = 0.40
  // Calibration ceiling: 10+ iterations showed that draw hit rate ≥ 30% is not
  // achievable with the available feature set. The maximum achievable in any
  // identifiable subgroup is ~27-31% but only for ~12% of fixtures — too few to
  // satisfy the ≥20% draw prediction rate constraint simultaneously. Raising the
  // threshold to 0.40 maximises overall hit rate (45.4%) at the cost of draw
  // prediction rate (16.6%). No threshold satisfies all three constraints at once;
  // 0.40 is chosen because it meets the most important floor (overall ≥ 45%).
  // To improve: add more seasons (currently only 2 real seasons available), or
  // add in-form defensive efficiency as a feature.
  const DRAW_PICK_THRESHOLD = 0.40;

  const outcomes = [
    { key: "1", prob: homeProb },
    { key: "X", prob: drawProb },
    { key: "2", prob: awayProb }
  ].sort((a, b) => b.prob - a.prob);

  const pick = drawProb >= DRAW_PICK_THRESHOLD
    ? "X"
    : (homeProb >= awayProb ? "1" : "2");

  // Confidence is based on the actual probability spread, not the pick label.
  const confidence = confidenceFromProb(outcomes[0].prob, outcomes[1].prob);

  // ── Coupon recommendation ────────────────────────────────────────────────
  // Priority order matches the spec:
  //   1. drawCandidate + Low  → Triple  (high uncertainty, draw likely)
  //   2. drawCandidate + Med  → Double including draw
  //   3. High confidence      → Single  (including confident draw picks)
  //   4. Medium confidence    → Double  (top two outcomes)
  //   5. Low confidence       → Triple
  let couponRec;
  if (drawCandidate && confidence === "Low") {
    couponRec = "Triple (1X2)";
  } else if (drawCandidate && confidence === "Medium") {
    if      (pick === "1") couponRec = "Double (1X)";
    else if (pick === "2") couponRec = "Double (X2)";
    else /* X is top */    couponRec = outcomes[1].key === "1" ? "Double (1X)" : "Double (X2)";
  } else if (confidence === "High") {
    couponRec = `Single (${pick})`;
  } else if (confidence === "Medium") {
    const pair = [pick, outcomes[1].key].sort().join("");
    couponRec = `Double (${pair})`;
  } else {
    couponRec = "Triple (1X2)";
  }

  // ── Reasons ──────────────────────────────────────────────────────────────
  const reasons = [];
  if (homeForm > awayForm + 1) reasons.push(`${home.name} has stronger recent form`);
  if (awayForm > homeForm + 1) reasons.push(`${away.name} has stronger recent form`);
  if (home.homePointsPerGame > away.awayPointsPerGame + 0.35) reasons.push(`${home.name} is stronger at home`);
  if (away.awayPointsPerGame > home.homePointsPerGame + 0.25) reasons.push(`${away.name} travels well`);
  if (home.position + 4 < away.position) reasons.push(`${home.name} has a clear table edge`);
  if (away.position + 4 < home.position) reasons.push(`${away.name} has a clear table edge`);
  if (drawCandidate) reasons.push(`draw candidate — ${Math.round(drawProb * 100)}% draw probability`);
  else if (strengthGap < 3.5) reasons.push("teams grade out similarly, some draw risk");
  if (reasons.length === 0) reasons.push("balanced profile, low model separation");

  return {
    fixture,
    home,
    away,
    probabilities: { "1": homeProb, "X": drawProb, "2": awayProb },
    pick,
    confidence,
    topProbability: outcomes[0].prob,
    drawCandidate,
    couponRec,
    reasons
  };
}
