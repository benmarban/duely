# Duely 🗓️

**Your student command center — every deadline, grade, and class in one place.**

Duely pulls together the systems students juggle every day — Canvas, email, and
your calendar — into a single dashboard, so important dates land in front of you
automatically instead of getting lost across a dozen tabs.

> ⚠️ **Prototype.** This is an early, front-end-only prototype. The dashboard,
> navigation, and email date-extraction all work, but grades, schedule, and
> account syncing currently run on realistic **sample data**. Live Canvas /
> Gmail / Google Calendar connections are the next phase (see [Roadmap](#roadmap)).

## What it does today

- **Dashboard** — at-a-glance stat tiles (due this week, overdue, term GPA,
  unread), today's class schedule with a live "Now" marker, recent grades, and
  announcements from Canvas + email.
- **Deadlines** — a unified list grouped by Overdue / Today / Tomorrow / This
  week / Later, color-coded by urgency and tagged by source.
- **Add from email** — paste any message (a professor's note, a club email) and
  Duely finds the date and turns it into a deadline.
- **Calendar, Grades, Courses** — dedicated views, all color-coded per course.
- **Works on your phone** — responsive layout; on mobile the sidebar becomes a
  bottom tab bar. Add it to your home screen to use it like an app.

## Run it

It's a single, self-contained HTML file — no build step, no dependencies.

- **Locally:** open `index.html` in any browser.
- **Hosted:** enable GitHub Pages on this repo (Settings → Pages → deploy from
  `main` / root) and it's live at `https://<your-username>.github.io/duely/`.

## Roadmap

- [ ] Connect a real Canvas account (via the Canvas calendar feed / REST API)
- [ ] Upgrade email date-extraction to an AI model for messy, vague wording
- [ ] Live Gmail sync + auto-add to Google Calendar
- [ ] Push notifications / reminders
- [ ] Real grade and GPA tracking

## Tech

Plain HTML, CSS, and JavaScript in one file. State persists in the browser via
`localStorage`. No framework, no backend — intentionally simple so it's easy to
host and iterate on.

## License

MIT — see [LICENSE](LICENSE).
