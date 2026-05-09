import { z } from "zod";
import { bookingBrowser } from "../browser.js";
import type { FilterItem, RatingScore, ReviewCard, ReviewListFrontendInput } from "../queries.js";
import { achievedMargin, computeStats, requiredSampleSize, scoreTrend } from "../stats.js";

const PAGE_SIZE = 25;
const MAX_CONCURRENT_FETCHES = 4;

export const SummarizeHotelSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.includes("booking.com/hotel/"), {
      message: "Must be a booking.com hotel page URL",
    }),
  withinMonths: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(12)
    .describe("Only consider reviews from the last N months (default 12)"),
});

export type SummarizeHotelInput = z.infer<typeof SummarizeHotelSchema>;

// ── multi-page fetch ──────────────────────────────────────────────────────────

interface FetchResult {
  reviews: ReviewCard[];
  hitDateCutoff: boolean;
}

async function fetchRecentReviews(
  session: Awaited<ReturnType<typeof bookingBrowser.ensureSession>>,
  baseInput: ReviewListFrontendInput,
  cutoffTimestamp: number,   // unix seconds
  targetN: number,
  startSkip: number
): Promise<FetchResult> {
  const mostRecentSorter = bookingBrowser.resolveSorter(session, "newest", "NEWEST_FIRST");

  // Plan all offsets we might need upfront, then drain them concurrently.
  const offsets: number[] = [];
  for (let count = 0, off = startSkip; count < targetN; count += PAGE_SIZE, off += PAGE_SIZE) {
    offsets.push(off);
  }

  const resultsByOffset = new Map<number, ReviewCard[]>();
  let nextIdx = 0;
  let stop = false;

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_FETCHES, offsets.length) }, async () => {
      while (!stop) {
        const i = nextIdx++;
        if (i >= offsets.length) return;
        const offset = offsets[i];
        const page = await bookingBrowser.callGraphQL(session, {
          ...baseInput,
          sorter: mostRecentSorter,
          filters: { text: "" },
          skip: offset,
          limit: PAGE_SIZE,
        });
        resultsByOffset.set(offset, page.reviewCard);
        // Stop scheduling further pages if this one already crosses the cutoff
        // or if the API returned a short page (no more reviews).
        if (page.reviewCard.length < PAGE_SIZE) stop = true;
        else if (page.reviewCard.length > 0 &&
                 page.reviewCard[page.reviewCard.length - 1].reviewedDate < cutoffTimestamp) {
          stop = true;
        }
      }
    })
  );

  // Merge in offset order, applying the date cutoff and the targetN limit.
  const sortedOffsets = [...resultsByOffset.keys()].sort((a, b) => a - b);
  const reviews: ReviewCard[] = [];
  let hitDateCutoff = false;
  outer: for (const offset of sortedOffsets) {
    const cards = resultsByOffset.get(offset)!;
    for (const r of cards) {
      if (r.reviewedDate < cutoffTimestamp) {
        hitDateCutoff = true;
        break outer;
      }
      reviews.push(r);
      if (reviews.length >= targetN) break outer;
    }
    if (cards.length < PAGE_SIZE) break;
  }

  return { reviews, hitDateCutoff };
}

// ── formatting helpers ────────────────────────────────────────────────────────

function bar(value: number, max = 10, width = 10): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function fmtScore(n: number): string {
  return n.toFixed(1);
}

function formatRatingScores(scores: RatingScore[]): string {
  if (!scores.length) return "  (not available)\n";
  const sorted = [...scores].sort((a, b) => b.value - a.value);
  return sorted
    .map((s) => `  ${s.translation.padEnd(16)} ${bar(s.value)}  ${fmtScore(s.value)}/10`)
    .join("\n") + "\n";
}

