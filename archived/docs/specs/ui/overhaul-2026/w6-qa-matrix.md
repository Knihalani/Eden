# Wave 6 — QA Matrix (Critical Flows)

**Agent:** `w6-qa-matrix`  
**Date:** 2026-07-20  
**Scope:** Docs + code inspection (manual browser optional). **No commit.**  
**Bar:** Desktop Comfortable / Compact + Mobile (`<lg`) for 10 critical flows; peer-parity smoke vs [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) §AC + Pattern Library P0 + [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) §A–§C.  
**Density SoT:** [`w3-density-rules.md`](./w3-density-rules.md) · Comfortable = shell/overview calm; Compact = denser rows/nav via `data-density="compact"` (`globals.css`).

### How to read verdicts

| Verdict | Meaning |
|---|---|
| **PASS** | Code (and/or vitest) implements the Laminar/peer criterion; visual stopwatch still recommended for scan timers |
| **FAIL** | Code contradicts the criterion or a required peer control is missing |
| **UNVERIFIED** | Needs live Comfortable/Compact/mobile pass (stopwatch, sticky scroll, band count in painted DOM) |

**Inspection baseline:** working tree under `clients/portal` as of 2026-07-20 (Wave 5+ surface work present despite README “Wave 5 not started” gate note).

---

## Summary counts (Laminar / peer criterion rows)

| Verdict | Count |
|---|---:|
| **PASS** | **22** |
| **FAIL** | **6** |
| **UNVERIFIED** | **12** |
| **Total criterion rows** | **40** |

*(Counts = peer/Laminar acceptance rows in §Flows below — not every Comfortable/Compact checklist bullet.)*

---

## Top 3 risks for `final-verifier` / Wave 10

1. **Issues + Alerts lack Laminar Table Views OS** — Traces wires `ViewsMenu` + `isViewDirty` (filters/sort/columns); Issues/Alerts use `ResourceOsToolbar` only → **P0-2 / §2.2 FAIL** until hubs share the same dirty amber · Save / Save as / Discard path.  
2. **Detail mode parity incomplete** — `TraceDetailPanel` modes = Transcript · Tree · Metadata; **no Timeline** → **P0-4 FAIL** vs Laminar Transcript·Tree·Timeline·Metadata (`w2-laminar-contracts` §B.3).  
3. **Shell micro-type + Home scan still manual gates** — `portal-chrome.tsx` still has raw `text-[10px]` / `text-[9px]` (**AC-12 FAIL**); Home Status→Action &lt;5s and mobile KPI 3–4 (**AC-08 / AC-04**) are **UNVERIFIED** stopwatch/viewport checks — feature-complete Home can still fail the calm bar.

---

## Design Brief must-ship skim (§6.1 Wave 5 Foundation)

Source: [`w3-design-brief.md`](./w3-design-brief.md) §6.1.

