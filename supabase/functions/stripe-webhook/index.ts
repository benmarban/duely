// Dayflow Pro — Stripe webhook. Flips each user's data.pro when their
// subscription starts, renews, or ends. This is the source of truth for Pro.
//
// Deploy with signature verification OFF for the platform JWT (Stripe signs its
// own way):  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets:   supabase secrets set STRIPE_SECRET_KEY=sk_...  STRIPE_WEBHOOK_SECRET=whsec_...
// Then in Stripe → Developers → Webhooks, add the function URL and subscribe to:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
async function setPro(userId: string, pro: Record<string, unknown>) {
  const { data } = await supa.from("user_state").select("data").eq("user_id", userId).maybeSingle();
  const state: any = (data && (data as any).data) || {};
  state.pro = pro;
  await supa.from("user_state").upsert({ user_id: userId, data: state, updated_at: new Date().toISOString() });
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, cryptoProvider,
    );
  } catch (e) {
    return new Response("Bad signature: " + (e as Error).message, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = (s.client_reference_id || (s.metadata as any)?.userId) as string;
      if (userId) await setPro(userId, { active: true, plan: (s.metadata as any)?.plan || "", since: Date.now(), customer: s.customer, subscription: s.subscription });
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata as any)?.userId as string;
      const active = sub.status === "active" || sub.status === "trialing";
      if (userId) await setPro(userId, { active, plan: sub.items?.data?.[0]?.price?.recurring?.interval || "", since: Date.now(), customer: sub.customer, subscription: sub.id });
    } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.paused") {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata as any)?.userId as string;
      if (userId) await setPro(userId, { active: false });
    }
  } catch (e) {
    return new Response("Handler error: " + (e as Error).message, { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
