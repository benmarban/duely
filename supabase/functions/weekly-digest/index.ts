// Dayflow — the Sunday plan.
//
// Once an hour, pg_cron pokes this function. For every Pro user whose *local*
// clock currently reads Sunday 7pm, it builds the week ahead out of their saved
// state and emails it. Free users are skipped: the digest is the reason someone
// remembers they pay for this.
//
// Why hourly instead of one weekly cron: "Sunday at 7pm" is a different instant
// in every timezone. A single UTC schedule would reach a student in California
// at 4pm and one in Berlin on Monday morning. The client writes its IANA zone to
// user_state.data.tz on every save; we read it back and only send to the users
// whose local hour matches right now.
//
// Deploy with --no-verify-jwt; guarded by DIGEST_SECRET so only the scheduler
// runs it. Secrets: DIGEST_SECRET, RESEND_API_KEY, DIGEST_FROM.
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SEND_DOW = 0;   // Sunday, per Date#getDay in the user's zone
const SEND_HOUR = 19; // 7pm local

type Ev = { title: string; cat: string; date: string; sh: number; sm: number; eh: number; em: number; loc?: string };
type Item = { title: string; course?: string; due: string; done?: boolean };

// ---- time helpers -------------------------------------------------------
// Read the wall clock in an arbitrary IANA zone without pulling in a date lib:
// format the instant *as* that zone, then read the parts back out.
function localParts(now: Date, tz: string): { dow: number; hour: number; ymd: string } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "numeric", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
    const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dow = dows.indexOf(p.weekday);
    if (dow < 0) return null;
    // "24" appears at midnight in hour12:false on some ICU versions.
    const hour = Number(p.hour) % 24;
    return { dow, hour, ymd: `${p.year}-${p.month}-${p.day}` };
  } catch {
    return null; // unknown/garbage zone — skip rather than guess
  }
}

function addDays(ymd: string, n: number): string {
  const [Y, M, D] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dowOf(ymd: string): string {
  const [Y, M, D] = ymd.split("-").map(Number);
  return DOW_LONG[new Date(Date.UTC(Y, M - 1, D)).getUTCDay()];
}
function hhmm(h: number, m: number): string {
  const ap = h < 12 ? "am" : "pm";
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`;
}
const mins = (h: number, m: number) => h * 60 + m;

// ---- the week -----------------------------------------------------------
// Same rules as the client's weekConflicts(): only events with real duration,
// strict overlap, so back-to-back never counts.
function conflictsIn(evs: Ev[]): Array<[Ev, Ev]> {
  const out: Array<[Ev, Ev]> = [];
  const day = evs.filter((e) => mins(e.eh, e.em) > mins(e.sh, e.sm))
                 .sort((a, b) => mins(a.sh, a.sm) - mins(b.sh, b.sm));
  for (let i = 0; i < day.length; i++)
    for (let j = i + 1; j < day.length; j++)
      if (mins(day[i].sh, day[i].sm) < mins(day[j].eh, day[j].em) &&
          mins(day[j].sh, day[j].sm) < mins(day[i].eh, day[i].em)) out.push([day[i], day[j]]);
  return out;
}

function buildWeek(state: any, startYmd: string) {
  const events: Ev[] = Array.isArray(state?.events) ? state.events : [];
  const items: Item[] = Array.isArray(state?.items) ? state.items : [];
  const days: Array<{ ymd: string; evs: Ev[]; dues: Item[]; busy: number; conflicts: Array<[Ev, Ev]> }> = [];

  for (let i = 0; i < 7; i++) {
    const ymd = addDays(startYmd, i);
    const evs = events.filter((e) => e.date === ymd)
                      .sort((a, b) => mins(a.sh, a.sm) - mins(b.sh, b.sm));
    const dues = items.filter((it) => !it.done && String(it.due).slice(0, 10) === ymd);
    const busy = evs.reduce((t, e) => t + Math.max(0, mins(e.eh, e.em) - mins(e.sh, e.sm)), 0);
    days.push({ ymd, evs, dues, busy, conflicts: conflictsIn(evs) });
  }
  const totalEvents = days.reduce((t, d) => t + d.evs.length, 0);
  const totalDues = days.reduce((t, d) => t + d.dues.length, 0);
  const allConflicts = days.flatMap((d) => d.conflicts.map((c) => ({ ymd: d.ymd, pair: c })));
  const tightest = days.reduce((a, b) => (b.busy > a.busy ? b : a), days[0]);
  return { days, totalEvents, totalDues, allConflicts, tightest };
}

// ---- the email ----------------------------------------------------------
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function renderEmail(w: ReturnType<typeof buildWeek>): { subject: string; html: string; text: string } {
  const nConf = w.allConflicts.length;
  const subject = nConf
    ? `Your week: ${w.totalDues} due, ${nConf} conflict${nConf > 1 ? "s" : ""}`
    : `Your week: ${w.totalEvents} things, ${w.totalDues} due`;

  const conflictBlock = nConf
    ? `<div style="border:1px solid rgba(255,77,106,.4);background:rgba(255,77,106,.08);border-radius:12px;padding:14px 16px;margin:0 0 20px">
         <div style="color:#FF4D6A;font-weight:700;font-size:15px;margin-bottom:8px">${nConf} conflict${nConf > 1 ? "s" : ""} this week</div>
         ${w.allConflicts.map(({ ymd, pair }) => `
           <div style="font-size:14px;color:#A09CB8;margin:6px 0">
             <b style="color:#ECEAF5">${dowOf(ymd)}</b> &nbsp;
             ${esc(pair[0].title)} <span style="color:#6B6785">${hhmm(pair[0].sh, pair[0].sm)}–${hhmm(pair[0].eh, pair[0].em)}</span>
             &nbsp;vs&nbsp;
             ${esc(pair[1].title)} <span style="color:#6B6785">${hhmm(pair[1].sh, pair[1].sm)}–${hhmm(pair[1].eh, pair[1].em)}</span>
           </div>`).join("")}
       </div>`
    : "";

  const dayRows = w.days.map((d) => {
    if (!d.evs.length && !d.dues.length) return "";
    const evs = d.evs.map((e) =>
      `<div style="font-size:14px;color:#ECEAF5;margin:3px 0">${esc(e.title)}
         <span style="color:#6B6785;font-size:12px">${hhmm(e.sh, e.sm)}</span></div>`).join("");
    const dues = d.dues.map((it) =>
      `<div style="font-size:14px;color:#FFB020;margin:3px 0">${esc(it.title)} due</div>`).join("");
    return `<tr>
      <td style="padding:12px 0;border-top:1px solid rgba(255,255,255,.08);vertical-align:top;width:120px">
        <div style="font-size:13px;color:#A09CB8;font-weight:600">${dowOf(d.ymd)}</div>
      </td>
      <td style="padding:12px 0;border-top:1px solid rgba(255,255,255,.08)">${evs}${dues}</td>
    </tr>`;
  }).join("");

  const tight = w.tightest && w.tightest.busy > 0
    ? `<p style="font-size:14px;color:#A09CB8;margin:18px 0 0">
         Your longest day is <b style="color:#ECEAF5">${dowOf(w.tightest.ymd)}</b>,
         with ${Math.round(w.tightest.busy / 60)} hours committed.</p>` : "";

  const html = `<div style="background:#0A0912;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#14121F;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:28px">
      <div style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#FFB020;font-weight:600">The week ahead</div>
      <h1 style="font-size:26px;color:#ECEAF5;margin:10px 0 20px;letter-spacing:-.02em">
        ${w.totalEvents} things on, ${w.totalDues} due.</h1>
      ${conflictBlock}
      <table style="width:100%;border-collapse:collapse">${dayRows}</table>
      ${tight}
      <a href="https://dayflo.org/app.html"
         style="display:inline-block;margin-top:24px;background:#FFB020;color:#1B1204;font-weight:700;
                font-size:15px;text-decoration:none;padding:13px 22px;border-radius:12px">Open Dayflow</a>
      <p style="font-size:12px;color:#6B6785;margin:22px 0 0">
        You get this because you're on Dayflow Pro. Reply to turn it off.</p>
    </div></div>`;

  const text = [
    `${w.totalEvents} things on, ${w.totalDues} due.`,
    ...(nConf ? [``, `${nConf} conflict(s):`, ...w.allConflicts.map(({ ymd, pair }) =>
      `  ${dowOf(ymd)}: ${pair[0].title} vs ${pair[1].title}`)] : []),
    ``, `https://dayflo.org/app.html`,
  ].join("\n");

  return { subject, html, text };
}

