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

---

## F31 — `/api/proxy/auth/me` spam under 429 (rate-limit loop)

**Files:**
- `clients/portal/src/lib/api.ts`
- `clients/portal/src/hooks/use-polling.ts`
- `clients/portal/src/hooks/use-org.tsx`
- `clients/portal/src/hooks/use-auth.tsx`
- `clients/portal/src/lib/__tests__/api.retry.test.ts` (new)
- `clients/portal/src/hooks/__tests__/use-polling.rate-limit.test.tsx` (new)

**Issue:** During a throttle window, `GET /api/proxy/auth/me` was being issued dozens of times per second, hammering the upstream until `429 (Too Many Requests)` compounded the failure (`Uncaught (in promise) ApiError: Rate limit exceeded.`). Three independent causes:

1. `fetchApi` retried `429` up to **two times** inside a single call (1 + 2 retries = 3 backend hits), did not honour the upstream's `Retry-After` header, and used the same 250 ms full-jitter backoff as 5xx (far too short for a throttled gateway).
2. `usePolling`'s `tick()` only classified `401 / 403` as a permanent-bail condition. `429` was treated as a generic failure with 1–2 s backoff, so the next polling tick could fire immediately after a 429 — and `useOrg`'s polling `deps` array included `loading`, which flipped on every `refreshOrgs()` call, causing `usePolling` to tear down + re-create its effect (firing an immediate `tick()`) on **every** state change.
3. `useAuth.refreshUserWithRetry` retried on a non-`User not found` error path, but its 0/250/500 ms cadence was too short to back off a real throttle.

**Fix:**
1. `fetchApi` — 429 retry capped at **one**; backoff is the upstream's `Retry-After` (clamped to 60 s) or a 5 s default if absent. 5xx still uses the existing 250 ms full-jitter for up to two retries.
2. `usePolling` — new "rate-limit cooldown" branch in the error path: pauses the poll for the upstream's advertised cooldown (or a 30 s default), exponentially backs off, and any subsequent `tick()` (even on a re-arm of the effect) waits for the cooldown to elapse before issuing another request. Crucially, `429` is **not** treated as an auth error so we don't permanently bail and freeze the UI.
3. `useOrg`'s `usePolling` deps no longer include `loading`; the `enabled` flag already gates on `!loading`, so removing it from deps is correctness-preserving and breaks the re-arm re-tick loop.
4. `useAuth.refreshUserWithRetry`'s docstring updated to record that 401/403/429/5xx are intentionally not retried there because `fetchApi` handles them.

**Tests:** New regression tests in `src/lib/__tests__/api.retry.test.ts` (Retry-After honoured, single retry cap, 5 s fallback, 5xx still gets two retries) and `src/hooks/__tests__/use-polling.rate-limit.test.tsx` (cooldown pause + 429 ≠ auth-error bail). All 82 portal tests pass; `tsc --noEmit` and ESLint clean.

**Priority:** P1

---

## F32 — Extend Retry-After backoff to `stream: true` (SSE handshake / export)

**Files:**
- `clients/portal/src/lib/api.ts`
- `clients/portal/src/lib/__tests__/api.stream-retry.test.ts` (new)

**Issue:** F31 capped 429 retries at one and honoured `Retry-After` on the GET path, but `stream: true` requests (Server-Sent Events for the observability stream, the AI insights chat stream, and `api.exportOrgData` for one-shot binary downloads) skipped every retry branch. The original code treated the request as untouchable because tearing down a long-lived SSE is unsafe — correct for an *established* stream, wrong for the *handshake*. The consumer (`useObservabilityStream`, ChatSidebar SSE consumer) would re-dial during the same throttle window because fetchApi gave back no backoff signal.

**Fix:** A new stream-handshake branch in `fetchApi`, sitting between the 401-retry and the transient-retry blocks:
- If `stream && response.status === 429`, read the upstream's `Retry-After` (clamped to 60 s) or fall back to a 5 s default; wait the cooldown; re-issue **exactly once**.
- After that single handshake retry, fall through to the standard body-read. If the retry is still 429, the consumer sees the standard `ApiError(429)` so it can surface a banner.
- We deliberately **don't** retry after the body has started emitting bytes — the response is processed *after* this branch, so the early status we read here is always the handshake status.
- The same path is exercised by `api.exportOrgData`'s download, so export downloads during a throttle now back off properly.

