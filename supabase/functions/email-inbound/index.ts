// Dayflow — inbound email → AI extract → save to the user's account
//
// A forwarding service (e.g. a Val.town email address) POSTs the forwarded
// email here as { text, secret }. We verify the shared secret, run Gemini to
// pull out dates/events, and write them into the target user's saved schedule
// using the service role (bypassing RLS, since there's no logged-in browser).
//
// Deploy as Edge Function "email-inbound" with --no-verify-jwt.
// Secrets needed: GEMINI_API_KEY, INBOUND_SECRET, TARGET_USER_ID.
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

async function geminiExtract(text: string): Promise<any[]> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const prompt =
    `You extract important dates, deadlines, and events from a student's email. Today is ${new Date().toString()}. ` +
    `Return every important item. For EACH: title = SHORT name only (no time/date/location in it); ` +
    `start = ISO 8601 date-time (resolve relative dates; deadlines with only a date use 23:59); ` +
    `end = ISO 8601 if a range is given else omit; location = place if mentioned else omit; ` +
    `category = school|athletics|work|personal; kind = "event" (set-time things) or "deadline" (things due). ` +
    `Ignore greetings/signatures. If none, return [].\n\nMESSAGE:\n${text}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "ARRAY", items: { type: "OBJECT", properties: {
        title: { type: "STRING" }, start: { type: "STRING" }, end: { type: "STRING" },
        location: { type: "STRING" },
        category: { type: "STRING", enum: ["school", "athletics", "work", "personal"] },
        kind: { type: "STRING", enum: ["event", "deadline"] } }, required: ["title", "start"] } },
    },
  };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  try { const p = JSON.parse(out); return Array.isArray(p) ? p : []; } catch { return []; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { text, secret } = await req.json().catch(() => ({}));
    if (secret !== Deno.env.get("INBOUND_SECRET")) return json({ error: "Unauthorized" }, 401);
    if (!text || typeof text !== "string") return json({ error: "No email text" }, 400);

    const userId = Deno.env.get("TARGET_USER_ID");
    if (!userId) return json({ error: "Server not configured (TARGET_USER_ID)" }, 500);

    const extracted = await geminiExtract(text);

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
