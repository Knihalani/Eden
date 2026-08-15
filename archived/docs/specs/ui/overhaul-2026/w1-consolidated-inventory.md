# Wave 1 — Eden Surface Discovery (Surfaces Synthesis)

**Job:** `w1-surfaces-synth` (Job 12)  
**Date:** 2026-07-20  
**Scope:** `clients/portal` surface inventory — docs only (no product-code claims beyond live re-reads cited in companion `w1-*.md`)  
**Companions:** per-agent discovery notes in this folder; route table [`w1-route-matrix.md`](./w1-route-matrix.md)

### Anti-clutter doctrine (binding)

Wave 1 locks the **anti-clutter** bar used by later waves:

- **Hub chrome ≤2 bands** — identity (`PageHeader`) + at most one toolbar / filter OS band. Tabs, facets, legacy links, KPI strips, and CrossLinkBars that stack as separate purpose rows count as bands.
- **No dual identity** — one page title; no rail `h2` + `PageHeader` echo; no in-page org switcher competing with shell Clerk switcher.
- **Clutter score** — Jobs 4–6 formula (0–10); higher = more overwhelming. Scores and the Top-20 overwhelm list below are the **live baseline** for Waves 5–10 surface work.

### Exit criteria

Wave 1 surfaces discovery is **complete** when: every portal route is classified; hubs have chrome-band counts + clutter scores; Top-20 overwhelm is locked; Settings dual-title re-verified; Traces bands documented. Checklist in §11 — all checked.

---

## 1. Executive snapshot

| Dimension | Live finding (2026-07-20) |
|---|---|
| Surface size | **97** `page.tsx` / **75** portal / **6** layouts |
| Core nav | **12** top-level (`CORE_NAV_ITEM_COUNT`); Advanced collapsed by default |
| Icon collisions | **0** (fixed — unique icons per nav item) |
| Group id ≠ label | **Remains:** `build`→Home, `automate`→Evaluate, `optimize`→Improve (`observe`/`workspace` match) |
| Traces | `band_count` = **3** (PageHeader + hub tabs + QueryFilterBar OS); facets/legacy in **More** menu — still **FAIL ≤2** |
| Settings | `dual_title` = **N** (rail `h2` removed); **21** tabs declared / **19** visible / **6** groups; Suspense uses **`SettingsLoading`** |
| Shell worst-case | **~7** stacked main-column bands when sticky header + onboarding/blocking banners + page chrome stack coincide |
| Hub clutter leaders | Artifacts **6.5**, Alerts **5.5**, Audit **5.0** (see §6) |

---

## 2. Route matrix summary

Full table: [`w1-route-matrix.md`](./w1-route-matrix.md) (cartographer notes: [`w1-route-cartographer.md`](./w1-route-cartographer.md)).

### Counts by group

| Group | Pages |
|---|---:|
| `(portal)` | 75 |
| `(marketing)` | 13 |
| `(auth)` | 5 |
| `sign-in` / `sign-up` / `docs-fill` / `[...notFound]` | 4 |
| **Total** | **97** |

### Layouts (6)

| File | Role |
|---|---|
| `app/layout.tsx` | Root HTML, fonts, globals |
| `app/(portal)/layout.tsx` | Portal providers → `PortalChrome` / `AppShell` |
| `app/(portal)/dashboard/layout.tsx` | Dashboard prefetch |
| `app/(portal)/traces/layout.tsx` | Traces prefetch |
| `app/(auth)/layout.tsx` | Auth chrome |
| `app/(marketing)/layout.tsx` | Marketing chrome |

### Adoption (all 97 pages)

| Pattern | Count | % |
|---|---:|---:|
| `PageContent` | 52 | 54% |
| `PageHeader` | 67 | 69% |
| `CoreResourcePage` / `ResourcePageShell` / `DetailPanelShell` (any) | 18 | 19% |

Portal-only (**75**): same absolute adoption counts (marketing/auth rarely use these shells).

### Notable dual / orphan patterns

