# Wave 3 — Peer Acceptance Criteria (`w3-apply-peer-bar`)

**Agent:** `w3-apply-peer-bar`  
**Date:** 2026-07-20  
**Scope:** Docs only — hub acceptance language for Wave 4/5 implementers. No product code.  
**Inputs:** [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md), [`w2-gap-matrix.md`](./w2-gap-matrix.md), [`w2-langfuse-patterns.md`](./w2-langfuse-patterns.md), [`w2-braintrust-patterns.md`](./w2-braintrust-patterns.md), [`w2-helicone-ia.md`](./w2-helicone-ia.md), [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md), [`w2-phoenix-patterns.md`](./w2-phoenix-patterns.md), [`w2-langsmith-weave.md`](./w2-langsmith-weave.md), [`w1-hub-surfaces.md`](./w1-hub-surfaces.md), [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md)

**Rule:** Match peer **interaction contracts**. Keep Eden moat: dark-terminal brand, AI rail (`ChatSidebar`), Improve ↔ Artifacts ↔ Promotions loop, U12 ≤12 core nav.

**Criterion shape:** Peer source · Eden gap · Measurable check · Priority · Wave 5 owner hint.

**W15 harden status (2026-07-20):** **PASS** S-06 · I-02 · E-04 · E-08 · **WAIVE** D-03 (fit-to-height product) · F-06 (Observe time control not invented). Evidence: [`w15-harden-evidence.md`](./w15-harden-evidence.md) · [`w10-evidence-pack.md`](./w10-evidence-pack.md) §4.3.

---

## 0. Moat guardrails (every hub)

| ID | Guardrail | Measurable check | Pri | W5 owner |
|---|---|---|---|---|
| M-01 | Dark-terminal brand | No light-theme portal; EmptyState terminal variant preserved on hubs | P0 | `w5-polish` |
| M-02 | AI rail first-class | `ChatSidebar` remains sibling of `main` (not Settings-only / header-icon-only) | P0 | `w5-ai-rail` |
| M-03 | U12 ≤12 core | `CORE_NAV_ITEM_COUNT === 12`; no new top-level leaves for peer feature parity | P0 | `w5-ia` |
| M-04 | Improve closed loop | Improve CrossLinkBar retains Issues / Artifacts / Promotions (or equivalent path) | P0 | `w5-improve` |

---

## 1. Dashboard (`/dashboard`)

**Peer bar:** Langfuse Home-as-dashboard + Datadog Status→Diagnosis→Action scan · Helicone Dashboard KPIs · Stripe calm overview.  
**W1 baseline:** 1 chrome band; widget grid; no time header; CTAs Open Traces / Issues / Connect / Edit layout (`w1-hub-surfaces` §1).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| D-01 | Status → Diagnosis → Action scan | Datadog overview; Langfuse Home widgets | Widgets exist but no enforced scan order; CTAs compete with KPI read | First viewport: (1) 5–7 KPI tiles, (2) one diagnosis strip (anomaly/error), (3) ≤3 primary CTAs (Traces / Issues / Connect). No second filter band | **P0** | `w5-dashboard` |
| D-02 | KPI count 5–7 | Langfuse curated Home cards; Helicone Dashboard spend/latency | `DEFAULT_WIDGETS` toggle set unbounded in edit mode | Visible default layout shows **5–7** KPI/list widgets; Edit layout can hide extras but default ≤7 | **P0** | `w5-dashboard` |
| D-03 | Fit-to-height list/bar tiles | Langfuse `useFitRowCount` + Show all | Fixed-content tiles scroll or pad unevenly | List/bar widgets measure tile height; default = no internal scrollbar; “Show all” expands inside tile | **P0** | `w5-dashboard` |
| D-04 | Header time range | Langfuse date in page header | Dashboard has no global time in `PageHeader` | `PageHeader` actions include shared time range; widget queries respect it | **P0** | `w5-dashboard` |
| D-05 | Calm overview density | Datadog overview breathes; Linear/Stripe chrome restraint | Micro-type risk on Home chrome (`text-[10px]` shell spill) | Dashboard chrome uses body/token sizes; no `text-[9px]`/`[10px]` in Home header/CTA row | **P1** | `w5-density` |
| D-06 | Home stays filter-free | Langfuse separates Home viewing from table filter chrome | Risk of copying Traces filter OS onto Home | Zero `QueryFilterBar` / facet chips on `/dashboard` | **P0** | `w5-dashboard` |
| D-07 | Cost as KPI dimension | Helicone: cost on Dashboard + requests, not Cost nav product | Advanced Cost leaf distracts from Home spend story | Home shows ≥1 cost/spend KPI; Cost deep tools not required for first-run scan | **P1** | `w5-ia` |
| D-08 | Composable Home (later) | Langfuse Home selector / Set as default | localStorage widget toggles only | Optional: org-default layout selector — defer until D-01–D-04 land | **P2** | `w5-dashboard` |

