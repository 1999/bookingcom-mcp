import { z } from "zod";
import { bookingBrowser } from "../browser.js";
import type { ReviewCard, ReviewListFrontendInput } from "../queries.js";

export const GetHotelReviewsSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.includes("booking.com/hotel/"), {
      message: "Must be a booking.com hotel page URL (booking.com/hotel/...)",
    }),
  limit: z.number().int().min(1).max(1000).default(10),
  skip: z.number().int().min(0).default(0),
  sortBy: z.enum(["MOST_RELEVANT", "MOST_RECENT"]).default("MOST_RELEVANT"),
});

export type GetHotelReviewsInput = z.infer<typeof GetHotelReviewsSchema>;

function formatReview(review: ReviewCard, index: number): string {
  const date = new Date(review.reviewedDate * 1000).toISOString().split("T")[0];
  const guest = review.guestDetails;
  const text = review.textDetails;
  const booking = review.bookingDetails;

  const lines: string[] = [
    `--- Review ${index + 1} ---`,
    `Score: ${review.reviewScore}/10`,
    `Date: ${date}`,
    `Guest: ${guest.anonymous ? "Anonymous" : guest.username} (${guest.countryName}, ${guest.guestTypeTranslation})`,
  ];

  if (booking.roomType?.name) {
    lines.push(`Room: ${booking.roomType.name} | ${booking.numNights} night(s) | ${booking.checkinDate} → ${booking.checkoutDate}`);
  }

  if (text.title) lines.push(`Title: ${text.title}`);
  if (text.positiveText) lines.push(`Positive: ${text.positiveText}`);
  if (text.negativeText) lines.push(`Negative: ${text.negativeText}`);
  if (review.partnerReply?.reply) lines.push(`Hotel reply: ${review.partnerReply.reply}`);

  return lines.join("\n");
}

const MAX_PAGE_SIZE = 25;
const MAX_CONCURRENT_FETCHES = 4;

export async function getHotelReviews(
  rawInput: unknown,
  onBatch?: (text: string, fetched: number, total: number) => Promise<void>
): Promise<string> {
  const input = GetHotelReviewsSchema.parse(rawInput);

  const url = new URL(input.url);
  const cleanUrl = `${url.origin}${url.pathname}`;

  // Get global CSRF session and hotel-specific baseInput
  const session = await bookingBrowser.ensureSession(cleanUrl);
  const hotelBaseInput = await bookingBrowser.getBaseInputForHotel(cleanUrl);

  const sorterLabel = input.sortBy === "MOST_RECENT" ? "newest" : "relevant";
  const sorterFallback = input.sortBy === "MOST_RECENT" ? "NEWEST_FIRST" : "MOST_RELEVANT";
  const sorterValue = bookingBrowser.resolveSorter(session, sorterLabel, sorterFallback);

  // First fetch reveals reviewsCount so we can plan all remaining pages upfront
  const firstResult = await bookingBrowser.callGraphQL(session, {
    ...hotelBaseInput,
    sorter: sorterValue,
    filters: { text: "" },
    skip: input.skip,
    limit: Math.min(MAX_PAGE_SIZE, input.limit),
  });

  if (firstResult.reviewCard.length === 0) {
    return `No reviews found for this hotel (total reported: ${firstResult.reviewsCount}).`;
  }

  const reviewsCount = firstResult.reviewsCount;
  const totalToFetch = Math.min(input.limit, reviewsCount);

  // Keyed by page offset for in-order final assembly; fetched updated synchronously
  // before each await so the JS single-threaded model keeps it race-free
  const resultsByOffset = new Map<number, string>();
  let fetched = 0;

  const storeAndNotify = async (offset: number, cards: ReviewCard[]) => {
    const text = cards.map((card, i) => formatReview(card, offset + i)).join("\n\n");
    resultsByOffset.set(offset, text);
    fetched += cards.length;
    await onBatch?.(text, fetched, totalToFetch);
  };

  await storeAndNotify(0, firstResult.reviewCard);

  // Remaining page offsets — all independent, safe to fetch in parallel
  const remaining: number[] = [];
  for (let off = firstResult.reviewCard.length; off < totalToFetch; off += MAX_PAGE_SIZE) {
    remaining.push(off);
  }

  if (remaining.length > 0) {
    // Worker-pool pattern: N workers drain the shared queue concurrently
    let nextIdx = 0;
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_FETCHES, remaining.length) }, async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= remaining.length) return;
          const offset = remaining[i];
          const result = await bookingBrowser.callGraphQL(session, {
            ...hotelBaseInput,
            sorter: sorterValue,
            filters: { text: "" },
            skip: input.skip + offset,
            limit: Math.min(MAX_PAGE_SIZE, input.limit - offset),
          });
          if (result.reviewCard.length > 0) {
            await storeAndNotify(offset, result.reviewCard);
          }
        }
      })
    );
  }

  const allParts = [...resultsByOffset.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text);

  const header = `Hotel has ${reviewsCount} reviews total. Showing ${fetched} (skip=${input.skip}, limit=${input.limit}, sort=${input.sortBy}):\n`;
  return header + "\n" + allParts.join("\n\n");
}
