import { bookingBrowser } from "./src/browser.js";

const HOTELS = [
  { name: "Renaissance KL", url: "https://www.booking.com/hotel/my/renaissance-kuala-lumpur.en-gb.html" },
  { name: "Shangri-La KL", url: "https://www.booking.com/hotel/my/shangri-la-kuala-lumpur.en-gb.html" },
  { name: "Shangri-La Golden Sands Penang", url: "https://www.booking.com/hotel/my/shangri-la-s-golden-sands-resort-penang.en-gb.html" },
  { name: "Shangri-La Rasa Sentosa Singapore", url: "https://www.booking.com/hotel/sg/shangri-la-s-rasa-sentosa-singapore.en-gb.html" },
  { name: "Village Hotel Changi Singapore", url: "https://www.booking.com/hotel/sg/village-hotel-changi.en-gb.html" },
  { name: "D'Resort Downtown East Singapore", url: "https://www.booking.com/hotel/sg/d-resort-downtown-east.en-gb.html" },
];

async function main() {
  console.log("=".repeat(70));
  console.log("HOTEL ID DISCOVERY");
  console.log("=".repeat(70));
  console.log();

  const hotelIds = new Map<string, number>();

  for (const hotel of HOTELS) {
    try {
      process.stderr.write(`\n[${hotel.name}] Loading...\n`);
      const session = await bookingBrowser.ensureSession(hotel.url);
      const hotelId = session.baseInput.hotelId;
      hotelIds.set(hotel.name, hotelId);
      console.log(`✅ ${hotel.name}: hotelId = ${hotelId}`);
    } catch (err) {
      console.log(`❌ ${hotel.name}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  console.log("=".repeat(70));
  console.log("DISCOVERED HOTEL IDS");
  console.log("=".repeat(70));
  console.log();

  for (const [name, id] of hotelIds) {
    console.log(`${name.padEnd(40)} → ${id}`);
  }

  console.log();
  console.log(`Success rate: ${hotelIds.size}/${HOTELS.length}`);

  // Also output JSON for easy copying
  console.log();
  console.log("JSON format for reference:");
  console.log(JSON.stringify(Object.fromEntries(hotelIds), null, 2));

  await bookingBrowser.close();
}

main();