| # | Must-ship | Status | Evidence |
|---:|---|---|---|
| 1 | Spacing ladder `--space-1`…`8` | **code-verified** | `clients/portal/src/app/globals.css` `--space-1`…`--space-8` + `--spacing-space-*` |
| 2 | Type ladder; ban chrome micro-px | **needs-manual** (+ residual FAIL) | Tokens present; `portal-chrome.tsx` still has `text-[10px]` / `text-[9px]` (AC-12) |
| 3 | CTA → `Button`; purge raw accent | **needs-manual** | Hubs inspected use `@/components/ui/button`; full hotspot purge not grepped this pass |
| 4 | Hub Tabs → `ui/tabs` | **code-verified** | Traces/Issues/Alerts/Agents/Evals/Improve all import `@/components/ui/tabs` |
| 5 | QueryState + ban null Suspense | **code-verified** (partial) | Issues/Alerts/Agents/Improve use `QueryState`; Traces uses Empty/Error/LoadingSkeleton equivalent; Suspense table skeleton on Traces |
| 6 | Flatten card chrome / composites | **needs-manual** | Agents still card grid; Traces detail nest depth not re-scored |
| 7 | Collapse-safe org; dual identity closed | **code-verified** | `portal-chrome.tsx` OrganizationSwitcher always mounted when collapsed; Settings tests assert single title / no page-body org Select |
| 8 | AppShell padding rhythm | **needs-manual** | Density attribute wired; sticky/banner offset visual check needed |
| 9 | Resource shells ≤2 page bands | **code-verified** (structure) | `ResourcePageShell` = header + toolbar (+ optional kpi); Traces toolbar `data-chrome-band="toolbar"`; painted band count **UNVERIFIED** |
| 10 | Orphan / dual route redirects | **code-verified** | `portal-hub-redirect.ts`: `/observability`→`/traces`, `/fleet`→Agents, `/signals`→Alerts, `/incidents`→Issues |
| 11 | Mobile Agents in More | **code-verified** | `MobileBottomNav.tsx` `MOBILE_MORE_GROUPS` Agents first; `u18-portal` / `w10-w12` tests |
| 12 | Clutter lint gates | **needs-manual** | `lint-portal-layout.cjs` / `lint-portal-classes.cjs` / `polish-check.sh` present; band/dual-title ratchet content not fully audited this pass |

**§6.2–6.3 surface/verify must-ships:** deferred to Waves 7–10 owners — this matrix is the Wave 6 smoke map for critical flows.

---

## Flows

### 1. Home Status→Action

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/dashboard` (Home): subtitle “Status → diagnosis → next action”; KPI strip + diagnosis + next actions (Open Traces / Issues / Connect). Default layout = 4–5 KPI tiles + failures + traces list (`DEFAULT_WIDGETS`). Primary CTAs `min-h-11` Buttons. |
| **Desktop Compact** | Density toggle (Settings → Sidebar prefs → Compact) densifies nav/table chrome via `data-density="compact"`; Home overview should stay readable — Compact must not bury Status→Action below fold with extra chrome. |
| **Mobile (`<lg`)** | Bottom nav: Home. KPI grid `grid-cols-1` stacks; AC-04 expects **3–4** mobile glance metrics — default may still expose 5 KPI ids → risk. Actions remain header Buttons. |
| **Laminar / peer criteria** | **AC-08 / M12 Home Status→Action &lt;5s** → **UNVERIFIED** (stopwatch ×3). **AC-04 KPI caps** → **UNVERIFIED** (desktop 5–7 likely OK; mobile 3–4 **at risk**). **P0-10 overview calm** → **PASS** (structure) / shell micro-type **FAIL** (see chrome). |
| **Evidence** | `dashboard/page.tsx` `:57-69`, `:514-616`, `:819-823`; `globals.css` density block. Scan timers: **needs manual**. |

---

### 2. Traces list → open detail (`?traceId=`) master-detail

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/traces`: Observe eyebrow + Traces title; **one** toolbar (`data-testid="traces-toolbar"`) with underline Tabs (traces\|spans\|sessions) + `QueryFilterBar` + `ViewsMenu` + Live + Refresh + More. Row open → `?traceId=`; list stays mounted; `DetailPanelShell` + `TraceDetailPanel`. ≥1280 (`xl`) split; 768–1279 drawer. |
| **Desktop Compact** | Explorer rows denser (`[data-density=compact] [data-table]`); toolbar still one band; type ≥ `text-xs` for chrome. Dirty amber ViewsMenu still visible. |
| **Mobile (`<lg`)** | Bottom nav Traces. Detail = full-width drawer (`DetailPanelShell` `xl:hidden` overlay). List remains in tree under drawer. |
| **Laminar / peer criteria** | **P0-1 / §B.2 bands ≤2** → **PASS** (code: legacy tools in More, facets in filter/`?facet=`). **P0-3 / §B.4 master–detail** → **PASS**. **P0-2 / §C dirty views** → **PASS** (wired + vitest). **P0-4 Transcript-first modes** → **FAIL** (no Timeline; modes = transcript/tree/meta). **P0-5 Filter OS** → **PASS** (code). **AC-01 / AC-09 hub scan** → **UNVERIFIED** painted. |
| **Evidence** | `traces/page.tsx` toolbar `:517-702`, shell `:833-878`; `DetailPanelShell.tsx` Laminar breakpoints; `TraceDetailPanel.tsx` mode tabs `:25-27`; `w3-2-traces-hub.test.ts`; `useSavedViews` + `ViewsMenu` tests. Sticky filter scroll: **needs manual**. |

