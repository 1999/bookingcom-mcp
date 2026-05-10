import { summarizeHotel } from "./src/tools/summarize-hotel.js";

async function testMultipleHotels() {
  const hotels = [
    "https://www.booking.com/hotel/au/felix.en-gb.html",
    "https://www.booking.com/hotel/au/stanmore-chic-studio-retreat.en-gb.html",
  ];

  const results: { url: string; hotelId?: number; reviewsCount?: number }[] = [];

  for (const url of hotels) {
    try {
      console.error(`\n[TEST] Querying: ${url}`);
      const result = await summarizeHotel({ url, withinMonths: 12 });

      // Extract hotelId and reviewsCount from the output to verify they're different
      const hotelIdMatch = result.match(/Hotel ID or metadata/);
      const reviewsMatch = result.match(/all (\d+(?:,\d+)*) reviews/);

      const reviewsCount = reviewsMatch ? parseInt(reviewsMatch[1].replace(/,/g, "")) : undefined;

      results.push({
        url,
        reviewsCount,
      });

      console.error(`[TEST] Result preview (first 300 chars):\n${result.substring(0, 300)}...\n`);
    } catch (err) {
      console.error(`[TEST] Error: ${err}`);
      results.push({ url });
    }
  }

  console.error("\n[TEST] Summary:");
  console.error(JSON.stringify(results, null, 2));

  // Check if different hotels returned different review counts
  const reviewsCounts = results.map((r) => r.reviewsCount).filter((r) => r !== undefined);
  const allSame = reviewsCounts.length === 2 && reviewsCounts[0] === reviewsCounts[1];

  if (allSame) {
    console.error("\n❌ FAILED: Both hotels returned the same review count - caching bug still present!");
  } else if (reviewsCounts.length === 2) {
    console.error("\n✓ PASSED: Different hotels returned different review counts!");
  } else {
    console.error("\n⚠ INCONCLUSIVE: Could not extract review counts from results");
  }
}

testMultipleHotels().catch(console.error);
