import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getHotelReviews } from "./tools/get-reviews.js";
import { bookingBrowser } from "./browser.js";

const server = new McpServer({
  name: "bookingcom-reviews",
  version: "0.1.0",
});

server.tool(
  "get_hotel_reviews",
  "Fetch guest reviews for a Booking.com hotel. Returns review scores, text (positive/negative), guest details, and room info.",
  {
    url: z
      .string()
      .url()
      .describe("Full URL of the Booking.com hotel page (e.g. https://www.booking.com/hotel/au/cradle-mountain-hotel.en-gb.html)"),
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
      .describe("Number of reviews to skip for pagination (default 0)"),
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
      return {
        content: [{ type: "text", text: `Error fetching reviews: ${message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Booking.com Reviews MCP server running on stdio\n");

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