---

## 2. Filters OS (Observe hubs — Traces primary)

**Peer bar:** Langfuse dual editor (chips ↔ query string ↔ URL) without cloning sidebar skin · Laminar/Braintrust Views · Phoenix filter+views under one band.  
**W1 baseline:** Traces ~3 bands; `QueryFilterBar` basic\|query; facet chips as separate band; Evals hub has no filters (`w1-hub-surfaces` §2, §4).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| F-01 | Dual-editor contract | Langfuse Filter Search Bar | Basic selects vs query mode; active state buried as muted `text-[10px]` | One control: chip/builder ↔ query string; lossless round-trip; active filters as readable chips (not truncated mono) | **P0** | `w5-filters` |
| F-02 | URL-serializable filters | Langfuse URL share; Laminar views | Partial `useResourceUrlState` | Copy URL → paste → same filters + view; `?q=` / `?filter=` / `?view=` documented | **P0** | `w5-filters` |
| F-03 | No third chrome band | Langfuse rail collapses filters; Laminar one toolbar | Facet chips + QueryFilterBar + tabs = band stack | Traces page chrome ≤2 bands (PageHeader + one toolbar). Facets live as filter predicates or `?facet=`, not a peer row | **P0** | `w5-traces` |
| F-04 | Progressive disclosure | Langfuse active-on-top, Show only active, summaries | Always-visible severity/status strips on Alerts/Issues | Collapsed filter chrome answers “what’s filtering?” via badge/count; focus mode optional | **P0** | `w5-filters` |
| F-05 | Peek, don’t vanish | Langfuse 40px rail + count badge | Filters either full band or gone | Collapsed filters leave persistent peek (badge ≥1 when active) — **Eden toolbar/peek, not Langfuse sidebar skin** | **P0** | `w5-filters` |
| F-06 | Time in header | Langfuse header time | Time packed in Traces toolbar band | Observe time range lives in `PageHeader` (or shell slot); toolbar keeps filters/views/live | **P0** | `w5-traces` |
| F-07 | Views dirty · save · discard | Laminar table views; Braintrust defaults | ViewsMenu partial; columns/sort uneven | Dirty amber when state ≠ saved; Save / Save as / Discard; payload = filters + sort + columns | **P0** | `w5-table-os` |
| F-08 | Hub coverage | Braintrust Display/Filter on Observe | Evals hub has **no** QueryFilterBar | Traces + Issues + Alerts ship Filter OS; Evals primary tabs get list filters where lists exist (P1) | **P0**/P1 | `w5-filters` |
| F-09 | Create alert from filters | Braintrust create-from-filters | Not universal | From Traces filtered view: one action → Alerts rule draft with filter payload | **P1** | `w5-alerts` |
| F-10 | Suggestions / Recent | Braintrust filter UX | Partial / uneven | Observe filter panel lists Recent + Suggestions (≥3 each when history exists) | **P1** | `w5-filters` |
| F-11 | No sidebar skin clone | Gap matrix non-goal | Temptation to pixel-copy Langfuse 280px rail | Dual-editor works inside Eden `QueryFilterBar` / peek; no mandatory left facet sidebar | **P0** | `w5-filters` |