| Route | Relation |
|---|---|
| `/observability` + children | Soft-nest / facet redirects → Traces (cohorts GAP — see §9) |
| `/fleet` | Redirect/embed → `/agents?tab=fleet` |
| `/signals` | Dual: page + `/alerts?tab=signals` |
| `/incidents` | Dual: page + Issues hub tab |
| Evals children (`/studio`, `/playgrounds`, …) | Hub tabs + standalone modules |
| `/replay`, `/debugger`, query leaves | Traces `?view=` / embeds |

---

## 3. Chrome map summary

Detail: [`w1-chrome-mapper.md`](./w1-chrome-mapper.md).

**Tree:** `(portal)/layout` → `PortalChrome` → `AppShell` → `DensityProvider` → sidebar | main (sticky header + banners + page) | AI rail.

| Slot | Notes |
|---|---|
| Sidebar | `#portal-sidebar`; mobile drawer; widths 240 / 64 |
| Org switcher | Clerk `OrganizationSwitcher` in sidebar (shell-only; Settings in-page Select removed) |
| Sticky header | `sticky top-0 z-30`, `h-11` — breadcrumbs + cmdk / notifications |
| Banner stack | Onboarding → offline → org-syncing → auth; blocking banners set `data-eden-chrome-banner` |
| Command palette | Dynamic slot inside `main` (⌘K) |
| AI rail | `ChatSidebar` sibling of `main` |
| Mobile nav | `MobileBottomNav` `lg:hidden`; `main` gets bottom pad |
| Density | `data-density` comfortable \| compact |
| Hide chrome | **DEAD** — `isOnboardingWizardPath` always `false`; full chrome always mounts |

**Worst-case main column (~7 bands):** sticky header + onboarding banner + up to three chrome banners + page identity + secondary tabs/toolbar + filter/KPI strip. Page-level bands are scored separately in hub clutter (§6); shell banners amplify perceived overload on dense hubs.

---

## 4. Sidebar IA summary

Detail: [`w1-sidebar-ia.md`](./w1-sidebar-ia.md). Source: `clients/portal/src/lib/sidebar-config.ts`.

| Check | Status |
|---|---|
| Core top-level | **12** — U12 numeric ≤12 **PASS** |
| Icon collisions | **0** (fixed) |
| Group id ≠ label | **Remains** for `build` / `automate` / `optimize` |
| Advanced | **7** top-level + Webhook DLQ nested; default **collapsed** (localStorage) |
| U12 leaf lock | Still **drifts** — Evals mega-hub; Incidents/Book/Drift not core leaves; extras Audit/Ledger/Promotions/Quickstart |

### Group id vs label

| Group `id` | Display label |
|---|---|
| `build` | Home |
| `observe` | Observe |
| `automate` | Evaluate |
| `optimize` | Improve |
| `workspace` | Workspace |

### Core vs Advanced (summary)

- **Core (12):** Home, Traces, Agent Issues, Alerts, Evals, Improve, Artifacts, Ledger, Promotions, Audit trail, Settings, Quickstart (external).
- **Advanced (7+1):** Agents, Analytics, Signals, Debug sessions, Cost, Guardrails, Prompts; nested Webhook DLQ.

---

## 5. Clutter score baseline (hubs)

**Source:** live Jobs 4–6 re-read in [`w1-hub-surfaces.md`](./w1-hub-surfaces.md) (2026-07-20).

### Formula (brief)

Score **0–10** (higher = more overwhelming):

| Factor | Penalty |
|---|---|
| Chrome bands beyond 2 | **+1.5** each |
| Visible primary CTAs above 5 | **+0.5** each |
| KPI chips above 7 (desktop) | **+0.3** each |
| Duplicate titles / dual identity | **+2** |
| Micro-controls packed in header | **+1** |
| Nested cards in chrome region | **+1** |

AppShell sidebar / top breadcrumb excluded. Bands counted by *stacked chrome purpose* (even when co-mounted in one toolbar wrap). Steady-state scoring (org present; non-empty where that unlocks KPI strips).

### Baseline table

