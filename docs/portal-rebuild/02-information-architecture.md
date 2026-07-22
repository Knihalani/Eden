# 02 — Information Architecture

> **Status:** Authoritative — an engineer must be able to implement nav, routes, redirects, and URL state from this file alone.  
> **Decision date:** 2026-07-21  
> **Companions:** [00-vision.md](./00-vision.md) · [01-product-bible.md](./01-product-bible.md)

---

## 0. IA laws

1. **≤12 core sidebar leaves.** Advanced/later items do not count; they also must not reintroduce hub-of-hubs.  
2. **One concept → one canonical path.** Everything else redirects.  
3. **Agents are core** — own nav **group**, not buried under Observe/Advanced.  
4. **Groups (FINAL):** `Home | Agents | Observe | Evaluate | Improve | Workspace`.  
5. **Landing after login:** `/dashboard` (agent-centric OS).  
6. **Embeds ≠ pages.** Facets/modes/tabs are query params or in-page tabs on a canonical page.  
7. **Deep links are data.** Selection and filters live in the URL; share/refresh must restore.  
8. **i18n:** all nav labels via `next-intl` (`en`/`de`).  
9. **Docs site:** external only — never rebuild docs inside portal.  
10. **Kill:** red-team routes, dual hubs, decorative “overview” pages that only link elsewhere.

---

## 1. Nav tree (FINAL)

### 1.1 Desktop sidebar

```
Home
  └─ Dashboard ........................ /dashboard          [core]

Agents
  └─ Agents ........................... /agents             [core]

Observe
  ├─ Traces ........................... /traces             [core]  ← Sessions via view=
  ├─ Issues ........................... /issues             [core]
  └─ Alerts ........................... /alerts             [core]

Evaluate
  └─ Evals ............................ /evals              [core]

Improve
  ├─ Improve .......................... /improve            [core]  ← plans/artifacts/promotions/ledger/PRs
  ├─ Guardrails ....................... /guardrails         [core]  ← policies ONLY
  └─ Cost ............................. /cost               [core]

Workspace
  ├─ AI Agent ......................... /agent              [core]
  ├─ Audit ............................ /audit              [core]
  └─ Settings ......................... /settings           [core]
```

**Core leaf count = 12.**

| # | Leaf | Href |
|---|------|------|
| 1 | Dashboard | `/dashboard` |
| 2 | Agents | `/agents` |
| 3 | Traces | `/traces` |
| 4 | Issues | `/issues` |
| 5 | Alerts | `/alerts` |
| 6 | Evals | `/evals` |
| 7 | Improve | `/improve` |
| 8 | Guardrails | `/guardrails` |
| 9 | Cost | `/cost` |
| 10 | AI Agent | `/agent` |
| 11 | Audit | `/audit` |
| 12 | Settings | `/settings` |

### 1.2 Not in core nav (but real pages or modes)

| Surface | How reached | Notes |
|---------|-------------|-------|
| Sessions | `/traces?view=sessions` or `/sessions` → redirect | Must-ship capability; not a 13th leaf |
| Debugger | `/debugger`, `/debugger/[id]` | Linked from Traces actions, Agent detail, Cmd+K — **not** core leaf (chrome budget) |
| Agent detail | `/agents/[id]` | Child of Agents |
| Issue detail | `/issues/[id]` | Child of Issues |
| Plan detail | `/improve/plans/[id]` | Child of Improve |
| Connect agent | `/agents/connect` | First-run / empty CTA |
| Docs Quickstart | External URL | Workspace footer / Cmd+K — not a product leaf |

### 1.3 Explicitly absent from v1 nav

