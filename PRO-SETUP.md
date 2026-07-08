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
   `customer.subscription.deleted`. Paste its signing secret as
   `STRIPE_WEBHOOK_SECRET` above.

5. **Enable the billing portal** once, in Stripe → Settings → Billing →
   Customer portal → **Activate**. (Powers the "Manage subscription" button.)

That's it. Flow: tap **Get Pro** → Stripe Checkout → back to `app.html?upgraded=1`
→ the webhook sets `data.pro.active = true` → the app flips to Pro **live** (via
the realtime/poll auto-update) with a thank-you toast. Pro members then see
**Manage subscription** (Stripe billing portal) to update their card or cancel.

## Testing before Stripe is live
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
