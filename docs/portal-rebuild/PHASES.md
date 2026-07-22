# Portal rebuild — Phase implementation contracts

> **Status:** Authoritative work orders for building the portal.  
> **Package:** `clients/portal`  
> **Baseline:** P0 complete on branch `portal/teardown-stub-a` (tag `portal-pre-teardown-20260721`)  
> **How this is used:** Point an implementer at this file and say *completely execute Phase N*. They implement **everything** in that phase section, in order, until Definition of Done. They do **not** start other phases.

Supporting specs (read when a phase lists them as required inputs):

| Doc | Role |
|-----|------|
| [`02-information-architecture.md`](./02-information-architecture.md) | Nav, routes, redirects, URL grammar |
| [`design/DESIGN-SYSTEM-V2.md`](./design/DESIGN-SYSTEM-V2.md) | Tokens, chrome, kit, mobile, a11y |
| [`engineering/00-overview.md`](./engineering/00-overview.md) | Stack, folders, data layer |
| [`engineering/02-kill-list.md`](./engineering/02-kill-list.md) | Patterns that must never return |
| [`surfaces/*.md`](./surfaces/_INDEX.md) | Per-page UX contracts |
| [`01-product-bible.md`](./01-product-bible.md) | Objects + closed loop |
| [`00-vision.md`](./00-vision.md) | Wedge + success bar |
| [`04-interview-log.md`](./04-interview-log.md) | Frozen product decisions |

---

## Global constraints (all phases)

These are always in force. Contradicting them fails the phase.

1. **Stay in** `clients/portal`. No `portal-v2`.
2. **Stack:** Next.js 16 · React 19 · Tailwind v4 · Clerk · TanStack Query · next-intl (en/de) · Radix + `src/components/ui` · Geist.
3. **Data:** `fetchApi` / `useOrgQuery` → `/api/proxy` only.
4. **Do not delete:** `api/proxy`, `proxy.ts`, `(marketing)`, auth routes, i18n pipeline, `globals.css` token foundation, `docs/portal-rebuild/**`.
5. **Do not touch** Northflank FastAPI unless a phase explicitly requires an API note.
6. **IA:** exactly **12** core sidebar leaves per [`02-information-architecture.md`](./02-information-architecture.md). Agents is core. No red-team. Sessions is not a 13th leaf (`/traces?view=sessions`). `/agent` ≠ `/agents`.
7. **Design:** dark-only; one accent CTA (`--accent`); Phosphor Green = running/live/focus only; ≤2 chrome bands; controls 28–32px; body 14px; chrome labels ≥12px; Laminar density; no decorative Card grids on Observe.
8. **Kill list:** [`engineering/02-kill-list.md`](./engineering/02-kill-list.md) — no hub-of-hubs, no `EmbeddedSurface`, no dual CommandPalette, no `TraceViewerModal` as primary, no `/redteam` pages.
9. **Wedge:** failure → artifact → PR · gateway + observe + improve.
10. **Gate:** finish Phase N Definition of Done before Phase N+1.

---

## Phase status

| Phase | Name | Status |
|------:|------|--------|
| 0 | Docs + teardown stub | **Complete** |
| 1 | Shell + design system | **Complete** |
| 2 | Agents + Dashboard (live) | **Complete** |
| 3 | Observe | **Complete** |
| 4 | Evaluate | **Complete** |
| 5 | Improve + Cost + Guardrails | **Complete** |
| 6 | AI Agent + Debugger | **Complete** |
| 7 | Settings + Audit + polish | **Complete** |

---

# Phase 0 — Docs + teardown stub

**Status:** Complete. Do not re-execute.

**Evidence:** Stub shell at `src/components/shell/stub-chrome.tsx`; product hubs deleted; redirects → `/dashboard`; docs under `docs/portal-rebuild/`; typecheck + 128 tests green.

**Forward rule:** Rebuild on top of the stub. Do not restore deleted hubs.

---

# Phase 1 — Shell + design system

**Status:** Complete.

## 1.1 Objective

Replace the teardown stub chrome with the **real rebuild AppShell** and design-system kit so that:

- Signed-in users land on `/dashboard` with correct IA chrome (12-leaf sidebar, slim header, mobile bottom nav).
- Unbuilt surfaces still show a clean Coming soon body (not broken routes).
- Empty / first-run Dashboard skeleton matches Laminar-adjacent OS energy (**not** Helicone KPI cards, **not** live agent data yet — that is Phase 2).
- IA + kill-list are enforced by Vitest contracts.

