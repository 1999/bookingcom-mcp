import { bookingBrowser } from "./src/browser.js";

const testHotels = [
  {
    name: "Shangri-La Rasa Sentosa",
    url: "https://www.booking.com/hotel/sg/shangri-la-s-rasa-sentosa-singapore.en-gb.html",
  },
  {
    name: "Village Hotel Sentosa",
    url: "https://www.booking.com/hotel/sg/village-hotel-changi.en-gb.html",
  },
  {
    name: "D'Resort @ Downtown East",
    url: "https://www.booking.com/hotel/sg/d-resort-downtown-east.en-gb.html",
  },
  {
    name: "Renaissance Kuala Lumpur",
    url: "https://www.booking.com/hotel/my/renaissance-kuala-lumpur.en-gb.html",
  },
  {
    name: "Shangri-La Golden Sands Penang",
    url: "https://www.booking.com/hotel/my/shangri-la-s-golden-sands-resort-penang.en-gb.html",
  },
];

async function testHotel(name: string, url: string) {
  try {
    console.log(`\n🧪 Testing: ${name}`);
    console.log(`   URL: ${url}`);
    console.log(`   ⏳ Capturing session...`);

    const session = await bookingBrowser.ensureSession(url);
    console.log(`   ✅ Session captured`);

    console.log(`   ⏳ Fetching reviews...`);
    const result = await bookingBrowser.callGraphQL(session, {
      ...session.baseInput,
      skip: 0,
      limit: 5,
    });

    console.log(`   ✅ Success!`);
    console.log(`      Reviews count: ${result.reviewsCount}`);
    console.log(`      Fetched reviews: ${result.reviewCard.length}`);
    console.log(`      Available sorters: ${result.sorters.map(s => s.name).join(", ")}`);
    return true;
  } catch (err) {
    console.log(`   ❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  console.log("🚀 Testing enhanced bot detection fix\n");

  const results: Array<{ name: string; passed: boolean }> = [];

  for (const hotel of testHotels) {
    const passed = await testHotel(hotel.name, hotel.url);
    results.push({ name: hotel.name, passed });
    await new Promise(resolve => setTimeout(resolve, 2000)); // Brief pause between tests
  }

  console.log("\n📊 Summary:");
  console.log("=".repeat(50));
  const passed = results.filter(r => r.passed).length;
  results.forEach(r => {
    console.log(`${r.passed ? "✅" : "❌"} ${r.name}`);
  });
  console.log("=".repeat(50));
  console.log(`Passed: ${passed}/${results.length}`);

  await bookingBrowser.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
