import { bookingBrowser } from "./src/browser.js";

async function testCSRFReuse() {
  try {
    console.error("[TEST] Capturing session from hotel 1...");
    const session1 = await bookingBrowser.ensureSession(
      "https://www.booking.com/hotel/au/felix.en-gb.html"
    );

    console.error("[TEST] Hotel 1 captured:");
    console.error(`  - hotelId: ${session1.baseInput.hotelId}`);
    console.error(`  - Headers keys: ${Object.keys(session1.headers).length}`);

    // Now try to use hotel 1's CSRF/headers but with a mock hotel 2 hotelId
    const modifiedInput = {
      ...session1.baseInput,
      hotelId: 99999999, // Fake hotel ID (should fail if CSRF is tied to hotel)
    };

    console.error("\n[TEST] Trying to query with hotel 1's CSRF but hotel 2's ID (99999999)...");
    try {
      const result = await bookingBrowser.callGraphQL(session1, modifiedInput);

      if (result.reviewsCount >= 0) {
        console.error("✓ SUCCESS: CSRF reuse works! Got reviews:", result.reviewsCount);
        return true;
      } else {
        console.error("✗ FAILED: Got invalid response");
        return false;
      }
    } catch (err: any) {
      const errMsg = err.message || String(err);
      if (errMsg.includes("404") || errMsg.includes("not found")) {
        console.error("✗ CSRF reuse FAILED: Hotel not found (CSRF is hotel-specific)");
        return false;
      } else {
        console.error("✗ ERROR:", errMsg);
        return false;
      }
    }
  } catch (err) {
    console.error("[TEST] Fatal error:", err);
    return false;
  } finally {
    await bookingBrowser.close();
  }
}

testCSRFReuse().then((worked) => {
  console.error("\n" + (worked
    ? "[RESULT] CSRF IS REUSABLE - optimize by capturing once"
    : "[RESULT] CSRF IS NOT REUSABLE - must capture per hotel"));
});
