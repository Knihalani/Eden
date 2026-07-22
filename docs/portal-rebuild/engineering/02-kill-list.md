# Kill list — never resurrect

> **Status:** Authoritative reject criteria for portal rebuild PRs.  
> **Parent:** [../README.md](../README.md)  
> **Overview:** [00-overview.md](./00-overview.md)  
> **Teardown:** [01-teardown-runbook.md](./01-teardown-runbook.md)  
> **Decision date:** 2026-07-21  

Ruthless. If a PR reintroduces anything below as **top-level product UI** or as a **pattern**, reject. Redirects-only ghosts are allowed. Mining object names from historical plans is allowed; copying the old UX is not.

Contract tests should eventually `grep`/assert absence of banned symbols and routes.

---

## 1. Routes to delete / never resurrect as top-level

### 1.1 Already removed (keep redirecting to `/dashboard` or successor — never rebuild pages)

| Path prefix | Notes |
|-------------|-------|
| `/marketplace` | Ghost — `REMOVED_PORTAL_PATH_PREFIXES` |
| `/multi-agent` | Ghost |
| `/builder` | Ghost |
| `/jobs` | Ghost |
| `/eval-harnesses` | Ghost |
| `/sandbox` | Ghost |
| `/agents/:id/sim-runs` | Ghost |
| `/agents/:id/test-runs` | Ghost |
| `/finops` as standalone app section | Settings/cost only |

### 1.2 Kill in teardown — never return as top-level nav or standalone app sections

These existed as `page.tsx` trees under `src/app/(portal)/`. After rebuild, capabilities may return **only** as modes/tabs under the must-ship surfaces defined in IA — not as peer top-level destinations.

| Path prefix | Disposition |
|-------------|-------------|
| `/redteam` | **Hard kill v1** (D3). No page, no nav, no ⌘K entry. |
| `/observability` and `/observability/*` | Hub-of-hubs. Facets become Traces URL grammar, not a second Observe product. |
| `/inspector` | Fold into Traces (`view=inspect` grammar) — no standalone app. |
| `/replay` | Fold into Traces/debugger — no standalone top-level. |
| `/debugger` | Distinct from `/debugger-sessions`; do not resurrect dual debugger entry points. Prefer one debugger IA per information-architecture doc. |
| `/fleet` | Not a peer of Agents — Agents tab/mode only. |
| `/incidents` | Issues mode/tab — not peer nav. |
| `/signals` | Alerts/Signals mode — not peer nav. |
| `/insights`, `/insights/topics` | Analytics later — not v1 top-level. |
| `/analytics` | **Later** (interview). No top-level until scheduled phase. |
| `/users` | Analytics later. |
| `/tools` | Analytics later / Agent detail — not top-level. |
| `/synthetic` | Not v1 top-level. |
| `/studio` | Evals mode only — not top-level. |
| `/labeling`, `/labeling/queues/*` | Evals mode only — not top-level. |
| `/playgrounds` | Evals tab only (redirect OK). |
| `/experiments` | Evals tab only (redirect OK). |
| `/datasets` | Evals/datasets mode — prefer under Evals, not peer “Improve vs Evaluate” confusion. |
| `/prompts` | **Later** registry — not v1 must-ship top-level. |
| `/ledger` | Improve/institutional memory mode — not peer core nav clutter. |
| `/promotions` | Nested under Improve/Ledger — not peer. |
| `/artifacts` as peer core without Improve parent | Artifacts live inside Improve loop; avoid duplicate top-level + Improve. |
| `/optimization/*` nested mini-apps (`/budget`, `/predict`, `/outcomes`, `/model-advisor`) | Single Cost surface with tabs — no nested route farms. |
| `/improve/scorecard`, `/improve/online-scoring`, `/improve/change-impact` as advanced nav spam | Reintroduce only with explicit IA amendment; default hide from core. |
| `/profile` | Prefer Clerk user profile / Settings account — no orphan profile app. |
| `/onboarding/improvement-loop` | Replace with honest first-run on Dashboard/Agents — no parallel onboarding product. |
| `/runs/*/lineage` as discoverable top-level IA | Deep link OK later; not nav. |
| `/docs-fill` | Not a product surface. |
| `/apm`, `/llmops`, `/closed-loop`, `/autonomous`, `/pr-suggestions` | Legacy aliases — redirects only forever. |

### 1.3 Allowed must-ship route families (rebuild targets — not kill)

Rebuild under clean IA (exact grammar in `02-information-architecture.md`):