| Item | Status |
|------|--------|
| Prompts | `/prompts` (+ `?prompt=`) | **Later live** — secondary; Cmd+K / Mobile More — **not** a core leaf |
| Analytics / Users / Tools / Topics / Insights | `/analytics?tab=` | **Later live** — secondary; aliases redirect into tabs |
| Red-team | **Killed** — redirect away; never re-add |
| Artifacts / Ledger / Promotions as top-level | **Tabs under Improve** |
| Fleet as top-level | Tab under Agents |
| Scorecard / online-scoring / change-impact as top-level | Improve tabs or deferred advanced tabs — **not** core leaves |
| Profile as top-level | Settings `tab=account` |

### 1.4 Group metadata (for implementation)

| Group id | Label key (i18n) | Default expanded |
|----------|------------------|------------------|
| `home` | `nav.groups.home` | yes |
| `agents` | `nav.groups.agents` | yes |
| `observe` | `nav.groups.observe` | yes |
| `evaluate` | `nav.groups.evaluate` | yes |
| `improve` | `nav.groups.improve` | yes |
| `workspace` | `nav.groups.workspace` | yes |

No “Show Advanced” trap that hides **Agents**. Optional user pin/hide may exist later; defaults must match this tree.

---

## 2. Exact routes table

### 2.1 Canonical real pages (implement these)

| Route | Purpose | Primary object |
|-------|---------|----------------|
| `/dashboard` | Agent-centric OS landing: agent health, diagnosis strip, next action — **not** KPI card spam | Org + Agents |
| `/agents` | Agent list / fleet lens (`tab=list\|fleet`) | Agent |
| `/agents/connect` | First-run connect Gateway or SDK | Agent |
| `/agents/[id]` | Agent home: health, recent traces, issues, ledger peek, artifacts peek | Agent |
| `/agents/[id]/ledger` | Agent-scoped ledger (may embed Improve ledger filters) | Ledger entries |
| `/traces` | Observe hub: traces / spans / sessions lenses + master–detail reader | Trace / Span / Session |
| `/issues` | Issues list master–detail | Issue |
| `/issues/[id]` | Issue detail (full page allowed; also deep-linkable from list) | Issue |
| `/alerts` | Alerts inbox + rules + signals | Alert / Signal |
| `/evals` | Evaluate hub: datasets, playgrounds, experiments, labeling, studio, synthetic as **tabs** | Dataset / Experiment |
| `/evals/datasets/[id]` | Dataset detail (optional dedicated page if hub drawer insufficient) | Dataset |
| `/improve` | Improve hub: queue, plans, artifacts, promotions, ledger, history | Plan / Artifact |
| `/improve/plans/[id]` | Plan detail: evidence, artifacts, PR actions | Plan |
| `/guardrails` | Guardrail **policies** CRUD + attachment — **no red-team tab** | GuardrailPolicy |
| `/cost` | Spend, budgets, outcomes, forecast, model advisor as **tabs** | CostBudget |
| `/agent` | Eden AI Agent full page | AI session |
| `/audit` | Audit trail + AuditPack export | AuditPack |
| `/debugger` | Debugger sessions list | DebuggerSession |
| `/debugger/[id]` | Debugger session: replay / compare / time-travel | DebuggerSession |
| `/settings` | Workspace settings via `?tab=` | Org / Account |

### 2.2 Auth / marketing (out of product nav; preserve)

| Route | Purpose |
|-------|---------|
| `/sign-in`, `/sign-up` | Clerk auth |
| Marketing routes | Unauthenticated site — not part of portal IA rebuild contract beyond shared tokens |

### 2.3 Settings tabs (single page)

Canonical: `/settings?tab=<id>`

| `tab` | Purpose |
|-------|---------|
| `overview` | Workspace pulse / recovery |
| `account` | Personal account (ex-`/profile`) |
| `org` | Org profile |
| `members` | Members / invites |
| `api-keys` | Org API keys |
| `gateway` | Gateway configuration & instructions |
| `security` | Security + alert channels |
| `billing` | Billing |
| `finops` | Finops kills / related |
| `pii` | PII policies |
| `retention` | Retention |
| `exports` | Exports |
| `webhooks-dlq` | Webhook DLQ |
| `mcp` | MCP |
| `scim` | SCIM |
| `status` | Status |
| `autonomous` | Autonomous improve toggles (if retained) |
| `sidebar` | Nav prefs (optional; defaults = FINAL tree) |
| `references` | References |
| `analytics` | Settings-level analytics prefs only — **not** the Later Analytics product hub |

