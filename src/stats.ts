/**
 * Required sample size for a proportion estimate using the finite population
 * correction formula.
 *
 * Based on: n = (Z² × p × (1-p)) / E²  corrected by  n / (1 + (n-1) / N)
 *
 * @param N           Total population (all reviews for this hotel)
 * @param confidence  Desired confidence level (default 0.95)
 * @param margin      Desired margin of error (default 0.05, i.e. ±5%)
 */
export function requiredSampleSize(
  N: number,
  confidence = 0.95,
  margin = 0.05
): number {
  const z = zScore(confidence);
  const nInfinite = (z * z * 0.25) / (margin * margin); // p=0.5 worst case
  const nAdjusted = nInfinite / (1 + (nInfinite - 1) / N);
  return Math.min(N, Math.ceil(nAdjusted));
}

/**
 * Compute mean, standard deviation, and confidence interval for an array of
 * numeric scores (e.g. review scores on a 0–10 scale).
 */
export function computeStats(
  scores: number[],
  confidence = 0.95
): {
  mean: number;
  stdDev: number;
  ci: { lower: number; upper: number; margin: number };
  n: number;
} {
  const n = scores.length;
  if (n === 0) {
    return { mean: 0, stdDev: 0, ci: { lower: 0, upper: 0, margin: 0 }, n: 0 };
  }

  // Welford's online algorithm: mean and variance in a single pass.
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const x = scores[i];
    const delta = x - mean;
    mean += delta / (i + 1);
    m2 += delta * (x - mean);
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const se = stdDev / Math.sqrt(n);
  const z = zScore(confidence);
  const marginVal = z * se;

  return {
    mean,
    stdDev,
    ci: {
      lower: mean - marginVal,
      upper: mean + marginVal,
      margin: marginVal,
    },
    n,
  };
}

/**
 * Compute a trend score: compare the mean of the older half of reviews
 * vs the newer half.  Reviews should be sorted newest-first.
 *
 * Returns { olderMean, newerMean, delta } where positive delta = improving.
 */
export function scoreTrend(scores: number[]): {
  olderMean: number;
  newerMean: number;
  delta: number;
  direction: "improving" | "declining" | "stable";
} {
  if (scores.length < 4) {
    return { olderMean: 0, newerMean: 0, delta: 0, direction: "stable" };
  }

  const mid = Math.floor(scores.length / 2);
  // scores are newest-first, so [0..mid) = newer, [mid..) = older
  const newerScores = scores.slice(0, mid);
  const olderScores = scores.slice(mid);

  const newerMean = newerScores.reduce((a, b) => a + b, 0) / newerScores.length;
  const olderMean = olderScores.reduce((a, b) => a + b, 0) / olderScores.length;
  const delta = newerMean - olderMean;

  const direction =
    Math.abs(delta) < 0.2 ? "stable" : delta > 0 ? "improving" : "declining";

  return { olderMean, newerMean, delta, direction };
}

/**
 * Achieved confidence level and actual margin of error for a given sample.
 * Inverse of requiredSampleSize — tells you "given n out of N, what did we
 * actually achieve?"
 */
export function achievedMargin(n: number, N: number, confidence = 0.95): number {
  if (n <= 0 || N <= 1) return 0;
  const z = zScore(confidence);
  // Standard error for a proportion with p=0.5 (worst case), FPC applied
  const se = Math.sqrt((0.25 / n) * (1 - (n - 1) / (N - 1)));
  return z * se;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function zScore(confidence: number): number {
  if (confidence >= 0.99) return 2.576;
  if (confidence >= 0.95) return 1.960;
  if (confidence >= 0.90) return 1.645;
  return 1.282; // 80%
}
