# Dayflow 🗓️

**Your whole day, one place — class, practice, film, work shifts, and deadlines.**

Dayflow pulls everything a busy student (or student-athlete) juggles into a
single dashboard: classes and assignment deadlines alongside athletics, work
shifts, and personal events — sorted by what's happening next.

> **Status.** Real email/password accounts and cloud sync work (via Supabase).
> **Live now:** importing a real calendar feed from Canvas and other LMS/work
> apps (`canvas-import`), and auto-intake of forwarded email into the right
> account (`email-inbound` → Gemini). **Still to come:** "Continue with Google"
> (OAuth), writing back to Google Calendar, and grades/GPA.

## The three pages

| File | What it is | Live URL |
|---|---|---|
| `index.html` | **Landing page** — dark, animated marketing front door | `https://benmarban.github.io/duely/` |
| `login.html` | **Sign-in** — email + password via Supabase (Google coming soon) | `https://benmarban.github.io/duely/login.html` |
| `app.html` | **Dashboard** — the actual app | `https://benmarban.github.io/duely/app.html` |

Flow: **landing → login → app**. The app redirects to login when signed out.

## What it does

- **Today timeline** — an hour-by-hour view of your whole day, merging class,
  athletics, work, personal events, and deadlines, with a live "Now" marker.
- **Add / edit / delete your own events** — practices, shifts, coaches meetings,
  appointments — with a type (Class / Athletics / Work / Personal), day, time,
  and location.
- **Category filters** on both Today and the Week view (e.g. see just Athletics
  or just Work).
- **Deadlines, Grades, Courses** — dedicated views, color-coded per course.
- **Add from email** — paste a message and Dayflow extracts the date.
- **Real accounts** — sign in with email; your schedule saves to *your* account
  in the cloud (not just one device), protected by row-level security.
- **Responsive** — full dashboard on desktop, bottom-tab app on mobile.

## Tech

- Plain HTML / CSS / JavaScript — no build step, no framework.
- **Supabase** for auth + per-user data (`user_state` table, JSONB blob, RLS).
- **GitHub Pages** hosting (served from `main` / root).
- Typography: Hanken Grotesk (app) + Schibsted Grotesk (landing display).

### Supabase setup (one-time)

1. Run the `user_state` table + RLS policies (see project notes / SQL).
2. Authentication → Providers → Email → turn **off** "Confirm email" for instant
   sign-up during development.
3. The publishable key lives in the client code by design; RLS is what protects
   each user's data.

## Roadmap

- [x] Connect a real Canvas / LMS / work account via calendar feed
- [x] Auto-add from forwarded email (Gemini extraction)
- [ ] "Continue with Google" (Google OAuth)
- [ ] Write events back to Google Calendar
- [ ] Verified email intake (SPF/DKIM) to stop sender spoofing
- [ ] Push notifications / reminders
- [ ] Real grade & GPA tracking

## License

MIT — see [LICENSE](LICENSE).
