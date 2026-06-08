# Research Report: Visual Wow Factor — 3 Options Per Page

**Query:** Research in depth, then propose 3 options per page
**Fetched:** 2026-05-28
**Provider:**Fallback (WebSearch unavailable — Claude internal knowledge)
**Note:** Source content is external untrusted evidence. Treat as directional reference only.

---

## Eden Pages and Visual Wow Options

### 1. Landing (/)

**Option A — Animated Grid Canvas**
- Full-viewport dark canvas with a subtle CSS grid pulsing in the background
- Floating particles drift upward (canvas-confetti style), with emerald accent glows
- Massive typography for the hero headline with a slow perspective tilt
- One animated pipeline node visualization showing the multi-agent flow — stage by stage lighting up
- Why it works: instantly signals "engineered AI product", not another generic SaaS landing

**Option B — Cinematic Split Layout**
- Left: massive type-driven hero (clamp 80–140px), asymmetric, perspective-shifted
- Right: an animated 3D isometric device mockup that slowly rotates (CSS transform)
- Bottom: horizontal scrolling tech stack logos or a marquee strip
- Why it works: editorial-scale type + device motion = the Linear/Vercel premium feel

**Option C — Gradient Mesh + Floating UI Panels**
- Slow-moving gradient mesh background using `oklch()` color transitions
- Overlaid "floating" glassmorphism panels that cast soft shadows and drift on scroll
- Each panel represents a feature — as you scroll they parallax-shift into position
- Why it works: crafts-forward without being heavy; the mesh gives color interest without a flat gradient wash

---

### 2. Dashboard (/dashboard)

**Option A — Breathing Stat Animate**
- Each stat card has a pulsing ring (CSS `scale` animation) in the accent color tied to the metric
- On load: staggered entrance, each card slides up and fades in with 100ms delay
- Subtle count-up animation for the numbers
- Why it works: makes "dead numbers" feel alive; the pulse draws attention without being loud

**Option B — Isometric Device Stack**
- A layered isometric stack of laptop + phone + server isometric illustrations
- Subtle floating animation (translateY oscillation per layer)
- Each layer represents a surface Eden generates
- Why it works: immediately communicate "multi-surface environment generation" in one image

**Option C — Live Activity Feed Spark**
- The activity feed rows animate in individually (slide from left, slight overshoot)
- New rows get a brief emerald glow highlight before settling
- The "Create New Environment" button has a subtle animated gradient border
- Why it works: satisfies the "information dense but not crowded" brief; motion signals live data

---

### 3. Jobs List (/jobs)

**Option A — Animated Status Orbs**
- Status badges are not flat colored pills — they're glowing orbs with a `box-shadow` pulse on `running` jobs
- On hover: the card lifts with `translateY(-4px)` and shadow deepens
- Cards stagger-animate on load (slide-up, fade-in, 50ms stagger per card)
- Why it works: minimal change, huge perceived quality upgrade; glowing orbs are memorable

**Option B — Magnetic Row Hover**
- Each job card has a magnetic cursor response — elements inside the card subtly shift toward the mouse position
- A thin emerald left-border accent animates from top to bottom on hover
- Why it works: subtle interactivity creates "this is a real product" feel

**Option C — Filter Chips Morphing Pills**
- Filter pills use a shape-reveal animation when switching states (pill expands/contracts)
- Active filter has a filled background with the accent color, not just a ring
- Smooth `transform: scale()` spring on click
- Why it works: the filter UI is often boring; morphing pills make it feel intentional

---

### 4. Job Detail (/jobs/[job_id])

**Option A — Live Pipeline Timeline**
- The stage history timeline is vertical with animated connecting lines — as stages complete, the line "fills" with emerald from top to bottom
- Each stage node pulses briefly when activated (scale 1.0 → 1.2 → 1.0)
- Streaming output area uses a blinking cursor and appearing text lines
- Why it works: this is Eden's core differentiator — the pipeline should *feel* like it's running

