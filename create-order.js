const PAYPAL_API = "https://api-m.paypal.com";
const COURSE_SLUG = "agency-blueprint";
const COURSE_PRICE = "29.00";
const COURSE_CURRENCY = "USD";
const SITE_URL = process.env.SITE_URL || "https://my-roan-five.vercel.app";

function json(res, status, body) {
  return res.status(status).json(body);
}

async function getSupabaseUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;

  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: auth
    }
  });

  if (!response.ok) return null;
  return response.json();
}

async function getPayPalAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    console.error("PayPal OAuth error:", data);
    throw new Error("PayPal authentication failed.");
  }

  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed." });
  }

  try {
    const required = [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET"
    ];

    for (const name of required) {
      if (!process.env[name]) {
        console.error(`Missing environment variable: ${name}`);
        return json(res, 500, { error: "Server configuration is incomplete." });
      }
    }

    const user = await getSupabaseUser(req);
    if (!user?.id) {
      return json(res, 401, { error: "You must be logged in." });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `academy-${user.id}-${Date.now()}`
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        payment_source: {
          paypal: {
            experience_context: {
              user_action: "PAY_NOW",
              return_url: `${SITE_URL}/courses.html?paypal=return`,
              cancel_url: `${SITE_URL}/courses.html?paypal=cancel`,
              shipping_preference: "NO_SHIPPING"
            }
          }
        },
        purchase_units: [
          {
            reference_id: COURSE_SLUG,
            custom_id: user.id,
            description: "ACADEMY — Agency Blueprint",
            amount: {
              currency_code: COURSE_CURRENCY,
              value: COURSE_PRICE
            }
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok || !data.id) {
      console.error("PayPal create order error:", data);
      return json(res, 502, { error: "PayPal could not create the order." });
    }

    const approvalLink =
      data.links?.find((link) => link.rel === "payer-action")?.href ||
      data.links?.find((link) => link.rel === "approve")?.href;

    if (!approvalLink) {
      console.error("PayPal approval link missing:", data);
      return json(res, 502, { error: "PayPal did not provide a checkout link." });
    }

    return json(res, 200, {
      orderID: data.id,
      approvalUrl: approvalLink
    });
  } catch (error) {
    console.error("Create order error:", error);
    return json(res, 500, { error: error.message || "Could not create order." });
  }
}
