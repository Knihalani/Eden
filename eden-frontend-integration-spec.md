# Eden Frontend Integration Spec

## Overview

Fully integrate the new dark-terminal frontend design from `Eden-—-AI-Native-Environment-Generation-Platform-----What/` into the existing Next.js portal at `clients/portal/`. Overwrite the outdated frontend. Preserve the visual design faithfully while polishing interactions and fully wiring all pages to real data.

## Source of Truth

- **Design folder**: `Eden-—-AI-Native-Environment-Generation-Platform-----What/`
- **Target app**: `clients/portal/` (Next.js 15, React 19, TypeScript, Tailwind CSS)
- **Design tokens**: `tokens.css`
- **HTML screens**: `landing.html`, `login.html`, `signup.html`, `dashboard.html`, `jobs.html`, `job-detail.html`, `settings.html`, `docs.html`

## Clarified Decisions

| Decision | Choice |
|----------|--------|
| Landing page scope | Replace existing marketing page entirely with new `landing.html` |
| Theme integration | Replace existing CSS variables globally with new design tokens |
| Integration depth | Full rewrite — rebuild pages from scratch using design as blueprint |
| Auth pages | Use `login.html` and `signup.html` from the new frontend folder |
| Typography | Install and configure Geist Sans + Geist Mono fonts properly |
| Animations | Full animation implementation with Framer Motion |
| Docs page | Yes, integrate as `/docs` route |
| Landing source of truth | Use `landing.html` (dark-terminal, tokens.css, Geist fonts) |
| Non-design pages | Remove them — the portal should fully be the new one |
| Component strategy | Build new components from scratch matching the design system |

## Design System

### Color Palette (oklch-based dark terminal)

All colors use oklch() for perceptual uniformity. The palette is already defined in `tokens.css`.

**Backgrounds**:
- `--bg-base`: oklch(10% 0.010 250) — deepest background
- `--bg-surface`: oklch(13% 0.014 250) — cards, panels
- `--bg-elevated`: oklch(17% 0.018 250) — elevated surfaces
- `--bg-hover`: oklch(21% 0.022 250) — hover states
- `--bg-input`: oklch(9% 0.008 250) — form inputs

**Text**:
- `--fg-primary`: oklch(96% 0.003 250) — headings, primary text
- `--fg-secondary`: oklch(82% 0.010 250) — body text
- `--fg-muted`: oklch(62% 0.012 250) — labels, metadata
- `--fg-faint`: oklch(42% 0.008 250) — placeholders, disabled

**Borders**:
- `--border-subtle`: oklch(26% 0.010 250)
- `--border-default`: oklch(34% 0.016 250)
- `--border-strong`: oklch(50% 0.018 250)

**Accent (electric cyan)**:
- `--accent`: oklch(70% 0.16 200)
- `--accent-hover`: oklch(74% 0.18 200)
- `--accent-dim`: oklch(70% 0.12 200 / 0.14)
- `--accent-glow`: oklch(70% 0.22 200 / 0.24)

**Secondary accent (emerald)**:
- `--accent-2`: oklch(72% 0.16 162)
- `--accent-2-dim`: oklch(72% 0.12 162 / 0.14)

**Status colors**:
- `--success`: oklch(72% 0.18 148)
- `--warn`: oklch(78% 0.16 82)
- `--error`: oklch(66% 0.22 25)
- `--info`: oklch(68% 0.14 245)

**Pipeline stage colors**:
- `--stage-planning`: oklch(70% 0.16 200)
- `--stage-fact-check`: oklch(66% 0.14 280)
- `--stage-executing`: oklch(74% 0.18 165)
- `--stage-archivist`: oklch(62% 0.14 200)
- `--stage-code-quality`: oklch(58% 0.16 290)
- `--stage-completed`: oklch(72% 0.18 148)
- `--stage-failed`: oklch(66% 0.22 25)
- `--stage-pending`: oklch(48% 0.014 250)

### Typography

**Fonts**:
- Sans: Geist Sans (primary), Inter (fallback from tokens.css)
- Mono: Geist Mono (primary), JetBrains Mono (fallback from tokens.css)