Path-style `/settings/<tab>` **redirects** to query form.

---

## 3. URL query grammar — Traces (and shared Observe)

### 3.1 Hub lenses vs reader modes

Two different parameters — **do not conflate**:

| Param | Scope | Values | Meaning |
|-------|-------|--------|---------|
| **`view`** | Hub list lens | `traces` \| `spans` \| `sessions` | Which table/list is primary |
| **`mode`** | Trace reader canvas | `transcript` \| `tree` \| `timeline` \| `meta` \| `scores` | How selected trace is rendered |
| **`viewId`** | Saved table view | opaque id | Laminar-style saved view — **never** reuse `view` |

Default: `view=traces`, `mode=transcript` when a `traceId` is selected.

### 3.2 Selection & identity params

| Param | Canonical | Aliases (read, normalize on write) | Notes |
|-------|-----------|--------------------------------------|-------|
| `traceId` | yes | `trace_id`, `trace` | Master–detail selection |
| `spanId` | yes | `span_id`, `span` | Highlight / tree focus |
| `sessionId` | yes | `session_id` | Session lens selection; also filter |
| `agentId` | yes | `agent_id` | Scope filter |
| `issueId` | yes | `issue_id` | Cross-link from Issues |
| `alertId` | yes | `alert_id` | Cross-link from Alerts |

### 3.3 Filter / search params

| Param | Type | Meaning |
|-------|------|---------|
| `q` | string | Full-text / search bar |
| `filter` | string | Structured filter expression (implementation-defined dialect; stable across share) |
| `pastHours` | number-as-string | Relative time window (e.g. `24`) |
| `from` / `to` | ISO8601 | Absolute range (optional; if set, prefer over `pastHours`) |
| `outcome` | enum string | e.g. `error` \| `ok` \| `unknown` |
| `realm` | string | Legacy/env facet if retained |
| `facet` | enum | Soft facet highlight: `mcp` \| `decisions` \| `memory` \| `retrieval` — **not** separate pages |
| `live` | `0`\|`1` | Live tail when supported |

### 3.4 Legacy embed params (accept → map)

Old portal used `view=inspect|replay|debug|query|time-travel|cohorts`. Rebuild mapping:

| Legacy `view=` | New behavior |
|----------------|--------------|
| `inspect` | Open detail; `mode=meta` (or inspector pane visible) |
| `replay` | CTA / navigate to `/debugger?traceId=` (seed) — do not keep fake hub |
| `debug` | Navigate to `/debugger` seeded |
| `query` | Keep as **panel** on `/traces` if shipped; else ignore gracefully |
| `time-travel` | `/debugger` time-travel mode |
| `cohorts` | Filter chip / saved `viewId` — not a route |
| `traces`\|`spans`\|`sessions` | Hub lens (keep) |

### 3.5 Example URLs

```
/traces
/traces?view=sessions
/traces?view=traces&traceId=tr_abc&mode=transcript
/traces?traceId=tr_abc&spanId=sp_9&mode=tree
/traces?view=sessions&sessionId=ses_1
/traces?agentId=agent_support&pastHours=24&outcome=error
/traces?traceId=tr_abc&mode=scores
/traces?facet=retrieval&q=checkout
```

### 3.6 Shared cross-link preservation set

When navigating Issue/Alert → Trace (and back), preserve:

`pastHours` | `from` | `to` | `q` | `filter` | `agentId` | `outcome` | `realm` | `viewId`

Always set destination identity (`traceId` / `spanId` / `sessionId`) as applicable.

### 3.7 Other hubs — tab grammar (summary)

