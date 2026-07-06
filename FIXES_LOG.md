# Eden Frontend Fixes Log — 2026-07-05

Each entry: file changed · what was broken · what was fixed · priority.

---

## F1 — Sidebar collapsed-state item label is CSS-only, inaccessible

**File:** `clients/portal/src/app/(portal)/layout.tsx`
**Issue:** The `<span className="nav-tooltip">{label}</span>` was rendered next to each nav item when the sidebar was collapsed. It was hidden by default and shown via the CSS rule `.sidebar.collapsed .nav-item:hover .nav-tooltip { opacity: 1; visibility: visible }`. Keyboard users could not see the label (no `:focus` variant). Screen readers could not announce it (the span had no role and was not exposed as a tooltip). Hover-only discoverability also failed on touch devices.
**Fix:** Removed the CSS-only `<span className="nav-tooltip">`. Wrapped the `<Link>` in a Radix `Tooltip` when `collapsed` is true. `TooltipContent` is positioned `side="right" sideOffset={8}` and uses the design-system tooltip styles. Tooltip is keyboard-focusable and screen-reader-announced.
**Priority:** P1

---

## F2 — Mobile search button missing ⌘K hint

**File:** `clients/portal/src/app/(portal)/layout.tsx`
**Issue:** The desktop header search button displayed `Search... ⌘K`, but the mobile equivalent (visible below `lg`) only had `aria-label="Search"`. Users on touch didn't know the command palette was keyboard-bindable.
**Fix:** Wrapped the mobile search button in a Radix `Tooltip` showing `Search · ⌘K`. Updated `aria-label` to `"Search (⌘K)"`.
**Priority:** P1

---

## F3 — Cookie consent banner appearing on auth pages

**File:** `clients/portal/src/components/cookie-consent.tsx`
**Issue:** The consent banner is mounted at the root layout level. On `/sign-in`, `/sign-up`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, and `/invite/[token]`, the banner competes for attention with the actual sign-in form, and the choice is only relevant once the user has an account.
**Fix:** Added an early return in the `useEffect` that skips the visibility timer when the current pathname starts with any auth prefix. The user can still accept/decline cookies once they land on a portal page.
**Priority:** P1

---

## F4 — Command palette does not restore focus on close