| Rank | Hub | Score | band_count | dual_title |
|---:|---|---:|---:|:---:|
| 1 | Artifacts | **6.5** | 5 | N |
| 2 | Alerts | **5.5** | 4 | N |
| 3 | Audit trail | **5.0** | 4 | N |
| 4 | Issues | **4.0** | 4 | N |
| 4 | Promotions | **4.0** | 4 | N |
| 4 | Agents | **4.0** | 4 | N |
| 7 | Settings | **2.5** | 3 | **N** |
| 7 | Traces | **2.5** | **3** ⚠ | N |
| 9 | Improve | **1.5** | 3 | N |
| 10 | Connect | **0.5** | 2 | N |
| 11 | Dashboard | **0.0** | 1 | N |
| 11 | Evals | **0.0** | 2 | N |
| 11 | Ledger | **0.0** | 2 | N |

### Traces archetype (still FAIL ≤2)

```
band 1: PageHeader (Observe / Traces)
band 2: TabsList traces | spans | sessions
band 3: QueryFilterBar + Views + Refresh + More
```

Facets / legacy tools collapsed into **More** (improvement vs chip-row era) — but **band_count = 3** still fails the ≤2 doctrine.

### Settings dual-title (re-verified)

| Signal | Present? |
|---|:---:|
| Rail `<h2>Settings</h2>` + PageHeader | **N** (fixed) |
| In-page org Select competing with Clerk | **N** (removed) |
| Suspense blank `fallback={null}` | **N** — uses **`SettingsLoading`** |

Remaining Settings overload is **19-tab / 6-group rail density**, not title duplication.

---

## 6. Top-20 overwhelm heatmap (locked for W5–W10)

**Job 10** — locked list. Cite methodology + band notes in [`w1-embed-surfaces.md`](./w1-embed-surfaces.md). Prefer **effective bands after embed** (hub + leaked leaf chrome) when scoring Studio / Fleet / Memory / Retrieval.

| # | Surface | Bands | One-line rationale |
|---:|---|---|---|
| 1 | **Traces** | 3 | Archetype fail: identity + hub tabs + QueryFilterBar OS; More collapses facets/legacy but stack remains |
| 2 | **Guardrails** | 3 | Density hotspot; StatCards + multi-tab testbench / history tables |
| 3 | **Alerts** | 4–5 | Feed: ResourceOsToolbar + severity KPI + ack/rules strips; hub clutter **5.5** |
| 4 | **Studio** | 2+forms | Nested under Evals 7-tab hub; form sprawl + accent history |
| 5 | **Replay** | 3 | StatCards + picker + local tabs; dense micro-type |
| 6 | **Fleet** | 3 | KPI×5 + heatmap/delegation; embed leaks nested chrome under Agents |
| 7 | **Time-Travel** | 3 | Stepper + multi-workflow Cards under Traces view chrome |
| 8 | **Settings** | 2–3 | 21/19/6 rail IA; `dual_title` **N** but tab density dominates |
| 9 | **Model Advisor** | 2 | Large form surface; Cards + dense Inputs; optimization deep-link dual chrome GAP |
| 10 | **Users** | 2–3 | Nested tabs + many DataTables inside Analytics embed |
| 11 | **Tools** | 2–3 | Multi-tab action forms; Analytics nest |
| 12 | **Memory facet** | 3 | Nested tabs/Cards under Traces facet chrome |
| 13 | **Retrieval facet** | 3 | Same shape as Memory under Traces |
| 14 | **Query DSL** | 2 | Multi-op Cards + alert compiler; raw-accent history |
| 15 | **Analytics** | 3 | KPI Panels + day chips + charts at hub |
| 16 | **Insights** | 2–3 | Nested tabs + detector actions; tight spacing |
| 17 | **Prompts** | 2 | Create forms + Card density; Advanced standalone |
| 18 | **Agents** | 4 | Header + CrossLinkBar + tabs + in-body filters (clutter **4.0**) |
| 19 | **Issues** | 4 | Section tabs + ResourceOsToolbar + status TabsList (clutter **4.0**) |
| 20 | **FinOps / Improve queue** | 2–3 | Dimension selectors / kanban + CrossLinkBar; FinOps deep-link GAP |

**Also watch (components, not routes):** `TranscriptView`, `ApprovalCard`, `portal-chrome` micro-controls — density leaders in [`w1-density-grep.md`](./w1-density-grep.md).

---

