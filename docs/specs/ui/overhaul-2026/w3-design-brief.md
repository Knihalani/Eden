# Wave 4 — Binding Design Brief

**Status:** **Approved-ready** — binding for Waves 5–10  
**Date:** 2026-07-20  
**Agent:** `w4-design-brief` (refresh of Wave 3 brief)  
**Scope:** Docs only. No product UI. **Wave 5 not started.**  
**Audience:** Wave 5–10 implementers + Wave 10 verifiers  
**Baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md)  
**Anti-clutter SoT:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)  
**Industry:** [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) · [`w2-gap-matrix.md`](./w2-gap-matrix.md) · [`w2-laminar-contracts.md`](./w2-laminar-contracts.md)

**Rule:** Clone peer **interaction grammar** (chrome bands, table OS, dirty views, master–detail, state stack). Keep Eden tokens, U12 ≤12 core, `portal-os` / `ui` components. **Not** a visual skin.

---

## 0. Success definition (read first)

**The overhaul succeeds when the portal no longer feels cluttered, crowded, visually overwhelming, or confusing.**

Operators open Home and know Status→Action in &lt;5s. They open Traces (and every core hub) and see **one identity + one toolbar** — not three stacked chrome bands, dual titles, or peer legacy tools fighting filters. Secondary power lives in overflow. Cards are not nested into lasagna. KPI strips stay within budget. Instrument surfaces (Transcript, triage) stay dense **via tokens**, not by packing more header chrome. Dual routes that look like second products are gone.

That calm bar is measured by [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) and the anti-clutter checkboxes in [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) §AC. Pattern Library P0–P10 and moat checks still apply — but **feature-complete yet still overwhelming = FAIL**.

---

## 1. Purpose & status

This brief is the **single binding exit** of Wave 4 contracts. Waves 5–10 implement and verify against it, the anti-clutter contract, and the sibling specs it indexes. Opinions outside these docs do not override P0.

| Field | Value |
|---|---|
| **Authority** | Binding for W5 foundation · W6–W9 surfaces · W10 verify |
| **Date** | 2026-07-20 |
| **Approval** | **Approved-ready** — ship gate for starting Wave 5 |
| **Implementation gate** | **No Wave 5 product code until this brief + anti-clutter contract are treated as approved** |
| **Primary peer** | Laminar (OSS) — structure, not pixels |
| **Severity source** | [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) (extend IDs; do not fork tickets) |
| **Ship checklist** | [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) + §AC anti-clutter |

**Exit of overhaul:** Pattern Library **P0-1…P0-10** PASS + moat checklist + **anti-clutter checklist 100% PASS** on core hubs; every hub/leaf in W5–W9 migrated or deferred with owner in W10.

---

## 2. Problem statement (Wave 1–2 evidence)

Eden already has the right **components** (`portal-os`, `ui/tabs`, `Button`, `QueryState`, `ViewsMenu`, `DetailPanelShell`). Operators still feel overwhelmed because **too much chrome at once** and **grammar drift** drown content.

| Failure | Live fact | Path / cite |
|---|---|---|
| Traces triple chrome | **3** page bands: PageHeader + Tabs + QueryFilterBar OS — **FAIL ≤2** | `traces/page.tsx` · inventory §5–§6 |
| Top-20 overwhelm | Traces, Guardrails, Alerts, Studio, Replay, Fleet, … locked | inventory §6 |
| Settings rail density | `dual_title` = **N** but **19** visible tabs / 6 groups | Settings hub · inventory |
| Crowding TOP-5 | portal-chrome · guardrails · alerts · TranscriptView · ApprovalCard | Wave 2 append |
| Card nest | Traces detail compose **~5** deep | Wave 2 card-nest |
| Shell amplify | Worst-case **~7** main-column bands with banners | chrome-mapper |
| Dual / orphan IA | `/observability/*`, optimization deep-links, signals/incidents gaps | redirect-ia |
| Density without roles | Arbitrary micro-type on hub chrome; instrument needs tokens | density-grep · density-rules |
| KPI over budget | Home default widgets at/over 5–7 glance budget | web-ux-standards |

---

## 3. Industry bar — Pattern Library P0-1…P0-10

Normative steal-list: [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) §1. Contracts: [`w2-laminar-contracts.md`](./w2-laminar-contracts.md). Must-match vs moat: [`w2-gap-matrix.md`](./w2-gap-matrix.md) §1.

