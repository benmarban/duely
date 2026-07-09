# Dayflow design system — "Dusk & Solar"

The old palette was teal-on-navy: cool, competent, and indistinguishable from every
other productivity SaaS. The new one commits to the metaphor the landing page already
had but never colored for — **a day, scrolled from dawn to night.**

## The idea

A student-athlete's day starts before sunrise and ends after dark. The interface should
feel like that arc. So the base is a deep plum-black night, and the brand accent is the
sun coming up over it.

- **Night** (`--bg` family) — deep, warm-shifted black. Not blue-black. Plum-black reads
  softer at 6am on a phone in a dark dorm room, which is when this app is actually opened.
- **Solar** (`--solar`) — the brand. Amber-gold. Every primary action, the logo, the time
  rail's fill, the "now" marker.
- **Category hues** are a spectrum across the day, not arbitrary labels.

## Tokens

### Surfaces
| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0A0912` | page |
| `--bg-2` | `#100E1C` | raised base, sidebar gradient |
| `--card` | `#14121F` | widgets, panels |
| `--card-2` | `#1A1830` | nested cards (timeline rows) |
| `--surface-3` | `#221F3A` | hover/pressed fills |

### Brand
| Token | Value | Use |
| --- | --- | --- |
| `--solar` | `#FFB020` | primary CTA, logo, rail fill |
| `--solar-2` | `#FFD27A` | hover, links, eyebrows |
| `--solar-deep` | `#C97A12` | logo gradient end, pressed |
| `--ink` | `#1B1204` | text **on** solar surfaces |

`--ink` replaces the old `#04141a` (teal-ink). Never put `--text` on a solar fill.

### Categories — the day's spectrum
| Token | Value | Means |
| --- | --- | --- |
| `--iris` | `#8B7CFF` | class, lecture |
| `--coral` | `#FF6B57` | practice, athletics |
| `--mint` | `#46E0B0` | work shifts, success |
| `--solar` | `#FFB020` | deadlines |
| `--azure` | `#58A6FF` | personal |
| `--danger` | `#FF4D6A` | overdue, destructive, the **now** line |

Six hues, each used once. `--danger` is deliberately *not* coral: a delete button and a
practice block must never read as the same thing. (`--sky-*` was taken — the landing page
uses it for the scroll-driven ambient glow — hence `--azure`.)

These values are the single source of truth for `CATS` in `app.html` **and** `SCHEDULE`
in `index.html`. The landing page is a promise the app has to keep; if they drift, the
hero screenshot is lying.

### Type
Tracking is size-specific (per Apple's typography rules — a single `letter-spacing`
is wrong somewhere):

- Display (`clamp(34px, 6vw, 62px)`) → `letter-spacing: -0.035em`, `line-height: 1.02`
- Section h2 → `-0.028em`, `1.06`
- Body → `0`, `1.55`
- Mono eyebrows / time codes → `+0.2em`, uppercase

### Motion
Springs, not fixed-duration curves, for anything the user can touch.

- **Default UI**: critically damped, no overshoot. `cubic-bezier(.32,.72,0,1)` @ 380ms.
- **Momentum only** (a flick, a drag release): slight bounce, `damping ~0.8`.
- **Press feedback fires on `:active`, not on click** — instant, `scale(.97)`.
- Reveal-on-scroll: opacity + 12px rise, never a slide from off-screen.
- Everything collapses to a cross-fade under `prefers-reduced-motion: reduce`.

### Materials
Chrome is translucent and content scrolls *under* it:
`background: rgba(10,9,18,.72)` + `backdrop-filter: blur(20px) saturate(1.6)`.
A bright top edge (`border-top: 1px solid rgba(255,255,255,.06)`) reads as light
catching the material. Under `prefers-reduced-transparency`, surfaces go solid.

## Rules

1. Never stack a translucent surface on another translucent surface.
2. Category color is carried on `--cc` and inherited — a timeline row sets it once and
   the dot, chip, and left border all read from it.
3. The "now" line is the only pulsing element on any screen. Motion is a scarce resource.
4. Photos are duotoned into the palette (`--iris` shadows, `--solar` highlights) so
   they belong to the system rather than sitting on top of it.
