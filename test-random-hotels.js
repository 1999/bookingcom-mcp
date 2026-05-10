import { getHotelReviews } from "./dist/tools/get-reviews.js";

// Random hotels from Singapore and Sydney
const hotels = [
  // Singapore
  "https://www.booking.com/hotel/sg/the-fullerton-singapore.html",
  // Sydney
  "https://www.booking.com/hotel/au/rydges-sydney-airport.html",
];

async function test() {
  console.log("Testing random hotels from Singapore and Sydney...\n");
  console.log("Hotels to test:");
  console.log("1. The Fullerton Hotel Singapore");
  console.log("2. Rydges Sydney Airport Hotel\n");

  for (let i = 0; i < hotels.length; i++) {
    const hotel = hotels[i];
    const location = i === 0 ? "Singapore" : "Sydney";
    console.log(`\n=== ${location} Hotel ${i + 1}: ${hotel} ===`);
    try {
      const result = await getHotelReviews({ url: hotel, limit: 5, skip: 0, sortBy: "MOST_RELEVANT" });
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
