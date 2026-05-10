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

  let reviewListRequestCaptured = false;
  let capturedInput: any = null;

  // Intercept ReviewList requests
  await page.route("**/dml/graphql**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postData();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed.operationName === "ReviewList") {
            console.log(`✅ ReviewList request captured!`);
            console.log(`   HotelId: ${parsed.variables?.input?.hotelId}`);
            console.log(`   Skip: ${parsed.variables?.input?.skip}`);
            console.log(`   Limit: ${parsed.variables?.input?.limit}`);
            reviewListRequestCaptured = true;
            capturedInput = parsed.variables?.input;
          }
        } catch (e) {
          // ignore
        }
      }
    }
    await route.continue();
  });

  try {
    console.log(`Loading ${URL}...`);
    const response = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(`Page loaded: ${response?.status()}`);
    await page.waitForTimeout(3000);

    // Try clicking the reviews tab in the navigation
    console.log("\nAttempt 1: Click reviews tab in header");
    try {
      const reviewsTab = page.locator('#reviews-tab-trigger, a[data-testid*="reviews"]').first();
      const isVisible = await reviewsTab.isVisible().catch(() => false);
      console.log(`  Reviews tab visible: ${isVisible}`);
      if (isVisible) {
        await reviewsTab.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`  Failed: ${(e as Error).message.split('\n')[0]}`);
    }

    if (!reviewListRequestCaptured) {
      console.log("\nAttempt 2: Find and click 'Guest reviews' link");
      try {
        const guestReviewLink = page.locator('a:has-text("Guest reviews")').first();
        await guestReviewLink.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
      } catch (e) {
        console.log(`  Failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    if (!reviewListRequestCaptured) {
      console.log("\nAttempt 3: Scroll to reviews section and wait");
      try {
        await page.evaluate(() => {
          const reviewSection = document.querySelector('[data-testid="reviews"]') ||
                               document.querySelector('.hp-reviews') ||
                               document.querySelector('#blockdisplay4');
          if (reviewSection) {
            reviewSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log(`  Failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    if (!reviewListRequestCaptured) {
      console.log("\nAttempt 4: Execute direct fetch to trigger ReviewList (if hotelId is available)");
      try {
        // First, try to extract hotelId from page
        const hotelId = await page.evaluate(() => {
          // Check for hotelId in window object
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            if (script.textContent?.includes('hotelId')) {
              const match = script.textContent.match(/hotelId["\s:]+(\d+)/);
              if (match) return match[1];
            }
          }
          return null;
        });
        console.log(`  Extracted hotelId from page: ${hotelId}`);
      } catch (e) {
        console.log(`  Failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    // Final wait and check
    await page.waitForTimeout(2000);
    console.log(`\nFinal result: ReviewList captured = ${reviewListRequestCaptured}`);
    if (capturedInput) {
      console.log(`Captured input hotelId: ${capturedInput.hotelId}`);
    }

  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser.close();
  }
}

main();
