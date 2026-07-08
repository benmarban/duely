// Dayflow — calendar feed import (Canvas + Blackboard/Moodle/Schoology + work apps)
//
// Browsers can't read a calendar .ics feed cross-origin (CORS), so this fetches it
// server-side, parses the events, and returns clean JSON. It's shared by the school
// importer (syncLMS) and the work-shift importer (importWork), so it must accept any
// vendor's feed — a host allowlist would break "Another app" and half the providers.
//
// Because the URL is user-supplied and we fetch it from inside Supabase's network,
// this is a classic SSRF sink. Defenses, in order:
//   1. https only.
//   2. Resolve the host and refuse any that points at a private, loopback, link-local
//      or otherwise non-public address — that's what stops someone pasting
//      http://169.254.169.254/… (cloud metadata) or an internal service URL.
//   3. Follow redirects manually, re-running the checks on every hop, so a public URL
//      can't 302 us to an internal one.
//   4. Abort slow fetches and cap the body — a feed link shouldn't stream forever.
//
// Deploy as a Supabase Edge Function named "canvas-import".
// Turn OFF "Verify JWT" for this function (it's a validated proxy).

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

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 5_000_000; // 5 MB — generous for a calendar, bounded against a firehose
const MAX_REDIRECTS = 4;

// Is a resolved IP one we must never connect to from inside our network?
function isBlockedIp(ip: string): boolean {
  const s = ip.toLowerCase();

  // IPv6
  if (s.includes(":")) {
    if (s === "::1" || s === "::") return true;               // loopback / unspecified
    if (s.startsWith("fe80")) return true;                    // link-local
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local (ULA)
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4
    const m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }

  // IPv4
  const p = s.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = p;
  if (a === 0 || a === 127) return true;                 // this-network / loopback
  if (a === 10) return true;                             // private
  if (a === 172 && b >= 16 && b <= 31) return true;      // private
  if (a === 192 && b === 168) return true;               // private
  if (a === 169 && b === 254) return true;               // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // carrier-grade NAT
  if (a >= 224) return true;                             // multicast / reserved
  return false;
}

// Resolve every address the host maps to and require all of them to be public.
// Rejecting on *any* private hit avoids a split-horizon record slipping through.
async function hostIsSafe(hostname: string): Promise<boolean> {
  // A bare IP literal in the URL never hits DNS — check it directly.
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) return !isBlockedIp(hostname);

  let ips: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try { ips = ips.concat(await Deno.resolveDns(hostname, kind)); } catch { /* no record of this kind */ }
  }
  if (!ips.length) return false;            // unresolvable → refuse rather than let fetch try
  return ips.every((ip) => !isBlockedIp(ip));
}

// Fetch with manual redirect handling so we can re-validate each hop's host.
async function safeFetch(startUrl: string): Promise<Response> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("Only https feed links are allowed.");
    if (!(await hostIsSafe(u.hostname))) throw new Error("That link points somewhere we can't fetch.");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(u.toString(), { headers: { Accept: "text/calendar" }, redirect: "manual", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    // 3xx with a Location → validate and loop, don't let fetch chase it for us.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      url = new URL(loc, u).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

// Read the body but stop once we've seen MAX_BYTES — a hostile URL shouldn't be able
// to stream unbounded data into the function.
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { reader.cancel(); throw new Error("That feed is too large."); }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { feedUrl } = await req.json().catch(() => ({}));
    if (!feedUrl || typeof feedUrl !== "string") {
      return json({ error: "Paste your calendar feed link first." }, 400);
    }

    // Accept webcal:// and https://, normalize to https.
    const url = feedUrl.trim().replace(/^webcal:\/\//i, "https://");
    if (!/^https:\/\//i.test(url)) {
      return json({ error: "That doesn't look like a calendar feed link." }, 400);
    }

    let ics: string;
    try {
      const res = await safeFetch(url);
      if (!res.ok) return json({ error: `The feed host returned ${res.status}. Double-check the link.` }, 502);
      ics = await readCapped(res);
    } catch (e) {
      // SSRF rejections, timeouts, oversize, DNS failures all land here — one clean message.
      return json({ error: (e as Error)?.message || "Couldn't read that feed link." }, 400);
    }

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
      title: e.summary || "Calendar item",
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
