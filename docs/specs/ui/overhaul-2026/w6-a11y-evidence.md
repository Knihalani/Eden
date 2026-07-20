# Wave 6 — A11y / Motion Evidence (UX-P0-15)

**Agent:** `w6-motion-a11y`  
**Date:** 2026-07-20  
**Brand:** dark-terminal (unchanged)  
**Binding:** [`w3-a11y.md`](./w3-a11y.md)

---

## 1. What changed

| Area | Change | Files |
|---|---|---|
| Focus rings | `Button`, `Tabs`, cmdk close, `MobileBottomNav` use `FOCUS_RING_CLASS` (`:focus-visible` + `--focus-ring`) | `button.tsx`, `tabs.tsx`, `command-palette.tsx`, `MobileBottomNav.tsx` |
| CTA floor | Button `default` / `icon` → `min-h-11` (44px product floor) | `button.tsx` |
| 2.4.11 | `scroll-padding` on `html` + `scroll-margin` on `#main-content :focus-visible` for sticky `h-11` header + mobile bottom nav | `globals.css` |
| Motion | Confirmed CSS `prefers-reduced-motion` + `MotionProvider reducedMotion="user"`; no framer on dashboard/traces/issues hot paths | `globals.css`, `motion-provider.tsx` (verified) |
| Mobile More | `text-[10px]` already migrated to `text-2xs` by mobile-nav agent; this wave added `FOCUS_RING_CLASS` to More + sheet links | `MobileBottomNav.tsx` |
| Axe gate | Routes + `/agents` + `/settings`; serious fail-gate on `/traces` + `/improve` | `audit-a11y.cjs`, `portal-polish.ts` |
| Tests | Source locks for above | `w6-a11y-motion.test.ts`; updated `u20-portal.test.ts`, `w10-w12-portal.test.ts` |

---

## 2. Axe audit status

### Run command (authenticated)

```bash
cd clients/portal
# Prefer production server + seed-auth storageState
# bun run seed-auth.mjs   # if e2e/.auth-state.json missing/stale
PORT=3000 bun run start &  # or next start after build
PORT=3000 bun run audit:a11y
```

### This session

| Item | Result |
|---|---|
| Dev/prod server on `:3000` | **Not running** (`curl` → connection refused) |
| `e2e/.auth-state.json` | **Present** (dated 2026-07-19) |
| Live `audit:a11y` this wave | **Not executed** — blocked on missing local server |

### Prior authenticated reports on disk (pre-W6 route list)

Checked `clients/portal/report-a11y-auth-*.json` from an earlier run:

| Route | Critical | Serious | Notes |
|---|---:|---:|---|
| `/dashboard` | 0 | 0 | PASS |
| `/traces` | 0 | 0 | PASS (now serious-gated) |
| `/issues` | 0 | 0 | PASS |
| `/artifacts` | 0 | 0 | PASS |
| `/playgrounds` | 0 | 0 | PASS |
| `/evals` | 0 | 0 | PASS |
| `/improve` | 0 | 0 | PASS (now serious-gated) |
| `/alerts` | 0 | 0 | PASS |
| `/agents` | — | — | **Not in prior reports** — needs first live pass |
| `/settings` | — | — | **Not in prior reports** — needs first live pass |

**Verdict for final-verifier:** Re-run `PORT=3000 bun run audit:a11y` with auth state against a live portal; expect prior 8 routes still 0 critical; confirm `/agents` + `/settings` newly audited.

---

## 3. Static verification (this wave)

| Check | Evidence |
|---|---|
| `prefers-reduced-motion` | `globals.css` `@media (prefers-reduced-motion: reduce)` zeros animation/transition; `.panel-enter` / `.live-append-pulse` / `.row-select-highlight` opt out |
| Framer respect | `MotionConfig reducedMotion="user"` in portal providers |
| Hot-path thrash | No `framer-motion` imports under `(portal)/dashboard`, `traces`, `issues` pages |
| Skip link | `AppShell` → `#main-content` unchanged |
| FOCUS_RING adoption | Button/Tabs/MobileBottomNav/cmdk close |
| Vitest | **PASS** — `w6-a11y-motion` + `u20-portal` + `w10-101-a11y-interaction`: **25/25** (2026-07-20) |

---

## 4. Remaining gaps (final-verifier)

1. **Live axe** on expanded route list (`/agents`, `/settings`) — cannot claim PASS without server.
2. **TranscriptView AUDIT H2** nested-interactive residual — owned by traces/transcript agents; not fixed here.
3. **Hub hand-rolled `role="tablist"` → `ui/tabs`** — still a W6/W4 sibling; this wave only hardened `ui/tabs` focus ring.
4. **Button `sm` (32px)** still allowed for dense secondary actions — primary default is now 44px; do not use `sm` on Improve/mobile chrome.
5. **Contrast / `text-[9px|10px]`** elsewhere — density agents; MobileBottomNav More is clean.
6. **Suspense `fallback={null}`** ban — separate lint track in w3-a11y §6.2.
7. **2.4.11 CDP Tab walk** — scroll-margin shipped; manual/CDP probe still recommended on sticky header + bottom nav.

---

## 5. Do-not-commit

Per wave instructions: **no git commit** from this agent.

---

*End of W6 a11y evidence.*