When Phase 1 is done, the product looks like a real instrument shell with empty content — ready for Phase 2 to fill Agents + Dashboard with data.

## 1.2 Required inputs (read before coding)

Read these end-to-end (or the cited sections):

1. This Phase 1 section (entire).
2. [`design/DESIGN-SYSTEM-V2.md`](./design/DESIGN-SYSTEM-V2.md) — §§1–9, §12–15 (purpose, tokens, type, density, **chrome**, layouts, kit, CTA, mobile, a11y, bans, QA).
3. [`02-information-architecture.md`](./02-information-architecture.md) — §§0–2 (laws, nav tree, routes table for `/dashboard` + stub targets).
4. [`surfaces/dashboard.md`](./surfaces/dashboard.md) — §§1–6 focused on **empty / first-run / loading** only (ignore populated data widgets for Phase 1).
5. [`engineering/00-overview.md`](./engineering/00-overview.md) — §§4–7, §9.
6. [`engineering/02-kill-list.md`](./engineering/02-kill-list.md) — full file.

## 1.3 Out of scope (do not build in Phase 1)

- Live Agents list/detail, Connect API flows beyond a CTA link to `/_stub/agents` or `/agents/connect` stub.
- Traces viewer, Issues, Alerts, Evals, Improve, Cost, Guardrails, Audit, Settings tabs.
- AI Agent page body and functional bubble (may reserve z-index / placeholder FAB that routes to `/_stub/agent` — no chat backend).
- Debugger, Prompts, Analytics.
- FastAPI changes.
- Marketing / docs site edits.

## 1.4 Target file tree

Create / rewrite these paths (adjust only if a listed path already exists and can be extended without violating the kill list):

```text
clients/portal/src/
  components/shell/
    app-shell.tsx              # root chrome: sidebar + header + main + mobile nav
    sidebar-nav.tsx            # 12-leaf nav from sidebar-config
    portal-header.tsx          # ≤56px: breadcrumb region + search trigger + optional Ask
    mobile-bottom-nav.tsx      # 5 items: Dashboard · Traces · Issues · Evals · Improve
    coming-soon-panel.tsx      # shared empty body for unbuilt surfaces
    density-provider.tsx       # comfortable | compact → data-density on shell
  lib/
    sidebar-config.ts          # REWRITE: real hrefs per IA; stub only unbuilt leaves
    portal-routes.ts           # keep stub-era redirects truth; align with IA
    rebuild-flags.ts           # NEXT_PUBLIC_PORTAL_REBUILD_STUB helper
  app/(portal)/
    layout.tsx                 # PortalProviders + AppShell (not StubChrome)
    dashboard/page.tsx         # empty / first-run Dashboard skeleton
    _stub/[surface]/page.tsx   # ComingSoonPanel for unbuilt surfaces
    error.tsx                  # keep minimal → /dashboard
    not-found.tsx              # keep minimal → /dashboard
  components/ui/               # ensure kit pieces below exist & match DESIGN-SYSTEM-V2
    # Button, Badge, Input, Tabs, Dialog, Sheet, Panel (or Card used only as Panel),
    # PageHeader, QueryState / EmptyState, CommandPalette (ONE), FilterBar (may stub)
  app/(portal)/__tests__/
    rebuild-ia.contract.test.ts
    rebuild-kill-list.contract.test.ts
  messages/
    en.json                    # shell + dashboard empty copy keys
    de.json                    # same keys
```

**Delete or stop using after AppShell ships:**

- `src/components/shell/stub-chrome.tsx` (remove import from layout; delete file).
- Any leftover references to “Portal rebuild in progress” as the permanent header title (Dashboard empty state may still mention rebuild only if unbuilt — prefer clean product chrome).

## 1.5 Sidebar & routing contract

### Leaves (exactly these 12)

