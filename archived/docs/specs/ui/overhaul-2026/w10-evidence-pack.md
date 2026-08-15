# Wave 10 — Cross-cut Verify Evidence Pack

**Agent wave:** `w10-crosscut-verify` (jobs 1–14)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) §AC · [`w3-laminar-acceptance.md`](./w3-laminar-acceptance.md) · [`w3-peer-acceptance.md`](./w3-peer-acceptance.md)  
**Baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) §5–§6

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| **Anti-clutter hard caps (core hubs)** | **PASS** |
| **Top-20 clutter tier drop** | **PASS** (20/20 ≥1 tier) |
| **`polish:check`** | **PASS** |
| **Focused vitest (W5–W9 + W10 a11y)** | **PASS** — 10 files / **75/75** |
| **Industry §AC (binding)** | **PASS** with **2 manual WAIVE** (AC-08/09 stopwatch) + **1 soft WAIVE** (AC-05 painted nest) |
| **Laminar P0 grammar** | **PASS** (35/37; 2 WAIVE) |
| **Peer P0 residuals** | **6 FAIL → WAIVE** with owners (not anti-clutter blockers) — **W14/W15 refresh:** S-06 · I-02 · E-04 · E-08 → **PASS**; D-03 · F-06 remain **WAIVE** |
| **Live `audit:a11y` this session** | **WAIVE** — no server on `:3000`; prior auth reports 0 critical/serious on 8 routes |
| **Golden e2e / screenshots** | **SKIP** — no live portal; checklist at `e2e/golden/w6-visual-smoke-checklist.mjs` |

### Overall: **PASS (ship with documented waivers)**

Anti-clutter doctrine + polish gates are green. Remaining peer interaction residuals and live-only checks are owned WAIVEs — not endless polish.

---

