// Dayflow — inbound email → AI extract → save to the RIGHT user's account
//
// A forwarding service (Cloudflare Email Routing / Postmark / SendGrid Inbound
// Parse / a Val.town address, etc.) POSTs the forwarded email here as
//   { text, secret, from, verified? }
// where `from` is the address the mail was forwarded FROM (the user's inbox).
//
// We verify the shared secret, resolve `from` to a Dayflow account by matching
// it against that account's linked inboxes (user_state.data.emails — the list
// managed in the app's Connections → Emails tab, incl. their sign-in address),
// run Gemini to pull out dates/events, and write them into THAT user's saved
// schedule using the service role (bypassing RLS, since there's no browser).
//
// ⚠ SPOOFING: `from` is an email header, and headers are forgeable. Someone who
// knows the intake address could send mail claiming From: victim@school.edu and
// have events filed onto the victim's calendar. The shared secret guards the HTTP
// endpoint, not the mail path. The real defence is to route only on a sender the
// forwarder has cryptographically checked (SPF/DKIM/DMARC pass). Val.town's email
// object exposes no such result and no raw signed message, so it CANNOT do this;
// Cloudflare Email Routing and Postmark inbound can, and pass it in their webhook.
// This function is ready for that: set the secret INBOUND_REQUIRE_VERIFIED=true and
// it will refuse any message the forwarder didn't mark { verified: true }. Left off
// (the default) it keeps working with Val.town, spoofable — a known, documented gap.
//
// Gemini also triages the mail first: marketing blasts and order receipts get
// dropped before anything reaches the schedule (see geminiExtract). We ask the
// model rather than pattern-matching headers or "unsubscribe" text, because
// Canvas/Blackboard notifications are automated, no-reply, unsubscribable mail
// that the student *does* want. A regex can't tell those apart from a DoorDash
// promo; the model reading the body can.
//
// Multi-user: routing is by sender, so every user who has forwarded/linked an
// inbox gets their own items — no per-user server config.
//
// Deploy as Edge Function "email-inbound" with --no-verify-jwt.
// Secrets: GEMINI_API_KEY, INBOUND_SECRET. Optional: TARGET_USER_ID (legacy
// single-account fallback used only when `from` matches no linked inbox).
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function parseISO(s: string) {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { Y: m[1], Mo: m[2], D: m[3], H: m[4] ? +m[4] : 23, Mi: m[5] ? +m[5] : 59 };
}

// A forwarded body can be huge (long threads, quoted history, HTML stripped to
// text). Cap what we hand the model: bounds the token spend and the blast radius
// of anything hostile buried in the tail.
const MAX_TEXT = 12_000;

type Triage = { promotional: boolean; items: any[] };

