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
  limit: z.number().int().min(1).max(50).default(10),
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

export async function getHotelReviews(rawInput: unknown): Promise<string> {
  const input = GetHotelReviewsSchema.parse(rawInput);

  // Normalise URL: strip query string / fragments, keep clean hotel path
  const url = new URL(input.url);
  const cleanUrl = `${url.origin}${url.pathname}`;

  const session = await bookingBrowser.ensureSession(cleanUrl);

  const sorterLabel = input.sortBy === "MOST_RECENT" ? "newest" : "relevant";
  const sorterFallback = input.sortBy === "MOST_RECENT" ? "NEWEST_FIRST" : "MOST_RELEVANT";
  const sorterValue = bookingBrowser.resolveSorter(session, sorterLabel, sorterFallback);

  const queryInput: ReviewListFrontendInput = {
    ...session.baseInput,
    sorter: sorterValue,
    filters: { text: "" },
    skip: input.skip,
    limit: input.limit,
  };

  const result = await bookingBrowser.callGraphQL(session, queryInput);

  if (result.reviewCard.length === 0) {
    return `No reviews found for this hotel (total reported: ${result.reviewsCount}).`;
  }

  const header = `Hotel has ${result.reviewsCount} reviews total. Showing ${result.reviewCard.length} (skip=${input.skip}, limit=${input.limit}, sort=${input.sortBy}):\n`;
  const body = result.reviewCard.map(formatReview).join("\n\n");

  return header + "\n" + body;
}
