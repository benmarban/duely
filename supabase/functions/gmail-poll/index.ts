// Dayflow — the auto-checker. Runs on a schedule (pg_cron, see the migration),
// and for every connected Gmail account: refreshes an access token, pulls the
// new messages since last time, runs the same AI triage+extract we use for
// forwarded mail, and files the dates onto that user's calendar. No user action,
// ever — this is the "set it and forget it" engine.
//
// Deploy with --no-verify-jwt; it's guarded by POLL_SECRET so only the scheduler
// can run it. Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GEMINI_API_KEY,
// POLL_SECRET. (SUPABASE_URL / _SERVICE_ROLE_KEY auto.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_TEXT = 12_000;
const BACKFILL_QUERY = "newer_than:2d"; // first sync after connecting: look back 2 days

// ---- Google token refresh ----
async function accessTokenFor(refreshToken: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("refresh failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

const gapi = (path: string, token: string) =>
  fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    headers: { Authorization: "Bearer " + token },
  }).then((r) => r.json());

// ---- pull the list of new message ids ----
// Incremental via historyId when we have one; otherwise a bounded backfill, then
// record the mailbox's current historyId so next run is incremental.
async function newMessageIds(token: string, lastHistoryId: string | null): Promise<{ ids: string[]; historyId: string | null }> {
  if (lastHistoryId) {
    let ids: string[] = [];
    let pageToken: string | undefined;
    let newHistoryId = lastHistoryId;
    do {
      const q = new URLSearchParams({ startHistoryId: lastHistoryId, historyTypes: "messageAdded" });
      if (pageToken) q.set("pageToken", pageToken);
      const h: any = await gapi("history?" + q, token);
      if (h.error) { // historyId too old (404) → fall back to backfill
        if (h.error.code === 404) return backfill(token);
        throw new Error("history: " + JSON.stringify(h.error).slice(0, 150));
      }
      for (const rec of h.history || []) for (const m of rec.messagesAdded || []) ids.push(m.message.id);
      if (h.historyId) newHistoryId = h.historyId;
      pageToken = h.nextPageToken;
    } while (pageToken);
    return { ids: [...new Set(ids)], historyId: newHistoryId };
  }
  return backfill(token);
}
async function backfill(token: string): Promise<{ ids: string[]; historyId: string | null }> {
  const list: any = await gapi("messages?" + new URLSearchParams({ q: BACKFILL_QUERY, maxResults: "20" }), token);
  const ids = (list.messages || []).map((m: any) => m.id);
  const profile: any = await gapi("profile", token);
  return { ids, historyId: profile.historyId || null };
}

