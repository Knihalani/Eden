# Wave 3 — Laminar shell OSS (calm chrome budget)

**Agent:** `w3-laminar-shell`  
**Date:** 2026-07-20  
**Scope:** Docs only. Clone interaction/layout — not skins.  
**Baseline:** [`w1-chrome-mapper.md`](./w1-chrome-mapper.md), [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md)  
**Contracts:** [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) §A

---

## Sources

| Source | Use |
|---|---|
| [laminar.sh/docs](https://laminar.sh/docs) / [llms.txt](https://laminar.sh/docs/llms.txt) | Platform chrome descriptions |
| [lmnr-ai/lmnr](https://github.com/lmnr-ai/lmnr) `frontend/` | `SidebarProvider` + inset; project sidebar; Header `h-12` |
| PRs #1918 / #1929 | Unified settings; picker containment |
| Eden | `AppShell`, `portal-chrome`, `sidebar-config` |

---

## How Laminar avoids header piles

1. **Inset work surface** — sidebar + `SidebarInset`; page `Header` is a **thin breadcrumb + actions** band, not a second global sticky stack of search/density/org.  
2. **Context in sidebar header** — workspace/project picker (collapse-safe monogram); notifications beside picker — not competing page titles.  
3. **Observe chrome inside the resource** — Traces tabs + table toolbar live under a minimal path header; **not** three page-level bands.  
4. **Settings = one leaf + `?tab=`** — not a second chrome tree with duplicate titles.  
5. **Flat ~10 primary nav** — feature flags gate leaves; no “everything equally loud” Advanced dump (Eden keeps Advanced + U12 — steal *calm*, not leaf count).

---

## Pattern → Eden gap (live W1/W2)

| # | Pattern | Laminar | Eden gap | P |
|---|---|---|---|---|
| 1 | Icon-collapse keeps context | Monogram picker clickable | Collapse-safe org is P0 if not fully landed; dual org **fixed** | P0 |
| 2 | Page Header = crumbs + optional actions | One band | Shell sticky **plus** PageHeader **plus** hub toolbars → Traces **3** bands | P0 |
| 3 | Hub tools inside resource toolbar | Tabs+filters one layer | Tabs band + QueryFilterBar band | P0 |
| 4 | Settings single identity | Sidebar leaf | dual_title **N** (fixed); **19-tab** density remains | P1 |
| 5 | Short primary nav | ~10 leaves | Keep ≤12; Advanced collapse; id≠label remains | P1 |
| 6 | Banner one strip | Usage banner | Multi banner + ~7 worst-case column | P1 |
| 7 | Density via component sizes | sm/default menu | Wrong-role micro-type on chrome (`portal-chrome` TOP crowding) | P0 |
| 8 | Mobile same destinations | Sheet sidebar | Keep Eden bottom nav; ensure More reachability (Agents in More — landed) | P2 |

---

## Shell chrome budget (steal)

| Slot | Budget |
|---|---|
| Shell sticky | 1 — breadcrumbs + sparse actions |
| Page identity | 1 — `PageHeader` |
| Hub toolbar | 1 — tabs+filters+views+overflow |
| **Page total** | **≤2** under shell |
| Sidebar | Org once; Advanced collapsed |

---

## Declutter acceptance (shell research → contracts)

- [ ] Documented Laminar “no header pile” grammar → §A contracts  
- [ ] Eden gaps cite live band counts (Traces 3, shell ~7 worst-case)  
- [ ] Progressive disclosure: account/notifications placement noted without requiring Laminar pixel clone  

*End of w2-laminar-shell-oss (Wave 3).*
