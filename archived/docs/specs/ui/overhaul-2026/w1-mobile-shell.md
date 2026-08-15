<!-- Wave 1 + Wave 2 refresh (`w2-mobile-shell`). -->

# Mobile shell inventory (Wave 2 refresh)

**Date:** 2026-07-20 · Plan agent: `w2-mobile-shell`  
Path: `clients/portal/src/components/portal-os/MobileBottomNav.tsx`

> **W1 stale claim corrected:** Agents **is** now in `MOBILE_MORE_LINKS` (first More item). Discoverability gap closed for Agents-in-More; remaining gaps are Advanced leaves still hamburger-only.

---

## 1. Bottom nav vs desktop

**Mobile core (4 + More)** — locked by `u18-portal.test.ts`

| Item | Href |
|------|------|
| Home | `/dashboard` |
| Traces | `/traces` |
| Issues | `/issues` |
| Improve | `/improve` |

**More sheet (8)** — live:

| Label | Href |
|-------|------|
| **Agents** | `/agents` |
| Artifacts | `/artifacts` |
| Alerts | `/alerts` |
| Evals | `/evals` |
| Ledger | `/ledger` |
| Promotions | `/promotions` |
| Debug sessions | `/debugger-sessions` |
| Settings | `/settings` |

**Still missing from More vs desktop Advanced:** Analytics, Cost/Optimization, Guardrails, Prompts, Signals, Audit trail, Quickstart (hamburger drawer only).

**Breakpoint:** `lg:hidden` (≥1024 hides bottom nav); `AppShell` applies `pb-20 lg:pb-0`.

---

## 2. Touch floors

- Bottom nav + More rows: `min-w/h-[44px]`
- Portal-wide `min-h/w-[44px]` / `min-h-11` hits: **~294**
- Crowding counter-signal: density grep still finds **`h-5`×121 + `h-6`×54** — many hub/settings controls remain touch-hostile

---

## 3. Improve kanban overwhelm

`improve/page.tsx`: **5 columns** (`urgent`, `needs_you`, `autonomous`, `proposed`, `verify`)

- Grid: `lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5`
- **&lt;lg = single-column stack of 5 panels** (`min-h-[12rem]` each) → long scroll, no list/snap alternate
- Wave 9 target: mobile list/queue pattern; kill 5-panel stack overwhelm

---

## 4. Tables without mobile strategy

| Signal | Count |
|---|---:|
| Files with `<DataTable` | **~28** |
| Sticky first-col (`sticky: true`) | **8** |
| Horizontal-scroll-only consumers | **~22** |

Includes: incidents, signals, tools, labeling, insights, users, synthetic, studio, redteam, debugger, observability eval/retrieval/memory, optimization leaves, settings exports/audit-log, SpansTab (no sticky).

Wave 10: card/list fallback &lt;lg for long tables (UX-P1-11).

---

## 5. Wave 5 / 9 / 10 handoff

| Wave | Mobile job |
|---|---|
| W5 | More menu without packing bottom nav; keep 4+More |
| W9 | Improve mobile list; Settings rail collapse on narrow |
| W10 | Table mobile strategy; touch floors on hub chrome (`h-5` purge) |