---

### 3. Issues inbox

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/issues`: `CoreResourcePage` + PageHeader; Tabs issues\|incidents via `ui/tabs`; list + `?issueId=` → `DetailPanelShell`; bulk triage bar when selected. |
| **Desktop Compact** | List rows denser; toolbar/`ResourceOsToolbar` still scannable; touch floors on actions. |
| **Mobile (`<lg`)** | Bottom nav Issues. Virtualized list + drawer detail; “Open full page” link to `/issues/[id]`. |
| **Laminar / peer criteria** | **P0-6 Tabs** → **PASS**. **Master–detail `?issueId=`** → **PASS**. **§2.2 Views dirty on Issues** → **FAIL** (no `ViewsMenu` / `useSavedViews`). **QueryState** → **PASS**. **AC-01 bands ≤2** → **UNVERIFIED** painted. |
| **Evidence** | `issues/page.tsx` imports + `issueId` / `DetailPanelShell` `:276-521`; greps show **no** ViewsMenu. |

---

### 4. Alerts

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/alerts`: Tabs feed\|signals; `ResourceOsToolbar`; feed rows open `?alertId=` → `DetailPanelShell`; acknowledge + bulk. |
| **Desktop Compact** | Same grammar; denser list rows; severity triage stays readable. |
| **Mobile (`<lg`)** | More → Alerts (not core bottom four). Drawer detail; stacked toolbar. |
| **Laminar / peer criteria** | **P0-6 Tabs** → **PASS**. **Master–detail `?alertId=`** → **PASS**. **§2.2 Views on Alerts** → **FAIL** (no ViewsMenu). **QueryState** → **PASS**. **AC-01 / AC-03 toolbar ≤5** → **UNVERIFIED** painted. |
| **Evidence** | `alerts/page.tsx` `:304+`, `alertId` + DetailPanelShell `:834+`; Mobile More `MOBILE_MORE_GROUPS` workspace. |

---

### 5. Agents list + More→Agents on mobile

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | Sidebar Advanced → Agents (or ⌘K). Hub Tabs agents\|fleet; card grid of agents; Connect CTA path. |
| **Desktop Compact** | Nav compact; card grid padding may tighten; CTAs `min-h-11`. |
| **Mobile (`<lg`)** | **More sheet → Agents first group** (UX-P0-14). Labels `text-2xs` (not raw 10px). Card stack `grid-cols-1`. |
| **Laminar / peer criteria** | **UX-P0-14 / M14 Mobile Agents in More** → **PASS**. **P0-6 Tabs** → **PASS**. **QueryState** → **PASS**. **U12 Agents advanced (not core-12)** → **PASS** (`category: "advanced"`). |
| **Evidence** | `MobileBottomNav.tsx` `:55-60`, `:124`; `u18-portal.test.ts` Agents-first; `agents/page.tsx` card grid + Tabs. |

---