function formatScoreDistribution(filters: FilterItem[], totalReviews: number): string {
  if (!filters.length) return "  (not available)\n";
  // API returns buckets like value="9" (meaning 9–10), value="7" (7–8), etc.
  // Sort descending by score value
  const sorted = [...filters].sort((a, b) => Number(b.value) - Number(a.value));
  let maxCount = 0;
  for (const f of filters) if (f.count > maxCount) maxCount = f.count;
  return sorted
    .map((f) => {
      const p = pct(f.count, totalReviews);
      return `  ${f.name.padEnd(16)} ${bar(f.count, maxCount)}  ${p.padStart(4)} (${f.count.toLocaleString()})`;
    })
    .join("\n") + "\n";
}

function formatCustomerTypes(filters: FilterItem[]): string {
  if (!filters.length) return "  (not available)\n";
  const total = filters.reduce((a, b) => a + b.count, 0);
  const sorted = [...filters].sort((a, b) => b.count - a.count);
  return sorted
    .map((f) => `  ${f.name.padEnd(16)} ${pct(f.count, total).padStart(4)} (${f.count.toLocaleString()})`)
    .join("\n") + "\n";
}

function formatTopLanguages(filters: FilterItem[], topN = 5): string {
  if (!filters.length) return "  (not available)\n";
  const total = filters.reduce((a, b) => a + b.count, 0);
  const sorted = [...filters].sort((a, b) => b.count - a.count).slice(0, topN);
  return sorted
    .map((f) => `  ${f.name.padEnd(16)} ${pct(f.count, total).padStart(4)} (${f.count.toLocaleString()})`)
    .join("\n") + "\n";
}

function formatRecentStats(
  reviews: ReviewCard[],
  totalReviews: number,
  newestDate: Date | null,
  oldestDate: Date | null,
  withinMonths: number,
  hitDateCutoff: boolean
): string {
  const scores = reviews.map((r) => r.reviewScore);
  const stats = computeStats(scores);
  const trend = scoreTrend(scores);
  const margin = achievedMargin(reviews.length, totalReviews);

  const dateRange = (newestDate && oldestDate)
    ? `${fmtDate(oldestDate)} – ${fmtDate(newestDate)}`
    : "unknown";

  const coverageNote = hitDateCutoff
    ? `All reviews within the last ${withinMonths} month(s) were fetched.`
    : `Fetched ${reviews.length} reviews — fewer than expected (hotel may have fewer recent reviews).`;

  // Score buckets from sample
  const buckets = { exceptional: 0, good: 0, fair: 0, poor: 0 };
  for (const s of scores) {
    if (s >= 9) buckets.exceptional++;
    else if (s >= 7) buckets.good++;
    else if (s >= 5) buckets.fair++;
    else buckets.poor++;
  }

  const trendArrow =
    trend.direction === "improving" ? "↑ Improving" :
    trend.direction === "declining" ? "↓ Declining" : "→ Stable";

  const trendDetail = scores.length >= 4
    ? ` (older half avg ${fmtScore(trend.olderMean)} → newer half avg ${fmtScore(trend.newerMean)})`
    : "";

  return [
    `RECENT REVIEWS (last ${withinMonths} month(s))`,
    `  Sampled:   ${reviews.length} reviews | ${dateRange}`,
    `  ${coverageNote}`,
    `  Confidence: ±${(margin * 10).toFixed(2)} pts on score (95% CI)`,
    ``,
    `  Recent avg score: ${fmtScore(stats.mean)}/10  [95% CI: ${fmtScore(stats.ci.lower)}–${fmtScore(stats.ci.upper)}]`,
    `  Trend:            ${trendArrow}${trendDetail}`,
    ``,
    `  Score breakdown (recent sample):`,
    `    Exceptional 9-10: ${bar(buckets.exceptional, reviews.length)}  ${pct(buckets.exceptional, reviews.length).padStart(4)} (${buckets.exceptional})`,
    `    Good        7-8:  ${bar(buckets.good,        reviews.length)}  ${pct(buckets.good,        reviews.length).padStart(4)} (${buckets.good})`,
    `    Fair        5-6:  ${bar(buckets.fair,        reviews.length)}  ${pct(buckets.fair,        reviews.length).padStart(4)} (${buckets.fair})`,
    `    Poor        <5:   ${bar(buckets.poor,        reviews.length)}  ${pct(buckets.poor,        reviews.length).padStart(4)} (${buckets.poor})`,
  ].join("\n") + "\n";
}