| ID | Name | Eden must ship | Backlog |
|---|---|---|---|
| **P0-1** | Single Observe chrome band | `/traces` = Identity + **one** toolbar; facets inside filters; legacy → overflow | UX-P0-01, UX-P0-09 |
| **P0-2** | Table views OS | Dirty amber · Save / Save as / Discard; columns+sort+filters | UX-P0-10 |
| **P0-3** | Master–detail | `?traceId=` + `DetailPanelShell`; list stays mounted | UX-P0-07 |
| **P0-4** | Transcript-first modes | Default Transcript; modes via `ui/tabs` in detail | UX-P0-08 |
| **P0-5** | Filter OS | Chips ↔ query; sticky in toolbar; facets = `?facet=` | UX-P0-09 |
| **P0-6** | Canonical hub Tabs | All hubs import `@/components/ui/tabs` | UX-P0-05 |
| **P0-7** | Empty / filter-empty / error / loading | `QueryState` default; ban hub/Settings `fallback={null}` | UX-P0-04, UX-P0-11 |
| **P0-8** | Settings chrome hygiene | One “Settings” title; zero page-body org Select; grouped rail | UX-P0-02 |
| **P0-9** | Collapse-safe context switcher | Icon rail opens org without Settings detour | UX-P0-03 |
| **P0-10** | Overview vs analysis density | Home/hub calm; instrument dense via tokens | UX-P0-12, UX-P0-08 |

**Gap-matrix extras:** Button CTA purge (**UX-P0-06**), orphan redirects (**UX-P0-13**), mobile Agents (**UX-P0-14**), core a11y (**UX-P0-15**).

**Anti-clutter overlay (binding):** Every P0 above must also satisfy [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) hard caps (bands ≤2, toolbar ≤5, dual-title=0, card-nest ban).

---

## 4. Brand & moat (keep)

| Moat | Contract |
|---|---|
| **Dark-terminal brand** | Dark-only portal; terminal `EmptyState`; no peer light skin |
| **AI rail** | `ChatSidebar` sibling of `main`; fix z-index vs sticky header |
| **U12 ≤12 core** | `CORE_NAV_ITEM_COUNT === 12`; Advanced default collapsed |
| **Instrument density** | Transcript / alerts triage / Improve queue stay dense via tokens — do **not** flatten to marketing whitespace |
| **Improve closed loop** | Improve ↔ Artifacts ↔ Promotions ↔ Audit/Ledger discoverable; CrossLinkBar = glue, not a third Traces band |
| **Governance** | Audit / Ledger / Compliance reachable |

**Live core-12:** Home · Traces · Agent Issues · Alerts · Evals · Improve · Artifacts · Ledger · Promotions · Audit trail · Settings · Quickstart — [`w3-ia-nav.md`](./w3-ia-nav.md).

---

## 5. Non-goals

| Do not | Why |
|---|---|
| Clone Laminar SQL Editor as P0 | Escape hatch after Filter/Views OS |
| Langfuse filter sidebar pixel clone | Dual-editor contract only |
| Braintrust Loop product clone | Product, not chrome |
| Light-mode portal | Brand moat |
| Raise core nav &gt;12 | Fix via hubs/Advanced |
| “Declutter” by deleting Improve/governance | Moat |
| Start Wave 5 before this brief + anti-clutter approved | Implementation gate |

---

## 6. Must-ship for Waves 5–10 (ranked)

Owners = plan agent IDs. Paths are primary touch files.

### 6.1 Wave 5 — Foundation (enforce breathing room)

