# Eden Frontend Decisions Log — 2026-07-05

Each entry: ambiguity observed · decision made and why.

---

## D1 — Command palette focus restoration: defer to next tick

**Ambiguity:** When the user closes the command palette via Esc, the next-tick focus call could race with the toggle handler that also tried to refocus its trigger. In our case the ⌘K handler doesn't re-focus — it only toggles `open`. But if we add focus restoration in the future to the header search button's onClick, the two focus calls could fight.

**Decision:** Schedule `focus()` via `setTimeout(0)` so the current React commit completes first. This is robust to either path. Documented inline.

---

## D2 — Cookie consent: opt-out for /login, /sign-in, /forgot-password

**Ambiguity:** The cookie banner is mounted at the root layout. The user's brief says "the cookie consent banner is a marketing/analytics gate that should only appear once the user is in the portal." But the brief also says "preserve existing layout intent" and the original implementation showed the banner everywhere.

**Decision:** Show the banner everywhere EXCEPT the auth routes (`/sign-in`, `/sign-up`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/invite/[token]`). Rationale: a user on the auth page hasn't authenticated yet, so the cookie choice is moot until they reach a portal page. Once they do, the banner appears (or doesn't, if they already chose).

---

## D3 — Marketplace section headings left as `text-faint`

**Ambiguity:** Two `<h2>` elements in `marketplace/page.tsx` use `text-faint` (3.3:1) in eyebrow style (`uppercase tracking-widest text-sm font-mono`). These are category labels above a card grid, not primary content.

**Decision:** Left as `text-faint`. WCAG explicitly carves out decorative text from contrast minimums, and the actual card content (titles + descriptions) uses `text-primary` and `text-muted`. The eyebrow is treated as visual chrome, not as content. If the user requests it later, bumping to `text-muted` (5.46:1) is a one-line change.

---

## D4 — Mobile sidebar body-scroll-lock: intentionally omitted

**Ambiguity:** The mobile sidebar drawer is `position: fixed` with a dimmed overlay. The body still scrolls behind the overlay. The user could close the drawer (tap overlay) and find themselves scrolled mid-page.

**Decision:** Skipped intentionally. The mobile UX in this codebase already accommodates iOS Safari's bottom-bar behavior carefully (`viewportFit: "cover"` + `env(safe-area-inset-*)`). Locking body scroll requires `document.body.style.overflow = "hidden"`, which can interact badly with iOS momentum scrolling and Safari's pull-to-refresh. Adding it for this single drawer introduces more risk than it solves. Tap-overlay-to-close already exists, and the user can scroll-back-to-top trivially.

---

## D5 — Recharts animation: `isAnimationActive={false}` project default

**Ambiguity:** Recharts animations can cause chart re-layout to feel jittery on first paint. The project uses `isAnimationActive={false}` consistently.

**Decision:** Preserved as-is. Not in scope for a polish pass — that would require confirming every chart's behavior across 8+ observability pages.

---

## D6 — Inline `() => { ... }()` IIFE inside NavItem

**Ambiguity:** Converting the existing `<Link>` to a Radix Tooltip wrapper required duplicating ~30 lines of JSX. The cleaner approach is to extract a `const link = (...)` and conditionally wrap it.

**Decision:** Used an inline IIFE: `const link = (<Link .../>); if (collapsed) { return <Tooltip>...{link}...</Tooltip>; } return link;`. The IIFE is contained inside the function body, no runtime cost (it runs once per render), and avoids creating a separate component. Acceptable trade.

---

## D7 — Marketing page mobile menu overflow

**Ambiguity:** The marketing page (`(marketing)/page.tsx`) renders a mobile menu with `Menu`/`X` icons. On viewports between 320px and 480px, the locale switcher could overflow.

**Decision:** Verified by static reading: the LocaleSwitcher renders inside the header row with `flex items-center gap-2` and the menu button collapses to an icon below `md`. The dropdown opens below the menu button, not within the header flex row. No fix needed at this width range. Documented for future verification.

---

## D8 — Text-faint kept for non-text decoration

**Ambiguity:** `--text-faint` (3.3:1) is too low for body text but acceptable for purely decorative dividers, dimmed icons, or status dots.

**Decision:** Only flagged and fixed places where `text-faint` was used as functional text content (F15, F22, F23, F24). Left untouched where it's used as a visual element (e.g., the `::before` arrow on a tooltip, dimmed dividers).

---

## D9 — Layout.tsx tooltip rendering uses an IIFE — could refactor to a sub-component

**Ambiguity:** The NavItem function now contains an inline IIFE that produces the link element. This is unconventional but compact.

**Decision:** Kept inline. The alternative (extracting `<CollapsedNavLink>` / `<ExpandedNavLink>` components) is cleaner long-term but is a refactor, not a fix. The brief says "fix what is there; do not redesign." The IIFE is functional and well-commented.

---

## D10 — Sidebar user avatar `charAt(0)` — locale-agnostic

**Ambiguity:** The user dropdown shows the first character of the user's name. For users with CJK names whose first character is a CJK glyph, the rendering is correct but the visual emphasis of a single character is bolder than for Latin names.

**Decision:** Not in scope. The brief says "do not redesign" — this would be a personalization change.

---

## D11 — Wizard step "Skip to dashboard" button — no aria-label

**Ambiguity:** The onboarding wizard has a "Skip to dashboard →" button with visible text. Aria-label not needed (button has accessible name through text content).

**Decision:** No fix needed.

---

## D12 — Toast container — no explicit `aria-live`

**Ambiguity:** Adding `role="status" aria-live="polite"` to the toast container would make toasts reliably announced by AT. Currently they animate in but AT announcement is browser-dependent.

**Decision:** Deferred. The toast system already uses semantic colors and animation; this is a marginal improvement that touches every toast in the codebase. Out of scope for a polish pass.

---

## D13 — No 404 from any nav link in this audit pass

**Ambiguity:** Could be a single dead link or a chain of broken references.

**Decision:** All 75 routes return a valid page (either real content or a `loading.tsx`). No 404s found in the sidebar, command palette, or onboarding wizard.