Dashboard · Agents · Traces · Sessions · Issues · Alerts · Evals · Improve (incl. PR outcomes) · Guardrails (policies, **no** red-team) · Cost · Audit · AI Agent · Debugger sessions · Settings.

Anything else as a **sidebar peer** requires a dated interview amendment.

---

## 2. Components / patterns banned

| Banned | Path / symbol examples | Why | Allowed replacement |
|--------|------------------------|-----|---------------------|
| Hub-of-hubs embedding | `EmbeddedSurface`, `src/components/layout/embedded-surface.tsx` | Nests full pages inside pages; destroys URL/chrome clarity | One surface per route; links or tab modes |
| Dual CommandPalette | `components/ui/command-palette.tsx` **and** `components/portal-os/CommandPalette.tsx` | Two ⌘K implementations | **One** palette module max |
| Trace as modal product | `TraceViewerModal` as primary observe UX | Hides transcript; breaks deep linking | Full-page / split transcript-first Traces |
| Portal OS resource chrome sprawl | `ResourcePageShell`, `CoreResourcePage`, `CrossLinkBar` stacks, `BulkActionBar` default-on | Chrome > content | DESIGN-SYSTEM-V2 ≤2 bands, ≤5 primary actions |
| Old portal-chrome stack | `src/app/(portal)/portal-chrome.tsx`, `components/portal-chrome/*` as restored wholesale | Cluttered chrome | New `components/shell/*` |
| Decorative Card grids as home | Dashboard of `Card`/`stat-card` marketing tiles | “Looks wrong”; not Laminar agent-first | Agent-centric OS home |
| `stat-card` KPI strips as first viewport | `outcomes-kpi-strip`, home-widgets card walls | Noise before diagnosis | One primary diagnosis + next action |
| Red-team UI | `src/app/(portal)/redteam/**`, guardrails copy that deep-links red-team | D3 | Guardrails policies only |
| Observe leaf shells | `observe-leaf-shell`, per-facet mini-apps under `/observability/*` | Hub explosion | Trace facets via query grammar |
| AiRailHost always-on rail | `portal-chrome/AiRailHost.tsx` as permanent third column | Chrome budget blowout | Dedicated AI Agent page + one bubble (D6) |
| Dual mobile + desktop nav with divergent IA | Mismatched `CORE_MOBILE_HREFS` vs sidebar | Adaptation failure | One IA, responsive |
| Wave freeze test theater | Re-adding `w1-…`, `ws12-freeze` style tests that pin dead UI | Blocks rebuild | IA contract tests against new specs |
| Feature-disabled → “Open Settings” lies | Improve disabled copy that pretends Settings toggles magic | Dishonest empty states | Honest disabled states (existing improve-feature messaging OK) |
| Parallel fetch layers | New axios client beside `fetchApi` | Split brain | `fetchApi` + `useOrgQuery` only |
| Storybook AppShell state stubs as product | Shipping `portal-os/stubs` as user-facing | Fake product | Real empty/first-run states |

---

## 3. Visual anti-patterns

Reject PRs that reintroduce:

| Anti-pattern | Concrete tell |
|--------------|---------------|
| Cluttered first viewport | Stats + schedules + promos + multiple H1s above transcript/agent |
| Card-as-layout default | Every section wrapped in bordered/shadowed Card when plain stack works |
| Nested headers | PageHeader inside EmbeddedSurface inside ResourceOsToolbar inside PortalHeader |
| Purple-glow AI aesthetic | Glow, gradient orbs, “magic” sparks as primary brand (unless brand doc mandates — it does not) |
| Soft cream + terracotta AI-default marketing look on product | Product is Laminar-density workspace, not brochure |
| Pill clusters / chip storms | Filter chips + status pills + badge rows competing |
| Multi-layer shadows / glassmorphism stacks | Depth noise |
| Dense newspaper columns | Broadsheet IA |
| Icon rows as navigation | 8+ icons explaining the page instead of content |
| Modal stacked on modal | Trace modal over issue sheet over command palette |
| Inset “hero” product screenshots on authenticated home | Auth product ≠ marketing landing |
| Inconsistent density | Mixing comfy marketing spacing with data tables on same view |
| Decorative sparklines without decision | `streaming-sparkline` / budget tickers that don’t change the next action |
| Broken mobile | Horizontal overflow, unreflowed tables, desktop-only hover IA |

North star: Laminar — dense, transcript-first, agent-primary. If it looks like the July 2026 portal, reject.

---

