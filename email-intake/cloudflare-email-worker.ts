// Dayflow — Cloudflare Email Worker (the spoof-resistant way to turn on email intake)
//
// This is the alternative to email-intake/valtown-forwarder.ts. Val.town is easier to
// stand up (no domain, no DNS) but it hands us no proof of who really sent a message,
// so routing there is spoofable. Cloudflare Email Routing checks SPF/DKIM/DMARC on the
// way in and records the verdict in the Authentication-Results header BEFORE this
// Worker runs. We read that verdict and pass verified:true only on a DMARC pass — so a
// forged "From: victim@school.edu" gets marked unverified and, with the gate on, dropped.
//
// ─── WHAT YOU NEED ──────────────────────────────────────────────────────────
// A domain on Cloudflare (free plan is fine). That's the one real cost vs. Val.town.
//
// ─── ONE-TIME SETUP ─────────────────────────────────────────────────────────
// 1. Cloudflare dashboard → your domain → Email → Email Routing → Enable. It adds the
//    MX + TXT records for you. Wait until it says "Enabled".
//
// 2. Deploy this Worker with wrangler (the dashboard's quick-editor can't bundle the
//    npm parser this needs). From an empty folder:
//       npm install -g wrangler
//       npm init -y && npm install postal-mime
//       # save this file as src/worker.ts, and the wrangler.toml below next to it
//       npx wrangler deploy
//    wrangler.toml:
//       name = "dayflow-email-inbound"
//       main = "src/worker.ts"
//       compatibility_date = "2024-11-01"
//
// 3. Give the Worker its two secrets (same INBOUND_SECRET you set in Supabase):
//       npx wrangler secret put SUPABASE_FN_URL
//         → https://<your-project-ref>.supabase.co/functions/v1/email-inbound
//       npx wrangler secret put INBOUND_SECRET
//         → the exact string from `supabase secrets set INBOUND_SECRET=…`
//
// 4. Email → Email Routing → Routes. Create an address, e.g. inbox@yourdomain.com,
//    with the action "Send to a Worker" → pick dayflow-email-inbound. (A catch-all
//    route to the Worker also works.) That address is your Dayflow inbox.
//
// ─── PER USER (once) ────────────────────────────────────────────────────────
// In Gmail → Settings → Forwarding → add inbox@yourdomain.com → confirm. Forwarding
// re-signs the mail as the user's own domain, so DMARC passes for THEIR address, which
// is what we route on. (A spoofer sending straight to the address as someone else fails
// DMARC and is marked unverified.)
//
// ─── TURN THE GATE ON (do this LAST, after a real test) ─────────────────────
// Forward yourself one real email and confirm it lands in Dayflow. THEN:
//       supabase secrets set INBOUND_REQUIRE_VERIFIED=true
// From that point the function refuses anything not verified here. Enabling it before
// you've confirmed your own forwards come through as verified would silently drop
// everything — test first.

import PostalMime from "postal-mime";

// Cloudflare's runtime types aren't imported here to keep this paste-able; `message`
// is a ForwardableEmailMessage, `env` carries the two secrets above.
export default {
  async email(message: any, env: any, _ctx: any): Promise<void> {
    const url = env.SUPABASE_FN_URL;
    const secret = env.INBOUND_SECRET;
    if (!url || !secret) {
      console.error("Missing SUPABASE_FN_URL or INBOUND_SECRET secret");
      return; // let the mail pass silently; nothing to file it to
    }

    // The verdict Cloudflare already computed. Multiple Authentication-Results headers
    // are joined with ", " by the Headers API, so a single regex over the lot is fine.
    // DMARC pass is the strong signal: it requires SPF or DKIM *aligned with the From
    // domain*, which is exactly the domain we route on. Anything less → not verified.
    const authResults = message.headers.get("authentication-results") || "";
    const verified = /dmarc\s*=\s*pass/i.test(authResults);

    // Parse the raw MIME for a clean plain-text body and the header From we route on.
    let from = message.from || "";
    let text = "";
    try {
      const email = await new PostalMime().parse(message.raw);
      from = email.from?.address || from;
      const body = email.text || stripHtml(email.html || "") || "";
      text = [email.subject, body].filter(Boolean).join("\n\n");
    } catch (e) {
      console.error("MIME parse failed:", (e as Error)?.message);
      text = message.headers.get("subject") || ""; // degrade to the subject line
    }
    if (!text.trim()) return; // nothing to extract

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, text, secret, verified }),
    });

    // Visible in `wrangler tail` so you can watch it work.
    const out = await res.json().catch(() => ({}));
    console.log("email-inbound →", res.status, JSON.stringify(out), "verified=" + verified);
  },
};

// Last-resort HTML → text, only used when a message has no text/plain part.
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
