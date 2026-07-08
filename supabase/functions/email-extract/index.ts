// Dayflow — AI email extraction (Google Gemini, free tier)
//
// Takes raw email text and returns the important dates/deadlines/events as
// structured JSON, resolving relative dates ("next Friday") against "today".
//
// Deploy as a Supabase Edge Function named "email-extract".
// Add a secret named GEMINI_API_KEY (your free Google AI Studio key).
//
// Auth: this calls Gemini on our key, so it must not be an open proxy — without a
// gate, anyone who finds the URL can spend our quota (and the SAME key powers
// email-inbound, so a stranger draining it silently kills email intake too). We
// require a real signed-in user. Note verify_jwt on its own is NOT enough: the
// public anon key is itself a valid project JWT, so we call getUser() and reject
// anything that isn't a genuine logged-in account, exactly like create-checkout.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The paste box handles one message; a huge body is either abuse or a mistake, and
// it is us who pays for the tokens. Cap it (matches email-inbound).
const MAX_TEXT = 12_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // Gate on a real user before we touch Gemini.
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await supa.auth.getUser();
    if (!u?.user?.id) return json({ error: "Not signed in" }, 401);

    const { text, today } = await req.json().catch(() => ({}));
    if (!text || typeof text !== "string") return json({ error: "No email text provided." }, 400);

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ error: "Server is missing GEMINI_API_KEY." }, 500);

    const now = today || new Date().toString();
    const prompt =
      `You extract important dates, deadlines, and events from a student's email or message. ` +
      `Today is ${now}. Return every genuinely important item (classes, practices, film sessions, meetings, ` +
      `work shifts, appointments, assignments, exams, application deadlines). For EACH item return: ` +
      `title = a SHORT name of the event or task ONLY — do NOT put the time, date, or location in the title ` +
      `(e.g. "Offense film", not "offense film 12:30 PM east classroom"); ` +
      `start = ISO 8601 date-time (resolve relative dates like "next Friday"/"tomorrow" using today; for a ` +
      `deadline given only a date, use 23:59); end = ISO 8601 if a time range is given, otherwise omit; ` +
      `location = the room/place if mentioned, otherwise omit; category = one of school, athletics, work, personal; ` +
      `kind = "event" for things happening at a set time (class, practice, film, meeting, shift, appointment), or ` +
      `"deadline" for things that are due (assignment, application, exam to submit). ` +
      `Ignore greetings, signatures, and small talk. If there are no real dates, return an empty array.\n\n` +
      `MESSAGE:\n${text.slice(0, MAX_TEXT)}`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              start: { type: "STRING" },
              end: { type: "STRING" },
              location: { type: "STRING" },
              category: { type: "STRING", enum: ["school", "athletics", "work", "personal"] },
              kind: { type: "STRING", enum: ["event", "deadline"] },
            },
            required: ["title", "start"],
          },
        },
      },
    };

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(key);

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 1200);
      return json({ error: `Gemini error ${r.status}`, detail }, 502);
    }

    const data = await r.json();
    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    let items: unknown = [];
    try { items = JSON.parse(out); } catch { items = []; }
    if (!Array.isArray(items)) items = [];

    return json({ items });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