| Hub | Param | Values (v1) |
|-----|-------|-------------|
| `/alerts` | `tab` | `inbox` \| `rules` \| `signals` |
| `/issues` | `tab` | `open` \| `all` \| `incidents` (incidents = clustered lens, not separate product) |
| `/evals` | `tab` | `datasets` \| `playgrounds` \| `experiments` \| `labeling` \| `studio` \| `synthetic` \| `eval` |
| `/improve` | `tab` | `queue` \| `plans` \| `artifacts` \| `promotions` \| `ledger` \| `history` |
| `/guardrails` | `tab` | `policies` \| `violations` — **no `redteam`** |
| `/cost` | `tab` | `overview` \| `budget` \| `outcomes` \| `forecast` \| `advisor` |
| `/agents` | `tab` | `list` \| `fleet` |
| `/audit` | `tab` | `events` \| `packs` |
| `/debugger` | `tab` / mode | `sessions` \| `replay` \| `compare` \| `time-travel` |

Detail selection on hubs that are master–detail should use object ids (`issueId`, `alertId`, …) consistent with traces.

### 3.8 AI deep-link params (global)

| Param | Meaning |
|-------|---------|
| `ai=1` | Open AI bubble / panel |
| `ai_prompt` | Prefill prompt (URL-encoded) |
| `ai_session` | Resume Eden AI session id |

Usable on any authenticated page; `/agent` is the full-page home for longer threads.

---

## 4. What embeds vs what is a real page

### 4.1 Real pages (own route module)

- All rows in §2.1  
- Auth pages  
- Marketing (separate)

### 4.2 Embeds (must NOT be top-level product routes)

| Capability | Embed location |
|------------|----------------|
| Sessions list/detail | `/traces?view=sessions` |
| Spans list | `/traces?view=spans` |
| Trace inspector / meta | `/traces` + `mode=meta` |
| Scores on a trace | `/traces` + `mode=scores` |
| MCP / decisions / memory / retrieval facets | `/traces?facet=` |
| Signals | `/alerts?tab=signals` |
| Incidents cluster lens | `/issues?tab=incidents` or `/issues/[id]` |
| Plans / artifacts / promotions / ledger / history | `/improve?tab=` |
| Playgrounds / experiments / datasets / labeling / studio / synthetic | `/evals?tab=` |
| Fleet | `/agents?tab=fleet` |
| Cost advisor / budget / forecast | `/cost?tab=` |
| Alert rules | `/alerts?tab=rules` |
| Agent book / drift (if retained) | Tabs on `/agents/[id]` — **not** `/agents/[id]/book` forever; prefer `?tab=book\|drift` going forward (old paths redirect) |
| AI chat | Bubble overlay **and** `/agent` page |

### 4.3 Soft embeds (related strips)

Improve / Issues / Traces may show a **related strip** (links only) — never a nested second router tree.

---

## 5. Mobile bottom nav (5 items)

Fixed five — overnight triage path. No sixth “overflow as equal.” Overflow (“More”) may list the remaining core leaves.

| Slot | Label | Href | Notes |
|------|-------|------|-------|
| 1 | Home | `/dashboard` | |
| 2 | Traces | `/traces` | Sessions via in-hub control |
| 3 | Issues | `/issues` | |
| 4 | Improve | `/improve` | Closed-loop exit |
| 5 | More | sheet | Agents, Alerts, Evals, Cost, Guardrails, Agent AI, Audit, Settings, Debugger |

**More sheet order (recommended):** Agents → Alerts → Evals → Cost → Guardrails → AI Agent → Debugger → Audit → Settings → Docs (external).

Do not put Analytics/Prompts/Red-team in More.

---

## 6. Command palette destinations

Cmd+K (or Ctrl+K) must reach at least:

### 6.1 Core navigation

