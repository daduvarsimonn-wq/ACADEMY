export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }


  try {

    /* ==========================================
       ENVIRONMENT VARIABLES
    ========================================== */

    const {
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY,
      PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET
    } = process.env;


    if (
      !SUPABASE_URL ||
      !SUPABASE_PUBLISHABLE_KEY ||
      !SUPABASE_SERVICE_ROLE_KEY ||
      !PAYPAL_CLIENT_ID ||
      !PAYPAL_CLIENT_SECRET
    ) {

      console.error(
        "Missing production environment variables."
      );

      return res.status(500).json({
        error: "Payment system is not configured."
      });

    }


    /* ==========================================
       AUTHENTICATE USER
    ========================================== */

    const authorization =
      req.headers.authorization;


    if (!authorization) {

      return res.status(401).json({
        error: "You must be logged in."
      });

    }


    const userResponse =
      await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          method: "GET",

          headers: {
            apikey:
              SUPABASE_PUBLISHABLE_KEY,

            Authorization:
              authorization
          }
        }
      );


    if (!userResponse.ok) {

      return res.status(401).json({
        error: "Invalid or expired session."
      });

    }


    const user =
      await userResponse.json();


    if (!user?.id) {

      return res.status(401).json({
        error: "Invalid user."
      });

    }


    /* ==========================================
       READ ORDER ID
    ========================================== */

    const {
      orderID
    } = req.body || {};


    if (!orderID) {

      return res.status(400).json({
        error: "Missing PayPal order ID."
      });

    }


    /* ==========================================
       PAYPAL LIVE OAUTH
    ========================================== */

    const credentials =
      Buffer
        .from(
          `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
        )
        .toString("base64");


    const tokenResponse =
      await fetch(
        "https://api-m.paypal.com/v1/oauth2/token",
        {
          method: "POST",

          headers: {
            Authorization:
              `Basic ${credentials}`,

            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            "grant_type=client_credentials"
        }
      );


    const tokenData =
      await tokenResponse.json();


    if (!tokenResponse.ok) {

      console.error(
        "PayPal OAuth error:",
        tokenData
      );

      return res.status(500).json({
        error: "PayPal authentication failed."
      });

    }


    const accessToken =
      tokenData.access_token;


    /* ==========================================
       GET ORDER BEFORE CAPTURE
    ========================================== */

    const orderResponse =
      await fetch(
        `https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(orderID)}`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Content-Type":
              "application/json"
          }
        }
      );


    const existingOrder =
      await orderResponse.json();


    if (!orderResponse.ok) {

      console.error(
        "PayPal order lookup error:",
        existingOrder
      );

      return res.status(400).json({
        error: "PayPal order could not be verified."
      });

    }


    /* ==========================================
       VERIFY ORDER OWNER + PRODUCT + PRICE
    ========================================== */

    const purchaseUnit =
      existingOrder
        ?.purchase_units?.[0];


    const paypalUserID =
      purchaseUnit?.custom_id;


    const paypalAmount =
      purchaseUnit
        ?.amount
        ?.value;


    const paypalCurrency =
      purchaseUnit
        ?.amount
        ?.currency_code;


    const referenceID =
      purchaseUnit?.reference_id;


    if (
      paypalUserID !== user.id
    ) {

      console.error(
        "PayPal user mismatch."
      );

      return res.status(403).json({
        error: "Payment does not belong to this account."
      });

    }


    if (
      referenceID !==
      "agency-blueprint"
    ) {

      return res.status(400).json({
        error: "Invalid course."
      });

    }


    if (
      paypalAmount !== "29.00" ||
      paypalCurrency !== "USD"
    ) {

      console.error(
        "Invalid payment:",
        paypalAmount,
        paypalCurrency
      );

      return res.status(400).json({
        error: "Payment amount verification failed."
      });

    }


    /* ==========================================
       CAPTURE LIVE PAYMENT
    ========================================== */

    const captureResponse =
      await fetch(
        `https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Content-Type":
              "application/json"
          },

          body: "{}"
        }
      );


    const capture =
      await captureResponse.json();


    /*
     * PayPal may return the already-completed
     * order if the request is repeated.
     */

    if (
      !captureResponse.ok &&
      capture?.name !==
        "ORDER_ALREADY_CAPTURED"
    ) {

      console.error(
        "PayPal capture error:",
        capture
      );

      return res.status(400).json({
        error:
          "PayPal payment could not be captured."
      });

    }


    /* ==========================================
       VERIFY FINAL PAYMENT STATUS
    ========================================== */

    if (
      capture.status !==
      "COMPLETED"
    ) {

      return res.status(400).json({
        error:
          "Payment was not completed."
      });

    }


    const capturedUnit =
      capture
        ?.purchase_units?.[0];


    const capturedPayment =
      capturedUnit
        ?.payments
        ?.captures?.[0];


    const capturedAmount =
      capturedPayment
        ?.amount
        ?.value;


    const capturedCurrency =
      capturedPayment
        ?.amount
        ?.currency_code;


    if (
      capturedAmount !== "29.00" ||
      capturedCurrency !== "USD"
    ) {

      console.error(
        "Captured amount mismatch:",
        capturedAmount,
        capturedCurrency
      );

      return res.status(400).json({
        error:
          "Captured payment amount could not be verified."
      });

    }


    /* ==========================================
       GET COURSE FROM SUPABASE
    ========================================== */

    const courseResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/courses?slug=eq.agency-blueprint&select=id,slug,price`,
        {
          method: "GET",

          headers: {
            apikey:
              SUPABASE_SERVICE_ROLE_KEY,

            Authorization:
              `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );


    const courses =
      await courseResponse.json();


    if (
      !courseResponse.ok ||
      !courses.length
    ) {

      console.error(
        "Course lookup error:",
        courses
      );

      return res.status(500).json({
        error: "Course not found."
      });

    }


    const course =
      courses[0];


    /* ==========================================
       VERIFY DATABASE PRICE
    ========================================== */

    if (
      Number(course.price) !==
      29
    ) {

      console.error(
        "Database price mismatch:",
        course.price
      );

      return res.status(500).json({
        error:
          "Course price configuration is invalid."
      });

    }


    /* ==========================================
       CHECK EXISTING PURCHASE
    ========================================== */

    const existingPurchaseResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/purchases?user_id=eq.${encodeURIComponent(
          user.id
        )}&course_id=eq.${encodeURIComponent(
          course.id
        )}&select=id,status`,
        {
          method: "GET",

          headers: {
            apikey:
              SUPABASE_SERVICE_ROLE_KEY,

            Authorization:
              `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );


    const existingPurchases =
      await existingPurchaseResponse.json();


    if (
      existingPurchaseResponse.ok &&
      existingPurchases.length > 0 &&
      existingPurchases[0].status ===
        "completed"
    ) {

      return res.status(200).json({

        success: true,

        course:
          "agency-blueprint",

        alreadyOwned:
          true

      });

    }


    /* ==========================================
       SAVE VERIFIED PURCHASE
    ========================================== */

    const purchaseResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/purchases`,
        {
          method: "POST",

          headers: {
            apikey:
              SUPABASE_SERVICE_ROLE_KEY,

            Authorization:
              `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

            "Content-Type":
              "application/json",

            Prefer:
              "resolution=merge-duplicates,return=representation"
          },

          body:
            JSON.stringify({

              user_id:
                user.id,

              course_id:
                course.id,

              paypal_order_id:
                orderID,

              status:
                "completed",

              amount:
                29.00,

              currency:
                "USD"

            })
        }
      );


    const purchase =
      await purchaseResponse.json();


    if (!purchaseResponse.ok) {

      console.error(
        "Supabase purchase error:",
        purchase
      );

      return res.status(500).json({
        error:
          "Payment succeeded but purchase could not be saved."
      });

    }


    /* ==========================================
       SUCCESS
    ========================================== */

    return res.status(200).json({

      success:
        true,

      course:
        "agency-blueprint",

      purchase:
        purchase

    });


  } catch (error) {

    console.error(
      "Capture server error:",
      error
    );

    return res.status(500).json({
      error:
        "Server error."
    });

  }

}