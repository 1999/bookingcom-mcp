# bookingcom-mcp

MCP server for Booking.com hotel reviews. Exposes two tools to fetch raw guest reviews and statistical summaries via a headless browser session that captures and reuses Booking.com's internal GraphQL API.

## Tools

### `get_hotel_reviews`

Fetches individual guest reviews for a hotel.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | Full Booking.com hotel URL |
| `limit` | integer 1–50 | `10` | Number of reviews to return |
| `skip` | integer ≥0 | `0` | Reviews to skip (for pagination) |
| `sortBy` | `MOST_RELEVANT` \| `MOST_RECENT` | `MOST_RELEVANT` | Sort order |

Returns each review's score, date, guest type, room info, positive/negative text, and hotel reply.

### `summarize_hotel`

Fetches a statistically meaningful summary of recent reviews (95% confidence ±5% margin via finite population correction).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | Full Booking.com hotel URL |
| `withinMonths` | integer 1–60 | `12` | Include reviews from the last N months |

Returns the overall score, per-category ratings (staff, cleanliness, location, value, etc.), score distribution, traveler type breakdown, top languages, score trend (improving/declining/stable), and the confidence interval on the recent sample mean.

## Installation

```bash
git clone https://github.com/your-username/bookingcom-mcp.git
cd bookingcom-mcp
npm install
npx playwright install chromium
```

## Running

```bash
# Production / used by an MCP client
npm start

# Development — auto-restarts on source changes
npm run dev
```

## Claude Desktop integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bookingcom-reviews": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/bookingcom-mcp/src/index.ts"]
    }
  }
}
```

Replace `/absolute/path/to/bookingcom-mcp` with the directory where you cloned the repo.

## How it works

**Session capture** — on first use, a headless Chromium instance (with stealth plugin to avoid bot detection) navigates to the hotel page and intercepts the first `ReviewList` GraphQL request. The captured headers, CSRF token, and query template are cached for 20 hours. Subsequent calls reuse the cached session without relaunching the browser.

**GraphQL execution** — review requests are made from within the browser context so Booking.com's session cookies are automatically included.

**Statistical sampling** — `summarize_hotel` uses the finite population correction formula to determine the minimum sample needed for a 95% confidence interval with ±5% margin of error, then fetches exactly that many recent reviews.