| Destination | Href |
|-------------|------|
| Dashboard | `/dashboard` |
| Agents | `/agents` |
| Connect agent | `/agents/connect` |
| Traces | `/traces` |
| Sessions | `/traces?view=sessions` |
| Issues | `/issues` |
| Alerts | `/alerts` |
| Alert rules | `/alerts?tab=rules` |
| Signals | `/alerts?tab=signals` |
| Evals | `/evals` |
| Datasets | `/evals?tab=datasets` |
| Playgrounds | `/evals?tab=playgrounds` |
| Experiments | `/evals?tab=experiments` |
| Improve | `/improve` |
| Plans | `/improve?tab=plans` |
| Artifacts | `/improve?tab=artifacts` |
| Promotions | `/improve?tab=promotions` |
| Ledger | `/improve?tab=ledger` |
| Guardrails | `/guardrails` |
| Cost | `/cost` |
| AI Agent | `/agent` |
| Debugger | `/debugger` |
| Audit | `/audit` |
| Settings | `/settings` |
| API keys | `/settings?tab=api-keys` |
| Gateway | `/settings?tab=gateway` |
| Members | `/settings?tab=members` |
| Billing | `/settings?tab=billing` |
| Docs Quickstart | external docs URL |

### 6.2 Actions (non-nav)

| Action | Behavior |
|--------|----------|
| Search traces | Focus `/traces` search (`q` editable) |
| Create issue | Opens create Issue (from context if `traceId` present) |
| Open AI | `?ai=1` or open bubble |
| Copy current deep link | Clipboard current URL |

Palette must **not** advertise killed routes (red-team, marketplace, builder, dual hubs).

---

## 7. Redirect map (old → new)

Permanent (`permanent: true`) unless noted. Preserve query string when destination supports the same params; otherwise map explicitly.

### 7.1 Observe consolidation

| Old | New |
|-----|-----|
| `/observability` | `/traces` |
| `/observability/apm` | `/traces` |
| `/observability/apm/:path*` | `/traces` |
| `/observability?trace_id=:id` | `/traces?traceId=:id` |
| `/observability?traceId=:id` | `/traces?traceId=:id` |
| `/observability/query` | `/traces` (query panel if present) |
| `/observability/mcp` | `/traces?facet=mcp` |
| `/observability/decisions` | `/traces?facet=decisions` |
| `/observability/memory` | `/traces?facet=memory` |
| `/observability/retrieval` | `/traces?facet=retrieval` |
| `/observability/time-travel` | `/debugger?tab=time-travel` |
| `/observability/cohorts` | `/traces` |
| `/observability/eval` | `/evals?tab=eval` |
| `/apm` | `/traces` |
| `/apm/:path*` | `/traces` |
| `/inspector` | `/traces?mode=meta` |
| `/replay` | `/debugger?tab=replay` |
| `/debugger-sessions` | `/debugger` |
| `/debugger-sessions/:id` | `/debugger/:id` |
| `/sessions` | `/traces?view=sessions` |
| `/sessions/:sessionId` | `/traces?view=sessions&sessionId=:sessionId` |
| `/signals` | `/alerts?tab=signals` |

### 7.2 Evaluate consolidation

| Old | New |
|-----|-----|
| `/playgrounds` | `/evals?tab=playgrounds` |
| `/experiments` | `/evals?tab=experiments` |
| `/datasets` | `/evals?tab=datasets` |
| `/datasets/:id` | `/evals/datasets/:id` or `/evals?tab=datasets&datasetId=:id` |
| `/labeling` | `/evals?tab=labeling` |
| `/labeling/queues/:id` | `/evals?tab=labeling&queueId=:id` |
| `/studio` | `/evals?tab=studio` |
| `/synthetic` | `/evals?tab=synthetic` |

### 7.3 Improve consolidation