## 7. Hub + leaf summary

| Artifact | Contents |
|---|---|
| [`w1-hub-surfaces.md`](./w1-hub-surfaces.md) | 8 hubs + Jobs 4–6 clutter scores / band math |
| [`w1-leaf-surfaces.md`](./w1-leaf-surfaces.md) | Evaluate / Improve / workspace leaves |
| [`w1-leaf-observability.md`](./w1-leaf-observability.md) | Observe leaves (query, facets, time-travel, …) |
| [`w1-leaf-advanced.md`](./w1-leaf-advanced.md) | Guardrails, Cost/optimization, Analytics cluster, Prompts, … |

### Hub chrome at a glance (post–More / dual-title fix)

| Hub | Bands | dual_title | Notes |
|---|---:|:---:|---|
| Dashboard | 1 | N | Calm baseline |
| Traces | **3** | N | FAIL ≤2; facets/legacy in More |
| Agents | 4 | N | CrossLinkBar + tabs + body filters |
| Evals | 2 | N | 7 peer tabs — IA wrap, not band penalty |
| Improve | 3 | N | CrossLinkBar + tabs |
| Alerts | 4–5 feed | N | Highest observe clutter |
| Issues | 4 | N | Status filter strip |
| Settings | 3 | **N** | Rail density, not double title |

None of the original “hand-rolled only” claim should drive W5 work uncritically — core hubs now use `@/components/ui/tabs` where foundation landed; band counts above are the binding overload metric.

---

## 8. Redirect / embed GAPs

| Gap | Detail | Cite |
|---|---|---|
| **Cohorts soft-nest broken** | Redirect → `/traces?view=cohorts` but hub does not honor `cohorts` in views → falls back to list | [`w1-redirect-audit.md`](./w1-redirect-audit.md), [`w1-embed-surfaces.md`](./w1-embed-surfaces.md) |
| **Optimization children dual chrome** | `/optimization/{budget,outcomes,predict,model-advisor}` embed when via Cost hub; **full chrome when deep-linked** (no redirect) | same |
| Improve orphans | `scorecard` / `change-impact` / `online-scoring` — CrossLink only, not hub-embedded | redirect audit |
| Nested chrome leak | Most embeds hide `PageHeader` only — local Tabs / StatCards / toolbars remain | embed surfaces |

Redirect mechanisms: `next.config.ts` + `portal-hub-redirect.ts` (query-preserving 307 via proxy).

---

## 9. Systems pointers (Wave 2+ territory — keep short)

These Wave 1 artifacts already exist; they feed token/density/state programs rather than re-litigating surface classification here.

| Topic | Doc |
|---|---|
| Density hotspots | [`w1-density-grep.md`](./w1-density-grep.md) |
| Tokens / spacing | [`w1-token-audit.md`](./w1-token-audit.md) |
| Loading / Empty / QueryState | [`w1-states-loading.md`](./w1-states-loading.md) |
| Mobile shell / More sheet | [`w1-mobile-shell.md`](./w1-mobile-shell.md) |
| Specs vs live (U12–U20) | [`w1-specs-gap.md`](./w1-specs-gap.md) |
| Test / e2e / polish blast | [`w1-test-e2e-map.md`](./w1-test-e2e-map.md) |
| Component drift inventory | [`w1-component-inventory.md`](./w1-component-inventory.md) |

---

## 10. Wave 1 exit checklist

- [x] Every portal route classified (97 pages / 75 portal / 6 layouts — [`w1-route-matrix.md`](./w1-route-matrix.md))
- [x] Chrome-band count + clutter score on hubs (Jobs 4–6 — [`w1-hub-surfaces.md`](./w1-hub-surfaces.md))
- [x] Top-20 overwhelm locked (§6 — cite [`w1-embed-surfaces.md`](./w1-embed-surfaces.md))
- [x] Dual-title Settings re-verified (**N** — rail `h2` gone; `SettingsLoading` Suspense)
- [x] Traces bands documented (**3** — PageHeader + hub tabs + QueryFilterBar OS; Still FAIL ≤2)

---

## 11. Handoff to Wave 2 / Wave 5