---

## 3. Evals (`/evals`)

**Peer bar:** Braintrust dataset → playground → experiment · Phoenix annotation-on-span · LangSmith/Weave hub nesting (few primaries).  
**W1 baseline:** 7 equal tabs; path named in copy; no CrossLinkBar; no hub filters; promote exists (`w1-hub-surfaces` §4; `w2-braintrust-patterns`).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| E-01 | Primary vs Advanced tabs | Braintrust path objects; LangSmith Datasets & Experiments nesting | 7 peer tabs flatten path | Visual/structural split: **Primary** = Datasets · Playground · Experiments; **Advanced** = Scores · Labeling · Studio · Synthetic (secondary rail, disclosure, or overflow). First-run weight on Primary | **P0** | `w5-evals` |
| E-02 | Path CrossLinkBar | Braintrust bind/promote; Improve already has CrossLinkBar | Evals CrossLinkBar = None | Hub CrossLinkBar: Datasets ↔ Playground ↔ Experiments (+ optional “Promote from Traces”) | **P0** | `w5-evals` |
| E-03 | Scratchpad vs snapshot chrome | Braintrust playgrounds-vs-experiments | Promote exists; permanence not chrome-taught | Playground tab: explicit “runs overwrite” + primary **Promote → Experiment** CTA; Experiments empty of playground-only drafts | **P0** | `w5-evals` |
| E-04 | Dataset bind as CTA | Braintrust inline create/bind | Bind OK; create/upload stays on Datasets tab | Playground: select **or** create/upload dataset without leaving tab | **P0** | `w5-evals` |
| E-05 | Baseline experiment compare | Braintrust compare; LangSmith Set baseline | Multi-select compare partial | Compare mode: set baseline; per-row score deltas; sort by regressions | **P0** | `w5-evals` |
| E-06 | Spreadsheet dataset editor | Braintrust datasets | Detail inline edit PARTIAL; schema/views thin | `/datasets/[id]` (or hub embed): cell edit + row add; schema or typed columns for input/expected/metadata | **P0** | `w5-evals` |
| E-07 | Shared `ui/tabs` | Linear/shadcn; Pattern Library P0-6 | Hand-rolled 7-tab list | Evals hub imports `@/components/ui/tabs` (`variant="underline"`) | **P0** | `w5-primitives` |
| E-08 | AI rail eval context | Braintrust Loop page-scoped; keep Eden ChatSidebar | Pathname context only | With `?tab=` / object id in URL, rail `page_context` includes datasetId / playgroundId / experimentId | **P0** | `w5-ai-rail` |
| E-09 | Annotation → dataset loop | Phoenix annotate→dataset; LangSmith/Weave queues | Labeling peer tab; weak export | From Labeling/review: one-click push to Datasets; CrossLink visible | **P1** | `w5-evals` |
| E-10 | Trace → playground → dataset | Phoenix inspect-to-improve | CrossLink jumps IA | Detail CrossLinkBar: Open playground / Add to dataset land on Primary Evals tabs without orphan dead-ends | **P1** | `w5-evals` |
| E-11 | Online scoring placement clarity | LangSmith Evaluators on tracing project | Online scoring Improve orphan vs Evals Scores | Document single owner surface; Scores tab ≠ online rule CRUD collision (rename or CrossLink) | **P1** | `w5-improve` |
| E-12 | U12 mega-hub OK | Helicone grouping; gap matrix moat | Spec leaf drift vs hub | Keep Evals as one core leaf (≤12); do **not** explode Primary tabs into three sidebar leaves without U12 amendment | **P0** | `w5-ia` |

---

## 4. Settings (`/settings`)

