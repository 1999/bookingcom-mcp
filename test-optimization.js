import { getHotelReviews } from "./dist/tools/get-reviews.js";

const hotels = [
  "https://www.booking.com/hotel/fr/tour-eiffel.html",
  "https://www.booking.com/hotel/fr/25hours-paris-terminus-nord.html",
  "https://www.booking.com/hotel/fr/cler-paris.html",
];

async function test() {
  console.log("Testing Playwright session optimization...\n");
  console.log("Fetching reviews for 3 different hotels to verify:");
  console.log("- Playwright launches on first hotel");
  console.log("- Session is reused for hotels 2 & 3\n");

  for (let i = 0; i < hotels.length; i++) {
    const hotel = hotels[i];
    console.log(`\n=== Hotel ${i + 1}: ${hotel} ===`);
    try {
      const result = await getHotelReviews({ url: hotel, limit: 3, skip: 0, sortBy: "MOST_RELEVANT" });
      const lines = result.split("\n");
      console.log(`Result: ${lines[0]}`);
      console.log(`(${lines.length} lines returned)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }

  console.log("\n✅ Test complete. Check stderr above for [bookingcom-mcp] logs.");
  process.exit(0);
}

test().catch(console.error);
