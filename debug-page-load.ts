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

  // Intercept all requests to log them
  await page.on("request", (request) => {
    if (request.url().includes("graphql") || request.url().includes("review")) {
      console.log(`[Request] ${request.method()} ${request.url()}`);
    }
  });

  // Log responses
  await page.on("response", (response) => {
    if (response.url().includes("graphql")) {
      console.log(`[Response] ${response.status()} ${response.url()}`);
    }
  });

  try {
    console.log(`Loading ${URL}...`);
    const response = await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
    console.log(`✅ Page loaded: ${response?.status()}`);

    // Check for common elements
    const reviewTab = await page.locator("a").filter({ hasText: /Guest reviews/i }).first();
    const reviewTabVisible = await reviewTab.isVisible().catch(() => false);
    console.log(`Review tab visible: ${reviewTabVisible}`);

    const page2Btn = await page.locator('button').filter({ hasText: /^2$/ }).first();
    const page2Visible = await page2Btn.isVisible().catch(() => false);
    console.log(`Page 2 button visible: ${page2Visible}`);

    // Check HTML for bot detection markers
    const html = await page.content();
    const hasBot = html.includes("robot") || html.includes("bot") || html.includes("challenge");
    const hasPageNotFound = html.includes("Page not found");
    console.log(`HTML contains bot-related text: ${hasBot}`);
    console.log(`HTML contains "Page not found": ${hasPageNotFound}`);

    // Take screenshot
    await page.screenshot({ path: '/tmp/debug-page.png' });
    console.log("Screenshot saved to /tmp/debug-page.png");

    // Save HTML
    const fs = await import("fs");
    fs.writeFileSync('/tmp/debug-page.html', html);
    console.log("HTML saved to /tmp/debug-page.html");

  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser.close();
  }
}

main();
