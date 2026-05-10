#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { getHotelReviewsJSON } from "./tools/get-reviews.js";
import { summarizeHotelJSON } from "./tools/summarize-hotel.js";
import { bookingBrowser } from "./browser.js";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .command(
      "summarize_hotel",
      "Fetch a statistically meaningful summary of a Booking.com hotel based on recent reviews",
      (yargs) =>
        yargs
          .option("url", {
            alias: "u",
            type: "string",
            description: "Full Booking.com hotel page URL",
            demandOption: true,
          })
          .option("within-months", {
            alias: "m",
            type: "number",
            description: "Only include reviews from the last N months (default 12)",
            default: 12,
          }),
      async (args) => {
        try {
          const result = await summarizeHotelJSON({
            url: args.url,
            withinMonths: args["within-months"],
          });
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        } catch (err) {
          console.error(
            "Error:",
            err instanceof Error ? err.message : String(err)
          );
          process.exit(1);
        } finally {
          await bookingBrowser.close();
        }
      }
    )
    .command(
      "get_hotel_reviews",
      "Fetch raw guest reviews for a Booking.com hotel",
      (yargs) =>
        yargs
          .option("url", {
            alias: "u",
            type: "string",
            description: "Full Booking.com hotel page URL",
            demandOption: true,
          })
          .option("limit", {
            alias: "l",
            type: "number",
            description: "Number of reviews to return (1–1000, default 10)",
            default: 10,
          })
          .option("skip", {
            alias: "s",
            type: "number",
            description: "Reviews to skip for pagination (default 0)",
            default: 0,
          })
          .option("sort-by", {
            alias: "b",
            type: "string",
            description: "Sort order: MOST_RELEVANT or MOST_RECENT",
            choices: ["MOST_RELEVANT", "MOST_RECENT"],
            default: "MOST_RELEVANT",
          }),
      async (args) => {
        try {
          const reviews = await getHotelReviewsJSON({
            url: args.url,
            limit: args.limit,
            skip: args.skip,
            sortBy: args["sort-by"] as "MOST_RELEVANT" | "MOST_RECENT",
          });
          console.log(JSON.stringify(reviews, null, 2));
          process.exit(0);
        } catch (err) {
          console.error(
            "Error:",
            err instanceof Error ? err.message : String(err)
          );
          process.exit(1);
        } finally {
          await bookingBrowser.close();
        }
      }
    )
    .version("0.1.0")
    .help()
    .alias("h", "help")
    .demandCommand()
    .strict()
    .parseAsync();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