**Type scale**:
| Token | Size | Usage |
|-------|------|-------|
| --text-xs | 11px | Labels, mono text, badges |
| --text-sm | 13px | Secondary text, nav items |
| --text-base | 15px | Body text |
| --text-md | 17px | Emphasized body |
| --text-lg | 20px | Section subtitles |
| --text-xl | 24px | Card titles |
| --text-2xl | 28px | Page section headers |
| --text-3xl | 34px | Page titles |
| --text-4xl | 44px | Stat values, large display |
| --text-5xl | 56px | Hero text |

**Line heights**: --leading-tight (1.1), --leading-snug (1.3), --leading-normal (1.6), --leading-relaxed (1.75)

**Letter spacing**: --tracking-tight (-0.025em), --tracking-normal (0), --tracking-wide (0.04em), --tracking-wider (0.08em)

### Spacing

| Token | Value |
|-------|-------|
| --space-1 | 4px |
| --space-2 | 8px |
| --space-3 | 12px |
| --space-4 | 16px |
| --space-5 | 20px |
| --space-6 | 28px |
| --space-8 | 36px |
| --space-10 | 44px |
| --space-12 | 52px |
| --space-16 | 68px |
| --space-20 | 84px |
| --space-24 | 96px |
| --space-32 | 128px |

### Radii

- --radius-sm: 4px
- --radius-md: 8px
- --radius-lg: 12px
- --radius-xl: 16px

### Motion

- --ease-out: cubic-bezier(0.25, 0.1, 0.25, 1)
- --t-fast: 100ms
- --t-base: 150ms
- --t-slow: 250ms

### Layout Constants

- --sidebar-w: 220px
- --header-h: 52px
- --content-max: 1200px

## Component Library

Build all components from scratch as React components in `src/components/ui/` and `src/components/brand/`. Do not reuse shadcn/ui components — the design has its own visual language.

### Core Components

1. **Button** — Variants: primary (cyan), secondary (elevated), ghost, danger, emerald. Sizes: sm, md, lg. States: hover, active, disabled, loading.
2. **Badge** — Variants: neutral, cyan, green, amber, red, purple. With optional spinner for loading state.
3. **Input** — Dark input with focus ring using accent color. Floating label variant for auth.
4. **Card** — Surface/elevated variants with subtle border transitions on hover.
5. **CodeBlock** — Dark background, syntax-highlighted with custom color tokens.
6. **Tag** — Small inline label with mono font.
7. **Table** — With hover states, sticky headers, and proper dark styling.
8. **StatCard** — For dashboard metrics with accent glow variant.
9. **Pipeline** — Horizontal stage indicator with dots, connectors, and labels.
10. **StreamLog** — Terminal-like scrolling log output with timestamps.
11. **SectionHeader** — Page section divider with title and optional meta.
12. **Tabs** — Horizontal tabs with animated indicator underline.
13. **CopyButton** — Button that morphs to checkmark on click with pop animation.
14. **NavItem** — Sidebar navigation item with active/hover states.
15. **AuthCard** — Glassmorphism card for auth forms.

### Animation Components (Framer Motion)

1. **FadeUp** — Staggered entrance animation for lists/grids.
2. **PageTransition** — Route transition wrapper.
3. **TabIndicator** — Animated sliding underline for tabs.
4. **PipelinePulse** — Glowing pulse animation for active pipeline stages.
5. **AuthMesh** — Canvas-based animated gradient mesh for auth pages.
6. **TerminalTypewriter** — Typing animation for terminal hero.
7. **ScrollProgress** — Reading progress indicator for docs.

## Page Inventory

### Marketing Routes

| Route | Source File | Notes |
|-------|-------------|-------|
| `/` | `landing.html` | Hero with terminal animation, feature grid, how-it-works, CTA |

### Auth Routes

| Route | Source File | Notes |
|-------|-------------|-------|
| `/login` | `login.html` | Split layout: brand panel (mesh animation + features) + form |
| `/signup` | `signup.html` | Same split layout with name field + terms checkbox |

### App Routes (require auth, sidebar layout)

| Route | Source File | Notes |
|-------|-------------|-------|
| `/dashboard` | `dashboard.html` | Stats cards, bento grid, recent jobs, activity feed |
| `/jobs` | `jobs.html` | Job list with filters, status badges, pagination |
| `/jobs/[id]` | `job-detail.html` | Pipeline timeline, stream log, code output, version history |
| `/settings` | `settings.html` | Vertical tabs: Profile, Org, Billing, API Keys, Danger |
| `/docs` | `docs.html` | API docs with sidebar nav, endpoint cards, code tabs, copy buttons |

