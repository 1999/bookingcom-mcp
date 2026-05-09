import { z } from "zod";
import { bookingBrowser } from "../browser.js";
import type { FilterItem, RatingScore, ReviewCard, ReviewListFrontendInput, ReviewListFullResult } from "../queries.js";
import { achievedMargin, computeStats, requiredSampleSize, scoreTrend } from "../stats.js";

const PAGE_SIZE = 25;
const REQUEST_DELAY_MS = 250; // be polite between pages

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
  firstPageMeta: ReviewListFullResult;   // ratingScores, filters — global stats from API
  hitDateCutoff: boolean;
  oldestReviewDate: Date | null;
  newestReviewDate: Date | null;
}

async function fetchRecentReviews(
  session: Awaited<ReturnType<typeof bookingBrowser.ensureSession>>,
  baseInput: ReviewListFrontendInput,
  cutoffTimestamp: number,   // unix seconds
  targetN: number
): Promise<FetchResult> {
  const reviews: ReviewCard[] = [];
  let firstPageMeta: ReviewListFullResult | null = null;
  let hitDateCutoff = false;
  let skip = 0;

  const mostRecentSorter = bookingBrowser.resolveSorter(session, "newest", "NEWEST_FIRST");

  while (reviews.length < targetN) {
    const input: ReviewListFrontendInput = {
      ...baseInput,
      sorter: mostRecentSorter,
      filters: { text: "" },
      skip,
      limit: PAGE_SIZE,
    };

    const page = await bookingBrowser.callGraphQL(session, input);

    if (!firstPageMeta) firstPageMeta = page;

    for (const review of page.reviewCard) {
      if (review.reviewedDate < cutoffTimestamp) {
        hitDateCutoff = true;
        break;
      }
      reviews.push(review);
    }

    if (hitDateCutoff || page.reviewCard.length < PAGE_SIZE) break;

    skip += PAGE_SIZE;

    if (reviews.length < targetN) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  const dates = reviews.map((r) => r.reviewedDate);
  return {
    reviews,
    firstPageMeta: firstPageMeta!,
    hitDateCutoff,
    oldestReviewDate: dates.length ? new Date(Math.min(...dates) * 1000) : null,
    newestReviewDate: dates.length ? new Date(Math.max(...dates) * 1000) : null,
  };
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
  return sorted
    .map((f) => {
      const p = pct(f.count, totalReviews);
      return `  ${f.name.padEnd(16)} ${bar(f.count, Math.max(...filters.map(x => x.count)))}  ${p.padStart(4)} (${f.count.toLocaleString()})`;
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
      targetN - filteredFirstPage.length
    );
    additionalReviews.push(...rest.reviews);
    if (rest.hitDateCutoff) hitDateCutoff = true;
  }

  const allReviews = [...filteredFirstPage, ...additionalReviews];
  const dates = allReviews.map((r) => r.reviewedDate);
  const newestDate = dates.length ? new Date(Math.max(...dates) * 1000) : null;
  const oldestDate = dates.length ? new Date(Math.min(...dates) * 1000) : null;

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