### 6. Improve queue (mobile list vs desktop kanban)

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/improve` tab queue: `lg+` kanban grid (`lg:grid-cols-2` … `2xl:grid-cols-5`) with virtualized columns. |
| **Desktop Compact** | Column cards denser; Approve/Snooze stay ≥ touch floor. |
| **Mobile (`<lg`)** | **List/stack** of populated columns only (`flex flex-col … lg:hidden`); empty columns omitted. Bottom nav Improve is core. |
| **Laminar / peer criteria** | **UX-P1-01 responsive queue** → **PASS**. **P0-6 Tabs** → **PASS**. **QueryState on queue** → **PASS**. **AC-01 bands** → **UNVERIFIED** (CrossLinkBar in header actions — confirm not a third band). |
| **Evidence** | `improve/page.tsx` `:532-600` comment UX-P1-01; CrossLinkBar near header. |

---

### 7. Evals hub primary + Advanced

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/evals`: Primary underline tabs = datasets · playgrounds · experiments; **Advanced** dropdown = eval · labeling · studio · synthetic. Subtitle documents first-run path. |
| **Desktop Compact** | Tabs remain `min-h-11`; Advanced trigger outline when advanced tab active. |
| **Mobile (`<lg`)** | More → Evals. Primary tabs wrap; Advanced in dropdown (not packed bottom nav). |
| **Laminar / peer criteria** | **Evals primary vs Advanced overflow (IA / progressive disclosure)** → **PASS**. **P0-6 Tabs** → **PASS**. **AC-03 / AC-06 CrossLinkBar** → **UNVERIFIED** (`CrossLinkBar` sits in toolbar — confirm ≤5 primary + not peer band). |
| **Evidence** | `evals/page.tsx` `PRIMARY_TABS` / `ADVANCED_TABS` `:29-32`, Advanced menu `:161-189`, CrossLinkBar `:191-194`. |

---

### 8. Settings search + categories

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | `/settings`: search-first rail (`SettingsSearch`); category groups; **one** PageHeader “Settings”; Advanced category default collapsed; search force-expands. Org only via shell Clerk. |
| **Desktop Compact** | Forms stay Comfortable-class (density rules: Settings Compact unused for forms); rail still scannable. |
| **Mobile (`<lg`)** | Horizontal scroll tab rail; search above; bottom padding safe-area. More → Settings. |
| **Laminar / peer criteria** | **P0-8 / AC-10 Settings chrome + search** → **PASS** (code + `w5-settings-ia.test.ts`). **AC-02 dual identity = 0** → **PASS** (tests: no rail h2 Settings; no page-body org Select). **AC-12 shell micro-type** → **FAIL** (`portal-chrome` raw 9/10px). |
| **Evidence** | `settings/page.tsx` `:419-481`; `settings-category-group.tsx` Advanced default collapsed; `w5-settings-ia.test.ts`. |

---

### 9. Connect / onboarding path

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | Home first-run CTAs → Docs / API keys / **Connect** (`/agents/connect`). Page: optional GitHub connect via `OnboardingConnectFlow`; SDK path remains primary. Product tour / banner may appear in shell. |
| **Desktop Compact** | Narrow `PageContent`; CTAs unchanged. |
| **Mobile (`<lg`)** | Reach Connect via Agents (More) → Connect, or Home first-run. NoOrgState if no org. |
| **Laminar / peer criteria** | **Connect path exists + optional (not blocking ingest)** → **PASS**. **End-to-end GitHub install callback** → **UNVERIFIED** (needs live install). **First-run Home &lt;5s** → **UNVERIFIED**. |
| **Evidence** | `agents/connect/page.tsx`; `OnboardingConnectFlow.tsx`; dashboard Connect links `:576-605`. |

---

### 10. ⌘K to Advanced leaf

