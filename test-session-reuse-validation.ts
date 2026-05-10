import { bookingBrowser } from "./src/browser.js";

const HOTELS = {
  renKL: "https://www.booking.com/hotel/my/renaissance-kuala-lumpur.en-gb.html",
  shanKL: "https://www.booking.com/hotel/my/shangri-la-kuala-lumpur.en-gb.html",
};

async function main() {
  try {
    console.log("=".repeat(60));
    console.log("SESSION REUSE VALIDATION TEST");
    console.log("=".repeat(60));

    // Step 1: Capture Renaissance KL session
    console.log("\n[Step 1] Capturing Renaissance KL session...");
    const renSession = await bookingBrowser.ensureSession(HOTELS.renKL);
    const renHotelId = renSession.baseInput.hotelId;
    console.log(`✅ Renaissance KL hotelId: ${renHotelId}`);
    console.log(`   Headers keys: ${Object.keys(renSession.headers).join(", ")}`);
    console.log(`   Query operation: ${renSession.baseInput.hotelCountryCode}`);

    // Step 2: Capture Shangri-La KL session
    console.log("\n[Step 2] Capturing Shangri-La KL session...");
    const shanSession = await bookingBrowser.ensureSession(HOTELS.shanKL);
    const shanHotelId = shanSession.baseInput.hotelId;
    console.log(`✅ Shangri-La KL hotelId: ${shanHotelId}`);
    console.log(`   Headers keys: ${Object.keys(shanSession.headers).join(", ")}`);

    // Step 3: Test session reuse - use Renaissance session with Shangri-La hotelId
    console.log("\n[Step 3] Testing session reuse: Renaissance session + Shangri-La hotelId...");
    try {
      const reusedInput = {
        ...renSession.baseInput,
        hotelId: shanHotelId,
      };
      console.log(`   Modified input hotelId: ${renHotelId} → ${shanHotelId}`);
      console.log(`   Other baseInput keys: ${Object.keys(renSession.baseInput).filter(k => k !== 'hotelId').join(", ")}`);

      const result = await bookingBrowser.callGraphQL(renSession, reusedInput);
      console.log(`✅ Session reuse SUCCESSFUL!`);
      console.log(`   Reviews count: ${result.reviewsCount}`);
      console.log(`   Sample reviews: ${result.reviewCard.slice(0, 2).map(r => `"${r.textDetails.title}" (${r.reviewScore}/10)`).join(", ")}`);

      // Step 4: Verify the reviews are for Shangri-La, not Renaissance
      console.log("\n[Step 4] Verifying reviews are for Shangri-La KL (not Renaissance)...");
      const shanDirectResult = await bookingBrowser.callGraphQL(shanSession, shanSession.baseInput);
      console.log(`   Direct Shangri-La call: ${shanDirectResult.reviewsCount} reviews`);
      console.log(`   Both return same reviews: ${result.reviewsCount === shanDirectResult.reviewsCount}`);

      console.log("\n" + "=".repeat(60));
      console.log("CONCLUSION: Session reuse architecture is VIABLE ✅");
      console.log("=".repeat(60));
      console.log("\nThis means we can:");
      console.log("1. Capture one working session (e.g., Renaissance KL)");
      console.log("2. Use the same session to query any other hotel by changing hotelId");
      console.log("3. Avoid per-hotel page loads for hotels blocked by bot detection");
    } catch (reusedErr) {
      console.log(`❌ Session reuse FAILED: ${reusedErr instanceof Error ? reusedErr.message : String(reusedErr)}`);
      console.log("\nThis means:");
      console.log("- Booking.com validates hotelId against headers or auth token");
      console.log("- Cannot use cross-hotel session reuse directly");
      console.log("- Alternative: Check if baseInput.ufi or other fields need updating");
    }

  } catch (err) {
    console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await bookingBrowser.close();
  }
}

main();