| Old | New |
|-----|-----|
| `/artifacts` | `/improve?tab=artifacts` |
| `/artifacts/:path*` | `/improve?tab=artifacts` |
| `/ledger` | `/improve?tab=ledger` |
| `/promotions` | `/improve?tab=promotions` |
| `/promotions/:path*` | `/improve?tab=promotions` |
| `/improve/plans` | `/improve?tab=plans` |
| `/improve/runs` | `/improve?tab=history` |
| `/improve/scorecard` | `/improve?tab=history` (or hide — not core) |
| `/improve/online-scoring` | `/improve` (advanced tab if kept) |
| `/improve/change-impact` | `/improve` (advanced tab if kept) |
| `/pr-suggestions` | `/improve?tab=plans` |
| `/pr-suggestions/:path*` | `/improve?tab=plans` |
| `/agents/eden/inbox` | `/improve?tab=plans` |
| `/closed-loop` | `/improve` |
| `/autonomous` | `/improve` |
| `/optimization` | `/cost` |
| `/optimization/:path*` | map tabs → `/cost?tab=` (below) |
| `/optimization/budget` | `/cost?tab=budget` |
| `/optimization/outcomes` | `/cost?tab=outcomes` |
| `/optimization/predict` | `/cost?tab=forecast` |
| `/optimization/model-advisor` | `/cost?tab=advisor` |
| `/llmops` | `/cost` |

### 7.4 Agents / fleet / analytics / misc

| Old | New |
|-----|-----|
| `/fleet` | `/agents?tab=fleet` |
| `/analytics` | **Live** (Later secondary hub — not core leaf) |
| `/analytics?tab=users` | Live |
| `/users` | `/analytics?tab=users` |
| `/tools` | `/analytics?tab=tools` |
| `/insights` | `/analytics?tab=insights` |
| `/insights/topics` | `/analytics?tab=topics` |
| `/prompts` | **Live** (Later secondary registry — not core leaf) |
| `/prompts/:path*` | `/prompts` (or soft-land if unused) |
| `/incidents` | `/issues?tab=incidents` |
| `/incidents/:cluster_id` | `/issues?tab=incidents&issueId=:cluster_id` (or issues id map) |
| `/runs/:run_id/lineage` | `/traces?traceId=:run_id&mode=tree` (best-effort) |
| `/onboarding/improvement-loop` | `/improve` |
| `/profile` | `/settings?tab=account` |
| `/billing` | `/settings?tab=billing` |
| `/finops` | `/settings?tab=finops` |
| `/audit-trail` | `/audit` |
| `/audit-trail/:path*` | `/audit` |

### 7.5 Guardrails / red-team (kill)

| Old | New |
|-----|-----|
| `/redteam` | `/guardrails?tab=policies` |
| `/redteam/:path*` | `/guardrails?tab=policies` |
| `/guardrails?tab=redteam` | `/guardrails?tab=policies` |

Strip red-team UI components entirely in teardown; redirects are safety nets only.

### 7.6 Settings path → query

| Old | New |
|-----|-----|
| `/settings/gateway` | `/settings?tab=gateway` |
| `/settings/exports` | `/settings?tab=exports` |
| `/settings/pii` | `/settings?tab=pii` |
| `/settings/retention` | `/settings?tab=retention` |
| `/settings/sidebar` | `/settings?tab=sidebar` |
| `/settings/status` | `/settings?tab=status` |
| `/settings/webhooks-dlq` | `/settings?tab=webhooks-dlq` |

### 7.7 Already-dead product surfaces → Dashboard

| Old | New |
|-----|-----|
| `/marketplace`, `/marketplace/:path*` | `/dashboard` |
| `/multi-agent`, `/multi-agent/:path*` | `/dashboard` |
| `/builder`, `/builder/:path*` | `/dashboard` |
| `/jobs`, `/jobs/:path*` | `/dashboard` |
| `/eval-harnesses`, `/eval-harnesses/:path*` | `/dashboard` |
| `/sandbox`, `/sandbox/:path*` | `/dashboard` |
| `/agents/:id/sim-runs`, `.../:path*` | `/agents/:id` |
| `/agents/:id/test-runs`, `.../:path*` | `/agents/:id` |