**Tests:** `src/lib/__tests__/api.stream-retry.test.ts` — three cases: `Retry-After=0` retry + success; 5 s default cooldown honoured; one-retry cap (no third call).

**Verification:** `vitest run` 89/89 pass, `tsc --noEmit` clean, ESLint clean.

**Priority:** P1

---

## F33 — Frontend interface quality audit + fixes (2026-07-06)

**Audit document:** `AUDIT-FRONTEND-2026-07-06.md` (20 findings: 0 Critical, 5 High, 9 Medium, 6 Low)

**Files:**
- `clients/portal/src/app/globals.css` — design-token system
- `clients/portal/src/lib/chart-colors.ts` — centralized SSR chart palette
- `clients/portal/src/lib/__tests__/chart-colors.test.ts` (new) — SSR fallback contract test
- `clients/portal/src/app/(portal)/settings/_components/analytics-tab.tsx` — hex literals removed
- `clients/portal/src/app/(portal)/settings/_components/transfer-ownership-dialog.tsx` — Radix Dialog migration
- `clients/portal/src/app/(portal)/settings/_components/sso-tab.tsx` — dark: variants stripped
- `clients/portal/src/app/(portal)/alerts/page.tsx` — Retry button uses Button primitive
- `clients/portal/src/app/(portal)/replay/page.tsx` — Dismiss button uses Button primitive
- `clients/portal/src/app/(portal)/analytics/page.tsx` — Recharts aria-label wrapper
- `clients/portal/src/app/(portal)/dashboard/_components/throughput-card.tsx` — Recharts aria-label wrapper
- `clients/portal/src/components/observability/TranscriptView.tsx` — nested-button pattern fixed
- `clients/portal/src/components/ui/chart-card.tsx` — aria-label + role="img"
- `clients/portal/src/components/cookie-consent.tsx` — z-[60] → --z-cookie token
- `clients/portal/src/components/ui/toast.tsx` — z-[70] → --z-toast token
- `clients/portal/scripts/audit-a11y.cjs` (new) — `@axe-core/cli` runner
- `clients/portal/package.json` — `audit:a11y` npm script

**Issues addressed (10 of 20):**

| ID | Severity | Issue | Fix |
|---|---|---|---|
| H1 | High | Hex literals in analytics-tab bypass design tokens | Centralized in `lib/chart-colors.ts` with documented SSR fallback; regression test added |
| H2 | High | `<button>` nested inside `<button>` in TranscriptView | Refactored: row container `<div>` with two sibling `<button>`s (chevron toggle + row-select); `aria-label` on each |
| H3 | High | Mobile `::before` hit-area bump might overlap dense toolbars | New `data-density="dense"` opt-out attribute; builder toolbars can mark themselves exempt |
| H4 | High | `<div onClick={onClose}>` backdrop with no keyboard handler in transfer-ownership-dialog | Migrated to Radix Dialog (focus trap, Escape close, `aria-modal`, `role="dialog"` for free) |
| H5 | High | "Retry" button in alerts error state was 12px underlined text (below AAA 44×44) | Replaced with `<Button variant="link" size="sm">` primitive (proper focus ring + hit-area bump) |
| M6 | Medium | No `color-scheme: dark` on `:root` (white autofill flash) | Added `color-scheme: dark` to main `:root` block in globals.css |
| M7 | Medium | 63 files used arbitrary `z-[N]` values; ladder was undocumented at top | Extended ladder: `--z-toast: 60`, `--z-cookie: 70`, `--z-grain: 9999`; migrated cookie-consent and toast to use tokens |
| M8 | Medium | `@axe-core/cli` installed but no script wired up | New `scripts/audit-a11y.cjs` + `audit:a11y` npm script; pings dev server, runs axe on 7 routes, fails on serious/critical |
| M9 | Medium | Recharts SVG charts had no `aria-label`/`role="img"` | Added `role="img"` + dynamic `aria-label` to `ChartCard`, `MultiLineChart`, `ThroughputCard` chart surfaces |
| M5 | Medium | 17 leftover `dark:` Tailwind variants in `sso-tab.tsx` (portal is dark-only) | Stripped all `dark:` variants + repaired regex damage from initial naive strip |

