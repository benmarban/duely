// Dayflow — Cloudflare Email Worker (the spoof-resistant way to turn on email intake)
//
// This is the alternative to email-intake/valtown-forwarder.ts. Val.town is easier to
// stand up (no domain) but hands us no proof of who really sent a message, so routing
// there is spoofable. Cloudflare Email Routing checks SPF/DKIM/DMARC on the way in and
// records the verdict in the Authentication-Results header BEFORE this Worker runs. We
// read that verdict and pass verified:true only on a DMARC pass — so a forged
// "From: victim@school.edu" is marked unverified and, with the gate on, dropped.
//
// ZERO DEPENDENCIES ON PURPOSE: this parses the email itself so you can paste it
// straight into the Cloudflare dashboard's Worker editor — no Node, no wrangler, no
// build step. (The trade-off vs. a library like postal-mime is a simpler MIME parser;
// it handles the multipart/quoted-printable/base64 shapes real forwarded mail uses.)
//
// ─── WHAT YOU NEED ──────────────────────────────────────────────────────────
// A domain on Cloudflare (buying one through Cloudflare puts it there automatically).
//
// ─── SETUP (all in the Cloudflare website — see the chat walkthrough) ────────
// 1. Domain on Cloudflare → Email → Email Routing → Enable.
// 2. Workers & Pages → Create → Worker → paste this whole file → Deploy.
// 3. That Worker → Settings → Variables and Secrets → add two:
//       SUPABASE_FN_URL = https://<your-project-ref>.supabase.co/functions/v1/email-inbound
//       INBOUND_SECRET  = the exact string set via `supabase secrets set INBOUND_SECRET=…`
// 4. Email → Email Routing → Routes → route an address (e.g. inbox@yourdomain.com)
//    with action "Send to a Worker" → pick this Worker. That address is your inbox.
// 5. Users forward their mail to that address (Gmail → Settings → Forwarding → add it).
//
// ─── TURN THE GATE ON (LAST, after a real test) ─────────────────────────────
// Forward yourself one real email, confirm it lands in Dayflow, THEN:
//       supabase secrets set INBOUND_REQUIRE_VERIFIED=true
// Now the function refuses anything not verified here. Enabling it before you've
// confirmed your own forwards arrive verified would silently drop everything.

// `message` is a ForwardableEmailMessage; `env` carries the two variables above.
export default {
  async email(message: any, env: any, _ctx: any): Promise<void> {
    const url = env.SUPABASE_FN_URL;
    const secret = env.INBOUND_SECRET;
    if (!url || !secret) {
      console.error("Missing SUPABASE_FN_URL or INBOUND_SECRET variable");
      return;
    }

    // The verdict Cloudflare already computed. Multiple Authentication-Results headers
    // are joined with ", " by the Headers API, so one regex over the lot is fine. DMARC
    // pass is the strong signal — it requires SPF or DKIM *aligned with the From domain*,
    // which is the domain we route on. Anything less → not verified.
    const authResults = message.headers.get("authentication-results") || "";
    const verified = /dmarc\s*=\s*pass/i.test(authResults);

    // The From we route on, and the raw MIME to pull a clean body from.
    const from = addressOf(message.headers.get("from") || message.from || "");
    let text = "";
    try {
      const raw = await new Response(message.raw).text();
      const body = extractText(raw);
      const subject = message.headers.get("subject") || "";
      text = [subject, body].filter(Boolean).join("\n\n");
    } catch (e) {
      console.error("parse failed:", (e as Error)?.message);
      text = message.headers.get("subject") || "";
    }
    if (!text.trim()) return;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, text, secret, verified }),
    });
    const out = await res.json().catch(() => ({}));
    console.log("email-inbound →", res.status, JSON.stringify(out), "verified=" + verified);
  },
};

// "Name <a@b.com>" → "a@b.com"; email-inbound cleans it further anyway.
function addressOf(v: string): string {
  const m = String(v).match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m ? m[0] : String(v).trim();
}

// Split a MIME chunk into its header block and its body at the first blank line.
function splitHead(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: "" };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

// Read one header (case-insensitive), unfolding RFC5322 continuation lines.
function getHeader(head: string, name: string): string {
  const re = new RegExp("^" + name + ":[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)", "im");
  const m = re.exec(head);
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

function boundaryOf(s: string): string | null {
  const ct = getHeader(splitHead(s).head, "Content-Type");
  const m = /boundary="?([^";\r\n]+)"?/i.exec(ct);
  return m ? m[1] : null;
}

// Split a multipart body into its parts, dropping preamble and the closing --b--.
function splitByBoundary(s: string, b: string): string[] {
  const chunks = splitHead(s).body.split("--" + b);
  const parts: string[] = [];
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].startsWith("--")) break; // closing boundary
    parts.push(chunks[i].replace(/^\r?\n/, ""));
  }
  return parts;
}

// Best plain-text body we can find: prefer text/plain, fall back to stripped HTML,
// else the raw body. Flattens one level of nested multipart (mixed → alternative),
// which covers how Gmail and friends actually build a forwarded message.
function extractText(raw: string): string {
  const b = boundaryOf(raw);
  const top = b ? splitByBoundary(raw, b) : [raw];
  const flat: string[] = [];
  for (const p of top) {
    const nb = boundaryOf(p);
    if (nb) for (const x of splitByBoundary(p, nb)) flat.push(x);
    else flat.push(p);
  }
  return pick(flat, /text\/plain/i) ?? stripHtml(pick(flat, /text\/html/i) ?? "") ?? splitHead(raw).body;
}

// First part whose Content-Type matches, decoded per its transfer encoding.
function pick(parts: string[], ctRe: RegExp): string | null {
  for (const part of parts) {
    const { head, body } = splitHead(part);
    if (!ctRe.test(getHeader(head, "Content-Type"))) continue;
    const cte = getHeader(head, "Content-Transfer-Encoding").toLowerCase();
    if (cte.includes("base64")) return decodeB64(body);
    if (cte.includes("quoted-printable")) return decodeQP(body);
    return body;
  }
  return null;
}

// UTF-8-aware quoted-printable: drop soft breaks, turn =XX into its byte, then decode.
function decodeQP(s: string): string {
  s = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeB64(s: string): string {
  const bin = atob(s.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
