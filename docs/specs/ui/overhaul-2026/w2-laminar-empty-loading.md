# Wave 3 — Laminar / peer empty & loading (no chaos flash)

**Agent:** `w3-laminar-states`  
**Date:** 2026-07-20  
**Baseline:** [`w1-states-loading.md`](./w1-states-loading.md); W2 — QueryState ×6; `fallback={null}` ×2  
**Peers:** Laminar empty tables; Langfuse/Braintrust “connect SDK” vs “no matches”; Linear skeleton-matches-layout

---

## State taxonomy (must distinguish)

| State | User meaning | UI |
|---|---|---|
| **Never ingested** | Product empty | Teaching CTA (install SDK / send first trace) |
| **Filter empty** | Data exists; filters too tight | “No matches” + **Clear filters** / adjust view |
| **Error** | Fetch failed | `ErrorState` + retry |
| **Loading** | In flight | Skeleton **matching** table/detail layout |
| **Partial / live** | Streaming | Don’t blank the list; subtle row flash OK |

**Chaos anti-pattern:** `Suspense fallback={null}` → blank main column (Settings historically; mostly fixed).

---

## Peer cues

| Peer | Pattern |
|---|---|
| Laminar | Empty table still exposes clear path to filters / save view; skeletons on table chrome |
| Langfuse / Braintrust | Connect-empty ≠ filter-empty copy |
| Linear / Stripe | Skeleton mirrors final layout; never null flash |

---

## Eden gap (live)

| Item | Status |
|---|---|
| `EmptyState` / `ErrorState` | Widely used |
| `QueryState` as default wrapper | Under-adopted (×6) — P0 |
| Settings Suspense | `SettingsLoading` — good |
| Remaining `fallback={null}` | ×2 — ban outside overlays |
| Dual `Skeleton` vs `LoadingSkeleton` | Pick one recipe — P1 |
| `loading.tsx` | ×79; fix anti-pattern re-exports |

---

## Declutter angle

Blank flashes and hand-rolled spinners **feel like clutter/confusion** even with few chrome bands. Calm state stack is part of anti-overwhelm:

- One async wrapper (`QueryState`)  
- One skeleton language per surface role  
- Filter-empty always offers **Clear** (reduces trapped chrome)

---

## Acceptance

- [ ] Taxonomy documented for Wave 4–5  
- [ ] Ban blank Suspense on hubs/Settings  
- [ ] Filter-empty vs never-ingested copy required on Observe  

*End of w2-laminar-empty-loading (Wave 3).*
