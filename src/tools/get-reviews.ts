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

export async function getHotelReviews(
  rawInput: unknown,
  onBatch?: (text: string, fetched: number, total: number) => Promise<void>
): Promise<string> {
  const input = GetHotelReviewsSchema.parse(rawInput);

  // Normalise URL: strip query string / fragments, keep clean hotel path
  const url = new URL(input.url);
  const cleanUrl = `${url.origin}${url.pathname}`;

  const session = await bookingBrowser.ensureSession(cleanUrl);

  const sorterLabel = input.sortBy === "MOST_RECENT" ? "newest" : "relevant";
  const sorterFallback = input.sortBy === "MOST_RECENT" ? "NEWEST_FIRST" : "MOST_RELEVANT";
  const sorterValue = bookingBrowser.resolveSorter(session, sorterLabel, sorterFallback);

  const allParts: string[] = [];
  let fetched = 0;
  let reviewsCount = 0;

  while (fetched < input.limit) {
    const batchLimit = Math.min(MAX_PAGE_SIZE, input.limit - fetched);
    const queryInput: ReviewListFrontendInput = {
      ...session.baseInput,
      sorter: sorterValue,
      filters: { text: "" },
      skip: input.skip + fetched,
      limit: batchLimit,
    };

    const result = await bookingBrowser.callGraphQL(session, queryInput);
    reviewsCount = result.reviewsCount;

    if (result.reviewCard.length === 0) break;

    const batchText = result.reviewCard
      .map((card, i) => formatReview(card, fetched + i))
      .join("\n\n");

    allParts.push(batchText);
    fetched += result.reviewCard.length;

    await onBatch?.(batchText, fetched, Math.min(input.limit, reviewsCount));

    if (fetched >= reviewsCount) break;
  }

  if (allParts.length === 0) {
    return `No reviews found for this hotel (total reported: ${reviewsCount}).`;
  }

  const header = `Hotel has ${reviewsCount} reviews total. Showing ${fetched} (skip=${input.skip}, limit=${input.limit}, sort=${input.sortBy}):\n`;
  return header + "\n" + allParts.join("\n\n");
}
