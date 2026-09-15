const PAYPAL_API = "https://api-m.paypal.com";

const COURSE_SLUG = "agency-blueprint";
const COURSE_PRICE = "29.00";
const COURSE_CURRENCY = "USD";

function json(res, status, body) {
  return res.status(status).json(body);
}

async function getSupabaseUser(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey:
          process.env.SUPABASE_PUBLISHABLE_KEY,

        Authorization: auth
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function getPayPalAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_API}/v1/oauth2/token`,
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

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    console.error(
      "PayPal OAuth error:",
      data
    );

    throw new Error(
      "PayPal authentication failed."
    );
  }

  return data.access_token;
}

async function paypalRequest(
  url,
  options
) {
  const response =
    await fetch(url, options);

  const data =
    await response
      .json()
      .catch(() => ({}));

  return {
    response,
    data
  };
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error:
        "Method not allowed."
    });
  }

  try {

    const required = [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET"
    ];

    for (const name of required) {

      if (!process.env[name]) {

        console.error(
          `Missing environment variable: ${name}`
        );

        return json(res, 500, {
          error:
            "Server configuration is incomplete."
        });
      }
    }

    const user =
      await getSupabaseUser(req);

    if (!user?.id) {

      return json(res, 401, {
        error:
          "You must be logged in."
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : (req.body || {});

    const orderID =
      body.orderID;

    if (
      !orderID ||
      typeof orderID !== "string"
    ) {

      return json(res, 400, {
        error:
          "Missing PayPal order ID."
      });
    }

    const accessToken =
      await getPayPalAccessToken();

    /*
      VERIFY PAYPAL ORDER
    */

    const orderResult =
      await paypalRequest(
        `${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderID)}`,

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

    if (
      !orderResult.response.ok
    ) {

      console.error(
        "PayPal order lookup error:",
        orderResult.data
      );

      return json(res, 502, {
        error:
          "Could not verify the PayPal order."
      });
    }

    const order =
      orderResult.data;

    const unit =
      order.purchase_units?.[0];

    const amount =
      unit?.amount;

    const customID =
      unit?.custom_id;

    const referenceID =
      unit?.reference_id;

    /*
      VERIFY USER + COURSE + PRICE
    */

    if (
      customID !== user.id ||
      referenceID !== COURSE_SLUG ||
      amount?.currency_code !==
        COURSE_CURRENCY ||
      amount?.value !==
        COURSE_PRICE
    ) {

      console.error(
        "PayPal order verification failed:",
        {
          orderID,
          customID,
          referenceID,
          amount
        }
      );

      return json(res, 400, {
        error:
          "PayPal order verification failed."
      });
    }

    let captureData;

    /*
      CAPTURE PAYMENT
    */

    if (
      order.status ===
      "COMPLETED"
    ) {

      captureData = order;

    } else {

      const captureResult =
        await paypalRequest(

          `${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,

          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",

              "PayPal-Request-Id":
                `capture-${orderID}`
            },

            body: "{}"
          }
        );

      if (
        !captureResult.response.ok &&
        captureResult.data?.name !==
          "ORDER_ALREADY_CAPTURED"
      ) {

        console.error(
          "PayPal capture error:",
          captureResult.data
        );

        return json(res, 502, {
          error:
            "PayPal could not complete the payment."
        });
      }

      captureData =
        captureResult.data;
    }

    /*
      PAYMENT MUST BE COMPLETED
    */

    if (
      captureData?.status !==
      "COMPLETED"
    ) {

      return json(res, 400, {
        error:
          "Payment was not completed."
      });
    }

    /*
      VERIFY CAPTURE AMOUNT
    */

    const capture =
      captureData
        .purchase_units?.[0]
        ?.payments
        ?.captures?.[0];

    if (
      capture &&
      (
        capture.status !==
          "COMPLETED" ||

        capture.amount
          ?.currency_code !==
          COURSE_CURRENCY ||

        capture.amount?.value !==
          COURSE_PRICE
      )
    ) {

      return json(res, 400, {
        error:
          "Captured payment could not be verified."
      });
    }

    /*
      SUPABASE ADMIN HEADERS

      SERVICE ROLE KEY NEVER
      GOES INTO FRONTEND CODE.
    */

    const supabaseHeaders = {

      apikey:
        process.env
          .SUPABASE_SERVICE_ROLE_KEY,

      Authorization:
        `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,

      "Content-Type":
        "application/json",

      Prefer:
        "return=representation"
    };

    /*
      FIND COURSE
    */

    const courseResponse =
      await fetch(

        `${process.env.SUPABASE_URL}/rest/v1/courses?slug=eq.${encodeURIComponent(COURSE_SLUG)}&select=id,price`,

        {
          headers:
            supabaseHeaders
        }
      );

    const courses =
      await courseResponse.json();

    if (
      !courseResponse.ok ||
      !courses.length ||
      Number(courses[0].price)
        .toFixed(2) !==
        COURSE_PRICE
    ) {

      console.error(
        "Course verification error:",
        courses
      );

      return json(res, 500, {
        error:
          "Course configuration could not be verified."
      });
    }

    const courseID =
      courses[0].id;

    /*
      CHECK EXISTING PURCHASE
    */

    const existingResponse =
      await fetch(

        `${process.env.SUPABASE_URL}/rest/v1/purchases?user_id=eq.${encodeURIComponent(user.id)}&course_id=eq.${encodeURIComponent(courseID)}&select=id,status`,

        {
          headers:
            supabaseHeaders
        }
      );

    const existing =
      await existingResponse.json();

    if (
      !existingResponse.ok
    ) {

      console.error(
        "Purchase lookup error:",
        existing
      );

      return json(res, 500, {
        error:
          "Could not verify your course access."
      });
    }

    /*
      SAVE PURCHASE
    */

    const purchasePayload = {

      user_id:
        user.id,

      course_id:
        courseID,

      paypal_order_id:
        orderID,

      status:
        "completed",

      amount:
        Number(COURSE_PRICE),

      currency:
        COURSE_CURRENCY
    };

    let purchaseResponse;

    if (existing.length) {

      purchaseResponse =
        await fetch(

          `${process.env.SUPABASE_URL}/rest/v1/purchases?id=eq.${encodeURIComponent(existing[0].id)}`,

          {
            method: "PATCH",

            headers:
              supabaseHeaders,

            body:
              JSON.stringify(
                purchasePayload
              )
          }
        );

    } else {

      purchaseResponse =
        await fetch(

          `${process.env.SUPABASE_URL}/rest/v1/purchases`,

          {
            method: "POST",

            headers:
              supabaseHeaders,

            body:
              JSON.stringify(
                purchasePayload
              )
          }
        );
    }

    if (
      !purchaseResponse.ok
    ) {

      const purchaseError =
        await purchaseResponse.text();

      console.error(
        "Purchase save error:",
        purchaseError
      );

      return json(res, 500, {
        error:
          "Payment succeeded, but course access could not be saved. Contact support."
      });
    }

    /*
      SUCCESS
    */

    return json(res, 200, {

      success:
        true,

      course:
        COURSE_SLUG,

      status:
        "completed"
    });

  } catch (error) {

    console.error(
      "Capture order error:",
      error
    );

    return json(res, 500, {

      error:
        error.message ||
        "Could not complete payment."
    });
  }
}