**Peer bar:** Stripe search-first + categorized rail · Linear single identity · Helicone ~10 tabs / Configure · Laminar single org.  
**W1 baseline:** ~21 rail tabs; double “Settings” title; dual org switcher; `Suspense fallback={null}` (`w1-hub-surfaces` §8).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| S-01 | Single title | Linear/Stripe one H1; Pattern Library P0-8 | Rail `<h2>Settings</h2>` + `PageHeader title="Settings"` | Exactly one visible “Settings” heading (rail label non-heading **or** PageHeader only) | **P0** | `w5-settings` |
| S-02 | Single org switcher | Stripe workspace in shell; Helicone Configure | Clerk sidebar + Settings `<Select>` | Org switch only in shell; Settings Org tab edits org **settings**, not switcher. Collapsed sidebar still exposes org (monogram/dropdown) | **P0** | `w5-shell` |
| S-03 | Search-first findability | Stripe settings categories + Eden SettingsSearch | Search = label substring only; ~21 tabs | `SettingsSearch` visible above rail; filters tabs; empty categories hide. Synonyms for SSO/SCIM/PII (P1) | **P0**/P1 | `w5-settings` |
| S-04 | Suspense skeleton | Linear/Stripe never blank | `fallback={null}` | Settings Suspense uses skeleton matching rail+panel; zero `fallback={null}` on settings tree | **P0** | `w5-settings` |
| S-05 | Audience sections | Helicone Org/Developer/Accounts; Stripe Personal/Account/Product | Compliance/Advanced grab-bags; ~21 tabs | Rail grouped ≤6 category headers; target ≤12 **visible** tabs after regroup (hidden gated OK) | **P1** | `w5-settings` |
| S-06 | ⌘K deep-links settings tabs | Linear shortcut teaching; Stripe search | Palette says “settings” but can’t jump to SCIM | Command palette indexes each settings tab label → `/settings?tab=` | **P0** | `w5-cmdk` |
| S-07 | DLQ off product nav | Helicone Developer webhooks in Settings | Webhook DLQ Advanced sidebar child | DLQ only under Settings Developer section; removed from Advanced sidebar children | **P1** | `w5-ia` |
| S-08 | Flat panels, elevated overlays | Linear flat chrome | Risk of card-stack settings | Settings panels: border/bg steps; shadows reserved for modals/cmdk | **P2** | `w5-polish` |

---

## 5. Issues / Alerts

**Peer bar:** Helicone Monitor (Alerts watch vs Settings configure) · Langfuse progressive disclosure · Laminar/Braintrust table OS · Phoenix error-mode clarity.  
**W1 baseline:** Alerts ~4–5 bands (severity + ack + toolbar); Issues 4 bands (section + status×7); BulkActionBar present; Signals dual (`w1-hub-surfaces` §6–7).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| A-01 | Collapse Alerts bands | Langfuse progressive disclosure; Linear one filter band | Feed ~4–5 stacked strips | Alerts feed ≤3 page bands: PageHeader + one toolbar (search/views + severity/ack as chips or disclosure) + table | **P0** | `w5-alerts` |
| A-02 | Issues status as filters | Langfuse active-on-top; Filter OS | Dual tablists (section + 7 status) always expanded | Section tabs (Issues\|Incidents) via `ui/tabs`; status = Filter OS chips / show-active, not second permanent tablist | **P0** | `w5-issues` |
| A-03 | Shared Tabs primitive | Pattern Library P0-6 | Hand-rolled tablists | Issues section tabs + Alerts mode links use `@/components/ui/tabs` or URL modes without hand-rolled a11y debt | **P0** | `w5-primitives` |
| A-04 | Table OS parity | Laminar views; Braintrust Display | Views/filters uneven vs Traces | Issues + Alerts: ResourceOsToolbar + ViewsMenu dirty/save; URL sync | **P0** | `w5-table-os` |
| A-05 | Bulk actions | Laminar/Braintrust selection | Present; keep | Selection → BulkActionBar with ≥ ack/resolve (Issues) and ack (Alerts) | **P1** | `w5-issues` |
| A-06 | Signals single path | Helicone one Monitor Alerts; H10 redirects | `/signals` + `/alerts?tab=signals` | Canonical `/alerts?tab=signals`; `/signals` redirect-only; Advanced Signals leaf removed | **P0** | `w5-ia` |
| A-07 | Watch vs configure | Helicone Monitor vs Settings | Rules panel vs Settings rate-limits dual mental model | Alert **rules** stay on Alerts (`?tab=rules`); delivery/channel config in Settings — CrossLink, not duplicate full pages | **P1** | `w5-alerts` |
| A-08 | Density tokens | Datadog analysis dense; U19 | Alerts page density score hotspot (`text-[10px]`×15) | Replace arbitrary micro-type with `--font-size-2xs/3xs`; severity strip readable at Compact | **P0** | `w5-density` |
| A-09 | Master–detail | Laminar/Braintrust peek | DetailPanelShell exists | Row open keeps list mounted; URL `?id=`; mobile drawer &lt;lg | **P1** | `w5-issues` |
| A-10 | Empty ≠ filtered empty | Laminar/Langfuse state stack | QueryState underused | No alerts + no filters → connect/teach empty; filters on → “No matches” + Clear filters | **P0** | `w5-states` |

