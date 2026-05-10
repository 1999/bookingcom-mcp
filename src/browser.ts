import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type {
  FilterItem,
  RatingScore,
  ReviewListFrontendInput,
  ReviewListFullResult,
  Sorter,
} from "./queries.js";

const SESSION_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours
const GRAPHQL_URL = "https://www.booking.com/dml/graphql";
const SESSION_CACHE_MAX = 64;

const TIMEOUTS = {
  navigate: 60_000,
  graphql: 20_000,
  click: 5_000,
  page2Wait: 12_000,
  settle: 2_000,
  postClick: 1_500,
  scrollSettle: 3_000,
} as const;

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
  private pendingSessions = new Map<string, Promise<CapturedSession>>();

  private cacheGet(hotelUrl: string): CapturedSession | undefined {
    const cached = this.sessionCache.get(hotelUrl);
    if (!cached) return undefined;
    if (Date.now() - cached.capturedAt >= SESSION_TTL_MS) {
      this.sessionCache.delete(hotelUrl);
      return undefined;
    }
    // Refresh LRU recency.
    this.sessionCache.delete(hotelUrl);
    this.sessionCache.set(hotelUrl, cached);
    return cached;
  }

  private cacheSet(hotelUrl: string, session: CapturedSession): void {
    this.sessionCache.set(hotelUrl, session);
    while (this.sessionCache.size > SESSION_CACHE_MAX) {
      const oldest = this.sessionCache.keys().next().value;
      if (oldest === undefined) break;
      this.sessionCache.delete(oldest);
    }
  }

  private async launch(): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({
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
    }) as unknown as Browser;

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });

    this.page = await this.context.newPage();

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      (window as any).chrome = { runtime: {} };
    });
  }

  async ensureSession(hotelUrl: string): Promise<CapturedSession> {
    const cached = this.cacheGet(hotelUrl);
    if (cached) return cached;

    const inFlight = this.pendingSessions.get(hotelUrl);
    if (inFlight) return inFlight;

    const promise = this.captureSession(hotelUrl).finally(() => {
      this.pendingSessions.delete(hotelUrl);
    });
    this.pendingSessions.set(hotelUrl, promise);
    return promise;
  }

  private async captureSession(hotelUrl: string): Promise<CapturedSession> {
    await this.launch();
    const page = this.page!;

    const session = await new Promise<CapturedSession>((resolve, reject) => {
      let resolved = false;
      let settled = false;

      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        page.unroute("**/dml/graphql**").catch(() => {});
        cb();
      };

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

        const captured: CapturedSession = {
          headers,
          baseInput: body.variables.input,
          query: body.query,
          queryVariableNames: parseVariableNames(body.query),
          capturedAt: Date.now(),
          sorters: [],
        };

        this.cacheSet(hotelUrl, captured);

        await route.continue();
        if (!resolved) {
          resolved = true;
          settle(() => resolve(captured));
        }
      };

      page
        .route("**/dml/graphql**", routeHandler)
        .then(() => {
          process.stderr.write(`[booking] Navigating to ${hotelUrl}\n`);
          return page.goto(hotelUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigate });
        })
        .then(async () => {
          process.stderr.write(`[booking] Page loaded, settling...\n`);
          await page.waitForTimeout(TIMEOUTS.settle + randomDelay(500, 1500));

          // Step 1: click the reviews tab in header navigation
          try {
            process.stderr.write(`[booking] Looking for reviews tab...\n`);
            const reviewTab = page.locator("#reviews-tab-trigger").first();
            const visible = await reviewTab.isVisible({ timeout: TIMEOUTS.click }).catch(() => false);
            if (visible) {
              await page.waitForTimeout(randomDelay(300, 800));
              await reviewTab.click({ timeout: TIMEOUTS.click });
              process.stderr.write(`[booking] Clicked reviews tab\n`);
              await page.waitForTimeout(TIMEOUTS.postClick + randomDelay(200, 600));
            } else {
              throw new Error("Reviews tab not visible");
            }
          } catch (e) {
            process.stderr.write(`[booking] Reviews tab (#reviews-tab-trigger) not found, trying Guest reviews link...\n`);
            try {
              const guestReviewLink = page.locator("a").filter({ hasText: /Guest reviews/i }).first();
              await guestReviewLink.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.click });
              await page.waitForTimeout(randomDelay(300, 800));
              await guestReviewLink.click({ timeout: TIMEOUTS.click });
              process.stderr.write(`[booking] Clicked Guest reviews link\n`);
              await page.waitForTimeout(TIMEOUTS.postClick + randomDelay(200, 600));
            } catch (e2) {
              process.stderr.write(`[booking] Both review tabs failed, scrolling instead\n`);
              await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
              await page.waitForTimeout(TIMEOUTS.postClick + randomDelay(200, 600));
            }
          }

          // Step 2: click page 2 pagination — this triggers the ReviewList GraphQL request
          try {
            process.stderr.write(`[booking] Looking for page 2 button...\n`);
            const page2Btn = page
              .locator('button[aria-label=" 2"], button')
              .filter({ hasText: /^2$/ })
              .first();
            await page2Btn.waitFor({ timeout: TIMEOUTS.page2Wait });
            process.stderr.write(`[booking] Found page 2 button\n`);
            await page.waitForTimeout(randomDelay(400, 1000));
            await page2Btn.scrollIntoViewIfNeeded();
            await page.waitForTimeout(randomDelay(300, 800));
            await page2Btn.click({ timeout: TIMEOUTS.click });
            process.stderr.write(`[booking] Clicked page 2 button\n`);
            await page.waitForTimeout(TIMEOUTS.settle + randomDelay(500, 1500));
          } catch (e) {
            process.stderr.write(`[booking] Page 2 not found, trying Read all reviews...\n`);
            try {
              await page.locator("button").filter({ hasText: /Read all reviews/i }).first().click({ timeout: TIMEOUTS.click });
              process.stderr.write(`[booking] Clicked Read all reviews\n`);
              await page.waitForTimeout(TIMEOUTS.settle + randomDelay(500, 1500));
            } catch {
              process.stderr.write(`[booking] Read all reviews not found either\n`);
            }
          }

          // Last resort: scroll to bottom
          if (!resolved) {
            process.stderr.write(`[booking] Last resort: scrolling to bottom\n`);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(TIMEOUTS.scrollSettle + randomDelay(500, 1500));
          }

          if (!resolved) {
            process.stderr.write(`[booking] FAILED: GraphQL request not captured\n`);
            settle(() => reject(new Error(
              "ReviewList GraphQL request was not captured. Booking.com's bot detection may have blocked the headless browser. Try again."
            )));
          }
        })
        .catch((err) => settle(() => reject(err)));
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
      async ({ url, headers, query, operationName, variables, timeoutMs }: {
        url: string;
        headers: Record<string, string>;
        query: string;
        operationName: string;
        variables: Record<string, unknown>;
        timeoutMs: number;
      }): Promise<GraphQLResponse> => {
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ operationName, query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return resp.json() as Promise<GraphQLResponse>;
      },
      {
        url: `${GRAPHQL_URL}?lang=en-gb`,
        headers: session.headers,
        query: session.query,
        operationName: "ReviewList",
        variables,
        timeoutMs: TIMEOUTS.graphql,
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

    // The session passed in is the same object stored in sessionCache,
    // so mutating it is enough — no scan needed.
    if (sorters.length > 0) session.sorters = sorters;

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