### Pages to Remove

The following existing pages should be removed as they have no design equivalents:
- `/billing` (absorbed into settings)
- `/profile` (absorbed into settings)
- `/environment/[id]` (merge functionality into job detail)
- `/invite/[token]` (remove or redirect to signup)

## Global Styles

Replace `globals.css` entirely. The new global styles must:

1. Import Geist Sans and Geist Mono via `next/font`.
2. Define all CSS custom properties from `tokens.css`.
3. Set `background: var(--bg-base)` and `color: var(--fg-primary)` on `body`.
4. Configure scrollbar styling (5px thin, dark themed).
5. Set `::selection` to accent color with transparency.
6. Include `@media (prefers-reduced-motion: reduce)` fallbacks.
7. Include responsive breakpoints matching the design handoff: 640px, 900px, 1100px.

## Layout Architecture

### Auth Layout (`app/(auth)/layout.tsx`)
- Full-height split layout
- Left panel: brand content with animated mesh canvas
- Right panel: centered auth card with glassmorphism
- Mobile: hide brand panel, show form only
- Links between login/signup

### Portal Layout (`app/(portal)/layout.tsx`)
- Fixed sidebar (220px) on left with logo, nav items, user section
- Collapsible on mobile with hamburger button + overlay
- Main content area with sticky header (52px)
- Padding and max-width constraints

### Marketing Layout (`app/(marketing)/layout.tsx`)
- Sticky nav bar with logo, links, CTA
- No sidebar
- Footer at bottom

### Docs Layout (`app/(docs)/layout.tsx` or within portal)
- Same sidebar as portal but with docs-specific navigation
- Reading progress indicator on sidebar
- Topbar with page title

## Data Integration

### Existing Hooks to Preserve

- `useAuth()` — Authentication state, login, logout, signup
- `useOrg()` — Organization context, switching
- `useJobStream(jobId)` — SSE streaming for job updates

### Existing API to Preserve

- `api.ts` — All existing API methods
- Type definitions from `types.ts`

### Data Mapping

| Design Element | Data Source |
|----------------|-------------|
| Dashboard stats | API aggregated metrics |
| Job list | `/api/jobs` with filters |
| Job detail | `/api/jobs/[id]` + SSE stream |
| Pipeline stages | Job status + stream events |
| Stream log | SSE message events |
| Settings tabs | User/org API endpoints |
| API docs | Static content from docs.html |

## Animation System (Framer Motion)

### Core Variants

All variants use the design's easing curve `cubic-bezier(0.25, 0.1, 0.25, 1)` mapped to Framer Motion's `[0.25, 0.1, 0.25, 1]`.

#### `fadeUp`
Base entrance animation used across almost every component.
```tsx
const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

#### `fadeUpStagger`
For parent containers whose children should stagger in.
```tsx
const fadeUpStagger = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};
```

#### `fadeIn`
Simple opacity-only entrance.
```tsx
const fadeIn = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.3, ease: "easeOut" } },
};
```

#### `slideInLeft`
For stream log lines and code line reveals.
```tsx
const slideInLeft = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

#### `scaleReveal`
For the terminal "done" reveal and copy button pop.
```tsx
const scaleReveal = {
  hidden: { opacity: 0, scaleX: 0.8, x: -4 },
  visible: {
    opacity: 1,
    scaleX: 1,
    x: 0,
    transition: { duration: 0.4, ease: [0.34, 1.56, 0.64, 1] },
  },
};
```

#### `tabWipe`
For docs code tab panel switches.
```tsx
const tabWipe = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

#### `tabPanelFade`
For settings tab panel switches.
```tsx
const tabPanelFade = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

#### `toastSlide`
For the copy toast.
```tsx
const toastSlide = {
  hidden: { opacity: 0, y: 80, x: "-50%" },
  visible: {
    opacity: 1,
    y: 0,
    x: "-50%",
    transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
  },
  exit: {
    opacity: 0,
    y: 80,
    x: "-50%",
    transition: { duration: 0.2 },
  },
};
```

---

### Page-Level Animations

#### Landing Page

