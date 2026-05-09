import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type {
  FilterItem,
  RatingScore,
  ReviewListFrontendInput,
  ReviewListFullResult,
  Sorter,
} from "./queries.js";

chromium.use(StealthPlugin());

const SESSION_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours
const GRAPHQL_URL = "https://www.booking.com/dml/graphql";

interface CapturedSession {
  headers: Record<string, string>;
  baseInput: ReviewListFrontendInput;
  /** The exact query string Booking.com's frontend sent — always valid */
  query: string;
  /** Variable names declared in the query */
  queryVariableNames: string[];
  capturedAt: number;
  /** Sorter values returned by the API — populated after first callGraphQL */
  sorters: Sorter[];
}

interface GraphQLResponse {
  data?: {
    reviewListFrontend?: {
      __typename: string;
      reviewsCount?: number;
      reviewCard?: ReviewListFullResult["reviewCard"];
      ratingScores?: RatingScore[];
      reviewScoreFilter?: FilterItem[];
      customerTypeFilter?: FilterItem[];
      languageFilter?: FilterItem[];
      sorters?: Sorter[];
      statusCode?: number;
      message?: string;
    };
  };
  errors?: Array<{ message: string }>;
}

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
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--ignore-certificate-errors"],
    }) as unknown as Browser;

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      ignoreHTTPSErrors: true,
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

    const session = await new Promise<CapturedSession>((resolve, reject) => {
      let resolved = false;

      const routeHandler = async (route: Route) => {
        const request = route.request();
        if (request.method() !== "POST") { await route.continue(); return; }

        const bodyText = request.postData() ?? "";
        let body: {
          operationName?: string;
          query?: string;
          variables?: { input?: ReviewListFrontendInput; [key: string]: unknown };
        };
        try { body = JSON.parse(bodyText); }
        catch { await route.continue(); return; }

        if (body.operationName !== "ReviewList" || !body.query || !body.variables?.input) {
          await route.continue(); return;
        }

        const rawHeaders = request.headers();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (!["host", "content-length"].includes(k.toLowerCase())) headers[k] = v;
        }

        const session: CapturedSession = {
          headers,
          baseInput: body.variables.input,
          query: body.query,
          queryVariableNames: parseVariableNames(body.query),
          capturedAt: Date.now(),
          sorters: [],
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
        .then(() => page.goto(hotelUrl, { waitUntil: "load", timeout: 45000 }))
        .then(async () => {
          await page.waitForTimeout(1500);

          // Step 1: click the "Guest reviews" tab
          try {
            const reviewTab = page.locator("a").filter({ hasText: /Guest reviews/i }).first();
            await reviewTab.scrollIntoViewIfNeeded({ timeout: 5000 });
            await reviewTab.click({ timeout: 5000 });
            await page.waitForTimeout(1000);
          } catch {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
            await page.waitForTimeout(1000);
          }

          // Step 2: click page 2 pagination — this triggers the ReviewList GraphQL request
          try {
            const page2Btn = page
              .locator('button[aria-label=" 2"], button')
              .filter({ hasText: /^2$/ })
              .first();
            await page2Btn.waitFor({ timeout: 8000 });
            await page2Btn.scrollIntoViewIfNeeded();
            await page2Btn.click({ timeout: 5000 });
            await page.waitForTimeout(1500);
          } catch {
            // fallback: "Read all reviews" button
            try {
              await page.locator("button").filter({ hasText: /Read all reviews/i }).first().click({ timeout: 5000 });
              await page.waitForTimeout(1500);
            } catch { /* ignore */ }
          }

          // Last resort: scroll to bottom
          if (!resolved) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2500);
          }

          if (!resolved) {
            reject(new Error(
              "ReviewList GraphQL request was not captured. Booking.com's bot detection may have blocked the headless browser. Try again."
            ));
          }
        })
        .catch(reject);
    });

    // Probe to populate available sorter values for this hotel
    if (session.sorters.length === 0) {
      try {
        const probe = await this.callGraphQL(session, { ...session.baseInput, skip: 0, limit: 1 });
        if (probe.sorters.length > 0) session.sorters = probe.sorters;
      } catch { /* sorters stay empty; fallback strings will be used */ }
    }

    return session;
  }

  async callGraphQL(
    session: CapturedSession,
    input: ReviewListFrontendInput
  ): Promise<ReviewListFullResult> {
    await this.launch();
    const page = this.page!;

    // Build variables — supply defaults for all declared query variables
    const variables: Record<string, unknown> = { input };
    for (const varName of session.queryVariableNames) {
      if (varName !== "input" && !(varName in variables)) {
        if (varName === "shouldShowReviewListPhotoAltText") variables[varName] = false;
      }
    }

    const result = await page.evaluate(
      async ({ url, headers, query, operationName, variables }: {
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
          signal: AbortSignal.timeout(20000),
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
    if (!frontend) throw new Error("No reviewListFrontend in response");

    if (frontend.__typename === "ReviewsFrontendError") {
      throw new Error(`Booking.com API error ${frontend.statusCode}: ${frontend.message}`);
    }

    const sorters = frontend.sorters ?? [];

    // Persist sorters into the session cache so callers can resolve actual API values
    for (const [url, cached] of this.sessionCache) {
      if (cached === session && sorters.length > 0) {
        cached.sorters = sorters;
        this.sessionCache.set(url, cached);
        break;
      }
    }

    return {
      reviewsCount: frontend.reviewsCount ?? 0,
      reviewCard: frontend.reviewCard ?? [],
      ratingScores: frontend.ratingScores ?? [],
      reviewScoreFilter: frontend.reviewScoreFilter ?? [],
      customerTypeFilter: frontend.customerTypeFilter ?? [],
      languageFilter: frontend.languageFilter ?? [],
      sorters,
    };
  }

  /**
   * Resolve the API-accepted sorter value for a user-facing label.
   * Falls back to `fallback` if sorters haven't been populated yet.
   * Matching is case-insensitive substring on the sorter name.
   */
  resolveSorter(session: CapturedSession, label: string, fallback: string): string {
    const match = session.sorters.find((s) =>
      s.name.toLowerCase().includes(label.toLowerCase())
    );
    return match?.value ?? fallback;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

export const bookingBrowser = new BookingBrowser();
export type { CapturedSession };
