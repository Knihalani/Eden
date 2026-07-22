# Surface: Cost

> **Status:** Authoritative surface contract  
> **Decision date:** 2026-07-21  
> **Phase:** P5 Improve track (Cost hub)  
> **Companions:** [../01-product-bible.md](../01-product-bible.md) · [../02-information-architecture.md](../02-information-architecture.md) · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md) · [../03-competitive-synthesis.md](../03-competitive-synthesis.md)

---

## 1. Purpose

**One decision this page owns:** Where is spend going (org/agent/model), are we inside **CostBudget**, and what should we change next (advisor → traces / improve / evals)?

Cost is the **gateway FinOps** hub. Helicone-class **KPI cards are allowed here** (and Dashboard) — never as Traces grammar. Canonical path `/cost` (not `/optimization`, not `/llmops`).

---

## 2. Primary user + JTBD

| | |
|--|--|
| **Primary** | Mira — cost surprise tonight; find heavy traces |
| **Secondary** | Jordan — budget burn trustworthy for leadership |
| **JTBD** | J10 Control spend |
| **Done when** | Budget visible; drill to agent/trace; advisor recommendation linkable |

---

## 3. URL + query grammar

### 3.1 Canonical routes

| Route | Purpose |
|-------|---------|
| `/cost` | Cost hub |
| `/optimization`, `/optimization/:path*`, `/llmops` | **Redirect** → `/cost` (+ tab map) |
| `/optimization/budget` | → `/cost?tab=budget` |
| `/optimization/outcomes` | → `/cost?tab=outcomes` |
| `/optimization/predict` | → `/cost?tab=forecast` |
| `/optimization/model-advisor` | → `/cost?tab=advisor` |

### 3.2 Query params

| Param | Values | Notes |
|-------|--------|-------|
| `tab` | `overview` \| `budget` \| `outcomes` \| `forecast` \| `advisor` | Default `overview` |
| `agentId` | id | Scope |
| `budgetId` | id | Selected budget |
| `model` / `provider` | string | Breakdown filters |
| `pastHours` / `from` / `to` | | Time — segment control 24H/7D/30D maps to these |
| `q` / `filter` / `viewId` | | |
| `groupBy` | `agent` \| `model` \| `provider` \| `day` | Overview breakdown |

### 3.3 Example URLs

```
/cost
/cost?tab=overview&pastHours=24
/cost?tab=budget&budgetId=bud_1
/cost?tab=outcomes&agentId=agent_support
/cost?tab=forecast
/cost?tab=advisor&agentId=agent_support&model=gpt-4.1
/cost?tab=overview&groupBy=model
```

### 3.4 Breadcrumb

`Improve / Cost` (group Improve per IA §9)

---

## 4. Layout diagrams

### 4.1 Desktop ≥1280 — overview (Helicone-adapted)

```
┌─ AppShell ──────────────────────────────────────────────────────────────┐
│ Sidebar │ Improve / Cost · Ask AI                                       │
│         │ PageHeader: Cost                    [Create budget] (Admin)   │
│         │ tabs: Overview | Budget | Outcomes | Forecast | Advisor       │
│         │ Time: 24H | 7D | 30D | Custom · Agent filter · Display        │
├─────────────────────────────────────────────────────────────────────────┤
│ StatCard grid (interaction / click-through ONLY):                       │
│  Spend$ · Requests · Errors% · Avg latency · Budget remaining           │
│                                                                         │
│ Panel: Spend by model (bars)     Panel: Spend by agent                  │
│ Panel: Top costly traces table → row opens /traces?traceId=             │
│ Related strip: Traces · Agents · Improve · Evals                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Budget tab

```
┌─ Budget ────────────────────────────────────────────────────────────────┐
│ List budgets: name · scope (org/agent) · limit · spent · period · status│
│ Detail: burn chart · alerts threshold · edit (Admin)                    │
│ CTA: Create budget (Admin) | Acknowledge overage → Issues/Alerts link   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Advisor tab

```
┌─ Advisor ───────────────────────────────────────────────────────────────┐
│ Recommendations: model swap · cache · truncate · routing                │
│ Each row: estimated $ delta · confidence · evidence count               │
│ Primary CTA per row: Open traces OR Create Improve Plan OR Try in Evals │
│ (one solid CTA per selected recommendation)                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Mobile

```
Stacked StatCards (not Trace collage rules — cards OK)
Horizontal tab scroll
Tables → priority columns + horizontal scroll
Detail Sheet for budget/advisor row
```

### 4.5 Mermaid

```mermaid
flowchart TD
  GW[Gateway usage] --> C[/cost overview]
  C --> B[Budget]
  C --> O[Outcomes]
  C --> F[Forecast]
  C --> A[Advisor]
  A --> T[/traces heavy runs]
  A --> I[/improve plan]
  A --> E[/evals experiment]
  B -->|overage| AL[/alerts or issues]