| # | id | Label | href in Phase 1 | Notes |
|---|----|-------|-----------------|-------|
| 1 | `dashboard` | Dashboard | `/dashboard` | Live empty page |
| 2 | `agents` | Agents | `/_stub/agents` | Coming soon until Phase 2 |
| 3 | `traces` | Traces | `/_stub/traces` | Phase 3 |
| 4 | `issues` | Issues | `/_stub/issues` | Phase 3 |
| 5 | `alerts` | Alerts | `/_stub/alerts` | Phase 3 |
| 6 | `evals` | Evals | `/_stub/evals` | Phase 4 |
| 7 | `improve` | Improve | `/_stub/improve` | Phase 5 |
| 8 | `guardrails` | Guardrails | `/_stub/guardrails` | Phase 5 |
| 9 | `cost` | Cost | `/_stub/cost` | Phase 5 |
| 10 | `agent` | AI Agent | `/_stub/agent` | Phase 6 — label must not say “Agents” |
| 11 | `audit` | Audit | `/_stub/audit` | Phase 7 |
| 12 | `settings` | Settings | `/_stub/settings` | Phase 7 |

**Groups:** `home | agents | observe | evaluate | improve | workspace` per IA doc.

**Forbidden:** red-team item; Sessions as 13th leaf; Analytics; Prompts; burying Agents under Advanced.

### Mobile bottom nav (exactly 5)

1. Dashboard → `/dashboard`  
2. Traces → `/_stub/traces`  
3. Issues → `/_stub/issues`  
4. Evals → `/_stub/evals`  
5. Improve → `/_stub/improve`  

More (optional sheet): Agents, Alerts, Cost, Guardrails, AI Agent, Audit, Settings — must match sidebar destinations.

### Redirects

Keep `next.config.ts` soft-landing old product URLs → `/dashboard`. Do not reintroduce old hub destinations.

## 1.6 Chrome specification (implement exactly)

| Element | Spec |
|---------|------|
| Sidebar expanded | **240px**, `bg-secondary`, hairline `border-subtle` |
| Sidebar collapsed | **64px** icon rail (desktop toggle) |
| Header height | **40–56px**, one band |
| Header contents | Breadcrumb/title region · spacer · Search (opens CommandPalette) · Ask control (links to `/_stub/agent` or inert) |
| Account | Clerk `UserButton` in **sidebar footer** — not duplicated in header |
| Bands above content | ≤2 (header + optional page toolbar). Dashboard Phase 1 has **no** second toolbar. |
| Banner | Max one; none required in Phase 1 |
| Main padding | 16–24px desktop; 12–16px mobile |
| Z-index | Use DESIGN-SYSTEM-V2 ladder (`--z-mobile-nav`, `--z-ai-fab`, etc.) |
| AI FAB | Optional placeholder only; if present, mutual exclusion with mobile nav per design system; click → `/_stub/agent` |
| Focus | Visible focus rings; `--terminal` or documented focus token |

**Active nav:** `--accent` text/bg-faint. No purple active states.

**Typography in nav:** labels ≥12px. **Ban** `text-[10px]` / `text-[9px]` group labels — use `text-xs` (≥12px) muted sentence-case or small caps only if ≥12px.

## 1.7 Kit requirements

Ensure these primitives exist under `src/components/ui/` and match DESIGN-SYSTEM-V2 (extend existing files; do not add a second kit):

| Primitive | Phase 1 use |
|-----------|-------------|
| `Button` | Primary = accent once per view; secondary/ghost for quiet actions |
| `Badge` | Status only if needed on empty dashboard |
| `Input` | Command palette search field / future filters |
| `Tabs` | Not required on Dashboard Phase 1 |
| `Dialog` / `Sheet` | Command palette / mobile More |
| `PageHeader` | Dashboard title + one-line subtitle |
| `QueryState` or `EmptyState` | First-run / empty dashboard body |
| `CommandPalette` | **Exactly one** implementation, ⌘K / Ctrl+K, lists the 12 leaves + sign-out if applicable |
| `Panel` | Optional diagnosis placeholder container — not a Card grid |

**Do not** add decorative multi-card KPI grids on Dashboard.

## 1.8 Dashboard page (Phase 1 content)

Route: `/dashboard`

Implement **empty + first-run skeleton only** (no `useOrgQuery` for agents/traces required):

1. `PageHeader` — title from i18n `dashboard.title` (“Dashboard”); subtitle one line (e.g. status → next action).
2. **DiagnosisStrip placeholder** — single slim strip: copy that nothing is connected yet OR “Connect an agent to see health” with primary CTA → `/_stub/agents` (Phase 2 will replace with real `/agents/connect`).
3. **Agent list empty state** — EmptyState: no agents yet; primary CTA Connect; secondary “View docs” → external docs quickstart URL if already in constants.
4. **Next action panel** — one quiet panel: “Connect your first agent” steps (1–3 short lines). No charts.
5. No live metrics, no Recharts, no fake numbers.

