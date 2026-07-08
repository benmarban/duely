# Dayflow Pro — going live

The app already has the full Pro experience built in: the upgrade modal, the
free-tier limits (1 school + 1 work + 1 inbox), and Pro state that unlocks
everything and updates live. To actually take payments, wire up Stripe once.

## Free vs Pro (change limits in `app.html` → `const FREE`)
| | Free | Pro |
|---|---|---|
| Unified timeline, AI assistant, month calendar | ✓ | ✓ |
| School systems (Canvas, Blackboard, …) | 1 | unlimited |
| Work apps for shifts | 1 | unlimited |
| Linked email inboxes | 1 | unlimited |
| Reminders / grade tracking | — | coming soon |

Prices live in one place in `app.html`: `const PRICE = { monthly:'$2.99', yearly:'$19.99' }`.

## One-time Stripe setup
1. **Create the product + prices** in Stripe → Products: a recurring **$2.99/month**
   price and a recurring **$19.99/year** price. Copy their `price_…` ids.
2. **Deploy the functions**
   ```
   supabase functions deploy create-checkout
   supabase functions deploy customer-portal
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
3. **Set secrets**
   ```
   supabase secrets set STRIPE_SECRET_KEY=sk_live_...            \
       STRIPE_PRICE_MONTHLY=price_...  STRIPE_PRICE_YEARLY=price_...  \
       STRIPE_WEBHOOK_SECRET=whsec_...
   ```
4. **Add the webhook** in Stripe → Developers → Webhooks: endpoint =
   the `stripe-webhook` function URL; events =
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`,
   `customer.subscription.resumed`. Paste its signing secret as
   `STRIPE_WEBHOOK_SECRET` above.

5. **Enable the billing portal** once, in Stripe → Settings → Billing →
   Customer portal → **Activate**. (Powers the "Manage subscription" button.)

That's it. Flow: tap **Get Pro** → Stripe Checkout → back to `app.html?upgraded=1`
→ the webhook sets `data.pro.active = true` → the app flips to Pro **live** (via
the realtime/poll auto-update) with a thank-you toast. Pro members then see
**Manage subscription** (Stripe billing portal) to update their card or cancel.

## Do it in test mode first
Stripe's test and live modes are fully separate — separate keys, separate
products, separate webhook endpoints, separate signing secrets. Nothing below
can touch a real card. Do the whole loop here, then repeat step 3+4 with live
values to go live.

Everything is browser-only; no CLI, no Docker.

1. **Stripe → toggle Test mode** (top right). Create the product + both prices
   here; copy the two test `price_…` ids. Grab the test key (`sk_test_…`) from
   Developers → API keys.
2. **Deploy the three functions** — Supabase → Edge Functions → *Deploy a new
   function* → *Via Editor*, once per function, pasting each `index.ts`.
   On `stripe-webhook`, **turn JWT verification off** (the dashboard equivalent
   of `--no-verify-jwt`). Stripe signs requests its own way and sends no Supabase
   `Authorization` header, so with JWT on it gets a 401 and your code never runs.
3. **Add the test webhook** — Stripe (still in Test mode) → Developers →
   Webhooks → endpoint = `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`,
   events as in step 4 above. Copy its `whsec_…`.
4. **Set the secrets** — Supabase → Edge Functions → Secrets:
   `STRIPE_SECRET_KEY=sk_test_…`, the two test price ids, `STRIPE_WEBHOOK_SECRET=whsec_…`.
   These are project-wide, so going live later means *overwriting* these four,
   not adding a second set.
5. **Buy it yourself.** Sign into the app, tap Get Pro, pay with `4242 4242 4242 4242`,
   any future expiry, any CVC. You should land on `app.html?upgraded=1` and watch
   the UI flip to Pro within a couple of seconds.
6. **Then cancel**, via Manage subscription → Cancel. Pro should switch back off.

Verify at both ends: Stripe → Webhooks → your endpoint shows each delivery and
its response (200 = handled, 400 = signature/secret mismatch, 401 = JWT still on,
500 = handler threw). Supabase → Edge Functions → `stripe-webhook` → Logs shows
the thrown message.

> **Don't verify with `stripe trigger`.** Its fixture events carry no
> `client_reference_id` and no `subscription.metadata.userId`, so the webhook
> can't tell which account to upgrade and returns 200 having done nothing. It
> looks like a broken webhook and isn't. A real test-card checkout is the only
> thing that exercises the metadata path.

## Testing without any Stripe setup at all
Set a user to Pro by hand in the Supabase SQL editor (replace the id):
```sql
update user_state
set data = jsonb_set(data, '{pro}', '{"active":true,"plan":"yearly"}'::jsonb)
where user_id = '<your-user-id>';
```
The app will pick it up on the next sync and unlock everything.

## Note on the free limits
Existing testers who connected multiple sources before Pro keep them — the limit
only blocks *adding new* ones on the free tier. Adjust `FREE` if you want to
grandfather differently or run a launch promo (e.g. everything free for a term).
