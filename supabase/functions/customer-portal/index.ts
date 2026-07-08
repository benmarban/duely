// Dayflow Pro — open the Stripe billing portal so a Pro user can update their
// card, view invoices, or cancel. Called from the app when a Pro member taps
// "Manage subscription". Returns { url }; the app redirects there.
//
// Deploy:  supabase functions deploy customer-portal
// Secrets: uses STRIPE_SECRET_KEY (already set for create-checkout).

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
    const { returnUrl } = await req.json().catch(() => ({}));

    // Identify the signed-in user from their JWT, then look up their Stripe customer.
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await supa.auth.getUser();
    const userId = u?.user?.id;
    if (!userId) return json({ error: "Not signed in" }, 401);

    // Reads through the caller's JWT — the "user reads own pro" policy scopes this
    // to their own row, so a forged user_id in the query would return nothing.
    const { data: row } = await supa.from("user_pro").select("customer").eq("user_id", userId).maybeSingle();
    const customer = (row as any)?.customer;
    if (!customer) return json({ error: "No subscription found" }, 404);

    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: ((returnUrl || "").split("?")[0]) || "https://benmarban.github.io/duely/app.html",
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