This document is the **Wave 1 surfaces discovery** synthesis: route classification, chrome map, sidebar IA, **live clutter baseline**, and the **locked Top-20** for surface waves.

- Competitive / pattern work and design contracts live in Wave 2–3 artifacts (`w2-*`, `w3-*`) already in this folder — this refresh does **not** re-open or claim those waves incomplete.
- Use §5 scores + §6 Top-20 as the anti-clutter baseline for the **10-wave plan**, especially **Waves 5–10** hub-by-hub surface work (Traces ≤2 bands first among Observe P0s).
- Foundation hygiene that already landed (unique icons, Settings title/org, Suspense skeletons, Tabs primitive on core hubs, facets→More) is reflected in the live snapshot above; remaining FAIL items (Traces bands, Artifacts/Alerts/Audit clutter, embed GAPs) are the surface backlog inputs.

**Out of scope for this file:** product code edits, competitor research, Design Brief authorship.

---

*End of Wave 1 surfaces synthesis (`w1-surfaces-synth`).*

---

# Wave 2 — Eden systems discovery (append; do not clobber Wave 1 surface sections)

**Date:** 2026-07-20  
**Plan:** Portal UI 10-Wave — Wave 2 (12 agents)  
**Method:** Parallel systems agents + orchestrator verification greps  
**Scope:** Docs-only under `docs/specs/ui/overhaul-2026/` — **no product UI edits**  
**Exit:** Complete component + crowding + card-nest + state + test map. ✅

Companion refreshes: [`w1-component-inventory.md`](./w1-component-inventory.md) §6–§9 · [`w1-density-grep.md`](./w1-density-grep.md) · [`w1-token-audit.md`](./w1-token-audit.md) · [`w1-states-loading.md`](./w1-states-loading.md) · [`w1-mobile-shell.md`](./w1-mobile-shell.md) · [`w1-specs-gap.md`](./w1-specs-gap.md) · [`w1-test-e2e-map.md`](./w1-test-e2e-map.md) · [`w1-route-matrix.md`](./w1-route-matrix.md) (layout section).

---

## W2-0. Executive snapshot (systems)

| Dimension | Wave 2 finding |
|---|---|
| UI primitives | **42** modules; Button ×**120** files; Tabs ×**20**; hand-rolled tablist ×**6** |
| CTA drift | ~**28** portal accent CTA lines; accent ratchet baseline **25** |
| Portal-OS | **20** files; full OS stack on Issues/Alerts/Artifacts/Experiments/Promotions/Datasets; Traces hand-composes; Agents/Improve/Evals/Settings under-adopt |
| Layout | PageContent **52/97**; hubs **2/12** direct PageContent (most use CoreResourcePage); ResourceOsToolbar ×**6** |
| Crowding | Micro **371**; half-step family **301**; gap-1 packing family **361**; files with hits **220** |
| Density TOP-5 | portal-chrome · guardrails · alerts · TranscriptView (tokenize) · ApprovalCard |
| Card-nest | Observe path depth **~5** (P0); SettingsCard nests + Card→DataTable systemic P1 |
| States | `loading.tsx` ×**79**; QueryState ×**6**; `fallback={null}` ×**2** |
| Tokens | `--space-1`…`8` **defined** + `@theme`; adoption ~**9** files |
| Mobile | Agents **in More**; Improve 5-col stack &lt;lg; sticky tables **8/28** |
| Specs | Traces 3 bands + Home 8 KPIs + QueryState underuse = anti-clutter P0 gaps |
| Tests | 95 Vitest; golden 8 paths; **no** band/KPI/nest budget gates yet |

---

## W2-1. Agent → artifact map (12/12)

