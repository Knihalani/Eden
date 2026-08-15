# Portal UI Overhaul 2026 — Discovery, Competitive & Design Specs

**Scope:** `clients/portal` product surface  
**Brand:** Keep dark-terminal / Linear-adjacent identity — clarity + rhythm + hierarchy overhaul, not a new visual skin.  
**Industry bar:** Meet or beat peer UX patterns (esp. **Laminar** OSS) — clone **interaction/layout**, not competitor skins.  
**Primary outcome:** Portal stops feeling cluttered / crowded / overwhelming / confusing — [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md).

| Wave | Status | Exit |
|---|---|---|
| **1 — Eden Surfaces** | **Complete (2026-07-20)** | Routes + chrome bands + clutter scores + Top-20 overwhelm locked |
| **2 — Eden Systems** | **Complete (2026-07-20)** | Components + crowding + card-nest + states + tests |
| **3 — Laminar + peers** | Corpus present | Pattern Library + calm-chrome research |
| **4 — UX contracts** | **Complete — Approved-ready (2026-07-20)** | Design Brief + **anti-clutter contract** + hierarchy/density/spacing/component/IA/backlog/acceptance |
| **5 — Foundation** | **Complete (2026-07-20)** | Tokens · primitives · shell band budget · redirects · clutter lint (in tree) |
| **6–9 — Surfaces** | **Complete (2026-07-20)** | Observe → Evals → Improve/Settings (10-wave plan) |
| **10 — Cross-cut verify** | **Complete — PASS with waivers (2026-07-20)** | Clutter verifier · industry §AC · polish · evidence pack |
| **11–14 — Debug → Interaction** | **Complete (2026-07-20)** | Perf · visual · interaction polish |
| **15 — Harden** | **Complete — PASS (2026-07-20)** | Lint ratchets · peer closures · touch · regression · [`w15-harden-evidence.md`](./w15-harden-evidence.md) |
| **16 — Marketing + Docs** | **Complete — PASS (2026-07-20)** | Brand · hero · sections · docs nav/chrome · a11y/perf · cross-links · [`w16-marketing-docs-evidence.md`](./w16-marketing-docs-evidence.md) |

**Defaults:** Waves **1–4** = docs / research / contracts. Waves **5–10** = product + ship gate. Waves **11–15** = portal polish + harden. Wave **16** = marketing + public docs polish. **Ship verdict:** anti-clutter PASS — see [`w10-evidence-pack.md`](./w10-evidence-pack.md). **Waves 11–16 complete.**

---

## Wave 4 — Web UX standards + binding contracts (docs-only)

**Goal:** Encode anti-clutter into enforceable contracts so Waves 5–10 cannot ship “feature-complete but still overwhelming.”

| # | Job | Artifact | Status |
|---|---|---|---|
| 1 | `w4-web-ux-standards` | [`w2-web-ux-standards.md`](./w2-web-ux-standards.md) | Refreshed |
| 2 | `w4-linear-stripe` | [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md) | Refreshed |
| 3 | `w4-datadog-density` | [`w2-datadog-llm.md`](./w2-datadog-llm.md) | Refreshed |
| 4 | `w4-hierarchy-spec` | [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) | Refreshed (+ toolbar/KPI caps) |
| 5 | `w4-anti-clutter-contract` | [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) | **CREATED** |
| 6 | `w4-density-rules` | [`w3-density-rules.md`](./w3-density-rules.md) | Refreshed |
| 7 | `w4-spacing-tokens` | [`w3-spacing-tokens.md`](./w3-spacing-tokens.md) | Refreshed |
| 8 | `w4-component-contract` | [`w3-component-contract.md`](./w3-component-contract.md) | Refreshed (+ R13) |
| 9 | `w4-ia-nav-redirect` | [`w3-ia-nav.md`](./w3-ia-nav.md) · [`w3-redirect-ia.md`](./w3-redirect-ia.md) | Refreshed |
| 10 | `w4-backlog` | [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) | Top-20 → UX-CL-01…21 |
| 11 | `w4-acceptance` | [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) | **§AC** anti-clutter (12) |
| 12 | `w4-design-brief` | [`w3-design-brief.md`](./w3-design-brief.md) | Declutter = success ¶1 |

Also: [`w3-a11y.md`](./w3-a11y.md) cross-linked to §AC / Wave 10.

### Wave 4 exit

- [x] Design Brief **Approved-ready** (declutter first; binding Waves 5–10)
- [x] Anti-clutter contract **Approved-ready** (formula · caps · overflow · card-nest · dual-title · toolbar ≤5 · band ≤2 · KPI)
- [x] Sibling contracts refreshed
- [x] Top-20 clutter hotspots each have P0 (`UX-CL-*` / existing `UX-P0-*`)
- [x] Industry acceptance includes anti-clutter checkboxes
- [x] **No product UI code**

