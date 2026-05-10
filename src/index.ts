import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { getHotelReviews } from "./tools/get-reviews.js";
import { summarizeHotel } from "./tools/summarize-hotel.js";
import { bookingBrowser } from "./browser.js";

// ── Dev-mode self-restart ─────────────────────────────────────────────────────
// Watch src/ for .ts changes and exit cleanly — Claude Desktop will respawn
// the process, causing tsx to recompile the updated files.
const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, ".");
let restartTimer: ReturnType<typeof setTimeout> | null = null;
watch(srcDir, { recursive: true }, (_event, filename) => {
  if (!filename?.endsWith(".ts")) return;
  if (restartTimer) return; // debounce
  restartTimer = setTimeout(() => {
    process.stderr.write(`[bookingcom-mcp] ${filename} changed — restarting\n`);
    bookingBrowser.close().finally(() => process.exit(0));
  }, 300);
});

const server = new McpServer({
  name: "bookingcom-reviews",
  version: "0.2.0",
});

const TOOL_TIMEOUT_MS = 120_000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// ── Tool: get_hotel_reviews ───────────────────────────────────────────────────

server.tool(
  "get_hotel_reviews",
  "Fetch raw guest reviews for a Booking.com hotel. Returns individual review scores, text (positive/negative), guest details, and room info. Use summarize_hotel instead when you need an overall assessment.",
  {
    url: z
      .string()
      .url()
      .describe("Full Booking.com hotel page URL (e.g. https://www.booking.com/hotel/au/cradle-mountain-hotel.en-gb.html)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(10)
      .describe("Number of reviews to return (1–1000, default 10). Fetched in pages of 25."),
    skip: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Reviews to skip for pagination (default 0)"),
    sortBy: z
      .enum(["MOST_RECENT"])
      .default("MOST_RECENT")
      .describe("Sort order: MOST_RECENT"),
  },
  async (input, extra) => {
    try {
      const progressToken = extra._meta?.progressToken;

      const onBatch = progressToken
        ? async (batchText: string, fetched: number, total: number) => {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: fetched, total, message: batchText },
            });
          }
        : undefined;

      const text = await withTimeout(
        getHotelReviews(input, onBatch),
        TOOL_TIMEOUT_MS,
        "get_hotel_reviews",
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// ── Tool: summarize_hotel ─────────────────────────────────────────────────────

server.tool(
  "summarize_hotel",
  "Fetch a statistically meaningful summary of a Booking.com hotel based on recent reviews. Automatically fetches enough recent reviews for 95% confidence ±5%, shows category scores (staff/cleanliness/location/value/etc.), score distribution, traveller type breakdown, score trend (improving/declining), and confidence interval on the recent average.",
  {
    url: z
      .string()
      .url()
      .describe("Full Booking.com hotel page URL"),
    withinMonths: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(12)
      .describe("Only include reviews from the last N months (default 12). Use 6 for recent-only, 24 for a longer view."),
  },
  async (input) => {
    try {
      const text = await withTimeout(
        summarizeHotel(input),
        TOOL_TIMEOUT_MS,
        "summarize_hotel",
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// ── Server startup ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Booking.com Reviews MCP server v0.2.0 running on stdio\n");

  const shutdown = async () => {
    await bookingBrowser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
