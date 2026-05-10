import { chromium } from "playwright";

const SEARCH_QUERIES = [
  { name: "Shangri-La Golden Sands Penang", query: "Shangri-La Golden Sands Penang Malaysia" },
  { name: "Shangri-La Rasa Sentosa Singapore", query: "Shangri-La Rasa Sentosa Singapore" },
  { name: "Village Hotel Changi Singapore", query: "Village Hotel Changi Singapore" },
  { name: "D'Resort Downtown East Singapore", query: "D'Resort Downtown East Singapore" },
];

async function searchHotel(hotelName: string, query: string): Promise<number | null> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    console.log(`[${hotelName}] Searching...`);

    // Go to booking.com and search
    try {
      await page.goto("https://www.booking.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (e) {
      console.log(`  ⚠ Home page load timed out`);
    }

    // Click search box and enter query
    try {
      const searchBox = page.locator('[data-testid="searchbox-input"]').first();
      const visible = await searchBox.isVisible({ timeout: 5000 }).catch(() => false);

      if (visible) {
        await searchBox.click();
        await page.waitForTimeout(500);
        await searchBox.fill(query);
        await page.waitForTimeout(1000);

        // Look for suggestions or search results
        // Try clicking first result if available
        const firstResult = page.locator('a[data-testid*="search"], div[role="option"]').first();
        const firstResultVisible = await firstResult.isVisible({ timeout: 3000 }).catch(() => false);

        if (firstResultVisible) {
          await firstResult.click();
          await page.waitForTimeout(2000);

          // Extract hotelId from URL or page
          const url = page.url();
          const hotelIdMatch = url.match(/hotel\/(\d+)/);
          if (hotelIdMatch) {
            const id = parseInt(hotelIdMatch[1]);
            console.log(`  ✅ Found hotelId from URL: ${id}`);
            return id;
          }

          // Try to extract from page content
          const hotelId = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll("script"));
            for (const script of scripts) {
              if (script.textContent?.includes("hotelId")) {
                const match = script.textContent.match(/"?hotelId"?\s*[:"=]+\s*(\d+)/);
                if (match) return parseInt(match[1]);
              }
            }
            return null;
          });

          if (hotelId) {
            console.log(`  ✅ Found hotelId from page: ${hotelId}`);
            return hotelId;
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠ Search failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }

    console.log(`  ❌ Could not find hotel in search results`);
    return null;
  } catch (err) {
    console.log(`  ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("SEARCHING FOR HOTEL IDS");
  console.log("=".repeat(70));
  console.log();

  const results: Record<string, number | null> = {};

  for (const { name, query } of SEARCH_QUERIES) {
    const id = await searchHotel(name, query);
    results[name] = id;
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
}

main();