## 1. Job roll-up (14)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w10-density-u19` | **PASS / WAIVE residual** | Shell/hub micro-type eradicated (`polish:check` micro-text 96/112). Instrument TOP hotspots (TranscriptView, ApprovalCard) stay dense via tokens — **WAIVE** endless instrument pixel hunt · Owner: Observe density |
| 2 | `w10-a11y-u20` | **PASS-WITH-GAPS** | Tabs = Radix keyboard; TranscriptView sibling buttons (no nested interactive). FilterBar selects → `min-h-11` + `aria-label`. Live axe WAIVE (no `:3000`) |
| 3 | `w10-mobile-tables` | **PASS** | `w6-tables-mobile.test.ts` green (sticky first-col util + surfaces) |
| 4 | `w10-loading-recipes` | **PASS / WAIVE** | Fleet hides KPI while loading; Settings status uses Loader2. Full Skeleton unification **WAIVE** · Owner: portal-os |
| 5 | `w10-ui-residual` | **WAIVE** | Quiet defaults largely landed W5; remaining ui/* polish · Owner: foundation |
| 6 | `w10-portal-os-residual` | **WAIVE** | Core hubs on `CoreResourcePage`/`ResourcePageShell`; leftover leaves · Owner: portal-os |
| 7 | `w10-auth-billing` | **PASS** | Auth split layout + calm chrome (`w5-b-auth-polish`); billing FinOps under Settings |
| 8 | `w10-icons-ia` | **WAIVE** | Group `id≠label` intentional (`sidebar-config` stable keys). Icon uniqueness not re-audited · Owner: IA |
| 9 | `w10-shell-adoption` | **WAIVE** | Remaining non-hub lists · Owner: portal-os UX-P2-02 |
| 10 | `w10-filter-views-power` | **PARTIAL / WAIVE** | Query suggestions present; **Recent filters** not shipped · Owner: Observe F-10 P1 |
| 11 | `w10-sql-sessions-kpi` | **PASS** | SQL/Query in Traces More (`?view=query`); Home `DEFAULT_WIDGETS=6` + `HOME_KPI_CAP_DESKTOP=7` |
| 12 | `w10-clutter-verifier` | **PASS** | See §2–§3 |
| 13 | `w10-industry-laminar-verifier` | **PASS + WAIVE peers** | See §4 |
| 14 | `w10-polish-evidence` | **PASS** | This pack + commands below |

---

## 2. Clutter verifier — core hubs (AC-01 / AC-03)

Source count 2026-07-20. Shell: `ResourcePageShell` `data-page-bands` is `"1"|"2"` only; KPI chips do not bump bands.

| Hub | bands | toolbar_primary | dual_title | KPI | Verdict |
|---|---:|---:|:---:|---|:---:|
| Traces | 2 | 4 | N | — | **PASS** |
| Issues | 2 | 3–4 | N | — | **PASS** |
| Alerts | 2 (+thin KPI) | 5 | N | 4 severity chips | **PASS** |
| Evals | 2 | 2 | N | — | **PASS** |
| Improve | 2 | 2 | N | — | **PASS** |
| Agents | 2 | 4 | N | — | **PASS** |
| Settings | 1 (+rail) | 0 | N | — | **PASS** |
| Dashboard | 1 | 3 | N | 4 tiles / 6 widgets | **PASS** |

**Vitest locks:** `w6-observe-core`, `w7-satellite`, `w8-evals-ecosystem`, `w9-improve-settings-advanced`, `w5-settings-ia`, `w3-2-traces-hub`.

---

## 3. Top-20 re-score (AC-07)

Formula: [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) §1. Redirects scored on **effective landing**.

| # | Surface | W1 bands | W10 bands | W10 score | Tier | Drop? | Verdict |
|---:|---|---|---:|---:|---|---|---|
| 1 | Traces | 3 | 2 | 0.0 | T0 | Y | **PASS** |
| 2 | Guardrails | 3 | 2 | 0.5 | T0 | Y | **PASS** |
| 3 | Alerts | 4–5 | 2 | 0.5 | T0 | Y | **PASS** |
| 4 | Studio | 2+forms | 3 eff. | 1.5 | T1 | Y | **PASS**† |
| 5 | Replay | 3 | 2 eff. | 1.0 | T0 | Y | **PASS** |
| 6 | Fleet | 3 | 3 eff. | 2.5 | T1 | Y | **PASS**† |
| 7 | Time-Travel | 3 | 2 eff. | 1.0 | T0 | Y | **PASS** |
| 8 | Settings | 2–3 | 2 | 1.0 | T0 | Y | **PASS** |
| 9 | Model Advisor | 2 | 2 hub | 1.0 | T0 | Y | **PASS**† |
| 10 | Users | 2–3 | 3 eff. | 2.5 | T1 | Y | **PASS**† |
| 11 | Tools | 2–3 | 3 eff. | 2.5 | T1 | Y | **PASS**† |
| 12 | Memory facet | 3 | 3 eff. | 2.5 | T1 | Y | **PASS**† |
| 13 | Retrieval facet | 3 | 3 eff. | 2.5 | T1 | Y | **PASS**† |
| 14 | Query DSL | 2 | 2 eff. | 1.0 | T0 | Y | **PASS** |
| 15 | Analytics | 3 | 2 | 0.0 | T0 | Y | **PASS** |
| 16 | Insights | 2–3 | 3 eff. | 1.5 | T1 | Y | **PASS**† |
| 17 | Prompts | 2 | 1–2 | 0.5 | T0 | Y | **PASS** |
| 18 | Agents | 4 | 2 | 0.0 | T0 | Y | **PASS** |
| 19 | Issues | 4 | 2 | 0.0 | T0 | Y | **PASS** |
| 20 | FinOps / Improve | 2–3 | 2 | 0.0 | T0 | Y | **PASS** |

†Tier drops; **embed leaf chrome leak** still soft residual (≤2 hard target on nested leaf tabs). Follow-up owners:

| Residual | Owner |
|---|---|
| Memory/Retrieval nested tabs under Traces facets | Observe |
| Fleet KPI Card strip | Agents |
| Studio local Tabs under Evals | Evals |
| Users/Tools/Insights nested under Analytics | Analytics |
| `/optimization/model-advisor` deep-link (no 308) | Cost / IA |

**Biggest wins:** Alerts 5.5→0.5 · Agents/Issues 4.0→0 · Traces 2.5→0.

---

## 4. Acceptance checklists

### 4.1 Industry §AC (binding ship)

| ID | Verdict | Evidence |
|---|---|---|
| AC-01 Core hubs ≤2 | **PASS** | §2 table + vitest |
| AC-02 Dual identity = 0 | **PASS** | `w5-settings-ia`; clutter lint org-select 0 |
| AC-03 Toolbar ≤5 | **PASS** | §2 primary counts ≤5 |
| AC-04 KPI caps | **PASS** | `DEFAULT_WIDGETS` length 6; `HOME_KPI_CAP_DESKTOP=7` |
| AC-05 Card-nest | **WAIVE** | Owner: W6/W10 · Traces detail flatten partial; painted ≤3 frames not stopwatched |
| AC-06 Progressive disclosure | **PASS** | Legacy in More; facets `?facet=` |
| AC-07 Top-20 tier drop | **PASS** | §3 |
| AC-08 Home &lt;5s | **WAIVE** | Owner: W7→W10 · stopwatch not run (structure supports Status→Action) |
| AC-09 Hub scan &lt;3s | **WAIVE** | Owner: W6–W7→W10 · stopwatch not run |
| AC-10 Settings rail | **PASS** | `w5-settings-ia` |
| AC-11 No dual UI | **PASS** | `portal-hub-redirect` |
| AC-12 Shell micro-type | **PASS** | `polish:check` |

**§AC: 9 PASS · 0 FAIL · 3 WAIVE**

### 4.2 Laminar P0 (S / T / V / D-01…03)

| Group | PASS | FAIL | WAIVE |
|---|---:|---:|---:|
| Shell S-01…S-12 | 11 | 0 | 1 (S-07 banner offset painted) |
| Traces T-01…T-12 | 12 | 0 | 0 |
| Table OS V-01…V-10 | 9 | 0 | 1 (V-08 virtualization load test) |
| Detail D-01…D-03 | 3 | 0 | 0 |
| **Total** | **35** | **0** | **2** |

### 4.3 Peer P0 residuals (WAIVE for ship)

| ID | Issue | Owner | Evidence | Status (W15) |
|---|---|---|---|---|
| D-03 | Fit-to-height list tiles | Dashboard | No `useFitRowCount` | **WAIVE** — needs product widget measure API |
| F-06 | Observe time in PageHeader | Traces | No dedicated Observe time control to relocate | **WAIVE** — inventing Traces time UX = scope creep |
| E-04 | Create/upload dataset in Playground tab | Evals | ~~Bind only~~ | **PASS** — `createAndBindDataset` + Upload/manage link (W15) |
| E-08 | AI `page_context` eval object IDs | AI rail | ~~lacked ids~~ | **PASS** — `dataset_id` / `playground_id` / `experiment_id` in `buildPageContext` (W15) |
| S-06 | ⌘K → `/settings?tab=` | CmdK | ~~Route-level only~~ | **PASS** — `SETTINGS_TAB_COMMANDS` (W14) |
| I-02 | Online-scoring hub entry | Improve | ~~Orphan leaf~~ | **PASS** — Improve PATH_LINKS + ⌘K (W14) |

Closed peers are **not** anti-clutter blockers. Remaining D-03 / F-06 stay owned WAIVEs — see [`w15-harden-evidence.md`](./w15-harden-evidence.md).

---

## 5. Polish / test / a11y evidence

### 5.1 `polish:check` (2026-07-20)

```
lint:portal-layout OK
lint:portal-classes micro-text OK (96/112)
lint:portal-classes half-step OK (138/139)
lint:portal-classes accent-cta OK (6/6)
lint:portal-clutter settings-org-select OK (0)
lint:portal-clutter chrome-band markers OK
lint:portal-clutter tablist-outside OK (2/3)
✓ all polish invariants pass
```

### 5.2 Focused vitest

```
npx vitest run \
  w6-observe-core · w7-satellite · w8-evals-ecosystem ·
  w9-improve-settings-advanced · w5-settings-ia · w6-views-os-hubs ·
  w3-2-traces-hub · w6-tables-mobile · w10-101-a11y-interaction ·
  w5-b-auth-polish
→ Test Files  10 passed · Tests  75 passed
```

### 5.3 A11y

| Check | Result |
|---|---|
| Prior `report-a11y-auth-*.json` (8 routes) | **0 critical · 0 serious** each |
| `/agents`, `/settings` live axe | **WAIVE** — not in prior reports; no `:3000` this session |
| Tabs keyboard | Radix `@radix-ui/react-tabs` (Arrow/Home/End) |
| TranscriptView nested-interactive | **Closed** — sibling buttons (`TranscriptView.tsx` ~343–359) |
| Issues status filter touch | FilterBar `min-h-11` + `aria-label="{label} filter"` |

### 5.4 Golden e2e / screenshots

**SKIP** — portal not running. Re-run when up:

```bash
cd clients/portal
# seed-auth + next start on :3000
npm run audit:a11y
node e2e/golden/w6-visual-smoke-checklist.mjs
```

Prior probe artifacts: `e2e/golden/w10-05-final-probe/`.

---

## 6. Code changes this wave (minimal)

| File | Change |
|---|---|
| `components/ui/filter-bar.tsx` | Selects: `min-h-11` + `aria-label="{label} filter"` |
| `lib/__tests__/w10-101-a11y-interaction.test.ts` | Align Issues status filter assert to ResourceOsToolbar → FilterBar |
| `dashboard/page.tsx` | `HOME_KPI_CAP_DESKTOP=7` compile guard for AC-04 |

---

## 7. Remaining known gaps (post-ship)

1. Live axe `/agents` + `/settings` + refresh of 8-route reports  
2. Manual stopwatch AC-08 / AC-09  
3. Peer WAIVEs remaining: **D-03**, **F-06** (S-06 / I-02 / E-04 / E-08 closed in W14–W15)  
4. Embed leaf chrome leaks (Memory/Retrieval/Fleet/Studio/Analytics children)  
5. Recent filters (F-10 P1)  
6. Model Advisor deep-link 308  
7. Golden visual PNG refresh  
8. Instrument density TOP files — tokenized, not zero-hit  

---

## 8. Wave 10 exit checklist

- [x] Core hubs bands ≤2  
- [x] Dual identity = 0  
- [x] Toolbar primary ≤5 on core hubs  
- [x] KPI Home default within 5–7  
- [x] Top-20 each ≥1 tier drop  
- [x] `polish:check` green  
- [x] Focused W5–W9 vitest green  
- [x] Evidence pack written  
- [ ] Live axe agents/settings (WAIVE)  
- [ ] Stopwatch scan proofs (WAIVE)  

*End of Wave 10 evidence pack.*