### 7.8 Agent sub-routes (normalize)

| Old | New |
|-----|-----|
| `/agents/:id/artifacts` | `/improve?tab=artifacts&agentId=:id` |
| `/agents/:id/ledger` | keep **or** `/improve?tab=ledger&agentId=:id` — prefer keep thin agent ledger page that shares Improve ledger component |
| `/agents/:id/book` | `/agents/:id?tab=book` |
| `/agents/:id/drift` | `/agents/:id?tab=drift` |

### 7.9 Auth aliases

| Old | New |
|-----|-----|
| `/login` | `/sign-in` |
| `/signup` | `/sign-up` |

### 7.10 Docs

| Old | New |
|-----|-----|
| `/docs` | `https://docs.edenobservability.com` (permanent) |
| `/docs/:path*` | docs site equivalent |

---

## 8. Kill list (routes & concepts)

### 8.1 Routes / surfaces — never rebuild

- Red-team UI (`/redteam`, guardrails red-team tab, attack libraries as product)  
- Marketplace, builder, sandbox, multi-agent builder, jobs board, eval-harnesses  
- Hub-of-hubs: `/observability/*` as a product area  
- Dual top-level: `/signals`, `/promotions`, `/artifacts`, `/ledger`, `/fleet`, `/inspector`, `/replay` as peers of canonical hubs  
- Profile as standalone app section  
- “Eden inbox” agent pseudo-routes (`/agents/eden/inbox`)  
- `/closed-loop`, `/autonomous`, `/llmops`, `/apm` as brands  

> **Amendment 2026-07-22:** `/prompts` and `/analytics` ship as **Later secondary destinations** (Cmd+K / Mobile More only — not core leaves). See [`surfaces/prompts.md`](./surfaces/prompts.md) and [`surfaces/analytics.md`](./surfaces/analytics.md).  

### 8.2 Concepts — banned in UI copy & IA

| Concept | Replace with |
|---------|--------------|
| Hub of hubs / “Overview” that only links out | Real landing content (Dashboard agent OS) |
| Decorative KPI card spam | Diagnosis + agent list + next action |
| Purple SaaS glow / decorative Phosphor Green | Brand tokens |
| Dual names for same object | Glossary terms in bible |
| Advanced burying Agents | Agents group core |
| Red team / adversarial test center | Guardrail **policies** + violations |
| Manager-only app | Same surfaces |

### 8.3 Pattern kills

- Second sidebar inside Settings (double rail)  
- Unmounting list on row select (≥1280)  
- Overloading `view` for saved views (use `viewId`)  
- Shipping both `/sessions` **and** `/traces?view=sessions` as non-redirect duplicates  

---

## 9. Breadcrumb rules

### 9.1 Format

```
Org switcher (chrome) · Group · Leaf · [Detail title] · [Subtab]
```

Visible breadcrumb in content header (not duplicating entire sidebar):

| Page type | Breadcrumb |
|-----------|------------|
| Dashboard | `Home` |
| Agents list | `Agents` |
| Agent detail | `Agents / {agentDisplayName}` |
| Traces hub | `Observe / Traces` |
| Trace selected | `Observe / Traces / {traceIdShort}` |
| Session lens | `Observe / Sessions` (+ session id when selected) |
| Issues | `Observe / Issues` |
| Issue detail | `Observe / Issues / {issueTitle\|id}` |
| Alerts | `Observe / Alerts` |
| Evals | `Evaluate / Evals` |
| Improve | `Improve` |
| Plan detail | `Improve / Plans / {planTitle\|id}` |
| Guardrails | `Improve / Guardrails` |
| Cost | `Improve / Cost` |
| AI Agent | `Workspace / Agent` |
| Audit | `Workspace / Audit` |
| Settings | `Workspace / Settings` |
| Debugger | `Observe / Debugger` (group Observe even if not core leaf) |