```

---

## 5. Chrome budget

| Rule | Contract |
|------|----------|
| Bands | ≤2 |
| Toolbar | Time range, Agent filter, Display, Search (if table), primary CTA — ≤5 |
| StatCards | Overview/Forecast only — click-through required or omit |
| One solid CTA | Overview: none or `Create budget` (Admin); Advisor: act on selected rec |
| Do not | Steal Improve queue chrome; do not embed full Traces page |

---

## 6. States

| State | Behavior |
|-------|----------|
| **Empty / first-run** | No usage: “Waiting for gateway traffic.” CTA: `/agents/connect` or `/settings?tab=gateway` |
| **Loading** | Skeleton cards + charts |
| **Error** | Retry + support |
| **Filtered-empty** | Clear agent/time filters |
| **Populated** | Cards + tables |
| **Live** | Optional spend tick — Display opt-in; never always-on primary |
| **Over budget** | Warning StatusBadge + banner (max one) → Budget tab |

---

## 7. Components used (kit only)

| Kit | Use |
|-----|-----|
| `PageHeader`, `Tabs` underline | Hub |
| `StatCard` | KPI summary / click-through |
| `Panel` | Chart/table grouping |
| `DataTable`, `QueryState`, `QueryFilterBar` | Costly traces, budgets, recommendations |
| `Badge` / `StatusBadge` | Budget health |
| `Button`, `Dialog`, `Sheet` | Create/edit budget |
| `MetricInline` | Row-level $ · tokens |
| `Select` / `Input` | Filters |
| `CommandPalette` | Cost, Budget, Advisor |

**Domain:** `CostStatGrid`, `SpendBreakdownChart`, `CostlyTracesTable`, `BudgetEditor`, `AdvisorRecommendationRow`.

Charts: prefer existing portal chart primitives if present; no marketing mesh backgrounds.

---

## 8. Keyboard map

| Key | Action |
|-----|--------|
| `⌘K` | Palette → Cost tabs |
| `/` | Focus search when table focused |
| `1`–`5` | overview…advisor |
| `↑` `↓` `Enter` | Table selection |
| `Esc` | Close Sheet/Dialog |
| `t` | Open selected costly trace |
| `b` | Jump `tab=budget` |

---

## 9. Closed-loop exits

| From | To | Max | Preserve |
|------|----|-----|----------|
| Costly trace row | `/traces?traceId=` | **1** | `agentId`, time window when possible |
| Overview agent bar | `/agents/[id]` or `/cost?agentId=` | **1** | — |
| Overage | `/alerts` or `/issues` | **≤2** | `agentId` |
| Advisor | `/improve?tab=queue&agentId=` Create plan | **≤2** | recommendation id in plan evidence |
| Advisor model swap | `/evals?tab=playgrounds` or experiments | **≤2** | model hint |
| Advisor | `/settings?tab=gateway` | **1** | — |
| Any | Ask AI cost question with scope | **1** | |

**Hard rule:** Improve may **link** here for optimization outcomes; Cost must not re-implement Plan/Artifact/PR chrome.

---

## 10. Anti-patterns banned on this surface

- Helicone **card collage as Traces** (irrelevant here — but do not navigate users into card-as-debug)
- Keeping `/optimization` or `/llmops` as live product brands
- Absorbing Cost into Improve tabs as the only home (Cost is its own core leaf)
- Purple glow / light SaaS Helicone theme in portal
- Decorative StatCards with no click-through and no decision value
- Red-team cost attacks
- False precision (show units: `$`, tokens, honest rounding)
- Sticky sandwich; &gt;2 bands; multiple solid CTAs
- Hub-of-hubs nesting full Improve/Traces

---

## 11. Acceptance checklist

- [ ] `/cost` core leaf under Improve group; breadcrumb `Improve / Cost`
- [ ] Tabs: overview, budget, outcomes, forecast, advisor
- [ ] Redirects from `/optimization*` and `/llmops`
- [ ] Overview StatCards + breakdowns; row → Trace deep link
- [ ] Budget CRUD Admin; Member read; overage path to Alerts/Issues
- [ ] Advisor recommendations exit to Traces / Improve / Evals ≤2 actions
- [ ] `agentId` + time grammar shareable/refreshable
- [ ] QueryState empty distinguishes no-gateway vs filter-empty
- [ ] Chrome ≤2 bands; ≤5 toolbar actions; kit StatCard/Panel only
- [ ] en+de i18n; WCAG AA; reduced-motion on chart transitions

---

## 12. Tab contracts

| Tab | Owns |
|-----|------|
| `overview` | Spend rollup, breakdowns, top traces |
| `budget` | CostBudget objects, thresholds, alerts linkage |
| `outcomes` | Spend vs quality/error outcomes (join scores/issues lightly) |
| `forecast` | Projected burn |
| `advisor` | Actionable recommendations with closed-loop exits |

---

## 13. Permissions

| Action | Viewer | Member | Admin |
|--------|--------|--------|-------|
| View cost | ✓ | ✓ | ✓ |
| Create/edit CostBudget | | | ✓ |
| Act on advisor (create plan) | | ✓ | ✓ |

---

*End of surfaces/cost.md*