---

## 6. Improve queue (`/improve`)

**Peer bar:** Eden moat (keep) · Braintrust Optimize handoff · LangSmith online rules placement clarity · Helicone Improve group for prompt/dataset work — not cost.  
**W1 baseline:** 3 tabs (Queue / Plans / History); CrossLinkBar yes; online-scoring orphan; kanban mobile pain (`w1-hub-surfaces` §5).

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| I-01 | Queue = closed-loop spine | Eden moat; gap matrix §1.2 | Orphans dilute hub (online-scoring, scorecard) | Queue / Plans / History remain hub tabs; CrossLinkBar keeps Issues · Artifacts · Promotions · Scorecard | **P0** | `w5-improve` |
| I-02 | Online scoring discoverable | LangSmith Evaluators near traces | `/improve/online-scoring` CrossLink orphan only | Online scoring reachable as Improve tab **or** documented Observe CrossLink with hub entry — not orphan-only | **P0** | `w5-improve` |
| I-03 | `ui/tabs` on hub | Pattern Library P0-6 | Hand-rolled IMPROVE_TABS | Improve imports `@/components/ui/tabs` | **P0** | `w5-primitives` |
| I-04 | Kanban → list on narrow | W1 mobile; Wave 5 known | xl/2xl columns only | &lt;lg: Queue renders single-column/list; columns at xl+ | **P1** | `w5-improve` |
| I-05 | Filter OS on History/Plans | Filter OS rollup | No hub QueryFilterBar | Plans/History lists use ResourceOsToolbar or equivalent search/filter | **P1** | `w5-filters` |
| I-06 | AI rail on queue cards | Braintrust Optimize; keep ChatSidebar | ApprovalCard density hotspot | Rail opens with selected improve item context; do not replace Improve with peer Loop product | **P1** | `w5-ai-rail` |
| I-07 | Cost not under Improve IA | Helicone H4 | Advanced Cost under `optimize` group | Cost/optimization deep tools not required to understand Improve queue; spend KPIs on Home/Observe | **P1** | `w5-ia` |
| I-08 | Instrument density OK | Datadog analysis; moat | Micro-type on improve page | Queue cards may stay dense via **tokens**, not raw `text-[10px]` sprawl | **P1** | `w5-density` |

---

## 7. Chrome quality bar (Linear / Stripe)

**Peer bar:** Linear spacing ladder + inverted-L restraint · Stripe settings search / workspace · Pattern Library shell P0s.  
**Applies to:** all hubs above; measured on shell + Settings + Observe headers.

