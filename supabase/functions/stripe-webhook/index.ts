// Dayflow Pro — Stripe webhook. Flips each user's row in `user_pro` when their
// subscription starts, renews, or ends. This is the source of truth for Pro, and
// (service role aside) the only thing that can write that table.
//
// Deploy with signature verification OFF for the platform JWT (Stripe signs its
// own way):  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets:   supabase secrets set STRIPE_SECRET_KEY=sk_...  STRIPE_WEBHOOK_SECRET=whsec_...
// Then in Stripe → Developers → Webhooks, add the function URL and subscribe to:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted, customer.subscription.paused,
//   customer.subscription.resumed
//
// Every path except checkout.session.completed finds the account via
// subscription.metadata.userId, which create-checkout sets through
// subscription_data.metadata. Drop that and renewals/cancels silently no-op.
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Stripe hands us `string | {id} | null` depending on whether a field was expanded.
// customer-portal reads user_pro.customer expecting a plain id, so flatten it here.
const id = (x: unknown): string | null =>
  typeof x === "string" ? x : (x && typeof x === "object" && "id" in x) ? String((x as any).id) : null;

// Writes the entitlement to `user_pro` (see supabase/migrations/*_user_pro.sql).
//
// That table is readable by its owner and writable by nobody but the service role,
// which is what this function holds. It used to live in `user_state.data.pro` — a
// blob the browser upserts — so customers could grant themselves Pro, and the
// browser's debounced save raced this write and could reset it to null. A row of
// its own removes both problems, and the read-modify-write with it: one upsert,
// no snapshot of anyone else's data to preserve.
//
// A failed write must not return 200, or Stripe drops the event. Throw so the
// handler 500s and Stripe redelivers.
async function setPro(userId: string, patch: Record<string, unknown>) {
  const { error } = await supa
    .from("user_pro")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(`write user_pro: ${error.message}`);
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
      if (userId) {
        await setPro(userId, {
          active: true,
          plan: (s.metadata as any)?.plan || "",
          since: new Date().toISOString(), // `since` is a timestamptz column now, not epoch ms
          customer: id(s.customer),
          subscription: id(s.subscription),
        });
      }
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.resumed" ||
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.paused"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata as any)?.userId as string;

      // deleted/paused end access no matter what the snapshot's status says —
      // that field varies with the cancellation path (cancel_at_period_end,
      // pause_collection), so decide from the event type and don't trust it.
      // Note a pending cancel_at_period_end arrives as `updated` with status
      // still "active": correct, the user keeps Pro until the period actually ends.
      const ended = event.type === "customer.subscription.deleted" ||
                    event.type === "customer.subscription.paused";
      const active = !ended && (sub.status === "active" || sub.status === "trialing");

      // customer/subscription are re-sent even when lapsing: customer-portal
      // needs the customer id to show a cancelled user their invoices.
      const patch: Record<string, unknown> = { active, customer: id(sub.customer), subscription: sub.id };

      // checkout.session.completed writes "monthly"/"yearly" from our own metadata;
      // Stripe's interval is "month"/"year". Normalise so user_pro.plan is one vocabulary.
      const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
      const plan = interval === "month" ? "monthly" : interval === "year" ? "yearly" : "";
      if (plan) patch.plan = plan; // don't blank a good value when Stripe omits the price

      if (userId) await setPro(userId, patch);
    }
  } catch (e) {
    return new Response("Handler error: " + (e as Error).message, { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