| # | Must-ship | Pattern / UX | Owner | Primary paths |
|---:|---|---|---|---|
| 1 | Spacing ladder `--space-1`…`8` + type utilities | UX-P1-02 | `w5-spacing-tokens` | `globals.css` · PageContent/PageHeader |
| 2 | Type ladder; ban new chrome micro-px | Hierarchy · anti-clutter §7 | `w5-type-tokens` | globals + lint |
| 3 | CTA → `Button`; purge raw accent | UX-P0-06 | `w5-button-purge` | ui/button · hotspots |
| 4 | Hub Tabs → `ui/tabs` | P0-6 · UX-P0-05 | `w5-tabs-primitive` | hubs + Settings rail |
| 5 | QueryState + ban hub/Settings null Suspense | P0-7 · UX-P0-04/11 | `w5-query-state` | hubs · settings |
| 6 | Flatten default card chrome / composites | Card-nest ban | `w5-ui-composites` | Empty/Error/FilterBar |
| 7 | Collapse-safe org; dual identity paths closed | P0-8/9 · UX-P0-02/03 | `w5-shell-org` | portal-chrome · settings |
| 8 | AppShell padding rhythm; fewer sticky layers | Anti-clutter shell | `w5-appshell` | AppShell · portal-chrome |
| 9 | Resource shells **hard-code ≤2 page bands** | Hierarchy · anti-clutter §3 | `w5-resource-shells` | ResourcePageShell · DetailPanelShell |
| 10 | Orphan / dual route redirects | UX-P0-13 | `w5-ia-redirects` | next.config · portal-hub-redirect |
| 11 | Mobile Agents in More; no packed bottom nav | UX-P0-14 | `w5-mobile-ia` | MobileBottomNav |
| 12 | Clutter lint gates (band / dual-title / nested-card ratchets) | Anti-clutter §9 | `w5-lint-gates` | lint-portal-*.cjs · polish-check |

### 6.2 Waves 6–9 — Surfaces (declutter by family)

| Wave | Focus | Anti-clutter must |
|---|---|---|
| **6 Observe core** | Traces ≤2 bands; filter/views/detail/transcript | UX-P0-01/07/08/09/10; card-nest flatten |
| **7 Observe satellite + Home** | Issues/Alerts/Agents/Dashboard copy Trace grammar | Band ≤2; KPI caps; Top-20 rows 3,6,18,19 |
| **8 Evaluate** | Evals hub + Studio/leaves quiet | Top-20 Studio; no snowflake chrome |
| **9 Improve / Settings / Advanced / AI** | Settings grouped rail; Guardrails/Optimize calm; AI less loud | Top-20 Settings, Guardrails, FinOps, ApprovalCard |

### 6.3 Wave 10 — Verify

| # | Must-ship | Owner |
|---:|---|---|
| 1 | Re-score Top-20; core hubs bands ≤2; dual-title=0; toolbar ≤5; card-nest; Home &lt;5s | `w10-clutter-verifier` |
| 2 | Industry + Laminar + peer + **§AC anti-clutter** | `w10-industry-laminar-verifier` |
| 3 | Density U19 + a11y U20 + polish evidence | `w10-density-u19` · `w10-a11y-u20` · `w10-polish-evidence` |

---

## 7. Contracts summary (sibling specs)

| Spec | Binding content |
|---|---|
| [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) | **Clutter formula · caps · overflow · card-nest · dual-title** |
| [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) | Band budget; hub-by-hub targets; ban list |
| [`w3-component-contract.md`](./w3-component-contract.md) | Button · Tabs · QueryState · shells · R10 chrome |
| [`w3-density-rules.md`](./w3-density-rules.md) | Overview calm / analysis tokenized |
| [`w3-spacing-tokens.md`](./w3-spacing-tokens.md) | `--space-1`…`8`; type ladder |
| [`w3-ia-nav.md`](./w3-ia-nav.md) · [`w3-redirect-ia.md`](./w3-redirect-ia.md) | Core-12 + redirects |
| [`w3-a11y.md`](./w3-a11y.md) | WCAG 2.2 AA portal set |
| [`w2-web-ux-standards.md`](./w2-web-ux-standards.md) | Cognitive load · progressive disclosure |
| [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md) | Single identity · quiet chrome |
| [`w2-datadog-llm.md`](./w2-datadog-llm.md) | Role density without header packing |
| [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) | Ship checklist + §AC |
| [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) | Ranked UX-P* + Top-20 P0 map |

**Wave 2 Laminar contracts remain normative:** [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) §A–§C.

---

## 8. Ranked backlog pointer

**Full ranked backlog:** [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md)

| Severity | Role |
|---|---|
| **P0** | Blocks calm Observe OS / identity / states / redirects / **every Top-20 clutter hotspot** |
| **P1** | Tokens, mobile, Display/Live/Bulk, Settings grouping |
| **P2** | Icons, shell adoption, filter power |
| **P3** | Explicit non-goals |

Do not invent parallel ticket IDs. Reference `UX-P*-**` + Pattern Library `P0-*` + anti-clutter caps.

---

## 9. Industry acceptance pointer

**Ship checklist:** [`w3-industry-acceptance.md`](./w3-industry-acceptance.md)

| Layer | Role |
|---|---|
| Industry rollup + **§AC anti-clutter** | Final ship SoT |
| Laminar / peer acceptance | Observe + hub detail |
| Anti-clutter contract | Formula + hard caps |