| ID | Criterion | Peer source | Eden gap | Measurable check | Pri | W5 owner |
|---|---|---|---|---|---|---|
| C-01 | Spacing ladder | Linear 4·8·12·16·24·32; Stripe Apps tokens | Only `--space-2/3/4` | `--space-1` (4) + `--space-5`… (24/32/48) in `globals.css` + `@theme`; PageHeader / ResourcePageShell / settings rail use tokens | **P0** | `w5-tokens` |
| C-02 | Two-tier chrome | Linear shell vs page identity | Traces/Settings overload | Shell sticky header = location (breadcrumbs + ⌘K); page = one identity `PageHeader`; ≤1 toolbar band | **P0** | `w5-shell` |
| C-03 | Header hierarchy | Stripe workspace + page job title | Thin header vs thick page stacks | No hub stacks three competing titles; Settings passes S-01 | **P0** | `w5-shell` |
| C-04 | ⌘K teaching bar | Linear shortcuts on rows | Chevrons only; weak actions | Palette rows show shortcut glyphs for nav+actions; Recent first | **P0** | `w5-cmdk` |
| C-05 | Button primitive | Linear/Stripe microstates | ~53 raw accent `<button>` | Zero new raw accent buttons; Traces/Settings/Evals CTAs use `Button` | **P0** | `w5-primitives` |
| C-06 | Density beat | Linear 32/40 rows; DensityProvider | Density buried in Settings → Sidebar | Compact/Comfortable discoverable in shell or density menu; header/banner sticky offsets consistent | **P1** | `w5-density` |
| C-07 | AI rail z-index | Eden chrome mapper | `z-30` collision with sticky header | Rail/overlays do not trap under sticky header; documented z ladder | **P0** | `w5-shell` |
| C-08 | Collapse-safe org | Laminar icon rail; P0-9 | Org vanishes when collapsed | Icon-rail monogram opens org switcher | **P0** | `w5-shell` |

---

## 8. Priority rollup (Wave 5 sequencing)

```
P0 Dashboard:   D-01..D-04, D-06
P0 Filters:     F-01..F-07, F-11
P0 Evals:       E-01..E-08, E-12
P0 Settings:    S-01..S-04, S-06
P0 Issues/Alert:A-01..A-04, A-06, A-08, A-10
P0 Improve:     I-01..I-03
P0 Chrome:      C-01..C-05, C-07, C-08
```

**P1** fills Filter suggestions, Settings regroup, Improve mobile list, annotation loops, watch-vs-configure.  
**P2** is Home multi-dashboard, pairwise queues, overlay elevation guardrails.

---

## 9. Explicit non-goals

| Do not | Why |
|---|---|
| Clone Langfuse filter sidebar pixels | Dual-editor contract only (F-11) |
| Clone Braintrust Loop / Linear purple / Stripe blurple | Moat + anti-skins |
| Raise core nav &gt;12 for peer feature count | M-03 / E-12 |
| Flatten AI rail to icon-only | M-02 |
| Add Home QueryFilterBar | D-06 |
| Treat playground runs as durable history without promote | E-03 |

---

## 10. Evidence index

| Hub section | Primary peers | W1 cite |
|---|---|---|
| Dashboard | Langfuse, Datadog, Helicone | `w1-hub-surfaces` §1 |
| Filters OS | Langfuse, Laminar, Braintrust, Phoenix | `w1-hub-surfaces` §2; inventory §7.1 |
| Evals | Braintrust, Phoenix, LangSmith/Weave | `w1-hub-surfaces` §4 |
| Settings | Stripe, Linear, Helicone | `w1-hub-surfaces` §8 |
| Issues/Alerts | Helicone, Langfuse, Laminar | `w1-hub-surfaces` §6–7 |
| Improve | Eden moat, LangSmith, Helicone | `w1-hub-surfaces` §5 |
| Chrome | Linear, Stripe, Laminar shell | `w1-chrome-mapper`; `w2-linear-stripe-chrome` |

---

## 11. Accomplished

- Folded Langfuse / Braintrust / Helicone / Linear / Stripe / Phoenix (+ LangSmith/Weave where Issues/Evals/Improve loop) into **7 hub sections**.
- Each criterion: peer · gap · measurable check · P0–P2 · Wave 5 owner hint.
- Moat guardrails M-01..M-04 bind dark-terminal, AI rail, U12≤12, Improve loop.

*End of `w3-peer-acceptance`.*