## 4. Nav anti-patterns

| Anti-pattern | Reject when |
|--------------|-------------|
| Hub-of-hubs | Sidebar item opens a page that is only a grid of other products |
| Show Advanced dumping ground | >12 core leaves + long advanced list without IA doc update |
| Duplicate destinations | Traces **and** Observability **and** Inspector **and** APM |
| Verb soup | Nav labels that are actions (“Optimize spend”) instead of places — prefer IA place nouns |
| Red-team in Guardrails child without amendment | Any href `/redteam` |
| Docs as fake product | Embedding full docs site chrome inside app aside from Quickstart external link |
| Settings megamenu | Recreating every former top-level as a Settings tab without need |
| ⌘K listing ghosts | Commands pointing at removed prefixes |
| Different IA per breakpoint | Mobile five that don’t map to desktop places |
| Landing ≠ Dashboard | Post-login → Improve/Traces/etc. without interview amendment (D4 = Dashboard) |

Target mental model: **Home → Observe → Evaluate → Improve → Workspace** with Agents first-class (Laminar), not buried forever under Advanced.

---

## 5. If you find X in a PR — reject

Use as review paste checklist:

| If you find… | Reject because… |
|--------------|------------------|
| `EmbeddedSurface` import in a new page | Hub-of-hubs |
| Both `ui/command-palette` and `portal-os/CommandPalette` mounted | Dual ⌘K |
| New `page.tsx` under `redteam/` | D3 hard kill |
| New route `/observability/...` with a real page (not redirect) | Observability hub resurrection |
| `TraceViewerModal` as the only way to read a transcript | Anti-Laminar |
| Dashboard composed of ≥6 `StatCard`/`Card` widgets before agent/diagnosis | Decorative home |
| `clients/portal-v2` package proposal | Deploy/Clerk fork — overview forbids |
| Raw browser `fetch(API_INTERNAL_URL)` | Breaks proxy/cookie contract |
| Reintroduction of `portal-chrome.tsx` wholesale from pre-tag | Clutter regression |
| Tests named `w3-traces-hub` pinning old hub copy | Freeze tests against dead UI |
| Sidebar link to `/fleet` or `/signals` or `/incidents` as peers | Nav anti-pattern |
| “Temporary” second design system (new token file ignoring DESIGN-SYSTEM-V2) | Split visuals |
| Marketing Card grid copied into authenticated shell | Wrong surface type |
| PR that deletes `src/app/api/proxy` or `src/proxy.ts` | Violates DO NOT delete |
| PR that “simplifies” by removing next-intl | Violates D8 |
| Red-team copy in Guardrails primary CTA | D3 |
| Nested `/optimization/budget/page.tsx` farm returns | Cost must be one surface |
| Ai rail + bubble + separate chat page all permanent | Exceeds D6 (page + bubble only) |
| Post-login redirect to `/improve` “because stub” without flag | Violates D4 unless stub Option B explicitly maps everything to dashboard |

---

## 6. Grep aids for reviewers / CI

Run from `clients/portal` after teardown / on every PR:

```bash
# Banned symbols (should be empty in src except redirects/docs comments)
rg -n 'EmbeddedSurface' src --glob '!**/_archive/**'
rg -n 'TraceViewerModal' src --glob '!**/_archive/**'
rg -n 'portal-chrome' src/app/\(portal\) --glob '!**/_archive/**'

# Dual palette (at most one implementation file should exist)
rg -l 'CommandPalette|command-palette' src/components --glob '*.tsx'

# Hard-killed route tree
test ! -e src/app/\(portal\)/redteam/page.tsx

# Observability must not return as real pages
test ! -e src/app/\(portal\)/observability/page.tsx
```

Wire equivalents into `rebuild-kill-list.contract.test.ts`.

---

## 7. Relationship to historical code

| Historical | Use | Do not |
|------------|-----|--------|
| `PORTAL_OBSERVE_V3_PLAN.md` | Mine URL grammar | Copy hub UX |
| `IMPROVE_V3_PLAN.md` | Mine object names (artifact, promote, PR) | Copy advanced nav spam |
| `sidebar-config.ts` pre-teardown | Evidence of what went wrong | Restore Advanced dump |
| `.cursor/visual-research/ai-portals/` | Evidence corpus | Cargo-cult screenshots into UI |

---

## Change control

To un-ban a route or pattern: (1) dated amendment in `04-interview-log.md`, (2) update this file, (3) update IA doc, (4) add surface spec. Code-only resurrection is a bug.
