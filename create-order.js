export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    /* ==========================================
       REQUIRED ENVIRONMENT VARIABLES
    ========================================== */

    const {
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET
    } = process.env;


    if (
      !SUPABASE_URL ||
      !SUPABASE_PUBLISHABLE_KEY ||
      !PAYPAL_CLIENT_ID ||
      !PAYPAL_CLIENT_SECRET
    ) {
      console.error("Missing server environment variables.");

      return res.status(500).json({
        error: "Payment system is not configured."
      });
    }


    /* ==========================================
       AUTHENTICATE SUPABASE USER
    ========================================== */

    const authorization =
      req.headers.authorization;

    if (!authorization) {
      return res.status(401).json({
        error: "You must be logged in."
      });
    }


    const userResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        method: "GET",

        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: authorization
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
        error: "User authentication failed."
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


    /* ==========================================
       CREATE LIVE PAYPAL ORDER
    ========================================== */

    const orderResponse =
      await fetch(
        "https://api-m.paypal.com/v2/checkout/orders",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${tokenData.access_token}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            intent: "CAPTURE",

            purchase_units: [

              {
                reference_id:
                  "agency-blueprint",

                description:
                  "ACADEMY — Agency Blueprint",

                custom_id:
                  user.id,

                amount: {
                  currency_code: "USD",
                  value: "29.00"
                }
              }

            ]

          })
        }
      );


    const order =
      await orderResponse.json();


    if (!orderResponse.ok) {

      console.error(
        "PayPal order creation error:",
        order
      );

      return res.status(500).json({
        error: "Could not create PayPal order."
      });
    }


    if (!order.id) {

      return res.status(500).json({
        error: "PayPal did not return an order ID."
      });
    }


    return res.status(200).json({
      orderID: order.id
    });


  } catch (error) {

    console.error(
      "Create order error:",
      error
    );

    return res.status(500).json({
      error: "Server error."
    });

  }
}