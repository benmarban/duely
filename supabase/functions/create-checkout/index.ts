// Dayflow Pro — create a Stripe Checkout Session.
//
// Called from the app (sb.functions.invoke('create-checkout', { body })) when a
// signed-in user taps "Get Pro". Returns { url }; the app redirects there.
// On success Stripe sends the user back to app.html?upgraded=1, and the
// stripe-webhook function flips data.pro.active = true for their account.
//
// Deploy:  supabase functions deploy create-checkout
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_...  \
//            STRIPE_PRICE_MONTHLY=price_...  STRIPE_PRICE_YEARLY=price_...
// (Create the two recurring Prices in Stripe → Products: $2.99/month, $19.99/year.)

import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { plan, userId: bodyUserId, email, returnUrl } = await req.json().catch(() => ({}));

    // Trust the signed-in user's JWT for the account id (fall back to body).
    let userId = bodyUserId;
    const auth = req.headers.get("Authorization");
    if (auth) {
      const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: auth } },
      });
      const { data } = await supa.auth.getUser();
      if (data?.user?.id) userId = data.user.id;
    }
    if (!userId) return json({ error: "Not signed in" }, 401);

    const price = plan === "monthly"
      ? Deno.env.get("STRIPE_PRICE_MONTHLY")
      : Deno.env.get("STRIPE_PRICE_YEARLY");
    if (!price) return json({ error: "Price not configured" }, 500);

    const base = ((returnUrl || "").split("?")[0]) || "https://benmarban.github.io/duely/app.html";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: userId,
      metadata: { userId, plan: plan || "yearly" },
      subscription_data: { metadata: { userId } },
      allow_promotion_codes: true,
      success_url: base + "?upgraded=1",
      cancel_url: base,
    });

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