async function geminiExtract(text: string, from: string): Promise<Triage> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const prompt =
    `You triage a student's forwarded email, then extract their schedule from it. ` +
    `Today is ${new Date().toString()}. It was forwarded from ${cleanAddress(from) || "an unknown address"}.\n\n` +

    `STEP 1 — set "promotional". TRUE when the message is commercial mail from a business ` +
    `the student is merely a customer of: marketing, special offers, discount codes, ` +
    `newsletters, sales and app promos, and also order receipts, delivery and shipping ` +
    `updates. Such a message often still names a date — "offer ends Friday", "your order ` +
    `arrives 7:15pm" — but that is the business's date, not the student's schedule.\n` +

    `Set it FALSE for anything that belongs on a student's calendar, even when the mail is ` +
    `automated, sent from a no-reply address, or carries an unsubscribe link: a professor, ` +
    `coach, teammate, advisor, club or employer writing to them; automated notices from a ` +
    `school system (Canvas, Blackboard, Moodle, Schoology); work shift schedules; calendar ` +
    `invites. If you are genuinely unsure, answer FALSE — a missed deadline costs the ` +
    `student far more than one stray event does.\n\n` +

    `STEP 2 — if promotional is true, return items = [] and stop. Otherwise return every ` +
    `important item. For EACH: title = SHORT name only (no time/date/location in it); ` +
    `start = ISO 8601 date-time (resolve relative dates; deadlines with only a date use 23:59); ` +
    `end = ISO 8601 if a range is given else omit; location = place if mentioned else omit; ` +
    `category = school|athletics|work|personal; kind = "event" (set-time things) or "deadline" (things due). ` +
    `Ignore greetings/signatures. If none, return [].\n\nMESSAGE:\n${text}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: {
        promotional: { type: "BOOLEAN" },
        items: { type: "ARRAY", items: { type: "OBJECT", properties: {
          title: { type: "STRING" }, start: { type: "STRING" }, end: { type: "STRING" },
          location: { type: "STRING" },
          category: { type: "STRING", enum: ["school", "athletics", "work", "personal"] },
          kind: { type: "STRING", enum: ["event", "deadline"] } }, required: ["title", "start"] } },
      }, required: ["promotional", "items"] },
    },
  };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  // A malformed reply must not read as "promotional" — that would silently bin a
  // real email. Fall back to "not promotional, nothing found" and add nothing.
  try {
    const p = JSON.parse(out);
    return { promotional: p?.promotional === true, items: Array.isArray(p?.items) ? p.items : [] };
  } catch { return { promotional: false, items: [] }; }
}

// Pull a bare address out of "Name <a@b.com>" or a raw header value.
function cleanAddress(from: string): string {
  const s = String(from || "").toLowerCase();
  const m = s.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m ? m[0] : "";
}

// Resolve a sender address to the account that linked it (Connections → Emails).
// Matches via jsonb containment: data @> { emails: [ { address } ] }.
async function findUserByEmail(supa: any, from: string): Promise<string | null> {
  const addr = cleanAddress(from);
  if (!addr) return null;
  const { data, error } = await supa
    .from("user_state")
    .select("user_id")
    .contains("data", { emails: [{ address: addr }] })
    .limit(1);
  if (error) { console.warn("sender lookup failed:", error.message); return null; }
  return data && data.length ? data[0].user_id : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { text, secret, from, verified } = await req.json().catch(() => ({}));
    if (secret !== Deno.env.get("INBOUND_SECRET")) return json({ error: "Unauthorized" }, 401);
    if (!text || typeof text !== "string") return json({ error: "No email text" }, 400);

    // Anti-spoofing gate. Off by default (Val.town can't produce a verified signal);
    // flip INBOUND_REQUIRE_VERIFIED=true once you're behind a forwarder that checks
    // SPF/DKIM and passes { verified: true }, and forged senders get turned away here.
    if (Deno.env.get("INBOUND_REQUIRE_VERIFIED") === "true" && verified !== true) {
      return json({ ignored: true, reason: "sender not verified", from: cleanAddress(from) }, 200);
    }

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Route by sender; fall back to the legacy single-account env if unmatched.
    const userId = (await findUserByEmail(supa, from)) || Deno.env.get("TARGET_USER_ID") || "";
    if (!userId) return json({ ignored: true, reason: "sender not linked to any account", from: cleanAddress(from) }, 200);

    const { promotional, items: extracted } = await geminiExtract(text.slice(0, MAX_TEXT), from);
    if (promotional) return json({ ignored: true, reason: "promotional", from: cleanAddress(from) }, 200);

    const { data: row } = await supa.from("user_state").select("data").eq("user_id", userId).maybeSingle();
    const state: any = (row && (row as any).data) || {};
    const items: any[] = Array.isArray(state.items) ? state.items : [];
    const events: any[] = Array.isArray(state.events) ? state.events : [];

    let added = 0;
    extracted.forEach((x: any, i: number) => {
      const s = parseISO(x.start);
      if (!s) return;
      const stamp = Date.now() + "" + i;
      if (x.kind === "event") {
        const e = parseISO(x.end) || s;
        const date = `${s.Y}-${s.Mo}-${s.D}`;
        const dup = events.some((v) => v.title === x.title && v.date === date && v.sh === s.H);
        if (dup) return;
        events.push({ id: "em" + stamp, title: x.title, cat: x.category || "personal", date, sh: s.H, sm: s.Mi, eh: e.H, em: e.Mi, loc: x.location || "" });
        added++;
      } else {
        const due = `${s.Y}-${s.Mo}-${s.D}T${String(s.H).padStart(2, "0")}:${String(s.Mi).padStart(2, "0")}:00`;
        const dup = items.some((it) => it.title === x.title && String(it.due).slice(0, 16) === due.slice(0, 16));
        if (dup) return;
        items.push({ id: "em" + stamp, title: x.title, course: x.location || "from email", source: "email", due, done: false, cat: x.category || "school" });
        added++;
      }
    });

    const newState = { ...state, items, events };
    await supa.from("user_state").upsert({ user_id: userId, data: newState, updated_at: new Date().toISOString() });

    return json({ added, found: extracted.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
