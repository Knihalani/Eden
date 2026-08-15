<!-- Wave 1 Job 9 — w1-redirect-audit (read-only discovery, 2026-07-20). -->

# Job 9 — Redirect / dual-URL audit

**Mechanisms:**
1. `clients/portal/next.config.ts` `redirects()` (~70–192)
2. `clients/portal/src/lib/portal-hub-redirect.ts` + `buildHubRedirectUrl` (query-preserving)
3. `clients/portal/src/proxy.ts` (Clerk middleware wrapper) calls hub redirect at `:148-150` (307)
4. Page-level / client: `router.replace`, App Router `redirect()`

**Note:** Next static redirects with `?` on the destination **drop** source query — hub-redirect exists to merge query. Both layers currently list overlapping Observe soft nests.

---

## 1. Hub redirect table (`HUB_REDIRECT_RULES`)

Source: `portal-hub-redirect.ts:14-58`. Applied in `proxy.ts:148-150` as **307**.

| From | To | Params |
|---|---|---|
| `/datasets` | `/evals` | `tab=datasets` |
| `/playgrounds` | `/evals` | `tab=playgrounds` |
| `/experiments` | `/evals` | `tab=experiments` |
| `/labeling` | `/evals` | `tab=labeling` |
| `/studio` | `/evals` | `tab=studio` |
| `/synthetic` | `/evals` | `tab=synthetic` |
| `/signals` | `/alerts` | `tab=signals` |
| `/fleet` | `/agents` | `tab=fleet` |
| `/incidents` | `/issues` | `tab=incidents` |
| `/users` | `/analytics` | `tab=users` |
| `/insights` | `/analytics` | `tab=insights` |
| `/tools` | `/analytics` | `tab=tools` |
| `/autonomous` | `/improve` | — |
| `/closed-loop` | `/improve` | — |
| `/apm` | `/traces` | — |
| `/replay` | `/traces` | `view=replay` |
| `/debugger` | `/traces` | `view=debug` |
| `/observability` | `/traces` | — |
| `/observability/mcp` | `/traces` | `facet=mcp` |
| `/observability/decisions` | `/traces` | `facet=decisions` |
| `/observability/memory` | `/traces` | `facet=memory` |
| `/observability/retrieval` | `/traces` | `facet=retrieval` |
| `/observability/time-travel` | `/traces` | `view=time-travel` |
| `/observability/cohorts` | `/traces` | `view=cohorts` |
| `/redteam` | `/guardrails` | `tab=redteam` |
| `/profile` | `/settings` | `tab=account` |
| `/billing` | `/settings` | `tab=billing` |

**Missing from hub-redirect but present in next.config:** `/inspector`, `/observability/query`, `/observability/eval`, settings tab paths, improve plans/runs, many dead→dashboard routes. Those rely on static redirects only (query drop risk if bookmarks carry `?`).

---

## 2. `next.config.ts` consolidation block (July 2026)

Key Observe / Advanced consolidations (`next.config.ts:109-174`):

| Source | Destination | permanent |
|---|---|---|
| `/observability` (+ trace_id/traceId has-rules) | `/traces` … | mixed |
| `/observability/{mcp,decisions,memory,retrieval}` | `/traces?facet=…` | true |
| `/observability/time-travel` | `/traces?view=time-travel` | true |
| `/observability/cohorts` | `/traces?view=cohorts` | true |
| `/observability/query` | `/traces?view=query` | true |
| `/observability/eval` | `/evals?tab=eval` | true |
| `/inspector` `/replay` `/debugger` | `/traces?view=…` | true |
| `/fleet` `/signals` `/incidents` `/studio` `/tools` `/users` `/insights` … | hub `?tab=` | true |
| `/redteam` | `/guardrails?tab=redteam` | true |
| Settings tab paths | `/settings?tab=…` | false |
| `/improve/plans` `/improve/runs` | improve tabs | false |

Settings exception: `/settings/webhooks-dlq` intentionally **not** redirected (`next.config.ts:79` comment).

---

## 3. Middleware / proxy

| Layer | Behavior | Evidence |
|---|---|---|
| `proxy.ts` | After intl, `buildHubRedirectUrl(path, search)` → 307 | `:148-150` |
| Clerk protect | Only `KNOWN_PORTAL_PREFIXES` | `:168+` |
| Locale | next-intl may redirect `/` → `/de` first | `:141-146` |

There is no separate `middleware.ts` export beyond the proxy rename pattern documented in-file (`:120-123`).

---

## 4. Page-level redirects

