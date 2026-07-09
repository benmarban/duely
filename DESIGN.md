# Dayflow design system — "Voltage"

Second system. The first ("Dusk & Solar") committed to a sunrise metaphor in amber
on plum-black. It was coherent and it was quiet. This one is not quiet.

The brief: a landing page that hooks someone in the first second, and an app that
still reads as a tool at 6am. Those pull in opposite directions, so the landing
page carries the spectacle and the app inherits only the palette.

## Direction

Research (dark-mode practice as of 2026) converges on three things, and all three
are load-bearing here:

1. **Never pure black.** `#000` smears on OLED during scroll and reads as a hole.
   Use a tinted near-black. Ours is violet-tinted: `#0A0912` → `#08070E`.
2. **Never pure white text.** `#FFF` on near-black vibrates. Soft white `#F4F3F8`.
3. **One high-salience accent, ~5% of the composition.** Neon everywhere is neon
   nowhere. Violet leads; lime is the shock and appears on almost nothing.

## Tokens

### Surfaces
| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#08070E` | page (violet-tinted near-black) |
| `--bg-2` | `#0D0B16` | raised base |
| `--card` | `#12101D` | widgets, panels |
| `--card-2` | `#191627` | nested cards |
| `--surface-3` | `#221E36` | hover/pressed |

### Brand
| Token | Value | Use |
| --- | --- | --- |
| `--volt` | `#7C5CFF` | brand. CTA, logo, rail fill |
| `--volt-2` | `#A78BFF` | hover, links, eyebrows |
| `--volt-deep` | `#5B3FD6` | gradient end, pressed |
| `--ink` | `#0A0614` | text **on** volt |
| `--lime` | `#C8FF3D` | the shock. "now", live states, nothing else |

### Categories — six hues, each used once
| Token | Value | Means |
| --- | --- | --- |
| `--cyan` | `#22E4F5` | class, lecture |
| `--magenta` | `#FF3D9A` | practice, athletics |
| `--lime` | `#C8FF3D` | work shifts |
| `--tangerine` | `#FF8A3D` | deadlines |
| `--azure` | `#5B8CFF` | personal |
| `--danger` | `#FF4D5E` | overdue, destructive, the **now** line |

`--volt` is the brand and never a category. A student must never wonder whether
purple means "class" or "the button."

## Background

The dot grid is gone. It was texture pretending to be depth.

**Hero: a WebGL mesh gradient.** Fractal Brownian motion over simplex noise, three
colour stops (volt, magenta, cyan) blended in the fragment shader, warped by a
sine mesh, with the pointer passed in as a uniform so the field leans toward the
cursor. Renders on the GPU at 60fps and pauses when off-screen.

Falls back to a static CSS radial-gradient when WebGL is unavailable, which also
covers `prefers-reduced-motion` — the shader's time uniform simply stops.

**Everywhere: film grain.** A fixed SVG `feTurbulence` layer at 3.5% opacity.
Large dark gradients band on cheap laptop panels; grain dissolves the stair-step
and adds a filmic surface. Static, no animation, near-zero cost.

## Motion

Everything springs, nothing eases linearly. Hand-rolled — no GSAP, no Lenis, no
Three.js, because Dayflow has no build step and a landing page is not a reason to
grow one.

| Effect | Technique | Reference |
| --- | --- | --- |
| Hero field | GLSL fbm + simplex, pointer uniform | Stripe's gradient |
| Headline | per-word clip mask, 45ms stagger | — |
| Section pinning | tall wrapper + `position:sticky`, scroll progress → CSS var | Codrops sticky-grid |
| Feature stack | cards scale + translate as they pin | Apple product pages |
| Marquee | duplicated track, `transform: translateX`, paused on hover | — |
| Cursor | `mix-blend-mode: difference` dot, springs to pointer | Awwwards house style |
| Buttons | magnetic pull, 6px cap | Arc |
| Cards | pointer-tracked spotlight via `--cx/--cy` | Linear |

**Reduced motion collapses all of it.** The shader freezes on frame zero, the
marquee stops, the cursor is removed, reveals become cross-fades. Not "less
motion" — none.

## Rules

1. `--lime` appears at most twice per viewport. It means *live, now, happening*.
2. Category colour rides on `--cc` and is inherited. Set it once per row.
3. The app gets the palette and the grain. It does not get the shader, the
   marquee, or the custom cursor. It's a tool, not a poster.
4. Every animation reads the pointer or the scroll. Nothing loops on a timer
   except the marquee, and it stops when you touch it.
