<!-- Wave 1 + Wave 2 refresh (`w2-specs-gap`). -->

# Specs ↔ Live UI Gap Audit (Wave 2 refresh)

**Date:** 2026-07-20 · Plan agent: `w2-specs-gap`  
Sources: `docs/specs/ui/u00–u20` + `00-portal-operating-system.md`, `AUDIT-FRONTEND-2026-07-06.md`, overhaul-2026 briefs, live `clients/portal/`.

Focus this refresh: **anti-clutter gaps** (bands, dual identity, progressive disclosure, density roles).

---

## 1. Spec inventory U00–U20 (status vs live)

| ID | Spec status line | Live reality (Jul 2026) |
|---|---|---|
| **U00** OS | PARTIAL | portal-os built; uneven hub wiring |
| **U01** Traces | PARTIAL | `/traces` + DetailPanelShell; **still ~3 chrome bands** |
| **U02–U11** | Mixed MISSING (often stale) | Routes largely exist |
| **U12** IA | PARTIAL | Count ≤12 OK; leaf set ≠ locked IA list |
| **U13–U17** | Mixed | Debugger Advanced; online scoring under Improve; **no** `/settings/render-templates`; ChatSidebar present |
| **U18** Overhaul | MISSING program (stale) | AppShell + density + mobile 4+More shipped; tests lock |
| **U19** Density | MISSING program (stale) | CrossLinkBar + density grep debt remain |
| **U20** Polish | MISSING program (stale) | polish scripts + u20 tests; not full clutter gate |

---

## 2. Anti-clutter gap table (Wave 2 priority)

| Gap | Spec / doctrine | Live | Severity |
|---|---|---|---|
| Traces ≤2 chrome bands | U01, hierarchy spec, anti-clutter #1 | Still **3 bands** (header + tabs/legacy + facets/filters) | **P0** |
| One identity / Settings hygiene | anti-clutter #3 | Dual Settings title + dual org switcher still documented in W1 hubs | **P0** |
| Home KPI 5–7 / mobile 3–4 | U09, density rules | `DEFAULT_WIDGETS` = **8** peers; no mobile KPI cap | **P0** |
| QueryState default Status | U00 §9 | Only **6** pages | **P1** |
| Progressive disclosure of secondary tools | anti-clutter #2 | Legacy observe links still peer chrome on Traces | **P0** |
| Flatten card nests | anti-clutter #6 | Observe depth ~5; SettingsCard nests; Card→DataTable | **P0/P1** |
| Micro-type ban on chrome | anti-clutter #7 | ~371 micro px; portal-chrome + alerts/guardrails wrong-role | **P0** |
| `--space-*` breathing | spacing tokens | Ladder **1–8 defined**; adoption ~9 files | **P1** |
| U12 leaf shape | U12 | Count OK; set drift | **P1** |
| U15 render templates | U15 | Route missing | **P2** |
| U18 mobile “5 items” vs code | U18 §3.6 | Live **4 + More** (tests lock 4) — docs disagree | Doc fix |
| AUDIT nested interactive | AUDIT-FRONTEND | TranscriptView nested interactive risk open | **P1** |

---

## 3. Spec doc staleness (do not trust headers blindly)

| Claim in specs/W1 | Live correction |
|---|---|
| Only `--space-2/3/4` | `--space-1`…`8` + `@theme` bridge |
| Agents missing from More | Agents **in** `MOBILE_MORE_LINKS` |
| QueryState ×3 | QueryState ×**6** |
| `fallback={null}` ×6 | **2** prod sites |
| U18/U19/U20 “MISSING” | Partially shipped; programs incomplete |

---

## 4. Wave 4 / 5 handoff

Wave 4 must encode: band budget, toolbar ≤5, KPI caps, card-nest ban, dual-title ban into binding anti-clutter contract.  
Wave 5 implements tokens + Button/Tabs purge + QueryState + shell breathing that close the gaps above.
