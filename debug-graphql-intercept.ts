import { chromium } from "playwright";

const URL = "https://www.booking.com/hotel/my/renaissance-kuala-lumpur.en-gb.html";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--ignore-certificate-errors",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Intercept all POST requests to log their bodies
  let requestCount = 0;
  await page.route("**/dml/graphql**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      requestCount++;
      const body = request.postData();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          console.log(`\n[GraphQL Request ${requestCount}]`);
          console.log(`Operation: ${parsed.operationName}`);
          console.log(`Query start: ${parsed.query?.substring(0, 50)}...`);
          if (parsed.variables?.input) {
            console.log(`Input keys: ${Object.keys(parsed.variables.input).join(", ")}`);
            console.log(`HotelId: ${parsed.variables.input.hotelId}`);
          }
        } catch (e) {
          console.log(`[GraphQL Request ${requestCount}] Failed to parse body`);
        }
      }
    }
    await route.continue();
  });

  try {
    console.log(`Loading ${URL}...`);
    const response = await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
    console.log(`\n✅ Page loaded: ${response?.status()}`);

    // Wait a bit for initial requests
    await page.waitForTimeout(2000);

    // Click on reviews tab
    console.log("\n--- Clicking Guest reviews tab ---");
    try {
      const reviewTab = await page.locator("a").filter({ hasText: /Guest reviews/i }).first();
      await reviewTab.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log(`Failed to click review tab: ${e}`);
    }

    // Try to click page 2
    console.log("\n--- Looking for pagination button ---");
    try {
      const page2 = await page.locator('button').filter({ hasText: /^2$/ }).first();
      const visible = await page2.isVisible().catch(() => false);
      console.log(`Page 2 button visible: ${visible}`);
      if (visible) {
        await page2.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`Failed to interact with page 2: ${e}`);
    }

    // Scroll
    console.log("\n--- Scrolling to reviews section ---");
    await page.evaluate(() => {
      const reviewSection = document.querySelector('[data-testid="reviews"]');
      if (reviewSection) reviewSection.scrollIntoView();
      else window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await page.waitForTimeout(2000);

    console.log(`\n\nTotal GraphQL requests captured: ${requestCount}`);

  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser.close();
  }
}

main();
