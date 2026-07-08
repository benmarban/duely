// Dayflow — Val.town email forwarder (the easiest way to turn on auto email intake)
//
// This runs on Val.town and gives you a free inbound email address with NO
// domain and NO DNS. When mail arrives, it POSTs the message to your Supabase
// `email-inbound` function, which files the dates onto the correct user's
// schedule (matched by the sender's address in their linked inboxes).
//
// ─── ONE-TIME SETUP ────────────────────────────────────────────────────────
// 1. Deploy the Supabase function (from the repo root):
//       supabase functions deploy email-inbound --no-verify-jwt
//       supabase secrets set GEMINI_API_KEY=…  INBOUND_SECRET=<pick-a-long-random-string>
//
// 2. Go to https://val.town → sign in (free, GitHub login) → New Val → "Email".
//    Paste this whole file in.
//
// 3. In the val's settings, add two Environment Variables:
//       SUPABASE_FN_URL = https://<your-project-ref>.supabase.co/functions/v1/email-inbound
//       INBOUND_SECRET  = <the exact same string you set in Supabase secrets>
//
// 4. Copy the val's email address (looks like  <you>.dayflowInbound@valtown.email ).
//    That's your Dayflow inbox.
//
// ─── PER USER (once) ───────────────────────────────────────────────────────
// In Gmail → Settings → Forwarding and POP/IMAP → add a forwarding address =
// the val address above → confirm. (Or just forward individual emails to it.)
// Because they forward FROM their own inbox, the `from` matches the address
// they linked in Dayflow → Connections → Emails, so it lands in THEIR account.
//
// That's it. No per-user server config — routing is by sender.

export default async function (email: {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
}) {
  const url = Deno.env.get("SUPABASE_FN_URL");
  const secret = Deno.env.get("INBOUND_SECRET");
  if (!url || !secret) {
    console.error("Missing SUPABASE_FN_URL or INBOUND_SECRET env var");
    return;
  }

  // Prefer plain text; fall back to a rough strip of the HTML body.
  const bodyText =
    email.text ||
    (email.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const message = [email.subject, bodyText].filter(Boolean).join("\n\n");

  // verified: false — Val.town's email object carries no SPF/DKIM/DMARC result and
  // no raw signed message, so we cannot vouch that `from` is really who it claims.
  // That means routing here is spoofable (see the SPOOFING note in email-inbound).
  // To close it, move intake to a provider that verifies inbound mail — Cloudflare
  // Email Routing or Postmark inbound — read its SPF/DKIM pass, send verified: true
  // only when it passed, and set INBOUND_REQUIRE_VERIFIED=true on the function.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: email.from, // "Name <addr>" or bare address — the function cleans it
      text: message,
      secret,
      verified: false,
    }),
  });

  // Log the result so you can watch it work in the Val.town run logs.
  const out = await res.json().catch(() => ({}));
  console.log("email-inbound →", res.status, out);
}