States to support in UI (static is fine):

| State | Behavior |
|-------|----------|
| first-run / empty | Above layout |
| loading | Optional skeleton if you wire org bootstrap; otherwise skip |
| error | QueryState error only if a real query is added; prefer none in Phase 1 |

Full populated Dashboard is **Phase 2** (`surfaces/dashboard.md`).

## 1.9 Coming soon surfaces

`/_stub/[surface]/page.tsx` must:

- Validate `surface` ∈ stub ids (all except `dashboard`, or including unknown → not-found).
- Render `ComingSoonPanel` with surface label, one sentence, link text pointing at `docs/portal-rebuild/surfaces/<file>.md` name when known.
- Use AppShell (via layout) — no second chrome.

## 1.10 i18n

Add keys (en + de) for at minimum:

- All sidebar group + leaf labels  
- Dashboard title, subtitle, empty CTA, diagnosis empty copy  
- Coming soon title/body  
- Mobile nav labels  
- Command palette placeholder  

Use `next-intl` (`useTranslations` / server equivalents). No hardcoded English in shell components.

## 1.11 Implementation order (mandatory sequence)

1. Align tokens in `globals.css` with DESIGN-SYSTEM-V2 names (fill gaps; do not invent a second palette).  
2. Implement `DensityProvider` + `AppShell` structure (no nav polish yet).  
3. Rewrite `sidebar-config.ts` to the Phase 1 href table.  
4. Implement `SidebarNav` + collapse behavior.  
5. Implement `PortalHeader` + single `CommandPalette`.  
6. Implement `MobileBottomNav` + More sheet.  
7. Implement `ComingSoonPanel` + ensure `_stub/[surface]` works.  
8. Replace `StubChrome` with `AppShell` in `(portal)/layout.tsx`; delete `stub-chrome.tsx`.  
9. Implement empty Dashboard page.  
10. Wire i18n keys (en + de).  
11. Write IA + kill-list contract tests.  
12. Run gates; fix until green.  
13. Update `clients/portal/README.md` one paragraph: Phase 1 shell live; product surfaces still stubbed.

## 1.12 Tests (must add)

### `rebuild-ia.contract.test.ts`

Assert:

- `CORE_NAV_ITEM_COUNT === 12` (or equivalent export).  
- Sidebar leaf ids deep-equal the 12 ids in §1.5.  
- No sidebar href contains `redteam`.  
- `dashboard` href is `/dashboard`.  
- `agent` and `agents` are distinct ids.  
- Mobile bottom nav length === 5 and targets the five hrefs in §1.5.

### `rebuild-kill-list.contract.test.ts`

Assert via filesystem/grep helpers or import graph:

- No `src/app/(portal)/redteam/**` page.  
- No `EmbeddedSurface` module under `src/components`.  
- At most one CommandPalette module path (define allowed path).  
- `stub-chrome.tsx` does not exist after Phase 1.

Keep existing proxy/auth tests green. Do not revive archived wave UI tests.

## 1.13 Exit gates (all required)

```bash
cd clients/portal
bun run typecheck
bun run test
```

Manual checklist:

- [ ] Sign-in → `/dashboard` shows empty OS (PageHeader + diagnosis placeholder + empty agents + next action) — **not** stub “teardown” marketing dump as the only UI, **not** KPI card grid  
- [ ] Sidebar: 12 leaves, correct groups, Agents visible without “Advanced”  
- [ ] Unbuilt leaf → Coming soon inside same shell  
- [ ] ⌘K opens the single command palette; destinations match IA  
- [ ] Desktop: ≤2 chrome bands; header ≤56px; sidebar 240/64  
- [ ] Mobile: bottom nav 5 items; no sticky sandwich; account reachable  
- [ ] No `text-[9px]`/`text-[10px]` in shell chrome  
- [ ] One accent primary CTA on Dashboard empty state  
- [ ] en + de keys present for shell strings  
- [ ] IA + kill-list contract tests pass  
- [ ] `stub-chrome.tsx` removed  

## 1.14 Definition of Done — Phase 1

Phase 1 is complete only when:

1. All of §1.4 target tree exists and is wired.  
2. All of §1.11 steps are done.  
3. All of §1.13 gates are green.  
4. No Phase 2+ surface is partially implemented “for fun.”  
5. Kill list clean.  
6. A short note is added to [`04-interview-log.md`](./04-interview-log.md) under a dated “Phase 1 complete” line (branch name + commit when committed).

**Hand-off to Phase 2:** shell is product-grade; Dashboard empty; Agents still Coming soon until Phase 2 replaces `/_stub/agents` with real routes.

---

# Phase 2 — Agents + Dashboard (live)

**Status:** Complete.

## 2.1 Objective

Make Dashboard and Agents real data surfaces so a solo eng can connect an agent and see health / next action (Laminar agent-first).

## 2.2 Required inputs

- [`surfaces/dashboard.md`](./surfaces/dashboard.md) — **full** acceptance  
- [`surfaces/agents.md`](./surfaces/agents.md) — **full** acceptance  
- [`01-product-bible.md`](./01-product-bible.md) — Agent object, first-run journey, click contracts  
- DESIGN-SYSTEM-V2 layouts  
- Phase 1 shell (must already be Done)

## 2.3 Deliverables

1. Routes: `/agents`, `/agents/connect`, `/agents/[id]` (and agent subpeeks per agents.md).  
2. Update `sidebar-config`: `agents` → `/agents` (leave other stubs).  
3. Dashboard populated states per dashboard.md (diagnosis strip, agent rows, recent failures) using `useOrgQuery`.  
4. Empty/first-run still excellent.  
5. Cross-links to Traces/Issues may target `/_stub/...` until Phase 3.  
6. Surface tests + acceptance checklists in both surface docs checked off in PR description.

## 2.4 Out of scope

Transcript viewer, evals, improve queue, AI chat backend.

## 2.5 Definition of Done

- `bun run typecheck` + `bun run test` green.  
- dashboard.md + agents.md acceptance criteria satisfied.  
- First-run Connect path obvious on mobile + desktop.  
- No Helicone KPI-card home.  
- Sidebar Agents href is live `/agents`.

---

# Phase 3 — Observe

**Status:** Complete.

## 3.1 Objective

Ship Traces (transcript-first), Sessions lens, Issues, Alerts.

## 3.2 Required inputs

- [`surfaces/traces.md`](./surfaces/traces.md)  
- [`surfaces/sessions.md`](./surfaces/sessions.md)  
- [`surfaces/issues.md`](./surfaces/issues.md)  
- [`surfaces/alerts.md`](./surfaces/alerts.md)  
- IA URL grammar  
- [`03-competitive-synthesis.md`](./03-competitive-synthesis.md) — Laminar + Langfuse  

## 3.3 Deliverables

1. `/traces` master–detail; default `mode=transcript`; modes tree/timeline/meta/scores.  
2. Sessions via `?view=sessions`; `/sessions` redirects.  
3. Latency · tokens · cost on rows/nodes; I/O split.  
4. `/issues`, `/alerts` per specs; no red-team.  
5. ≤8 first-paint controls on Traces.  
6. Update sidebar hrefs for traces/issues/alerts to live routes.  
7. Playwright smoke: login → dashboard → open trace.  
8. URL deep links restore selection.

## 3.4 Definition of Done

- All four surface acceptances green.  
- No `TraceViewerModal` primary path; kill list clean.  
- Mobile list → drawer detail.  
- typecheck + tests + smoke green.

---

# Phase 4 — Evaluate

## 4.1 Objective

One `/evals` hub: datasets → playgrounds → experiments.

## 4.2 Required inputs

- [`surfaces/evals.md`](./surfaces/evals.md)  
- Competitive Braintrust compare notes  

## 4.3 Deliverables

1. `/evals` tabs only — no top-level datasets/playgrounds/experiments leaves.  
2. Trace → dataset path.  
3. Experiment compare UI.  
4. Legacy URLs redirect to `/evals?tab=`.  
5. Sidebar `evals` → `/evals`.

## 4.4 Definition of Done

evals.md acceptance + gates green + no hub-of-hubs embeds.

---

# Phase 5 — Improve + Cost + Guardrails

**Status:** Complete.

**Evidence:** Live `/improve` (6 tabs + plan detail), `/cost` (5 tabs), `/guardrails` (policies|violations); shared `components/improve/*` + agent ledger share; IA redirects; en+de i18n; contract tests (`rebuild-improve|cost|guardrails` 8/8 each); kill-list clean (no `/redteam` page, no `EmbeddedSurface` in new hubs); gates green; Playwright `e2e/golden/agent10-improve-probe.mjs` (auth soft-skip).