**Do not start Wave 5** until brief + anti-clutter are treated as approved.

---

## Binding authority (after Wave 4)

| Doc | Role |
|---|---|
| [`w3-design-brief.md`](./w3-design-brief.md) | Must-ship for Waves 5–10 |
| [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) | Clutter formula + hard caps |
| [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) | Ranked UX-P0…P3 + UX-CL-* (66 items) |
| [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) | Ship checklist (72 checks) + Wave 10 verifier |

### Supporting contracts

| Artifact | Purpose |
|---|---|
| [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) | Band budget; CTA/KPI caps; ban list |
| [`w3-density-rules.md`](./w3-density-rules.md) | Overview calm / analysis tokenized |
| [`w3-spacing-tokens.md`](./w3-spacing-tokens.md) | `--space-1`…`--space-8` + type ladder |
| [`w3-component-contract.md`](./w3-component-contract.md) | Button · Tabs · QueryState · shells · R13 |
| [`w3-ia-nav.md`](./w3-ia-nav.md) | U12 core-12 lock |
| [`w3-redirect-ia.md`](./w3-redirect-ia.md) | Orphan redirects / nests |
| [`w3-a11y.md`](./w3-a11y.md) | WCAG 2.2 AA portal set |
| [`w3-laminar-acceptance.md`](./w3-laminar-acceptance.md) | Laminar must-match |
| [`w3-peer-acceptance.md`](./w3-peer-acceptance.md) | Peer hub criteria |

---

## Wave 2 — Competitive + systems

| Artifact | Purpose |
|---|---|
| [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) | Steal-list (P0–P2) |
| [`w2-gap-matrix.md`](./w2-gap-matrix.md) | Must-match vs moat |
| [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) | Shell · traces · table OS |
| [`w2-web-ux-standards.md`](./w2-web-ux-standards.md) | Cognitive load · progressive disclosure |
| [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md) | Calm craft · single identity |
| [`w2-datadog-llm.md`](./w2-datadog-llm.md) | Role density |

Systems discovery: Wave 2 append on [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) (crowding TOP-5, card-nest ~5 deep on Traces detail).

---

## Wave 1 — Eden Surface Discovery

**Exit:** Every portal route classified; Top-20 overwhelm locked. Live headlines: Traces **3 bands** (FAIL ≤2); Settings **dual_title=N** but 19-tab rail; crowding leaders Artifacts **6.5** · Alerts **5.5** · Audit **5.0**.

| Artifact | Purpose |
|---|---|
| [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) | Master inventory + clutter baseline + Top-20 |
| [`w1-hub-surfaces.md`](./w1-hub-surfaces.md) | Hub band counts + clutter scores |
| Sibling `w1-*.md` | Routes, chrome, IA, leaves, redirects, density, tokens, states, tests |

---

## Wave 6 — Polish + verify (product)

**Goal:** Close mobile, a11y/motion, auth/marketing token sync, onboarding path hygiene, empty/error voice, i18n key coverage, visual-regression map, perf thrash, QA smoke matrix, and docs sync — without filling the full industry checklist (final-verifier owns that).

| # | Job | Artifact / outcome | Status |
|---|---|---|---|
| 1 | `w6-mobile-nav` | Grouped More sheet; Agents first; `text-2xs` | **Done** |
| 2 | `w6-tables-mobile` | Sticky util + fleet / runs / cohorts / query | **Done** |
| 3 | `w6-motion-a11y` | `FOCUS_RING`; audit routes expanded; [`w6-a11y-evidence.md`](./w6-a11y-evidence.md) | **Done** (live axe blocked — no `:3000`) |
| 4 | `w6-auth-marketing` | Token / spacing sync; no rebrand | **Done** |
| 5 | `w6-onboarding` | Kill `isOnboardingWizardPath` + `isWaitPath` | **Done** |
| 6 | `w6-empty-microcopy` | Hub empty / error voice | **Done** |
| 7 | `w6-i18n` | +147 keys `en`/`de`; portal intl still unwired (P25) | **Done-with-gaps** |
| 8 | `w6-visual-regression` | [`w6-visual-regression.md`](./w6-visual-regression.md) + smoke checklist; no PNG refresh | **Done-with-gaps** |
| 9 | `w6-perf-check` | [`w6-perf-check.md`](./w6-perf-check.md) — JobGantt FM removed | **Done-with-gaps** (PASS-WITH-GAPS) |
| 10 | `w6-docs-sync` | This README + U18/U19/U20 status notes | **Done** |
| 11 | `w6-qa-matrix` | [`w6-qa-matrix.md`](./w6-qa-matrix.md) — 22 PASS / 6 FAIL / 12 UNVERIFIED | **Done-with-gaps** |
| 12 | `w6-final-verifier` | [`w6-verification-report.md`](./w6-verification-report.md) | **Done** — industry checklist **~54/72** after gap-close (Views OS + Timeline) |

