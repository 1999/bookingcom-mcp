import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getHotelReviews } from "./tools/get-reviews.js";
import { summarizeHotel } from "./tools/summarize-hotel.js";
import { bookingBrowser } from "./browser.js";

const server = new McpServer({
  name: "bookingcom-reviews",
  version: "0.2.0",
});

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
      .max(50)
      .default(10)
      .describe("Number of reviews to return (1–50, default 10)"),
    skip: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Reviews to skip for pagination (default 0)"),
    sortBy: z
      .enum(["MOST_RELEVANT", "MOST_RECENT"])
      .default("MOST_RELEVANT")
      .describe("Sort order: MOST_RELEVANT or MOST_RECENT"),
  },
  async (input) => {
    try {
      const text = await getHotelReviews(input);
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
      const text = await summarizeHotel(input);
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