| Location | Behavior | Evidence |
|---|---|---|
| `(marketing)/health/page.tsx` | `redirect("/status")` | App Router |
| Settings gateway tab page | `router.replace(/settings?…)` | `settings/(tabs)/gateway/page.tsx:29` |
| Playgrounds from-span | `router.replace("/evals?tab=playgrounds")` after create | `playgrounds/page.tsx:119` |
| Traces filter write | `router.replace` same path + qs | `traces/page.tsx:211` |
| Alerts rules/tab | `router.replace` | `alerts/page.tsx:378+` |
| portal-chrome | Orgless → `/settings?tab=org` | chrome (not URL dual) |
| Auth pages | Clerk `forceRedirectUrl` / sanitize | `lib/auth-redirect.ts` |

---

## 5. GAP redirects (needed but missing / incomplete)

### 5.1 Soft-nest incomplete (redirect exists, hub does not honor)

| From | Claimed to | Gap |
|---|---|---|
| `/observability/cohorts` | `/traces?view=cohorts` | **`cohorts` not in `ALL_VIEWS` / no CohortsView embed** — `useQueryTab` falls back to `traces` (`traces/page.tsx:61-64`, `use-query-tab.ts:15-16`) |

### 5.2 Live dual URLs (filesystem reachable; no redirect)

| Path | Why GAP | Suggested nest |
|---|---|---|
| `/optimization/budget` | Own PageHeader chrome; also Cost tab | `/optimization?tab=budget` |
| `/optimization/outcomes` | same | `?tab=outcomes` |
| `/optimization/predict` | same | `?tab=predict` |
| `/optimization/model-advisor` | same | `?tab=advisor` |
| `/improve/scorecard` | CrossLink orphan | Improve tab or keep unlisted |
| `/improve/change-impact` | CrossLink orphan | Improve tab or unlisted |
| `/improve/online-scoring` | CrossLink orphan | Improve tab or unlisted |

Detail KEEP (intentional, not GAP): `/incidents/[cluster_id]`, `/labeling/queues/[id]`, `/datasets/[id]`, `/debugger-sessions`, `/debugger-sessions/[id]`, `/agents/connect`, `/sessions/[sessionId]`.

### 5.3 Hub-redirect coverage holes (static-only)

| Path | next.config | HUB_REDIRECT_RULES | Risk |
|---|---|---|---|
| `/inspector` | yes → view=inspect | **no** | Query on `/inspector?trace=…` may drop on static redirect |
| `/observability/query` | yes | **no** | same |
| `/observability/eval` | yes → evals | **no** | same |
| `/insights/topics` | yes | **no** (`/insights` only) | topics query merge |

### 5.4 Spec drift

`w3-redirect-ia.md` still marks rules 8–13 (mcp…cohorts) as **GAP**, but `next.config.ts:149-156` + `HUB_REDIRECT_RULES` already ship them. **Update status → SHIPPED** except cohorts nest wiring. Tests in `u18-portal.test.ts:18-26,73-81` already treat them as required rules.

---

## 6. Competing dual UIs (user confusion)

| Pair | Same job? | Canonical | Confusion |
|---|---|---|---|
| `/traces` vs Inspector/Replay/Debugger/Time-Travel/Query | Observe one run | Traces `?view=` | Separate titles + toolbars; More menu still exposes tools |
| `/traces?facet=*` vs `/observability/{mcp,…}` modules | Facet analytics | Traces facet | Modules still full-chrome capable; redirects hide URL but not dual design |
| `/debugger` vs `/debugger-sessions` | Different products, similar names | Both live (legacy→traces; sessions Advanced) | Naming collision |
| Agents vs Fleet | Agent estate | Agents `?tab=fleet` | Fleet CrossLinkBar when not embedded |
| Alerts vs Signals sidebar entry | Alerting | Alerts | Advanced “Signals” duplicates hub |
| Issues vs Incidents | Failure triage | Issues `?tab=incidents` | Dual list chrome historically |
| Guardrails vs `/redteam` | Safety testing | Guardrails tab | Thin standalone still exists as embed source |
| Cost hub vs `/optimization/*` children | FinOps | `/optimization?tab=` | **Deep links skip hub chrome** |
| Evals vs Studio/Labeling/… | Eval workflow | Evals tabs | 7-tab mega-hub + dense Studio |
| Replay vs Time-Travel “replay” | Timeline restore | Traces overflow | Shared vocabulary |
| Query → link `/observability/cohorts` | Columnar SQL | Should be `/traces?view=cohorts` | Extra redirect hop; nest broken |

---

## 7. Evidence checklist

- `next.config.ts:70-192`
- `portal-hub-redirect.ts:14-78`
- `proxy.ts:134-150`
- `traces/page.tsx:61-64,103-138,768-779`
- `u18-portal.test.ts:18-100`
- `portal-hub-redirect.test.ts` (time-travel/cohorts soft-nest cases)
- `w3-redirect-ia.md` §1.1 status column (stale GAP labels)