async function sendEmail(to: string, subject: string, html: string, text: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: Deno.env.get("DIGEST_FROM") || "Dayflow <hello@dayflo.org>", to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ---- entry --------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.headers.get("x-digest-secret") !== Deno.env.get("DIGEST_SECRET")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";     // report who *would* get mail
  const force = url.searchParams.get("force") === "1";    // ignore the Sunday-7pm gate

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();

  const { data: pros, error } = await supa.from("user_pro").select("user_id").eq("active", true);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const report: any[] = [];
  let sent = 0;

  for (const { user_id } of pros ?? []) {
    const { data: row } = await supa.from("user_state").select("data").eq("user_id", user_id).maybeSingle();
    const state: any = row?.data ?? {};
    const tz = String(state.tz || "");
    if (!tz) { report.push({ user_id, skip: "no timezone yet" }); continue; }

    const lp = localParts(now, tz);
    if (!lp) { report.push({ user_id, skip: `bad timezone ${tz}` }); continue; }
    if (!force && !(lp.dow === SEND_DOW && lp.hour === SEND_HOUR)) {
      report.push({ user_id, skip: `local ${DOW_LONG[lp.dow]} ${lp.hour}:00` }); continue;
    }
    // One digest per local week, even if the hourly cron double-fires or the
    // student crosses a timezone on a road trip.
    if (state.digestAt === lp.ymd) { report.push({ user_id, skip: "already sent today" }); continue; }

    const week = buildWeek(state, lp.ymd);
    if (!week.totalEvents && !week.totalDues) { report.push({ user_id, skip: "empty week" }); continue; }

    const { data: u } = await supa.auth.admin.getUserById(user_id);
    const to = u?.user?.email;
    if (!to) { report.push({ user_id, skip: "no email" }); continue; }

    const { subject, html, text } = renderEmail(week);
    if (dryRun) { report.push({ user_id, would_send: to, subject }); continue; }

    try {
      await sendEmail(to, subject, html, text);
      await supa.from("user_state").upsert({
        user_id, data: { ...state, digestAt: lp.ymd }, updated_at: new Date().toISOString(),
      });
      sent++;
      report.push({ user_id, sent: to, subject });
    } catch (e) {
      report.push({ user_id, error: String((e as Error).message).slice(0, 160) });
    }
  }

  return new Response(JSON.stringify({ sent, considered: pros?.length ?? 0, report }, null, 2),
    { headers: { "Content-Type": "application/json" } });
});
