import { chromium } from "playwright";

// These are the hotel slugs from the booking.com URLs
const HOTELS = [
  { name: "Shangri-La Golden Sands Penang", slug: "shangri-la-s-golden-sands-resort-penang", url: "https://www.booking.com/hotel/my/shangri-la-s-golden-sands-resort-penang.en-gb.html" },
  { name: "Shangri-La Rasa Sentosa Singapore", slug: "shangri-la-s-rasa-sentosa-singapore", url: "https://www.booking.com/hotel/sg/shangri-la-s-rasa-sentosa-singapore.en-gb.html" },
  { name: "Village Hotel Changi Singapore", slug: "village-hotel-changi", url: "https://www.booking.com/hotel/sg/village-hotel-changi.en-gb.html" },
  { name: "D'Resort Downtown East Singapore", slug: "d-resort-downtown-east", url: "https://www.booking.com/hotel/sg/d-resort-downtown-east.en-gb.html" },
];

async function findHotelIdInPage(url: string, hotelName: string): Promise<number | null> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--ignore-certificate-errors",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    console.log(`[${hotelName}] Searching for hotelId...`);

    // Load the page with just domcontentloaded
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      console.log(`  ⚠ Page load timed out, continuing with available content...`);
    }

    // Try to extract hotelId from various sources
    const hotelId = await page.evaluate(() => {
      // Try 1: Look in all script tags for hotelId
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const script of scripts) {
        if (script.textContent) {
          // Look for "hotelId":25783 or hotelId: 25783 patterns
          const match = script.textContent.match(/"?hotelId"?\s*[:"=]+\s*(\d+)/i);
          if (match) return parseInt(match[1]);
        }
      }

      // Try 2: Look in HTML data attributes
      const dataElements = document.querySelectorAll("[data-hotel-id], [data-hotelid]");
      for (const el of dataElements) {
        const id = el.getAttribute("data-hotel-id") || el.getAttribute("data-hotelid");
        if (id && /^\d+$/.test(id)) return parseInt(id);
      }

      // Try 3: Look in all element attributes
      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        for (const attr of el.attributes) {
          if (attr.value && /^(\d+)$/.test(attr.value) && attr.value.length > 4 && attr.value.length < 8) {
            const potential = parseInt(attr.value);
            if (potential > 1000) return potential; // Likely a hotelId
          }
        }
      }

      return null;
    });

    if (hotelId) {
      console.log(`  ✅ Found hotelId: ${hotelId}`);
      return hotelId;
    } else {
      console.log(`  ❌ Could not find hotelId in page`);
      return null;
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("FINDING REMAINING HOTEL IDS");
  console.log("=".repeat(70));
  console.log();

  const results: Record<string, number | null> = {};

  for (const hotel of HOTELS) {
    const id = await findHotelIdInPage(hotel.url, hotel.name);
    results[hotel.name] = id;
  }

  console.log();
  console.log("=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log();

  for (const [name, id] of Object.entries(results)) {
    if (id) {
      console.log(`✅ ${name.padEnd(40)} → ${id}`);
    } else {
      console.log(`❌ ${name.padEnd(40)} → NOT FOUND`);
    }
  }

  console.log();
  console.log("Summary:");
  const found = Object.values(results).filter(id => id !== null).length;
  console.log(`Found: ${found}/${HOTELS.length}`);
}

main();