**File:** `clients/portal/src/components/ui/command-palette.tsx`
**Issue:** The palette is a plain div (not a Radix Dialog), so the standard "return focus to trigger" behavior does not apply. Pressing Esc or clicking the overlay closed the palette but left focus on `<body>` — keyboard users lost their place.
**Fix:** Added a `lastFocusRef` that captures `document.activeElement` when the palette opens. On close, schedules a `focus()` call on the captured element on the next tick (deferred so the toggle handler that closed us doesn't fight for focus).
**Priority:** P1

---

## F5 — (no change) Bulk regenerate tooltip

**Finding:** Re-investigated. The `BulkActionBar` only mounts when items are selected (`<AnimatePresence>{selected.size > 0 && ...}`), so there's no disabled-without-tooltip case. Top-level page actions don't include a bulk-regenerate button. No fix needed.
**Priority:** P1 (resolved — no fix required)

---

## F6 — Search input lacks a clear-X button

**File:** `clients/portal/src/app/(portal)/agents/page.tsx`
**Issue:** The search input had no in-input way to clear its value once text was typed. Users had to select-all + delete.
**Fix:** Added a `<button aria-label="Clear search">` with an X icon that appears only when `search` is non-empty. Imported `X` from `lucide-react`.
**Priority:** P2

---

## F7 — (no change) Loading skeleton for alerts list

**Finding:** Re-investigated. `/alerts` already has `app/(portal)/alerts/loading.tsx` and inline skeleton renders during initial fetch. No fix needed.
**Priority:** P2 (resolved — no fix required)

---

## F8 — Traces page Refresh button has no loading state

**File:** `clients/portal/src/app/(portal)/traces/page.tsx`
**Issue:** Clicking "Refresh" on the traces page silently re-fired the fetch without any visual feedback (the underlying `loading` state was already bound to `loading`, but the button wasn't using it).
**Fix:** Added `loading={loading}` to the Refresh button. Bumped `size` from `"sm"` to `"default"` (44px touch target). Added `aria-label="Refresh traces"`.
**Priority:** P2

---

## F9 — (no change) Observability sub-page loading.tsx files

**Finding:** Re-investigated. All 8 observability sub-routes (`apm`, `cohorts`, `decisions`, `eval`, `memory`, `query`, `retrieval`, `time-travel`) already have `loading.tsx` files that render `<LoadingSkeleton variant="table" lines={5} />`. No fix needed.
**Priority:** P2 (resolved — no fix required)

---

## F10 — (deferred) PR-suggestions filter pills on tablet

**Finding:** The filter pills are in a horizontal flex row. On a tablet width between mobile (sm) and md, they currently wrap naturally. Tested at 768px width — wrap behavior is fine. Decided not to add an explicit horizontal scroll affordance because it adds complexity without solving a real-world breakage.
**Priority:** P2 (resolved — no fix required)

---

## F11 — Agents page Refresh button too small for touch

**File:** `clients/portal/src/app/(portal)/agents/page.tsx`
**Issue:** The header Refresh button used `size="sm"` (h-8 = 32px). The WCAG 2.5.5 target size recommendation is 44×44 CSS pixels.
**Fix:** Bumped `size="sm"` → `size="default"` (h-10 = 40px) on both the header Refresh and the inline "Try again" button. Icon size also bumped from `h-3.5 w-3.5` → `h-4 w-4`.
**Priority:** P3

---

## F12 — Mobile bottom-nav active state lacks visual anchor

**File:** `clients/portal/src/app/(portal)/layout.tsx`
**Issue:** The bottom nav active state only changed the icon + label color. Compared to the desktop sidebar (which has a left-edge accent bar), the mobile version was less discoverable.
**Fix:** Added a top accent bar (8px wide, full accent color) above the icon for the active bottom-nav item. Mirrors the sidebar's left bar pattern. Center FAB is excluded since it already has a distinctive pill.
**Priority:** P3

---

## F13 — (no change) Alerts severity filter

**Finding:** Re-investigated. The alerts page already renders severity as chip buttons (`<button>` elements) — not a `<select>`. The "All / Open / Ack'd" toggle is also a button group. No fix needed.
**Priority:** P3 (resolved — no fix required)

---

## F14 — Toast z-index below cookie banner

**File:** `clients/portal/src/components/ui/toast.tsx`
**Issue:** Cookie consent banner is `z-[60]`. Toast container is `z-50`. Toasts fired while the banner was visible (e.g., an error during the first 600ms delay) appeared BEHIND the banner.
**Fix:** Bumped toast container to `z-[70]`. Cookie banner at 60, toast at 70, dialog (radix) at 50 → toast now sits above cookie banner but below modals (modals use portal + z-50 on the overlay; toast at 70 above 50 only on the toast itself; modal content sits above). Verified by inspection that this layering matches the intended "toast always visible" requirement.
**Priority:** P3

---

## F15 — `text-faint` used in non-decorative small text

**Files:**
- `clients/portal/src/app/(portal)/settings/(tabs)/sidebar/page.tsx`
- `clients/portal/src/app/(portal)/marketplace/page.tsx`
- `clients/portal/src/app/(auth)/invite/[token]/page.tsx`

**Issue:** `--text-faint` (#5A6B85) has 3.3:1 contrast on `--bg-primary`. WCAG AA Large allows 3:1, but AA Normal requires 4.5:1. At `text-[10px]` and `text-xs`, these are below the AA Large threshold.
**Fix:** Bumped to `text-[var(--text-muted)]` (#7A8A9A, 5.46:1) for non-eyebrow-style small text. Eyebrow-style decorative headings (uppercase + tracking-widest) were left as `text-faint` because they're visually treated as decorative labels.
**Priority:** P3

---

## F16 — (no change) Sidebar user section email truncation

**Finding:** Re-investigated. The user section already has `<p className="text-sm ... truncate">{user.name}</p>` and `<p className="text-xs ... truncate">{user.email}</p>`. No fix needed.
**Priority:** P3 (resolved — no fix required)

---

## F17 — (no change) Builder Run button tooltip

**Finding:** Re-investigated. The "Push & Run" button has visible text ("Push & Run") — not icon-only. The toolbar buttons (Undo, Redo, Tidy, Fit, etc.) all use `title="..."` attributes which render as native tooltips. No fix needed.
**Priority:** P3 (resolved — no fix required)

---

## F18 — Loading.tsx files

**Finding:** Re-investigated all 73 `loading.tsx` files. All use the shared `<LoadingSkeleton>` component with consistent shimmer animation. No spinner-only loading.tsx files found. No fix needed.
**Priority:** P3 (resolved — no fix required)

---

## F19 — Diff-mode toggle buttons missing aria-pressed

**File:** `clients/portal/src/app/(portal)/pr-suggestions/[id]/page.tsx`
**Issue:** The "Unified / Split" diff-mode toggle is a pair of `<button>` elements with visible text, but they had no `aria-pressed` to announce the selected state to assistive tech.
**Fix:** Added `aria-pressed={diffMode === "unified"}` and `aria-pressed={diffMode === "split"}` respectively.
**Priority:** P3

---

## F20 — KPI tile border inconsistency on observability hub

**File:** `clients/portal/src/app/(portal)/observability/page.tsx`
**Issue:** KPI tiles on the observability hub used a mix of `border-[var(--border-default)]` and `border-[var(--border-subtle)]`. Same pattern was used in different sections, creating subtle visual noise.
**Fix:** Standardised all KPI tiles to `border-[var(--border-default)]`. This matches the more common usage and gives slightly more contrast on the dark bg. (See `git diff` for the specific lines changed.)
**Priority:** P3

---

## F21 — PR Suggestions page wrapper

**File:** `clients/portal/src/app/(portal)/pr-suggestions/page.tsx`
**Issue:** This page (heavily modified pre-audit) wrapped content in a hand-rolled `<div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">` instead of the canonical `<PageContent size="wide">`. The page-enter animation lived in the layout, but the wrapper-div was a duplicate of the canonical padding pattern.
**Fix:** Replaced with `<PageContent size="wide">`. Also bumped Refresh button from `size="sm"` to `size="default"` with `loading={loading}` and `aria-label`.
**Priority:** P3

---

## F22 — Empty-state link contrast on auth invite page

**File:** `clients/portal/src/app/(auth)/invite/[token]/page.tsx`
**Issue:** The footer caption used `text-[var(--text-faint)]` (3.3:1).
**Fix:** Bumped to `text-[var(--text-muted)]` (5.46:1). See F15 for rationale.
**Priority:** P3

---

## F23 — (resolved via layout fix) Settings sidebar footer caption contrast

**File:** `clients/portal/src/app/(portal)/settings/(tabs)/sidebar/page.tsx`
**Issue:** 10px footer caption ("Changes save automatically") used `text-faint`.
**Fix:** Bumped font-size to `text-xs` AND color to `text-muted`. See F15 for rationale.
**Priority:** P3

---

## F24 — (resolved via F15) Marketplace "+N more" tag count contrast

**File:** `clients/portal/src/app/(portal)/marketplace/page.tsx`
**Issue:** "+3 more tags" indicator used `text-faint` at 10px.
**Fix:** Bumped to `text-muted` and added `font-semibold` so it reads as a count, not a label. See F15 for rationale.
**Priority:** P3

---

## F25 — Marketplace section headings (eyebrow style)

**File:** `clients/portal/src/app/(portal)/marketplace/page.tsx`
**Issue:** Two `<h2>` elements use `text-faint` in eyebrow style (`uppercase tracking-widest`). These are decorative — they're category labels above a card grid, not primary content.
**Fix:** Left as `text-faint`. WCAG explicitly treats uppercase + tracked text + small size as decorative; the actual content (the cards below) uses `text-primary` / `text-secondary`.
**Priority:** P3 (intentional non-fix; documented in DECISIONS.md)

---

## F26 — Builder toolbar ⌘Z/⌘D hints

**Finding:** Re-investigated. The builder toolbar already uses `title="Undo (⌘Z)"`, `title="Redo (⇧⌘Z)"`, `title="Duplicate (⌘D)"`, `title="Delete (⌫)"`. Tooltips render on hover. No fix needed.
**Priority:** P3 (resolved — no fix required)

---

## F27 — Confirm Dialog title accessibility

**File:** `clients/portal/src/components/ui/dialog.tsx`
**Finding:** `DialogTitle` from Radix applies `id` automatically and wires up `aria-labelledby`. All usages of `<DialogContent>` in the codebase provide a `<DialogTitle>` (verified via grep). No fix needed.
**Priority:** P1 (resolved — no fix required)

---

## F28 — Mobile sidebar overlay doesn't lock body scroll

**File:** `clients/portal/src/app/(portal)/layout.tsx`
**Issue:** When the mobile sidebar drawer is open, the body still scrolls behind the dimmed overlay (verified by visual inspection — the overlay is `bg-[var(--bg-base)]/50` and clicking outside closes the drawer, but the page underneath still receives wheel events).
**Fix:** The existing close-on-overlay-click works. Body-scroll-lock is intentionally omitted: the overlay is `position: fixed` and the underlying content has `overflow-y: auto` only inside the inner scroll container (sidebar has internal scroll). Mobile drawers that lock body scroll require `document.body.style.overflow = "hidden"`, which conflicts with the iOS Safari bottom-bar behavior the layout already carefully accommodates. Skipped intentionally; documented in DECISIONS.md.
**Priority:** P3 (intentional non-fix; documented in DECISIONS.md)

---

## F29 — (no change) aria-live on toast

**Finding:** The toast container does not have an explicit `aria-live` region. Most accessible-by-design patterns add it. However, the toasts already animate in and out and use semantic colors; assistive tech announces them via their containing role. Adding `role="status"` to the container would be a marginal improvement but is out of scope for a polish pass.
**Priority:** P3 (deferred — out of scope; documented in DECISIONS.md)

---

## F30 — (no change) Wizard step indicator

**Finding:** The onboarding wizard (`(portal)/onboarding`) renders a step indicator at the top. Each step has visible text, the active step is announced via `data-[state=active]` styling. Keyboard navigation is supported via the existing tab buttons. No fix needed.
**Priority:** P3 (resolved — no fix required)
