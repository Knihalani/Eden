# Wave 6 — `w6-perf-check` (framer-motion + layout thrash)

**Agent:** `w6-perf-check`  
**Date:** 2026-07-20  
**Scope:** `clients/portal/src` — hot paths + prefers-reduced-motion  
**Verdict:** **PASS-WITH-GAPS**

---

## Goal

No framer-motion regressions on hot paths; spot-check layout thrash. Dock/rail chrome may animate; list / table / virtualization parents must not wrap every row in `motion.*` / `AnimatePresence`.

---

## Method

1. Repo-wide grep for `framer-motion`, `AnimatePresence`, `motion.`, `MotionConfig` under `clients/portal/src`.
2. Hot-path file review: dashboard, traces (+ TracesTab / LiveTail), issues, `portal-chrome` / AppShell, ChatSidebar (AI rail), TranscriptView / transcript-v2.
3. `prefers-reduced-motion` / `MotionConfig` / `motion-reduce:` wiring check.
4. Fix only clear P0 (motion wrapping list/gantt rows). Document the rest.

---

## Inventory — framer-motion call sites

| File | Usage | Hot path? | Risk | Notes |
|---|---|---|---|---|
| `components/providers/motion-provider.tsx` | `MotionConfig reducedMotion="user"` | Shell (all) | OK | Wired in `app/(portal)/providers.tsx`. Disables FM JS anims when OS prefers reduce. |
| `components/onboarding/ProductTour.tsx` | `AnimatePresence` + `motion.div` (mask + card) | Overlay only | OK | Not list/virtualization. Also uses `matchMedia("(prefers-reduced-motion: reduce)")` for scroll; FM itself gated by MotionConfig. |
| `components/observability/JobGantt.tsx` | ~~`motion.div` per job bar~~ → plain `div` | **No consumers** | **Fixed** | Latent P0: every gantt row used `initial/animate` scaleX. Unused today; stripped so future mounts stay safe. |
| High-traffic pages (alerts, users, tools, studio, obs leaves, optimization, guardrails) | none | Yes | OK | Guarded by `w15a-portal-longtail.done-when.test.ts` P11. |
| Hot paths below | **zero** `framer-motion` imports | Yes | OK | See § Hot paths. |

**Dependency:** `framer-motion@^12.40.0` remains in `clients/portal/package.json` (ProductTour + MotionProvider). `next.config.ts` includes it in `optimizePackageImports`.

---

## Hot paths — detail

| Surface | framer-motion / AnimatePresence | Layout thrash notes |
|---|---|---|
| `dashboard/page.tsx` + `_components/*` | None | `live-append-pulse` on a single status dot (CSS). Loading skeleton uses `page-enter` (CSS). Row keys are stable IDs / hours — no remount thrash. |
| `traces/page.tsx` + `TracesTab` / list | None | Action buttons use `transition-colors` only. No row-level enter animations. |
| `traces/_components/LiveTailPanel.tsx` | None | **Gap (P2):** on append, restarts CSS pulse via `offsetWidth` read on the **`<ul>`** (not per row). Cap `maxEvents: 40`. Intentional animation restart; mild forced reflow. Reduced-motion: `.live-append-pulse` disabled in `globals.css`. |
| `issues/page.tsx` | None | Rows: `transition-colors` hover only. Spinners: `animate-spin`. |
| `portal-chrome.tsx` | None | Sidebar width/collapse: CSS `transition-*` + widespread `motion-reduce:transition-none`. Main body wrapper: single `page-enter` (CSS). No pathname-keyed remount of the enter shell. |
| `components/portal-os/AppShell.tsx` | None | No FM. |
| `components/portal-os/DetailPanelShell.tsx` | None | `panel-enter` CSS once on panel open — OK; gated under reduced-motion. |
| `components/ai-insights/ChatSidebar.tsx` (+ SessionList / MessageList) | None | Dock via Sheet (`panel-enter` OK). List parents have no FM / no stagger. `transition-colors` on chrome only. |
| `TranscriptView` / `transcript-v2/*` | None | Progressive slice virtualization (`INITIAL_BATCH` / IntersectionObserver). Rows are plain DOM — **not** wrapped in `motion.*`. |

---

## Flagged patterns (requirement 2)

| Pattern | Found? | Severity |
|---|---|---|
| `AnimatePresence` / `motion.*` on **list rows** | JobGantt only (unused) → **removed** | Was latent P0 |
| `motion.*` on **table rows** | No | — |
| FM on **every hub remount** | No | — |
| FM wrapping **virtualized transcript rows** | No | — |
| CSS enter on chrome / panel / live pulse | Yes (intentional) | P2 / OK |

---

## prefers-reduced-motion wiring

| Layer | Status |
|---|---|
| CSS (`globals.css` `@media (prefers-reduced-motion: reduce)`) | Present — zeroes animation/transition durations; disables `.page-enter`, `.stagger-children`, `.panel-enter`, `.live-append-pulse`, stage pulses. Covered by `u20-portal.test.ts`. |
| Framer (`MotionProvider` → `MotionConfig reducedMotion="user"`) | Present in portal providers tree. |
| Tailwind `motion-reduce:*` | Used heavily in `portal-chrome` nav / collapse transitions. |
| ProductTour | Extra `matchMedia` for scroll; FM follows MotionConfig. |
| Marketing / auth brand | Separate local `matchMedia` (out of portal hot-path scope). |

**Gap (non-blocking):** `.stagger-children` CSS exists but has **no TSX call sites** in portal — dead utility; already reduced-motion gated.

---

## Fixes applied

1. **`clients/portal/src/components/observability/JobGantt.tsx`**  
   - Removed `framer-motion` import.  
   - Replaced per-job `motion.div` (scaleX enter) with static `div`.  
   - Rationale: clear P0 pattern (motion on every row) even though the component currently has zero importers.

No other code changes (hot paths already clean).

---

## Residual gaps (not P0)

1. **LiveTailPanel** forced reflow to restart list-container pulse — acceptable at N≤40; do not promote to per-row pulse.
2. **`stagger-children`** unused CSS — optional cleanup later.
3. **ProductTour** still depends on FM — fine for one-shot overlay; keep off list/hub paths.
4. **`page-enter` on portal-chrome** — single CSS enter wrapper; PageContent intentionally does **not** duplicate it (comment sync with layout).

---

## Verdict

**PASS-WITH-GAPS**

- Hot paths (dashboard, traces list/TracesTab, issues, chrome/AppShell, ChatSidebar lists, TranscriptView / v2): **no framer-motion regressions**.
- Virtualization parents are **not** wrapped in motion.
- Reduced-motion is wired at CSS + MotionConfig + chrome `motion-reduce`.
- Gaps are documented CSS thrash helpers / dead utilities / overlay-only FM — not FAIL-level.

---

## Evidence quick refs

```text
rg 'from ["'\'']framer-motion["'\'']' clients/portal/src
# → motion-provider.tsx, ProductTour.tsx only (JobGantt cleared)

Hot path greps (dashboard|traces|issues|portal-chrome|ChatSidebar|transcript*): no matches
```