### Wave 6 evidence

| Doc | Role |
|---|---|
| [`w6-verification-report.md`](./w6-verification-report.md) | Final-verifier rollup — lint/test evidence + industry scoreboard |
| [`w6-a11y-evidence.md`](./w6-a11y-evidence.md) | Focus rings · motion · axe gate status |
| [`w6-perf-check.md`](./w6-perf-check.md) | Framer / layout thrash inventory |
| [`w6-qa-matrix.md`](./w6-qa-matrix.md) | Critical-flow Laminar/peer smoke |
| [`w6-visual-regression.md`](./w6-visual-regression.md) | Golden coverage map + re-baseline commands |

### Wave 6 exit

- [x] Mobile nav + sticky tables shipped
- [x] A11y focus/motion contract advanced; live axe deferred to running portal
- [x] Auth/marketing token sync (no rebrand)
- [x] Onboarding dead-path helpers removed
- [x] Hub empty/error microcopy pass
- [x] i18n keys added (`en`/`de`); runtime wiring = P25
- [x] Visual regression map + smoke checklist (PNG refresh blocked)
- [x] Perf: JobGantt motion stripped; residual gaps documented
- [x] QA matrix published (22 / 6 / 12)
- [x] Specs U18–U20 + this README marked complete / deferred honestly
- [x] Full [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) checkbox fill → **final-verifier** ([`w6-verification-report.md`](./w6-verification-report.md): **~54/72** `[x]` after gap-close; **~18** open)
- [x] **Gap-close pass (2026-07-20):** Issues/Alerts Views OS + Trace Timeline mode (P0-2 / §2.2 / P0-4)

---

## Wave 10 — Cross-cut density, a11y, clutter verify (ship gate)

**Status:** **Complete — PASS with waivers (2026-07-20)**  
**Evidence:** [`w10-evidence-pack.md`](./w10-evidence-pack.md)

| Gate | Result |
|---|---|
| Core hubs bands ≤2 · toolbar ≤5 · dual identity 0 | **PASS** |
| Top-20 clutter tier drop | **PASS** (20/20) |
| `polish:check` + W5–W9 vitest (75/75) | **PASS** |
| Industry §AC | **9 PASS · 3 WAIVE** (AC-05/08/09) |
| Live axe / golden e2e / stopwatch | **WAIVE / SKIP** (no `:3000`) |

### Leftover known gaps (honest)

| Gap | Source | Disposition |
|---|---|---|
| Live `audit:a11y` on `:3000` (incl. `/agents`, `/settings`) | [`w6-a11y-evidence.md`](./w6-a11y-evidence.md) · [`w15-harden-evidence.md`](./w15-harden-evidence.md) | Run when portal up |
| ~~Issues + Alerts lack `ViewsMenu` / dirty views OS~~ | gap-close | **Closed** — `ResourceOsToolbar` + `w6-views-os-hubs` |
| ~~Trace detail **Timeline** mode missing~~ | gap-close | **Closed** — `TRACE_DETAIL_MODE_TABS` + `useTraceTimeline` |
| Portal intl runtime unwired (P25) despite +147 keys | `w6-i18n` | Maintenance |
| Golden PNG refresh not run (no server) | [`w6-visual-regression.md`](./w6-visual-regression.md) | Re-baseline when `:3000` + auth |
| LiveTail `offsetWidth` pulse restart (P2) | [`w6-perf-check.md`](./w6-perf-check.md) | Non-P0 |
| ~~⌘K Settings tab deep-link gap~~ | [`w14-interaction-evidence.md`](./w14-interaction-evidence.md) | **Closed (S-06)** |
| Peer D-03 / F-06 | [`w15-harden-evidence.md`](./w15-harden-evidence.md) | **WAIVE** (product scope) |
| Filter sticky **paint** on Observe hubs | [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) §2.2 | Manual scroll when portal up |
| Painted §AC (bands/KPI/stopwatch) | [`w6-verification-report.md`](./w6-verification-report.md) | Manual when portal up |

---

## Next wave

**Portal polish waves 11–15 complete (2026-07-20).** Harden evidence: [`w15-harden-evidence.md`](./w15-harden-evidence.md).  
**Next:** Wave **16 — marketing/docs** (not started). Residual live QA (axe / golden / stopwatch) + peer D-03 / F-06 remain maintenance.  
**Verifier:** [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) + [`w6-verification-report.md`](./w6-verification-report.md) + [`w10-evidence-pack.md`](./w10-evidence-pack.md).  
**Related specs:** [`../u18-portal-overhaul.md`](../u18-portal-overhaul.md) · [`../u19-portal-improvement.md`](../u19-portal-improvement.md) · [`../u20-portal-polish.md`](../u20-portal-polish.md).