// ---- message → clean text ----
function b64url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function findBody(payload: any): { plain?: string; html?: string } {
  if (!payload) return {};
  if (payload.mimeType === "text/plain" && payload.body?.data) return { plain: b64url(payload.body.data) };
  if (payload.mimeType === "text/html" && payload.body?.data) return { html: b64url(payload.body.data) };
  let plain: string | undefined, html: string | undefined;
  for (const p of payload.parts || []) {
    const r = findBody(p);
    plain = plain || r.plain;
    html = html || r.html;
  }
  return { plain, html };
}
const headerOf = (payload: any, name: string): string =>
  (payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

async function messageText(token: string, id: string): Promise<{ text: string; from: string }> {
  const m: any = await gapi("messages/" + id + "?format=full", token);
  const body = findBody(m.payload);
  const bodyText = body.plain || (body.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const subject = headerOf(m.payload, "Subject");
  return { text: [subject, bodyText].filter(Boolean).join("\n\n"), from: headerOf(m.payload, "From") };
}

// ---- AI triage + extract (same contract as email-inbound) ----
function parseISO(s: string) {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { Y: m[1], Mo: m[2], D: m[3], H: m[4] ? +m[4] : 23, Mi: m[5] ? +m[5] : 59 };
}
async function geminiExtract(text: string): Promise<{ promotional: boolean; items: any[] }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const prompt =
    `You triage a student's email, then extract their schedule. Today is ${new Date().toString()}.\n\n` +
    `STEP 1 — set "promotional" TRUE for commercial mail the student is merely a customer of ` +
    `(marketing, offers, newsletters, order/delivery/shipping receipts), even when it names a date. ` +
    `FALSE for anything belonging on their calendar even if automated/no-reply/unsubscribable: a professor, ` +
    `coach, teammate, advisor, club, or employer; school-system notices (Canvas, Blackboard, Moodle, ` +
    `Schoology); work shift schedules; calendar invites. If unsure, answer FALSE.\n\n` +
    `STEP 2 — if promotional, items=[] and stop. Else return every important item. For EACH: title = SHORT ` +
    `name only; start = ISO 8601 (resolve relative dates; date-only deadlines use 23:59); end = ISO 8601 if a ` +
    `range else omit; location = place if mentioned else omit; category = school|athletics|work|personal; ` +
    `kind = "event" (set-time) or "deadline" (due). Ignore greetings/signatures.\n\nMESSAGE:\n${text}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: {
        promotional: { type: "BOOLEAN" },
        items: { type: "ARRAY", items: { type: "OBJECT", properties: {
          title: { type: "STRING" }, start: { type: "STRING" }, end: { type: "STRING" }, location: { type: "STRING" },
          category: { type: "STRING", enum: ["school", "athletics", "work", "personal"] },
          kind: { type: "STRING", enum: ["event", "deadline"] } }, required: ["title", "start"] } },
      }, required: ["promotional", "items"] },
    },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Gemini " + r.status);
  const data = await r.json();
  try {
    const p = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    return { promotional: p?.promotional === true, items: Array.isArray(p?.items) ? p.items : [] };
  } catch { return { promotional: false, items: [] }; }
}

// ---- file extracted items into the user's saved state (dedup like email-inbound) ----
function fileInto(state: any, extracted: any[]): number {
  const items: any[] = Array.isArray(state.items) ? state.items : [];
  const events: any[] = Array.isArray(state.events) ? state.events : [];
  let added = 0;
  extracted.forEach((x, i) => {
    const s = parseISO(x.start);
    if (!s) return;
    const stamp = Date.now() + "" + i;
    if (x.kind === "event") {
      const e = parseISO(x.end) || s;
      const date = `${s.Y}-${s.Mo}-${s.D}`;
      if (events.some((v) => v.title === x.title && v.date === date && v.sh === s.H)) return;
      events.push({ id: "gm" + stamp, title: x.title, cat: x.category || "personal", date, sh: s.H, sm: s.Mi, eh: e.H, em: e.Mi, loc: x.location || "" });
      added++;
    } else {
      const due = `${s.Y}-${s.Mo}-${s.D}T${String(s.H).padStart(2, "0")}:${String(s.Mi).padStart(2, "0")}:00`;
      if (items.some((it) => it.title === x.title && String(it.due).slice(0, 16) === due.slice(0, 16))) return;
      items.push({ id: "gm" + stamp, title: x.title, course: x.location || "from email", source: "email", due, done: false, cat: x.category || "school" });
      added++;
    }
  });
  state.items = items; state.events = events;
  return added;
}

async function processAccount(supa: any, acct: any): Promise<number> {
  const token = await accessTokenFor(acct.refresh_token);
  const { ids, historyId } = await newMessageIds(token, acct.last_history_id);

  let added = 0;
  if (ids.length) {
    const { data: row } = await supa.from("user_state").select("data").eq("user_id", acct.user_id).maybeSingle();
    const state: any = (row as any)?.data ?? {};
    for (const id of ids.slice(0, 25)) { // safety cap per run
      try {
        const { text } = await messageText(token, id);
        if (!text.trim()) continue;
        const { promotional, items } = await geminiExtract(text.slice(0, MAX_TEXT));
        if (!promotional) added += fileInto(state, items);
      } catch (e) { console.warn("msg", id, (e as Error)?.message); }
    }
    if (added) await supa.from("user_state").upsert({ user_id: acct.user_id, data: state, updated_at: new Date().toISOString() });
  }

  await supa.from("gmail_accounts").update({
    last_history_id: historyId, last_sync_at: new Date().toISOString(), last_error: null,
  }).eq("user_id", acct.user_id);
  return added;
}

Deno.serve(async (req) => {
  // Only the scheduler may run this.
  const given = req.headers.get("x-poll-secret") || new URL(req.url).searchParams.get("secret");
  if (given !== Deno.env.get("POLL_SECRET")) return new Response("no", { status: 401 });

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: accounts } = await supa.from("gmail_accounts").select("user_id, refresh_token, last_history_id");

  let totalAdded = 0, ok = 0, failed = 0;
  for (const acct of accounts || []) {
    try { totalAdded += await processAccount(supa, acct); ok++; }
    catch (e) {
      failed++;
      await supa.from("gmail_accounts").update({ last_error: String((e as Error)?.message || e).slice(0, 300) }).eq("user_id", acct.user_id);
    }
  }
  return new Response(JSON.stringify({ accounts: (accounts || []).length, ok, failed, added: totalAdded }), {
    headers: { "Content-Type": "application/json" },
  });
});