### 9.2 Behavior

- Last crumb is current; prior crumbs are links.  
- IDs in crumbs use mono short form; full ID in title tooltip.  
- Do not mirror every query param in breadcrumbs (`mode`, `pastHours` stay in URL only).  
- i18n: group/leaf labels translated; object titles may be user data (no translation).

---

## 10. Deep-link preservation rules

### 10.1 Hard requirements

1. **Refresh restores state.** Any selectable master–detail id in the URL survives reload.  
2. **Share restores state.** Pasting URL into another session (same org auth) opens the same selection + mode + critical filters.  
3. **Cross-surface links write canonical params** (`traceId` not only `trace_id`).  
4. **Back button** returns to previous URL including query (browser history) — do not `replace` on every keystroke in search; debounce or explicit Apply for heavy filters.  
5. **Esc** closes detail / drawer and **removes** selection params without wiping filters.  
6. **AI citations** navigate with canonical object URLs.  
7. **Org switch** drops another org’s object ids; keep only global UI prefs.

### 10.2 Write normalization

On any URL update helper:

- Prefer camelCase keys.  
- Delete aliases when writing canonical.  
- Omit empty params.  
- Skip navigation when serialized query unchanged (avoid thrash).

### 10.3 Preserve sets by transition

| From → To | Must preserve | Must set | May drop |
|-----------|---------------|----------|----------|
| Traces list → Trace detail | filters (`pastHours`,`q`,`filter`,`agentId`,…) | `traceId`, default `mode=transcript` | — |
| Trace → Issue create | evidence ids | issue draft context | reader `mode` optional |
| Issue → Trace evidence | issue filters if any | `traceId` (+ `spanId`) | unrelated alert ids |
| Trace → Debugger | `traceId`,`agentId` | debugger session seed | hub `view` |
| Any → Settings | — | `tab` | object selection |
| Any → AI open | current object ids in context payload | `ai=1` optional | — |

### 10.4 Mobile

Same URL grammar. Bottom nav must not strip query when returning to a hub if the hub is already mounted with state — prefer keeping search params when tapping the same hub icon.

---

## 11. Floating AI bubble vs `/agent`

| Surface | Role |
|---------|------|
| **Bubble** | Persistent, clickable; opens compact chat; context = current page objects |
| **`/agent`** | Full-page threads, history, denser tool cards |

Both are must-ship. Bubble visible on all authenticated product pages (not marketing). Not a 13th confusing product — Workspace leaf + chrome.

---

## 12. Implementation checklist (IA acceptance)

- [ ] Sidebar matches §1 with **exactly 12** core leaves  
- [ ] Agents group exists; Agents not `category: advanced`  
- [ ] Login lands on `/dashboard`  
- [ ] `/sessions` redirects to `/traces?view=sessions`  
- [ ] `/cost` is canonical (not `/optimization`)  
- [ ] `/audit` is canonical (not `/audit-trail`)  
- [ ] `/agent` exists (AI); `/agents` exists (customer agents) — names distinct in i18n  
- [ ] No red-team route or tab  
- [ ] Redirect map §7 covered in `next.config` (or successor)  
- [ ] Trace URL grammar §3 implemented with tests  
- [ ] Mobile 5-item nav matches §5  
- [ ] Cmd+K destinations match §6  
- [ ] Breadcrumbs match §9  
- [ ] Deep-link rules §10 tested (refresh, share, Esc, cross-link)  
- [ ] Docs remain external; i18n en/de on all nav strings  

---

## 13. Naming collision note (critical)

| Path | Meaning |
|------|---------|
| `/agents` | **Customer** agents under observation |
| `/agent` | **Eden AI** assistant page |

UI labels must disambiguate: nav “Agents” vs “AI Agent” (i18n keys distinct). Never title both “Agent” alone in the same chrome band.

---

*End of 02-information-architecture.md*
