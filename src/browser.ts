import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type { ReviewListFrontendInput, ReviewListResult } from "./queries.js";

chromium.use(StealthPlugin());

const SESSION_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours
const GRAPHQL_URL = "https://www.booking.com/dml/graphql";

interface CapturedSession {
  headers: Record<string, string>;
  baseInput: ReviewListFrontendInput;
  /** The exact query string Booking.com's frontend sent — always valid */
  query: string;
  /** Variable names declared in the query (so we can pass them correctly) */
  queryVariableNames: string[];
  capturedAt: number;
}

interface GraphQLResponse {
  data?: {
    reviewListFrontend?: {
      __typename: string;
      reviewsCount?: number;
      reviewCard?: ReviewListResult["reviewCard"];
      statusCode?: number;
      message?: string;
    };
  };
  errors?: Array<{ message: string }>;
}

/** Extract all variable names declared in a GraphQL query string */
function parseVariableNames(query: string): string[] {
  const matches = query.match(/\$(\w+)/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export class BookingBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionCache = new Map<string, CapturedSession>();

  private async launch(): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    }) as unknown as Browser;

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
    });

    this.page = await this.context.newPage();
  }

  async ensureSession(hotelUrl: string): Promise<CapturedSession> {
    const cached = this.sessionCache.get(hotelUrl);
    if (cached && Date.now() - cached.capturedAt < SESSION_TTL_MS) {
      return cached;
    }

    await this.launch();
    const page = this.page!;

    return new Promise<CapturedSession>((resolve, reject) => {
      let resolved = false;

      const routeHandler = async (route: Route) => {
        const request = route.request();

        if (request.method() !== "POST") {
          await route.continue();
          return;
        }

        const bodyText = request.postData() ?? "";
        let body: {
          operationName?: string;
          query?: string;
          variables?: { input?: ReviewListFrontendInput; [key: string]: unknown };
        };
        try {
          body = JSON.parse(bodyText);
        } catch {
          await route.continue();
          return;
        }

        if (body.operationName !== "ReviewList" || !body.query || !body.variables?.input) {
          await route.continue();
          return;
        }

        const rawHeaders = request.headers();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (!["host", "content-length"].includes(k.toLowerCase())) {
            headers[k] = v;
          }
        }

        const session: CapturedSession = {
          headers,
          baseInput: body.variables.input,
          query: body.query,
          queryVariableNames: parseVariableNames(body.query),
          capturedAt: Date.now(),
        };

        this.sessionCache.set(hotelUrl, session);

        if (!resolved) {
          resolved = true;
          await route.continue();
          page.unroute("**/dml/graphql**").catch(() => {});
          resolve(session);
        } else {
          await route.continue();
        }
      };

      page
        .route("**/dml/graphql**", routeHandler)
        .then(() => page.goto(hotelUrl, { waitUntil: "networkidle", timeout: 45000 }))
        .then(async () => {
          // Step 1: scroll to and click the "Guest reviews" tab to reveal the review section
          try {
            const reviewTab = page.locator('a').filter({ hasText: /Guest reviews/i }).first();
            await reviewTab.scrollIntoViewIfNeeded({ timeout: 5000 });
            await reviewTab.click({ timeout: 5000 });
            await page.waitForTimeout(2000);
          } catch {
            // try generic scroll
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
            await page.waitForTimeout(2000);
          }

          // Step 2: the ReviewList request fires on pagination — click page 2
          // (the first page of reviews is often server-rendered, not via GraphQL)
          try {
            const page2Btn = page.locator('button[aria-label=" 2"], button').filter({ hasText: /^2$/ }).first();
            await page2Btn.waitFor({ timeout: 8000 });
            await page2Btn.scrollIntoViewIfNeeded();
            await page2Btn.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
          } catch {
            // fallback: try "Read all reviews" button
            try {
              const readAllBtn = page.locator('button').filter({ hasText: /Read all reviews/i }).first();
              await readAllBtn.click({ timeout: 5000 });
              await page.waitForTimeout(3000);
            } catch { /* ignore */ }
          }

          // Step 3: last resort — scroll to bottom to trigger any lazy-loaded GraphQL
          if (!resolved) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(5000);
          }

          if (!resolved) {
            reject(
              new Error(
                "ReviewList GraphQL request was not captured. Booking.com's bot detection may have blocked the headless browser. Try again."
              )
            );
          }
        })
        .catch(reject);
    });
  }

  async callGraphQL(
    session: CapturedSession,
    input: ReviewListFrontendInput
  ): Promise<ReviewListResult> {
    await this.launch();
    const page = this.page!;

    // Build variables object — only include variable names declared in the captured query
    const variables: Record<string, unknown> = { input };
    for (const varName of session.queryVariableNames) {
      if (varName !== "input" && !(varName in variables)) {
        // Provide sensible defaults for known optional variables
        if (varName === "shouldShowReviewListPhotoAltText") variables[varName] = false;
      }
    }

    const result = await page.evaluate(
      async ({
        url,
        headers,
        query,
        operationName,
        variables,
      }: {
        url: string;
        headers: Record<string, string>;
        query: string;
        operationName: string;
        variables: Record<string, unknown>;
      }): Promise<GraphQLResponse> => {
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ operationName, query, variables }),
        });
        return resp.json() as Promise<GraphQLResponse>;
      },
      {
        url: `${GRAPHQL_URL}?lang=en-gb`,
        headers: session.headers,
        query: session.query,
        operationName: "ReviewList",
        variables,
      }
    );

    if (result.errors?.length) {
      throw new Error(`GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    const frontend = result.data?.reviewListFrontend;
    if (!frontend) {
      throw new Error("No reviewListFrontend in response");
    }

    if (frontend.__typename === "ReviewsFrontendError") {
      throw new Error(`Booking.com API error ${frontend.statusCode}: ${frontend.message}`);
    }

    return {
      reviewsCount: frontend.reviewsCount ?? 0,
      reviewCard: frontend.reviewCard ?? [],
    };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

export const bookingBrowser = new BookingBrowser();