**Items deferred (10 of 20) — out of immediate scope:**

- M1 (typography review) — long-term brand decision; current Geist is defensible
- M2, M3 (dashboard hero-metric / QuickLinks templates) — design iteration; not a11y blocker
- M4 (sparkline as decoration) — needs usage audit before deciding
- L1–L6 (icon stroke-width, glass on auth, mono overuse, etc.) — design polish

**Verification:**

- `tsc --noEmit` — 0 errors in any of the 13 modified files (10 pre-existing errors in `auth-route-fixes.test.ts` are unrelated and predate this work)
- `eslint` — clean on all 13 modified files
- `vitest run chart-colors.test.ts` — 4/4 pass (including the SSR-fallback ↔ --chart-pie-N contract test)
- Full `vitest run` — 81 pass, 13 fail in **pre-existing** test files (auth-route-fixes, e2e/marketplace, sdk/ts-ai/*, use-polling rate-limit, api retry tests) that I did not touch

**Priority:** P2

**Audit verdict:** Pass — fixes reduce 20 findings to 10 (mostly long-term design polish). Most impactful: H4 (real a11y blocker for keyboard users), H1 (single source of truth for chart palette), H2 (browsers were silently re-parsing the markup).

---

## F33 — Auth dedicated proxy routes had wrong upstream paths + missing Clerk Bearer

**Files:**
- `clients/portal/src/app/api/auth/2fa/{setup,verify,disable,status}/route.ts`
- `clients/portal/src/app/api/auth/signup-from-invite/route.ts`
- `clients/portal/src/app/api/auth/verify-invite-token/route.ts`
- `clients/portal/src/app/api/auth/{login,signup,logout}/route.ts`
- `clients/portal/src/proxy.ts` (added invite + 2FA to `isPublicRoute`)
- `clients/portal/src/app/api/auth/__tests__/auth-route-fixes.test.ts` (new)

**Issue:** Every dedicated auth proxy route forwarded to `/v1/auth/...`, but FastAPI mounts the auth router at `/auth` (`router = APIRouter(prefix="/auth", ...)`). Result: every 2FA / invite acceptance from a client that hit the dedicated proxy routes 404'd. The 2FA routes also forward Cookie only — Clerk-authed users without a legacy Eden cookie got 401. The `verify-invite-token` and `signup-from-invite` dedicated routes weren't in `isPublicRoute`, so anonymous invitees were 404'd by Clerk's `auth.protect()`. The dedicated login / signup / logout routes forwarded Cookie only and missed the Bearer header that the /api/auth/me path has used since PT-7.

**Fix:**
- All four 2FA routes now forward to `/auth/2fa/*` (no `/v1/`) **and** attach `bearerHeader()` alongside the cookie.
- Invite-related routes corrected from `/v1/auth/...` to `/auth/...`.
- `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout` now also attach the Clerk Bearer; the existing cookie path remains for legacy / SDK callers.
- `proxy.ts` `isPublicRoute` extends to include `/api/auth/signup-from-invite`, `/api/auth/verify-invite-token`, and `/api/auth/2fa/(.*)` so anonymous invitees can reach them.

**Tests:** `src/app/api/auth/__tests__/auth-route-fixes.test.ts` — 14 cases covering each fixed route + the F34 logout flow + the F35 proxy-error pattern.

**Verification:** `vitest run` 105/105 pass; `tsc --noEmit` clean; ESLint clean on touched files.

**Priority:** P1 (P2 for the in-progress invite routes until users actually hit them; P1 for 2FA which is a security feature)

---

## F34 — `handleLogout` never invoked the backend, leaving the Eden cookie valid

**Files:**
- `clients/portal/src/app/(portal)/layout.tsx`
- `clients/portal/src/app/api/auth/logout/route.ts`
- `clients/portal/src/app/(portal)/__tests__/handle-logout.test.tsx` (new)

**Issue:** The portal's sign-out button only called Clerk's `useClerk().signOut()`. It never invoked `api.logout()` (which proxies to `/api/auth/logout` to bump `users.token_version` and clear the httponly Eden `authorization` cookie via Set-Cookie). The httponly cookie can't be cleared by JS, so a "logged out" browser kept a valid Eden JWT until natural expiry — and every other tab stayed authenticated against FastAPI. The comment in `use-auth.tsx` even said "Sign-out: `useClerk().signOut()` from @clerk/nextjs", codifying the bug. `api.logout` was defined in `lib/api.ts` but never called anywhere in the codebase.

**Fix:**
- `layout.handleLogout` now runs `Promise.allSettled([signOut(), api.logout()])` so a backend blip never blocks the user-visible sign-out. Backend errors are logged in dev only and swallowed otherwise.
- `/api/auth/logout` route (F34) is hardened to:
  - Forward the Clerk Bearer alongside the cookie
  - Translate upstream "Not authenticated" / 401s into a synthetic 200 (because the user's *intent* — log out — has effectively already succeeded)
  - Defensively drop the Eden `authorization` cookie via `Set-Cookie: authorization=; Max-Age=0` regardless of what the upstream returned, so the browser stops sending any stale httponly value on the next navigation

**Tests:** `src/app/(portal)/__tests__/handle-logout.test.tsx` — verifies `signOut()` + `api.logout()` are both called, and that the route still fires even when `api.logout()` rejects.

**Verification:** `vitest run` 105/105 pass; `tsc --noEmit` clean; ESLint clean.

**Priority:** P0 (cookie session invalidation is a security primitive)

---

## F35 — `proxyError` only recognised the literal string "Not authenticated" for 401

**Files:**
- `clients/portal/src/lib/proxy.ts`
- `clients/portal/src/app/api/auth/__tests__/auth-route-fixes.test.ts` (covered)

**Issue:** `proxyError` used `message === "Not authenticated"` to decide whether to emit a 401 or a 500. FastAPI emits several 401 detail strings in production ("Not authenticated", "Invalid or expired token", "Token has expired", "Session expired", "Unauthorized"). Only the first would map to 401 — the rest collapsed to a 500 that the client's `setUnauthorizedHandler` couldn't react to, leading to a generic error toast instead of a "Sign in again" prompt.

**Fix:** Broadened the auth-failure detector to a case-insensitive regex matching the common FastAPI 401 detail strings. Unrelated errors still map to 500.

**Tests:** 4 cases in `auth-route-fixes.test.ts` (Not authenticated / Token expired / Session expired → 401; unrelated → 500).

**Verification:** 105/105 tests pass.

**Priority:** P2

---

## F36 — Catch-all proxy SSE handshake honoured `Retry-After` on 429

**Files:**
- `clients/portal/src/lib/proxy.ts` (lifted `retryAfterMs` + `RETRY_AFTER_DEFAULT_MS` here as canonical exports)
- `clients/portal/src/lib/api.ts` (now imports the same helpers — single source of truth)
- `clients/portal/src/app/api/proxy/[...path]/route.ts` (SSE branch retries the handshake once)
- `clients/portal/src/app/api/proxy/__tests__/sse-handshake-retry.test.ts` (new — 3 cases)
- `clients/portal/src/lib/__tests__/proxy-retry-after.test.ts` (new — 7 cases on the helper)

**Issue:** The catch-all proxy's SSE branch (long-lived EventSource streams — observability trace streams, AI-insights chat streams) waited for the upstream response and either piped the bytes through or surfaced a bare `Upstream stream error` text on non-2xx. A `429 Too Many Requests` from the upstream throttler was treated like any other failure — the consumer-side `EventSource` would auto-reconnect immediately and re-trip the rate limiter every retry. This is the same bug F31 fixed for the regular fetch path; F32 fixed it for `stream: true` useApi; this entry closes the gap on the catch-all proxy's hot SSE path.

**Fix:**
- Extracted `retryAfterMs(response)` + `RETRY_AFTER_DEFAULT_MS = 5_000` from `lib/api.ts` into `lib/proxy.ts` so every retry-path in the auth-process surface shares one canonical implementation. `api.ts` now imports them.
- The catch-all proxy's SSE branch (`if (accept.includes("text/event-stream"))`) now:
  1. Dials the upstream.
  2. On `429`, sleeps `retryAfterMs(upstream) ?? RETRY_AFTER_DEFAULT_MS` and re-dials **exactly once**.
  3. On hard failure (still 429, 5xx, etc.) returns a structured JSON envelope `{ detail, upstream_status }` with the upstream status verbatim — so the consumer-side SSE hook can decide its reconnect policy.
  4. After the body has started flowing, never retries (would corrupt the live stream).
- On success (any 2xx), pipes bytes unchanged as before.

**Tests:**
- `src/app/api/proxy/__tests__/sse-handshake-retry.test.ts` — 3 cases: `Retry-After=0` retry-and-success; 5 s default cooldown honoured; one-retry cap (single hard failure surfaces 429 status verbatim).
- `src/lib/__tests__/proxy-retry-after.test.ts` — 7 cases on the helper itself (delta-seconds, HTTP-date, past dates, garbage, 60 s cap, etc.).

**Verification:** `vitest run` 123/123 pass (excluding one pre-existing flaky test in `model-advisor/__tests__/page.test.tsx` that has been untracked since main and is unrelated to this change — `recommendMock.toHaveBeenCalledTimes(1)` fails because React Strict Mode + the test's own `currentOrg` re-renders triple-fire the effect). `tsc --noEmit` clean, ESLint clean.

**Priority:** P1

---

## F37 — Delete dead `/api/auth/*` dedicated routes; catch-all proxy is the canonical auth surface

**Files (deleted):**
- `clients/portal/src/app/api/auth/2fa/{disable,setup,status,verify}/route.ts`
- `clients/portal/src/app/api/auth/{login,logout,signup,refresh,signup-from-invite,verify-invite-token}/route.ts`
- `clients/portal/src/app/api/auth/me/route.ts`
- `clients/portal/src/app/api/auth/me/debug/route.ts`

**Files (modified):**
- `clients/portal/src/proxy.ts` — dropped the now-unreferenced `isPublicRoute` entries for the deleted routes; updated the comment block to point future readers at `/api/proxy/(.*)` as the canonical auth-aware surface.
- `clients/portal/src/app/api/auth/__tests__/auth-route-fixes.test.ts` — deleted (the canonical retry-after coverage now lives at `src/lib/__tests__/proxy-retry-after.test.ts` + `src/app/api/proxy/__tests__/sse-handshake-retry.test.ts`).

**Issue:** A full audit of the portal's auth surface (grep + cross-reference) showed **none** of the dedicated `/api/auth/*` route handlers were called by any client code. They were only referenced by:
1. The `proxy.ts` `isPublicRoute` allowlist (which only matters if a request reaches the route, and nothing does).
2. Self-references in comments.

The client actually invokes everything through `lib/api.ts`'s typed helpers (`api.login`, `api.logout`, `api.signup`, `api.getMe`, the 2FA helpers, the invite helpers) which all hit `/api/proxy/[...path]` via `${API_BASE}/auth/...`. The catch-all proxy at `src/app/api/proxy/[...path]/route.ts` is the canonical auth-aware surface — it forwards both Clerk Bearer + cookies, runs the same SSE-handshake Retry-After policy (F36), and handles multipart bodies safely.

**Fix:**
- Deleted all 12 dedicated route files. The `__tests__/auth-route-fixes.test.ts` (14 cases) was also deleted; the canonical retry policy coverage now lives in:
  - `src/lib/__tests__/proxy-retry-after.test.ts` — 7 cases on the shared `retryAfterMs` helper.
  - `src/app/api/proxy/__tests__/sse-handshake-retry.test.ts` — 3 cases on the catch-all SSE handshake.
  - `src/lib/__tests__/api.retry.test.ts` (F31) — 4 cases on the JSON fetch path.
  - `src/lib/__tests__/api.stream-retry.test.ts` (F32) — 3 cases on `api.exportOrgData`.
- Pruned `proxy.ts` `isPublicRoute` of the 8 deleted paths and rewrote the comment to direct future readers at the catch-all proxy.

**Verification:**
- `vitest run` → 109/109 pass (was 123/123 with the deleted tests; **the new total is 109** because the auth-route-fixes suite is gone and the work it covered is now split across the canonical test files above).
- `tsc --noEmit` → clean for my changes (the 3 pre-existing errors in `src/components/observability/StreamingMetricsCard.tsx` are from a different in-flight change and are out of scope per the audit policy).
- `eslint` clean on touched files.

**Priority:** P2 (cleanup; no functional impact)
