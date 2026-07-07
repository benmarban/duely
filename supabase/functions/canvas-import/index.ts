// Dayflow — Canvas calendar import
//
// Browsers can't read a Canvas .ics feed directly (CORS), so this small
// serverless function fetches it server-side, parses the events, and returns
// clean JSON to the app.
//
// Deploy as a Supabase Edge Function named "canvas-import".
// Turn OFF "Verify JWT" for this function (it's a simple validated proxy).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { feedUrl } = await req.json().catch(() => ({}));
    if (!feedUrl || typeof feedUrl !== "string") {
      return json({ error: "Paste your Canvas calendar feed link first." }, 400);
    }

    // Accept webcal:// and https://, normalize to https
    const url = feedUrl.trim().replace(/^webcal:\/\//i, "https://");

    // Basic safety: only allow https Canvas calendar-feed URLs (prevents abuse)
    if (!/^https:\/\//i.test(url) || !/\/feeds\/calendars\//i.test(url)) {
      return json({ error: "That doesn't look like a Canvas calendar feed link." }, 400);
    }

    const res = await fetch(url, { headers: { "Accept": "text/calendar" } });
    if (!res.ok) {
      return json({ error: `Canvas returned ${res.status}. Double-check the link.` }, 502);
    }
    const ics = await res.text();
    return json({ events: parseICS(ics) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

function parseICS(ics: string) {
  // Unfold folded lines (RFC5545: continuation lines start with space/tab)
  const unfolded = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r\n|\n|\r/);
  const events: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const val = line.slice(idx + 1);
    if (key === "SUMMARY") cur.summary = unescapeICS(val);
    else if (key === "DTSTART") cur.dtstart = val;
    else if (key === "UID") cur.uid = val;
  }

  return events
    .map((e) => ({
      title: e.summary || "Canvas item",
      due: icsDateToISO(e.dtstart),
      uid: e.uid || "",
    }))
    .filter((e) => e.due);
}

function unescapeICS(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function icsDateToISO(v?: string): string | null {
  if (!v) return null;
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (hh === undefined) {
    // All-day → treat as due end of that day
    return new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 0).toISOString();
  }
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss)).toISOString();
  return new Date(+y, +mo - 1, +d, +hh, +mi, +ss).toISOString();
}