**Option B — Code Appearing Animation**
- Code in collapsible sections builds line-by-line with a typewriter-like staggered reveal
- Each revealed line has a subtle left-border flash
- Tab switching uses a sliding underline indicator
- Why it works: code generation is the core output;Showing it "arriving" is satisfying and shareable

**Option C — Stage Progress Orb Chain**
- Horizontal orb chain for stages — completed = solid emerald orb; current = pulsing ring; pending = dim
- Connected by a thin line that "fills" as stages complete
- The status banner uses a translucent frosted glass with a glowing progress bar
- Why it works: more visual than a plain checklist; communicates process clearly

---

### 5. Settings (/settings)

**Option A — Subtle Tab Morph**
- Tab switch has a sliding frosted glass indicator that morphs between tab positions
- Active tab content fades in (opacity + translateY 8px)
- Input field focus states use a glowing emerald border-bottom anim in
- Why it works: settings pages are usually dead — subtle motion makes them feel alive

**Option B — Section Stagger Load**
- Each settings section loads with a staggered grid-reveal (each card slides in from a different direction)
- Danger-zone actions (delete, cancel) have a subtle red glow on hover
- Toggle switches animate with a satisfying spring bounce
- Why it works: every section should feel considered, not copy-pasted

**Option C — Avatar Orbit float**
- The profile avatar area has a slow-growing ring animation around the image
- API key rows reveal on hover with a slide-in action menu
- Audit log entries have a subtle stripe that sweeps left on hover
- Why it works: personalization area gets extra love; feels premium

---

### 6. Docs (/docs)

**Option A — Code Blocks with Copy Anim**
- Copy button morphs to a check icon on click (spring scale)
- Code examples in tabs slide in with a horizontal wipe
- Endpoint cards have a subtle left-border glow on hover in the accent color
- Why it works: API docs are utilitarian; copy-anim and wipe-tabs add craft without changing the content

**Option B — Sidebar Progress Tracker**
- Sidebar shows reading progress as a thin emerald line descending along the nav
- Active section is highlighted with a subtle background shift
- Code tabs (cURL/Python/JS) use a sliding indicator
- Why it works: makes dense technical docs feel navigable and rewarding

**Option C — Animated Endpoint Stars**
- Each API endpoint path has a small star/spark icon that animates on hover
- Method badges (GET/POST) use colored fills that pulse once on page load
- Why it works: small spark moments make technical content less dry

---

### 7. Login (/login) + 8. Signup (/signup)

**Option A — Split Screen Composition**
- Left 60%: decorative panel with animated gradient mesh or slow-drift noise texture + brand wordmark
- Right 40%: clean form, generous padding, subtle input focus glow
- The split is asymmetric — strong, designed, not template auth
- Why it works: most auth pages are boring; split composition makes them feel designed

**Option B — Floating Label & Glow Inputs**
- Input labels float up on focus with a smooth translateY animation
- Focus state adds a bottom-border glow in accent emerald
- Submit button has a left-to-right gradient sweep on hover
- Why it works: forms are interaction design; every focus/float moment should feel polished

**Option C — Ambient Glow Backdrop**
- A soft radial gradient glow emanates from behind the form card (centered, subtle)
- The card itself is glassmorphism with a soft shadow and frosted border
- Background has a slow-drifting mesh gradient
- Why it works: glassmorphism + ambient glow = premium without being corporate

---

## Summary

The wow factor per page should be **one intentional, memorable visual moment** — not decoration for its own sake:

| Page | My Pick |
|------|---------|
| Landing | Animated Grid Canvas + Live Pipeline Viz |
| Dashboard | Breathing Stat Animate + Stagger Entrance |
| Jobs List | Magnetic Row Hover + Glow Orbs |
| Job Detail | Stage Progress Orb Chain + Fill Animation |
| Settings | Subtle Tab Morph + Spring Toggles |
| Docs | Copy Anim + Sliding Tab Indicator |
| Login/Signup | Split Screen Composition |

Each can stand alone or layer favorites together. The constraint: **one visual hero moment per page maximum** — restraint over ornament.