**Terminal typewriter** — Imperative `useEffect` timer, not Framer Motion:
```tsx
// Character interval: 38ms per character
// Command: 'describe: "multi-tool support agent with memory and dynamic tool discovery"'
// After typing completes (600ms pause), remove .active-terminal class
// Then reveal result lines with stagger delays: [300, 380, 420, 360, 300, 320, 420]ms
// Cursor blink: 1s step-end infinite when idle, 0.6s step-end infinite when typing
```

**Terminal glow pulse** (CSS keyframe, not Framer Motion):
```css
@keyframes termGlow {
  from { box-shadow: 0 0 0 1px oklch(60% 0.18 255 / 0.2), 0 24px 64px oklch(0% 0 0 / 0.4), 0 0 30px oklch(70% 0.16 200 / 0.08); }
  to   { box-shadow: 0 0 0 1px oklch(60% 0.18 255 / 0.4), 0 24px 64px oklch(0% 0 0 / 0.6), 0 0 60px oklch(70% 0.16 200 / 0.18); }
}
/* duration: 2s, ease-in-out, infinite alternate */
```

**Pipeline flow glow** (CSS keyframe):
```css
@keyframes pipeGlow {
  from { box-shadow: 0 0 0 1px oklch(60% 0.18 145 / 0.2), 0 24px 64px oklch(0% 0 0 / 0.4), 0 0 30px oklch(72% 0.16 148 / 0.08); }
  to   { box-shadow: 0 0 0 1px oklch(60% 0.18 145 / 0.4), 0 24px 64px oklch(0% 0 0 / 0.6), 0 0 60px oklch(72% 0.16 148 / 0.18); }
}
/* duration: 1.8s, ease-in-out, infinite alternate */
```

**Stage pulse** (CSS keyframe for active pipeline dot):
```css
@keyframes stagePulse {
  0%, 100% { box-shadow: 0 0 0 4px oklch(70% 0.16 200 / 0.25), 0 0 16px oklch(70% 0.16 200 / 0.5), 0 0 0 0 oklch(70% 0.16 200 / 0); }
  50%       { box-shadow: 0 0 0 10px oklch(70% 0.16 200 / 0.12), 0 0 36px oklch(70% 0.16 200 / 0.25), 0 0 40px oklch(70% 0.16 200 / 0.1); }
}
/* duration: 1.5s, ease-in-out, infinite */
```

**Pipeline log lines**:
```tsx
const plogLine = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.3, ease: "easeOut" },
  },
};
// Stagger: 220ms between pipeline stage log lines
```

**Hero section entrance** (staggered):
```tsx
// Parent: fadeUpStagger (staggerChildren: 0.08)
// Children: fadeUp
// Badge → headline → sub → actions
// Terminal card: fadeUp with delay 0.08s
// Pipeline card: fadeUp with delay 0.12s
```

**Feature cards** (staggered grid):
```tsx
// Parent: fadeUpStagger (staggerChildren: 0.08)
// 8 cards max in design
// Hover: border-color transition 150ms, transform translateY(-2px) 150ms, box-shadow 150ms
```

**CTA band entrance**:
```tsx
// Uses same stagger pattern as feature cards
// Parent: fadeUpStagger
// Children: fadeUp
```

**Trust bar**: Static, no animation.

**Grid canvas** (fixed background): Custom `<canvas>` animation loop, NOT Framer Motion.
- Grid size: 52px
- Accent grid every 4th line
- Floating particles: count = floor((W * H) / 14000)
- Particle velocity: ±0.3 px/frame
- Particle pulse: sin(time * 0.001 + offset) * 0.5 + 0.5
- Radial glow at (0.55W, 0.4H) and (0, H)

---

#### Auth Pages