## 5.1 Objective

Closed loop visible: queue → plan → artifact → PR; plus Cost and Guardrails policies.

## 5.2 Required inputs

- [`surfaces/improve.md`](./surfaces/improve.md)  
- [`surfaces/artifacts.md`](./surfaces/artifacts.md)  
- [`surfaces/ledger.md`](./surfaces/ledger.md)  
- [`surfaces/cost.md`](./surfaces/cost.md)  
- [`surfaces/guardrails.md`](./surfaces/guardrails.md)  
- Product bible closed-loop grammar  
- TraceRoot notes in competitive synthesis  

## 5.3 Deliverables

1. `/improve` with tabs (queue/plans/artifacts/promotions/ledger/history) + plan detail.  
2. Promote → ledger; **Open PR** first-class.  
3. `/cost`, `/guardrails` (policies only — **zero** red-team UI).  
4. Sidebar hrefs live for improve/cost/guardrails.  
5. Issue/Trace → Improve handoff within bible click budgets.

## 5.4 Definition of Done

All five surface acceptances + demoable failure→PR path + no `/redteam` page + gates green.

**Accepted gaps (not blockers):** Admin EvidenceGate override dialog; Generate Artifact via `learnApi.authorArtifactNl`; optional ViewsMenu; Guardrails create-only policies (no `updatePolicy`/`deletePolicy` API); Cost single-org budget API.

---

# Phase 6 — AI Agent + Debugger

**Status:** Complete.

## 6.1 Objective

`/agent` page + floating bubble; debugger sessions without old observability hubs.

## 6.2 Required inputs

- [`surfaces/ai-agent.md`](./surfaces/ai-agent.md)  
- [`surfaces/debugger.md`](./surfaces/debugger.md)  

## 6.3 Deliverables

1. Live `/agent`; sidebar `agent` → `/agent`.  
2. Bubble opens compact chat; mutual exclusion with mobile nav.  
3. Context preload from trace/issue; citations; actions to Improve/PR.  
4. `/debugger` (+ detail) per debugger.md.  
5. Clear copy: AI Agent ≠ customer Agents.

## 6.4 Definition of Done

ai-agent.md + debugger.md acceptance + gates green.

---

# Phase 7 — Settings + Audit + polish

**Status:** Complete.

## 7.1 Objective

Ship Settings + Audit; retire stubs; mobile/density pass; meet rebuild Definition of Done.

## 7.2 Required inputs

- [`surfaces/settings.md`](./surfaces/settings.md)  
- [`surfaces/audit.md`](./surfaces/audit.md)  
- DESIGN-SYSTEM-V2 mobile + visual QA  
- [`engineering/00-overview.md`](./engineering/00-overview.md) §10  

## 7.3 Deliverables

1. `/settings` ≤8 visible tabs + Advanced; gateway keys first-class.  
2. `/audit` + AuditPack.  
3. Sidebar settings/audit live.  
4. Mobile QA on Dashboard, Traces, Issues, Evals, Improve.  
5. Density pass; kill-list CI; golden observe→eval→improve.  
6. Remove Coming soon for all must-ship surfaces; Later surfaces stay redirected/stubbed.  
7. Sign engineering DoD §10.

## 7.4 Definition of Done

Full rebuild DoD in `engineering/00-overview.md` §10 satisfied.

---

# Later (post Phase 7) — **Complete** 2026-07-22

Shipped as **secondary destinations** (not core leaves — IA law ≤12):

- Prompts — [`surfaces/prompts.md`](./surfaces/prompts.md) · `/prompts`
- Analytics — [`surfaces/analytics.md`](./surfaces/analytics.md) · `/analytics?tab=`

Entry: Cmd+K + Mobile More. Core nav count remains **12**.  

---

# Completing a phase (operator checklist)

When finishing any phase:

1. All Definition of Done bullets for that phase are true.  
2. `cd clients/portal && bun run typecheck && bun run test` pass.  
3. No files from a future phase were introduced except inert hrefs to `/_stub/...`.  
4. Dated note in `04-interview-log.md`: `Phase N complete — <branch> — <summary>`.  
5. Stop.

---

*This file is the work order. Surface/design/IA docs are binding detail. If they conflict, fix the conflict in docs with a dated interview-log note — then implement.*
