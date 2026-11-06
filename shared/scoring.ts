/**
 * Public scoring methodology. Versioned; any change bumps METHODOLOGY_VERSION and
 * must be reflected on the public methodology page.
 */

export const METHODOLOGY_VERSION = "2026.11-v2";
/** Shown to the public instead of the version code. Update together with METHODOLOGY_VERSION. */
export const METHODOLOGY_CHANGED_ON = "1 November 2026";

export const SCORING = {
  /**
   * Minimum COUNTED, distinct-nullifier ballots in the window to appear in Best/Lowest lists.
   * 1 = every rated listing is shown; the Bayesian prior (m below) keeps thinly rated listings
   * near the cohort average instead of letting a single 10 top the list.
   */
  minRankingVotes: 1,
  /** Bayesian prior strength m. */
  priorStrength: 20,
  /** Hours a valid countable ballot is held PROVISIONAL before it may count. */
  maturationHours: 24,
  /** Days between score changes for the same entity-scoped nullifier. */
  cooldownDays: 30,
  /** Rolling window for the primary ranking period. */
  windowDays: 365,
  /** Below this many counted ratings a profile shows "Not enough ratings" instead of an average. */
  profileMinDisplay: 1,
  /** Histogram hidden entirely below this many counted ratings. */
  histogramMinTotal: 1,
  /** Non-zero histogram buckets below this are shown as "fewer than N" (1 = no suppression). */
  histogramMinBucket: 1,
} as const;

export type Period = "12m" | "all";
export const PERIODS: readonly Period[] = ["12m", "all"];

export interface EntityAggregate {
  count: number;
  sum: number;
}

export function rawMean(a: EntityAggregate): number | null {
  return a.count > 0 ? a.sum / a.count : null;
}

/** ranking_score = (n/(n+m))·raw + (m/(n+m))·cohort_mean */
export function bayesianScore(a: EntityAggregate, cohortMean: number, m: number = SCORING.priorStrength): number {
  const n = a.count;
  if (n === 0) return cohortMean;
  const raw = a.sum / n;
  return (n / (n + m)) * raw + (m / (n + m)) * cohortMean;
}

export function cohortMeanOf(rows: EntityAggregate[]): number | null {
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    count += r.count;
    sum += r.sum;
  }
  return count > 0 ? sum / count : null;
}

export interface RankableRow extends EntityAggregate {
  entityId: string;
  name: string;
}

export interface RankedRow extends RankableRow {
  rawMean: number;
  adjustedScore: number;
  rank: number;
}

/**
 * Qualify (n >= threshold) and order best-first.
 * Ties: adjusted score, then eligible count, then stable name ordering. No paid priority.
 */
export function rankRows(
  rows: RankableRow[],
  cohortMean: number,
  opts: { minVotes?: number; m?: number } = {},
): RankedRow[] {
  const minVotes = opts.minVotes ?? SCORING.minRankingVotes;
  const m = opts.m ?? SCORING.priorStrength;
  const ranked = rows
    .filter((r) => r.count >= minVotes)
    .map((r) => ({ ...r, rawMean: r.sum / r.count, adjustedScore: bayesianScore(r, cohortMean, m), rank: 0 }));
  ranked.sort(compareBest);
  ranked.forEach((r, i) => (r.rank = i + 1));
  return ranked;
}

function compareBest(a: RankedRow, b: RankedRow): number {
  if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
  if (b.count !== a.count) return b.count - a.count;
  return a.name.localeCompare(b.name, "en") || a.entityId.localeCompare(b.entityId);
}

/** Lowest-rated ordering among the same qualified rows (ties: lower adjusted, more votes, name). */
export function lowestFirst(rows: RankedRow[]): RankedRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.adjustedScore !== b.adjustedScore) return a.adjustedScore - b.adjustedScore;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name, "en") || a.entityId.localeCompare(b.entityId);
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

export type HistogramCell = { score: number; count: number | null; suppressed: boolean };

/** Integer-only 1..10 histogram with small-number suppression. Returns null if hidden entirely. */
export function publicHistogram(histogram: number[], total: number): HistogramCell[] | null {
  if (total < SCORING.histogramMinTotal) return null;
  return histogram.map((count, i) => {
    const suppressed = count > 0 && count < SCORING.histogramMinBucket;
    return { score: i + 1, count: suppressed ? null : count, suppressed };
  });
}

export function formatScore(mean: number | null): string {
  if (mean === null) return "–";
  return (Math.round(mean * 10) / 10).toFixed(1);
}

/** Plain-language count for explanations: "one counted rating" / "30 counted ratings". */
export function countedRatings(n: number): string {
  return n === 1 ? "one counted rating" : `${n.toLocaleString("en")} counted ratings`;
}

export function emptyHistogram(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}