**Auth card entrance**:
```tsx
const authCardEntrance = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

**Auth mesh gradient** (login/signup left panel): Custom `<canvas>` animation loop, NOT Framer Motion.
- Time increment: `time * 0.0004`
- 3 radial gradients drifting via sin/cos
- Grid overlay: 60px step, `rgba(100,120,160,0.04)`

**Pipeline dots** (auth brand panel):
```css
@keyframes pipelinePulse {
  0%, 100% { box-shadow: 0 0 6px oklch(70% 0.16 200 / 0.4); }
  50% { box-shadow: 0 0 16px oklch(70% 0.16 200 / 0.9), 0 0 32px oklch(70% 0.16 200 / 0.4); }
}
/* duration: 2.4s, ease-in-out, infinite */
/* stagger delays per dot: 0s, 0.3s, 0.6s, 0.9s */
```

**Input focus glow**:
```css
/* On focus: border-color var(--accent), box-shadow: 0 0 0 3px oklch(70% 0.16 200 / 0.12), 0 0 16px oklch(70% 0.16 200 / 0.08) */
/* transition: border-color 100ms, box-shadow 100ms */
```

**Floating label**:
```css
/* On focus or not-placeholder-shown: */
/* top: 8px, font-size: 10px, letter-spacing: 0.06em, uppercase, color: var(--accent) */
/* transition: top 0.15s ease, font-size 0.15s ease, color 0.15s ease */
```

---

#### Dashboard

**Stat card entrance** (with stagger):
```tsx
// Parent container: fadeUpStagger (staggerChildren: 0.1)
// Each stat card: fadeUp with CSS custom property --delay
// Delays: 0ms, 100ms, 200ms, 300ms
```

**Stat ring expand** (SVG stroke-dashoffset animation):
```css
@keyframes ringExpand {
  from { stroke-dashoffset: 220; opacity: 0.4; }
  to   { stroke-dashoffset: 55;  opacity: 1; }
}
/* duration: 2s, ease: [0.25, 0.1, 0.25, 1], forwards */
/* stroke-dasharray: 220, stroke-dashoffset animated from 220 → 55 */
```

**Stat ring pulse** (ongoing breathing):
```css
@keyframes ringPulse {
  0%, 100% { opacity: 0.7; }
  50%       { opacity: 1; filter: drop-shadow(0 0 6px oklch(72% 0.16 162 / 0.65)); }
}
/* duration: 3s, ease-in-out, infinite */
```

**Stat count-up**:
```tsx
// Imperative animation, not Framer Motion
// Duration: 1800ms per stat
// Step: target / (1800 / 16) per frame
// Start after delay + 400ms
```

**Activity feed rows**:
```tsx
const feedRow = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] },
  },
};
// Stagger delays: 400ms, 480ms, 560ms, 640ms, 720ms
```

**Quick action cards hover**:
```css
/* border-color transition 100ms, background 100ms */
/* On hover: border-color oklch(72% 0.16 195 / 0.4), background var(--bg-hover) */
```

---

#### Jobs Page

**Job card entrance** (staggered grid):
```tsx
// Parent: fadeUpStagger (staggerChildren: 0.06)
// Each job card: fadeUp
```

**Job card hover** (magnetic effect):
```tsx
// On mousemove: translate inner .magnetic-wrap by (dx * 3px, dy * 3px)
// Where dx = (mouseX - cardCenterX) / cardWidth
// transition: transform 0.12s linear (0.15s on 1440px+)
// On mouseleave: transform resets to ''
```

**Job card left border draw**:
```css
/* ::before pseudo-element, height 0 → 100% on hover */
/* transition: height 0.35s var(--ease-out) */
/* background: var(--accent-2), box-shadow: 0 0 8px oklch(72% 0.16 162 / 0.5) */
```

**Job card lift**:
```css
/* On hover: translateY(-2px) scale(1.01) */
/* transition: border-color 150ms, background 150ms, transform 250ms var(--ease-out), box-shadow 250ms var(--ease-out) */
/* box-shadow: 0 4px 20px oklch(0% 0 0 / 0.2), 0 0 0 1px oklch(72% 0.16 162 / 0.15) */
```

**Filter pill active**:
```css
/* Instant — no Framer Motion needed */
/* background: var(--accent-dim), border-color: var(--accent), color: var(--accent) */
/* Active scale on click: transform scale(0.97) */
```

---

#### Job Detail Page

**Pipeline timeline node pulse** (active stage):
```css
@keyframes nodePulse {
  0%, 100% { box-shadow: 0 0 0 0 oklch(70% 0.16 200 / 0.5), 0 0 16px oklch(70% 0.16 200 / 0.25); }
  50% { box-shadow: 0 0 0 8px oklch(70% 0.16 200 / 0.12), 0 0 24px oklch(70% 0.16 200 / 0.4); }
}
/* duration: 2s, ease-in-out, infinite */
```

**Pipeline timeline fill bar**:
```tsx
// Animated via CSS transition on width property
// transition: width 0.8s var(--ease-out)
// Gradient: linear-gradient(to right, var(--success), var(--accent))
// box-shadow: 0 0 8px oklch(72% 0.18 148 / 0.5)
```

**Stream log line entrance**:
```tsx
const streamLine = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.3, ease: "easeOut" },
  },
};
```

**Stream live dot pulse**:
```css
@keyframes termPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
/* duration: 1.5s, ease-in-out, infinite */
```

**Code block line reveal**:
```tsx
const codeLineReveal = {
  hidden: { opacity: 0, x: -4 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
  },
};
// Stagger per line: 40ms
// e.g., line n delay = n * 40ms
```

**Code toggle expand/collapse**:
```tsx
// display toggle + class toggle for .reveal
// On expand: remove class, force reflow, add class
// Each .code-line inside gets staggered animation-delay via inline style
```

**Copy button morph**:
```tsx
// On click:
// 1. Add .copied class (background → var(--success), border-color → var(--success), color → var(--bg-base))
// 2. Add .animate-pop class (keyframes copyPop 0.35s)
// 3. Swap icon: copy-icon hidden, check-icon shown with scale(0) → scale(1)
// 4. After 2200ms: remove .copied and .animate-pop, restore label