| Surface | What to check / expected |
|---|---|
| **Desktop Comfortable** | Sticky header Search / ⌘K opens `CommandPalette`. Type e.g. **Guardrails**, **Agents**, **Optimization** — Advanced leaves from `DEFAULT_SIDEBAR` appear even when Advanced sidebar collapsed (U12 rule 3). Enter navigates. |
| **Desktop Compact** | Palette unchanged; header ⌘K kbd may still be `text-[10px]` (cosmetic FAIL under AC-12). |
| **Mobile (`<lg`)** | Header search icon opens same palette; Advanced leaves reachable without expanding desktop Advanced group. |
| **Laminar / peer criteria** | **⌘K indexes core + Advanced** (`w3-industry-acceptance` §1.2) → **PASS** (`buildNavCommands` walks full sidebar including `category: "advanced"`). **Settings tab deep-link from ⌘K** → **FAIL / gap** (peer S-06 / Linear-Stripe P0-4 — palette is route-level `/settings`, not `?tab=scim`). **Manual fuzzy find Guardrails** → **UNVERIFIED** UX polish. |
| **Evidence** | `nav-commands.ts` `buildNavCommands`; `sidebar-config.ts` advanced hrefs `/agents`, `/guardrails`, `/optimization`, …; `command-palette.tsx`; `portal-chrome` ⌘K open. |

---

## Cross-cutting density checklist (all flows)

| Check | Comfortable | Compact | Verdict |
|---|---|---|---|
| Shell `data-density` wired | default | `prefs.density === "compact"` → AppShell | **PASS** code (`portal-chrome.tsx` `:183`, `:580`) |
| Compact shrinks row/nav, not type below `text-xs` for readable UI | — | CSS padding/font on `.nav-item` / `[data-table]` | **PASS** structure / **UNVERIFIED** visual floor |
| Instrument (`TranscriptView`) may stay dense via tokens | — | Independent of shell | **UNVERIFIED** (token migration vs residual `text-[10px]` hotspots) |
| Mobile bottom nav ≥44px targets | — | — | **PASS** (`min-w/h-[44px]`) |

---

## Criterion index (quick)

| ID | Flow(s) | Verdict |
|---|---|---|
| AC-01 bands ≤2 | 2–7 | UNVERIFIED (Traces structure PASS) |
| AC-02 dual identity | 8 | PASS |
| AC-03 toolbar ≤5 | 2,4,7 | UNVERIFIED |
| AC-04 KPI caps | 1 | UNVERIFIED (mobile risk) |
| AC-08 Home &lt;5s | 1,9 | UNVERIFIED |
| AC-09 hub scan &lt;3s | 2–4 | UNVERIFIED |
| AC-10 Settings rail | 8 | PASS |
| AC-12 micro-type | chrome / 8 / 10 | FAIL |
| P0-1 Traces chrome | 2 | PASS |
| P0-2 Table views OS | 2 PASS; 3–4 FAIL | mixed |
| P0-3 Master–detail | 2,3,4 | PASS |
| P0-4 Transcript modes | 2 | FAIL (no Timeline) |
| P0-5 Filter OS | 2 | PASS |
| P0-6 ui/tabs | 2–7 | PASS |
| P0-8 Settings | 8 | PASS |
| P0-9 Collapse org | shell | PASS |
| P0-10 density roles | 1 | PASS structure / UNVERIFIED instrument |
| UX-P0-14 Mobile Agents | 5 | PASS |
| UX-P1-01 Improve responsive | 6 | PASS |
| ⌘K Advanced leaves | 10 | PASS |
| ⌘K Settings tabs | 10 | FAIL |
| Connect path | 9 | PASS / E2E UNVERIFIED |

---

## Manual QA script (optional browser)

1. Comfortable + Compact: Settings → Sidebar → Density; reload each hub.  
2. Stopwatch Home Status→Action ×3 cold loads (AC-08).  
3. `/traces` → open row → confirm URL `?traceId=` + list still visible (split at ≥1280).  
4. Change filter → ViewsMenu amber → Discard / Save.  
5. Issues + Alerts: confirm **missing** dirty views (document FAIL until fixed).  
6. Resize &lt;1024: Improve queue list; Traces/Issues drawer; More → Agents.  
7. ⌘K → “Guardrails” / “Agents” → navigate.  
8. Settings search “SCIM” / “SSO”; Advanced starts collapsed.

---

*End of `w6-qa-matrix`. Owner handoff: Wave 10 `w10-industry-laminar-verifier` + `w10-clutter-verifier` re-run §AC with screenshots.*
