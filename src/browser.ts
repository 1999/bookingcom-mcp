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

const TIMEOUTS = {
  navigate: 45_000,
  graphql: 20_000,
  click: 5_000,
  page2Wait: 8_000,
  settle: 1_500,
  postClick: 1_000,
  scrollSettle: 2_500,
} as const;

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

  private getHotelId(hotelUrl: string): string {
    const match = hotelUrl.match(/\/hotel\/([^/?]+)/);
    return match ? match[1] : hotelUrl;
  }

  private isSessionValid(session: CapturedSession): boolean {
    return Date.now() - session.capturedAt < SESSION_TTL_MS;
  }

  private async launch(): Promise<void> {
    if (this.browser) return;

    console.error("[bookingcom-mcp] Launching Playwright browser...");
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
  }

  async ensureSession(hotelUrl: string): Promise<CapturedSession> {
    const hotelId = this.getHotelId(hotelUrl);
    const cached = this.sessionCache.get(hotelId);

    if (cached && this.isSessionValid(cached)) {
      const ageMs = Date.now() - cached.capturedAt;
      const ageMin = Math.round(ageMs / 60000);
      console.error(`[bookingcom-mcp] Reusing session for hotel ${hotelId} (${ageMin}m old) — no Playwright launch needed`);
      return cached;
    }

    const inFlight = this.pendingSessions.get(hotelId);
    if (inFlight) {
      console.error(`[bookingcom-mcp] Session capture in progress for hotel ${hotelId}, waiting...`);
      return inFlight;
    }

    console.error(`[bookingcom-mcp] No valid session found for hotel ${hotelId}, capturing new one...`);
    const promise = this.captureSession(hotelUrl).then((session) => {
      this.sessionCache.set(hotelId, session);
      return session;
    }).finally(() => {
      this.pendingSessions.delete(hotelId);
    });
    this.pendingSessions.set(hotelId, promise);
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

        console.error("[bookingcom-mcp] Session captured successfully");

        await route.continue();
        if (!resolved) {
          resolved = true;
          settle(() => resolve(captured));
        }
      };

      page
        .route("**/dml/graphql**", routeHandler)
        .then(() => page.goto(hotelUrl, { waitUntil: "load", timeout: TIMEOUTS.navigate }))
        .then(async () => {
          await page.waitForTimeout(TIMEOUTS.settle);

          // Step 1: click the "Guest reviews" tab
          try {
            const reviewTab = page.locator("a").filter({ hasText: /Guest reviews/i }).first();
            await reviewTab.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.click });
            await reviewTab.click({ timeout: TIMEOUTS.click });
            await page.waitForTimeout(TIMEOUTS.postClick);
          } catch {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
            await page.waitForTimeout(TIMEOUTS.postClick);
          }

          // Step 2: click page 2 pagination — this triggers the ReviewList GraphQL request
          try {
            const page2Btn = page
              .locator('button[aria-label=" 2"], button')
              .filter({ hasText: /^2$/ })
              .first();
            await page2Btn.waitFor({ timeout: TIMEOUTS.page2Wait });
            await page2Btn.scrollIntoViewIfNeeded();
            await page2Btn.click({ timeout: TIMEOUTS.click });
            await page.waitForTimeout(TIMEOUTS.settle);
          } catch {
            // fallback: "Read all reviews" button
            try {
              await page.locator("button").filter({ hasText: /Read all reviews/i }).first().click({ timeout: TIMEOUTS.click });
              await page.waitForTimeout(TIMEOUTS.settle);
            } catch { /* ignore */ }
          }

          // Last resort: scroll to bottom
          if (!resolved) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(TIMEOUTS.scrollSettle);
          }

          if (!resolved) {
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