const copyPop = {
  0:   { scale: 1 },
  30:  { scale: 1.25 },
  60:  { scale: 0.92 },
  100: { scale: 1 },
};
// duration: 0.35s, ease: [0.25, 0.1, 0.25, 1]
```

**Tab switch**:
```tsx
// Active tab: color var(--accent), font-weight 600
// Inactive: color var(--fg-muted)
// Transition: color 100ms
```

**Tab panel switch**:
```tsx
// Uses tabPanelFade variant (see Core Variants)
// On switch: remove .active from all panels, add to target
// Reset animation: panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = ''
```

**Modal backdrop**:
```tsx
// Backdrop: display flex, background rgba(0,0,0,0.7), backdrop-filter blur(6px)
// Modal content: box-shadow 0 30px 80px rgba(0,0,0,0.5)
// No Framer Motion needed for this modal
```

**Export dropdown**:
```tsx
// Simple display toggle
// Option hover: background var(--bg-hover), color var(--fg-primary)
// transition: background 100ms
```

**Toast**:
```tsx
// Uses toastSlide variant (see Core Variants)
// AnimatePresence for enter/exit
// Show for 2200ms then exit
```

---

#### Settings Page

**Sliding nav indicator**:
```tsx
// Pure CSS transition on top and height properties
// transition: top 0.3s var(--ease-out), height 0.3s var(--ease-out)
// Positioned absolutely behind active nav item
// Background: oklch(70% 0.16 200 / 0.08)
// Border: 1px solid oklch(70% 0.16 200 / 0.15)
// Backdrop-filter: blur(8px)
// On tab click: recalculate top = el.offsetTop + 2, height = el.offsetHeight - 4
```

**Tab panel fade**:
```tsx
// Uses tabPanelFade variant
// Reset animation on each switch (same technique as job detail)
```

**Usage bar fill**:
```tsx
// CSS transition on width
// transition: width 0.8s var(--ease-out)
// Color changes at thresholds: accent default, warn at >80%, danger at >95%
```

**Avatar ring**:
```css
@keyframes avatarRing {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
/* duration: 4s, linear, infinite */
/* Applied to ::after pseudo-element with gradient border technique */
```

**Input focus glow**:
```css
/* Same as auth pages */
/* box-shadow: 0 0 0 3px oklch(70% 0.16 200 / 0.12), 0 0 12px oklch(70% 0.16 200 / 0.08) */
```

---

#### Docs Page

**Endpoint expand/collapse**:
```tsx
// Chevron rotation: transform rotate(180deg), transition 150ms
// Body display toggle (no height animation, just display block/none)
// Header hover: background var(--bg-elevated), transition 100ms
```

**Code tab horizontal wipe indicator**:
```tsx
// Uses a ::after pseudo-element on .code-tabs
// transition: left 0.25s var(--ease-out), width 0.25s var(--ease-out)
// On tab click:
//   1. Remove .animate class, force reflow
//   2. Calculate newLeft = newTabRect.left - tabsRect.left
//   3. Set CSS vars --tab-indicator-left and --tab-indicator-width
//   4. Add .animate class
//   5. After 300ms, remove .animate class
```

**Code tab panel switch**:
```tsx
// Uses tabWipe variant (see Core Variants)
```

**Reading progress line**:
```tsx
// Pure JS on scroll event (passive listener)
// progressHeight = (scrollY / (docHeight - innerHeight)) * 100%
// Applied to .docs-progress-fill height
// transition: height 0.15s linear
// box-shadow on fill: 0 0 6px oklch(70% 0.16 200 / 0.4)
```

**Copy button**:
```tsx
// Same as job detail copy button
```

---

### Reduced Motion

All Framer Motion animations must respect `prefers-reduced-motion`:
```tsx
const shouldReduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// In variants, set duration to 0 when reduced motion is preferred
const fadeUp = {
  hidden: { opacity: shouldReduceMotion ? 1 : 0, y: shouldReduceMotion ? 0 : 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: shouldReduceMotion ? 0 : 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};
```

For CSS keyframe animations:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

### Animation Component Inventory

| Component | Source | Animation Type | Tech |
|-----------|--------|----------------|------|
| `FadeUp` | Reusable wrapper | Entrance (y + opacity) | Framer Motion `motion.div` + `whileInView` |
| `FadeUpStagger` | Parent wrapper | Staggered children | Framer Motion `staggerChildren` |
| `TerminalTypewriter` | Landing hero | Character-by-character typing | `useEffect` + `setInterval` (38ms) |
| `PipelinePulse` | Landing + Job detail | Active dot glow | CSS `@keyframes` |
| `PipelineConnector` | Landing | Stage connector fill | CSS class toggle + `transition` |
| `AuthMesh` | Login/Signup | Drifting gradient canvas | Raw `<canvas>` + `requestAnimationFrame` |
| `GridCanvas` | Landing | Grid + particles | Raw `<canvas>` + `requestAnimationFrame` |
| `StatRing` | Dashboard | SVG stroke-dashoffset | CSS `@keyframes` (2s) |
| `StatRingPulse` | Dashboard | Ongoing breathing | CSS `@keyframes` (3s infinite) |
| `CountUp` | Dashboard | Number increment | `requestAnimationFrame` (1800ms) |
| `MagneticHover` | Jobs | Inner content follows cursor | `onMouseMove` + inline transform |
| `StreamLine` | Job detail | Fade-in per line | Framer Motion `motion.div` |
| `CodeLineReveal` | Job detail | Staggered line reveal | CSS `animation-delay` per line (40ms stagger) |
| `TabIndicator` | Docs | Sliding underline | CSS `::after` + CSS vars + `transition` |
| `CopyButton` | Job detail + Docs | Icon swap + pop | CSS class toggle + `@keyframes copyPop` |
| `Toast` | Job detail | Slide up/down | Framer Motion `AnimatePresence` + `toastSlide` |
| `NavIndicator` | Settings | Sliding glass pill | CSS `transition` on `top`/`height` |
| `ReadingProgress` | Docs | Sidebar fill | JS scroll listener + CSS `transition` |
| `PageTransition` | All routes | Fade on route change | Framer Motion `AnimatePresence` + `motion.div` |

## Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| > 1100px | Full sidebar, 4-column grids, split auth layout |
| 900px–1100px | 2-column grids, sidebar still visible |
| < 900px | Collapsible sidebar (hamburger), main content full width, reduced padding |
| < 640px | Single column layouts, mobile auth (no brand panel), compact spacing |

## File Structure

```
clients/portal/src/
├── app/
│   ├── (auth)/
│   │   ├── layout.tsx          # Split layout with mesh
│   │   ├── login/
│   │   │   └── page.tsx        # Login form
│   │   └── signup/
│   │       └── page.tsx        # Signup form
│   ├── (marketing)/
│   │   ├── layout.tsx          # Nav + footer
│   │   └── page.tsx            # Landing page
│   ├── (portal)/
│   │   ├── layout.tsx          # Sidebar + header
│   │   ├── dashboard/
│   │   │   └── page.tsx        # Dashboard
│   │   ├── jobs/
│   │   │   ├── page.tsx        # Job list
│   │   │   └── [job_id]/
│   │   │       └── page.tsx    # Job detail
│   │   └── settings/
│   │       └── page.tsx        # Settings (vertical tabs)
│   ├── (docs)/
│   │   ├── layout.tsx          # Docs sidebar + header
│   │   └── page.tsx            # API documentation
│   ├── globals.css             # Design tokens + base styles
│   └── layout.tsx              # Root layout with fonts
├── components/
│   ├── ui/                     # Core UI components
│   │   ├── button.tsx
│   │   ├── badge.tsx
│   │   ├── input.tsx
│   │   ├── card.tsx
│   │   ├── code-block.tsx
│   │   ├── tag.tsx
│   │   ├── table.tsx
│   │   ├── stat-card.tsx
│   │   ├── pipeline.tsx
│   │   ├── stream-log.tsx
│   │   ├── section-header.tsx
│   │   ├── tabs.tsx
│   │   ├── copy-button.tsx
│   │   └── nav-item.tsx
│   ├── brand/                  # Brand/layout components
│   │   ├── page-header.tsx
│   │   ├── sidebar.tsx
│   │   ├── auth-card.tsx
│   │   └── footer.tsx
│   ├── animations/             # Framer Motion wrappers
│   │   ├── fade-up.tsx
│   │   ├── page-transition.tsx
│   │   ├── auth-mesh.tsx
│   │   └── terminal-typewriter.tsx
│   ├── landing/                # Landing page sections
│   │   ├── hero.tsx
│   │   ├── features.tsx
│   │   ├── how-it-works.tsx
│   │   └── cta.tsx
│   ├── dashboard/              # Dashboard components
│   ├── jobs/                   # Job list/detail components
│   ├── settings/               # Settings components
│   └── docs/                   # Docs components
├── hooks/
│   ├── use-auth.tsx            # Existing (preserve)
│   ├── use-org.tsx             # Existing (preserve)
│   ├── use-job-stream.ts       # Existing (preserve)
│   └── use-scroll-progress.ts  # New
├── lib/
│   ├── api.ts                  # Existing (preserve)
│   ├── types.ts                # Existing (preserve)
│   └── utils.ts                # Existing (preserve)
└── public/
    └── (assets if needed)
```

## Dependencies to Add

```json
{
  "dependencies": {
    "geist": "^1.3.0",
    "framer-motion": "^12.0.0"
  }
}
```

Remove unused shadcn/ui dependencies if they conflict with the new design system.

## Implementation Phases

### Phase 1: Foundation
1. Install Geist font package and Framer Motion.
2. Replace `globals.css` with design tokens.
3. Update root `layout.tsx` with Geist font configuration.
4. Build core UI components (Button, Badge, Input, Card, Tag).
5. Build layout components (Sidebar, PageHeader, AuthCard).

### Phase 2: Auth & Marketing
1. Build auth split layout with mesh canvas.
2. Port login and signup forms with floating labels.
3. Build landing page with all sections and animations.

### Phase 3: App Shell & Dashboard
1. Build portal layout with sidebar navigation.
2. Port dashboard page with stat cards and bento grid.
3. Wire dashboard to real data hooks.

### Phase 4: Jobs
1. Port jobs list page with filters and pagination.
2. Port job detail page with pipeline and stream log.
3. Wire job stream SSE to UI.

### Phase 5: Settings & Docs
1. Port settings page with vertical tabs.
2. Port docs page with interactive endpoint cards.
3. Wire settings to real API endpoints.

### Phase 6: Polish
1. Add all Framer Motion animations.
2. Test responsive behavior at all breakpoints.
3. Verify data flow and error states.
4. Clean up removed pages and unused components.

## Quality Checklist

- [ ] All pages match the design HTML pixel-for-pixel (layout, colors, typography)
- [ ] All animations from the design are implemented
- [ ] All data hooks are properly wired
- [ ] Responsive at 360px, 640px, 900px, 1100px, 1440px, 1920px
- [ ] No horizontal overflow on any viewport
- [ ] Accessibility: focus states, aria labels, semantic HTML
- [ ] Reduced motion preferences respected
- [ ] TypeScript types correct throughout
- [ ] No console errors
- [ ] Build passes without errors