| # | Agent | Artifact |
|---|---|---|
| 1 | `w2-ui-primitives-inv` | [`w1-component-inventory.md`](./w1-component-inventory.md) §6 |
| 2 | `w2-portal-os-inv` | same §7 |
| 3 | `w2-layout-inv` | [`w1-route-matrix.md`](./w1-route-matrix.md) Wave 2 section |
| 4 | `w2-density-grep` | [`w1-density-grep.md`](./w1-density-grep.md) |
| 5 | `w2-token-audit` | [`w1-token-audit.md`](./w1-token-audit.md) |
| 6 | `w2-states-loading` | [`w1-states-loading.md`](./w1-states-loading.md) |
| 7 | `w2-obs-component-map` | component inventory §8 |
| 8 | `w2-card-nest-audit` | component inventory §9 |
| 9 | `w2-mobile-shell` | [`w1-mobile-shell.md`](./w1-mobile-shell.md) |
| 10 | `w2-specs-gap` | [`w1-specs-gap.md`](./w1-specs-gap.md) |
| 11 | `w2-test-e2e-map` | [`w1-test-e2e-map.md`](./w1-test-e2e-map.md) |
| 12 | `w2-systems-synth` | **this section** |

---

## W2-2. Top crowding / card-nest findings

### Crowding (chrome worse than instrument)

| Rank | File | Why |
|---:|---|---|
| 1 | `portal-chrome.tsx` | Shell crowding (`h-5`×5, half-steps) taxes every route |
| 2 | `guardrails/page.tsx` | Hub wrong-role: instrument micro + half×17 |
| 3 | `alerts/page.tsx` | Hub wrong-role: `text-[10px]`×15 |
| 4 | `TranscriptView.tsx` | Densest absolute — **tokenize, don’t undensify** |
| 5 | `ApprovalCard.tsx` | Pure micro stack (`10px`×17 + `11px`×6) |

Full Top-40: [`w1-density-grep.md`](./w1-density-grep.md).

### Card-nest

| Sev | Finding |
|---|---|
| **P0** | `/traces` detail compose depth **~5**: DetailPanelShell → TraceDetailPanel → TranscriptV2 → ParallelToolLane → TranscriptView |
| **P0** | `ParallelToolLane` + `TranscriptView` bordered expandables = boxes-on-boxes |
| **P1** | SettingsCard + inner bordered wells; scim/security/roles/autonomous hand-rolled piles |
| **P1** | Card wrapping DataTable (≥10 files) = double frame |
| **P1** | improve change-impact/scorecard KPI Card grids; studio generator Card + mini-cards |

---

## W2-3. Density hotspot TOP-5 (Wave 10 priority)

| # | File | Role | Action |
|---:|---|---|---|
| 1 | `app/(portal)/portal-chrome.tsx` | shell chrome | Breathe; kill `h-5` packing |
| 2 | `app/(portal)/guardrails/page.tsx` | hub wrong-role | Hub calm skin |
| 3 | `app/(portal)/alerts/page.tsx` | hub wrong-role | ≥`text-xs`; drop `py-0.5` |
| 4 | `components/observability/TranscriptView.tsx` | instrument | Tokenize `9/10/11px` → `3xs/2xs/xs` |
| 5 | `components/ai-insights/ApprovalCard.tsx` | overview-adjacent | Demote off instrument floors |

---

## W2-4. Portal-OS + primitives debt (for later implementation waves)

1. Traces → `ResourceOsToolbar` (collapse hand-wired filter+views).
2. Agents / Improve → ResourceOsToolbar (+ optional detail/bulk).
3. Button purge: observability + optimization accent CTAs.
4. Tabs: settings / replay / fleet / issues/[id] → `ui/tabs` where still hand-rolled.
5. QueryState on remaining async hubs; ban `fallback={null}` outside overlay allowlist.
6. Flatten Observe nest (one chrome owner); Card→DataTable single border; SettingsCard children → Panel/open.
7. Adopt `--space-*` utilities beyond portal-os (~9 files today).

---

## W2-5. Exit checklist

- [x] Component inventory refreshed (primitives + portal-os + obs map + card-nest)
- [x] Crowding recount + Top-40 + TOP-5
- [x] Token audit (breathing ladder + adoption skew)
- [x] States / loading / blank-flash map
- [x] Mobile shell refresh
- [x] Specs gap (anti-clutter focus)
- [x] Test / e2e / polish gap map (no band-budget gates yet)
- [x] Layout adoption matrix
- [x] Systems synthesis appended here (Wave 1 surface sections preserved)
- [x] **No product UI code edits**

**Wave 2 exit: MET.**

---

*End of Wave 2 systems append (`w2-systems-synth`).*