**Fail rule:** Any **P0** or **§AC** checkbox FAIL → Wave 10 blocks ship. P1 may WAIVE with linked ticket.

---

## 10. Success metrics

| ID | Metric | Target |
|---|---|---|
| **M0** | **Anti-clutter calm bar** | Core hubs bands ≤2; dual-title=0; toolbar ≤5; Top-20 tier drop; Home &lt;5s |
| **M1** | Traces page chrome bands | **≤2** |
| **M2** | Pattern Library P0-1…P0-10 | **10/10 PASS** |
| **M3** | Hub `ui/tabs` | All core hubs |
| **M4** | Raw accent CTAs | 0 new; purge touched |
| **M5** | `fallback={null}` Settings/hubs | 0 (overlay allowlist) |
| **M6** | QueryState on async hubs | Traces + Issues + Alerts + Evals + Improve + Agents |
| **M7** | Views dirty OS | Traces + Issues + Alerts |
| **M8** | Master–detail | `?traceId=`; list mounted |
| **M9** | Settings identity | One title; one org (shell) |
| **M10** | Collapse-safe org | 64px rail works |
| **M11** | Density | 0 raw 9–11px on shell/hub chrome |
| **M12** | Home Status→Action | &lt;5s; KPI 5–7 / 3–4 mobile |
| **M13** | U12 | `CORE_NAV_ITEM_COUNT === 12` |
| **M14** | Mobile Agents | In More |
| **M15** | Redirects | Dual orphans closed |
| **M16** | A11y | `audit:a11y` green; TranscriptView H2 |
| **M17** | Moat | Dark-terminal + AI rail + Improve loop |
| **M18** | Wave 10 verifier | Industry + §AC PASS |

---

## 11. Explicit: Wave 5 not started — implementation gate

| Gate | Status |
|---|---|
| Wave 1–2 discovery | **Complete** |
| Wave 3 peer research | In progress / corpus present — Wave 4 used current files |
| Wave 4 contracts + this Design Brief + anti-clutter | **Complete — Approved-ready** |
| **Wave 5 product UI** | **NOT STARTED** |

**Allowed before Wave 5 code:** docs under `docs/specs/ui/overhaul-2026/` only.

**Wave 5 may begin when:** an owner treats this brief + [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) as approved, picks a §6.1 must-ship row, cites `UX-P0-*` / anti-clutter cap, and opens a scoped PR. First slice recommendation: **lint/shell band budget → tokens → Traces chrome collapse (P0-1)**.

**Do not:** start Wave 6 surface work as a substitute for foundation gates; do not expand core nav; do not introduce peer skins.

---

## Appendix A — Document index (Wave 4 fold-in)

| Artifact | Agent |
|---|---|
| `w3-design-brief.md` | `w4-design-brief` (**this file**) |
| `w4-anti-clutter-contract.md` | `w4-anti-clutter-contract` |
| `w2-web-ux-standards.md` | `w4-web-ux-standards` |
| `w2-linear-stripe-chrome.md` | `w4-linear-stripe` |
| `w2-datadog-llm.md` | `w4-datadog-density` |
| `w3-hierarchy-spec.md` | `w4-hierarchy-spec` |
| `w3-density-rules.md` | `w4-density-rules` |
| `w3-spacing-tokens.md` | `w4-spacing-tokens` |
| `w3-component-contract.md` | `w4-component-contract` |
| `w3-ia-nav.md` / `w3-redirect-ia.md` | `w4-ia-nav-redirect` |
| `w3-p0-p3-backlog.md` | `w4-backlog` |
| `w3-industry-acceptance.md` | `w4-acceptance` |
| `w3-a11y.md` | cross-link refresh |

---

## Appendix B — One-page operator promise

After Waves 5–10:

1. Open **Traces** → one header + one toolbar → table → detail without leaving the list.  
2. Switch org from a **collapsed** sidebar.  
3. Settings has **one** title, **one** workspace control, and a scannable grouped rail.  
4. Filters/views round-trip in the URL; dirty views warn amber.  
5. Empty ≠ filtered-empty ≠ error; never a blank Settings flash.  
6. Home answers Status→Action in seconds; analysis panels stay dense **with tokens**.  
7. Core nav stays **12**; secondary tools hide until needed; the portal feels **calm**.

---

*End of binding Design Brief. Wave 5 not started.*
