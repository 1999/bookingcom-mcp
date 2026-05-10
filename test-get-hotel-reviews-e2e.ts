import { getHotelReviews } from "./src/tools/get-reviews.js";
import * as fs from "fs";

const logFile = "/tmp/test-get-hotel-reviews-e2e.log";
const writeLog = (msg: string) => {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${msg}`;
  console.error(line);
  fs.appendFileSync(logFile, line + "\n");
};

async function testGetHotelReviewsE2E() {
  writeLog("[TEST START]");
  const startTime = Date.now();

  const hotels = [
    {
      name: "Felix",
      url: "https://www.booking.com/hotel/au/felix.en-gb.html",
    },
    {
      name: "Stanmore Chic Studio Retreat",
      url: "https://www.booking.com/hotel/au/stanmore-chic-studio-retreat.en-gb.html",
    },
  ];

  const results: { hotel: string; reviews: string; count: number }[] = [];

  for (let hotelIdx = 0; hotelIdx < hotels.length; hotelIdx++) {
    const hotel = hotels[hotelIdx];
    try {
      writeLog(`[HOTEL ${hotelIdx + 1}/${hotels.length}] Start: ${hotel.name}`);
      const hotelStartTime = Date.now();

      console.error(`\n[TEST] Fetching 5 most recent reviews for ${hotel.name}...`);
      const reviewsText = await getHotelReviews({
        url: hotel.url,
        limit: 5,
        sortBy: "MOST_RECENT",
      });

      const hotelElapsed = Date.now() - hotelStartTime;
      writeLog(`[HOTEL ${hotelIdx + 1}/${hotels.length}] End: ${hotel.name} (${hotelElapsed}ms)`);

      const reviewCount = (reviewsText.match(/--- Review \d+ ---/g) || []).length;

      if (reviewCount === 0) {
        console.error(`⚠ WARNING: No reviews found for ${hotel.name}`);
      } else {
        console.error(`✓ Got ${reviewCount} reviews for ${hotel.name}`);
      }

      results.push({
        hotel: hotel.name,
        reviews: reviewsText,
        count: reviewCount,
      });
    } catch (err) {
      console.error(`✗ ERROR fetching reviews for ${hotel.name}:`, err);
      process.exit(1);
    }
  }

  // Verify results
  writeLog("[VERIFY] Starting verification");
  console.error("\n[TEST] Verifying results...");

  if (results.length !== 2) {
    writeLog("[VERIFY] ERROR: Did not get results for both hotels");
    console.error("✗ FAILED: Did not get results for both hotels");
    process.exit(1);
  }

  const [hotel1, hotel2] = results;

  // Check both hotels have reviews
  if (hotel1.count === 0 || hotel2.count === 0) {
    writeLog(`[VERIFY] ERROR: One or both hotels have no reviews (${hotel1.count}, ${hotel2.count})`);
    console.error(`✗ FAILED: One or both hotels have no reviews (${hotel1.count}, ${hotel2.count})`);
    process.exit(1);
  }

  // Check reviews are different
  if (hotel1.reviews === hotel2.reviews) {
    writeLog("[VERIFY] ERROR: Reviews are identical (caching bug!)");
    console.error("✗ FAILED: Reviews are identical (caching bug!)");
    console.error("Hotel 1 reviews:", hotel1.reviews.substring(0, 200));
    console.error("Hotel 2 reviews:", hotel2.reviews.substring(0, 200));
    process.exit(1);
  }

  // Extract reviewer usernames to verify they're different
  const hotel1Names = (hotel1.reviews.match(/Guest: (\w+)/g) || []).sort();
  const hotel2Names = (hotel2.reviews.match(/Guest: (\w+)/g) || []).sort();

  console.error(`\nHotel 1 (${hotel1.hotel}):`);
  console.error(`  - ${hotel1.count} reviews`);
  console.error(`  - Reviewers: ${hotel1Names.slice(0, 3).join(", ")}...`);

  console.error(`\nHotel 2 (${hotel2.hotel}):`);
  console.error(`  - ${hotel2.count} reviews`);
  console.error(`  - Reviewers: ${hotel2Names.slice(0, 3).join(", ")}...`);

  const totalElapsed = Date.now() - startTime;
  writeLog(`[TEST END] PASSED (total: ${totalElapsed}ms)`);
  console.error("\n✓ PASSED: Both hotels have different reviews");
}

testGetHotelReviewsE2E().catch((err) => {
  writeLog(`[TEST FATAL] ${err}`);
  console.error("[TEST] Fatal error:", err);
  process.exit(1);
}).finally(() => {
  writeLog("[PROCESS] Closing");
});