// ── main export ───────────────────────────────────────────────────────────────

export async function summarizeHotel(rawInput: unknown): Promise<string> {
  const input = SummarizeHotelSchema.parse(rawInput);

  const url = new URL(input.url);
  const cleanUrl = `${url.origin}${url.pathname}`;

  // Bootstrap session (navigate to page, capture CSRF + hotel metadata)
  const session = await bookingBrowser.ensureSession(cleanUrl);
  const baseInput = session.baseInput;

  const mostRecentSorterValue = bookingBrowser.resolveSorter(session, "newest", "NEWEST_FIRST");

  // First, fetch one page to get totalReviews and global metadata
  const firstPage = await bookingBrowser.callGraphQL(session, {
    ...baseInput,
    sorter: mostRecentSorterValue,
    filters: { text: "" },
    skip: 0,
    limit: PAGE_SIZE,
  });

  const totalReviews = firstPage.reviewsCount;
  const targetN = requiredSampleSize(totalReviews);
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - input.withinMonths * 30 * 24 * 3600;

  // Fetch statistically significant sample of recent reviews
  // (first page already fetched — continue from skip=PAGE_SIZE)
  const additionalReviews: ReviewCard[] = [];
  let hitDateCutoff = false;

  // Include first page reviews (filtered by date)
  const filteredFirstPage: ReviewCard[] = [];
  for (const r of firstPage.reviewCard) {
    if (r.reviewedDate < cutoffTimestamp) { hitDateCutoff = true; break; }
    filteredFirstPage.push(r);
  }

  if (!hitDateCutoff && filteredFirstPage.length === PAGE_SIZE && filteredFirstPage.length < targetN) {
    const rest = await fetchRecentReviews(
      session,
      baseInput,
      cutoffTimestamp,
      targetN - filteredFirstPage.length,
      PAGE_SIZE,
    );
    additionalReviews.push(...rest.reviews);
    if (rest.hitDateCutoff) hitDateCutoff = true;
  }

  const allReviews = filteredFirstPage.concat(additionalReviews);
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const r of allReviews) {
    if (r.reviewedDate < minTs) minTs = r.reviewedDate;
    if (r.reviewedDate > maxTs) maxTs = r.reviewedDate;
  }
  const newestDate = allReviews.length ? new Date(maxTs * 1000) : null;
  const oldestDate = allReviews.length ? new Date(minTs * 1000) : null;

  // ── Format output ────────────────────────────────────────────────────────
  const lines: string[] = [
    `═══════════════════════════════════════════════════`,
    `  BOOKING.COM HOTEL REVIEW SUMMARY`,
    `  ${cleanUrl}`,
    `═══════════════════════════════════════════════════`,
    ``,
    `OVERALL (all ${totalReviews.toLocaleString()} reviews, all time)`,
    `  Score: ${fmtScore(baseInput.hotelScore)}/10`,
    ``,
    `CATEGORY SCORES (all-time averages)`,
    formatRatingScores(firstPage.ratingScores),
    `SCORE DISTRIBUTION (all ${totalReviews.toLocaleString()} reviews)`,
    formatScoreDistribution(firstPage.reviewScoreFilter, totalReviews),
    `TRAVELLER TYPES`,
    formatCustomerTypes(firstPage.customerTypeFilter),
    `TOP REVIEW LANGUAGES`,
    formatTopLanguages(firstPage.languageFilter),
  ];

  if (allReviews.length > 0) {
    lines.push(formatRecentStats(
      allReviews,
      totalReviews,
      newestDate,
      oldestDate,
      input.withinMonths,
      hitDateCutoff
    ));
  } else {
    lines.push(`RECENT REVIEWS\n  No reviews found within the last ${input.withinMonths} month(s).\n`);
  }

  return lines.join("\n");
}
