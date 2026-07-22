# Surface: Agents

> **Status:** Authoritative surface contract  
> **Decision date:** 2026-07-21  
> **Phase:** P2 Agents + Dashboard (detail continues through later phases)  
> **Companions:** [../01-product-bible.md](../01-product-bible.md) · [../02-information-architecture.md](../02-information-architecture.md) · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md) · [../03-competitive-synthesis.md](../03-competitive-synthesis.md)

---

## 1. Purpose

**One decision this page owns:** Which **Agent** am I operating on — and is it healthy enough to debug, evaluate, or improve tonight?

Agents are the **spine** of Eden (bible §3.3). This surface is the fleet list + agent home — not buried under Advanced, not a second Observe hub.

**Naming collision:** `/agents` = customer agents; `/agent` = Eden AI assistant. Labels must stay distinct (i18n: “Agents” vs “AI Agent”).

---

## 2. Primary user + JTBD

| | |
|--|--|
| **Primary** | Mira — connect agent tonight; open the one that’s failing |
| **Secondary** | Jordan — fleet coverage / health glance |
| **JTBD** | J1 Connect agent · C12 list → detail · feeds J2–J11 scoped by `agentId` |
| **Done when** | Agent identity exists; first Trace visible; agent appears on Dashboard |

---

## 3. URL + query grammar

### 3.1 Canonical routes

| Route | Purpose |
|-------|---------|
| `/agents` | List / fleet lens |
| `/agents/connect` | First-run Gateway or SDK connect |
| `/agents/[id]` | Agent home |
| `/agents/[id]/ledger` | Agent-scoped ledger (thin page; shares Improve ledger component) |
| `/fleet` | **Redirect** → `/agents?tab=fleet` |
| `/agents/:id/book` | **Redirect** → `/agents/:id?tab=book` |
| `/agents/:id/drift` | **Redirect** → `/agents/:id?tab=drift` |
| `/agents/:id/artifacts` | **Redirect** → `/improve?tab=artifacts&agentId=` |
| `/agents/:id/sim-runs`, `test-runs` | **Redirect** → `/agents/:id` |

### 3.2 Query params

| Param | Values | Notes |
|-------|--------|-------|
| `tab` (list) | `list` \| `fleet` | Default `list` |
| `tab` (detail) | `overview` \| `traces` \| `issues` \| `ledger` \| `artifacts` \| `book` \| `drift` \| `cost` \| `guardrails` | Default `overview`. Peeks are **links/embeds of summary strips** — not nested full hubs with second headers |
| `q` / `filter` / `viewId` | | Search / filter / saved view |
| `status` | `healthy` \| `degraded` \| `failing` \| `silent` \| `unknown` | Fleet filters |
| `ai=1` / `ai_prompt` / `ai_session` | | Global AI deep links |

### 3.3 Example URLs

```
/agents
/agents?tab=fleet
/agents/connect
/agents/agent_support
/agents/agent_support?tab=overview
/agents/agent_support?tab=drift
/agents/agent_support/ledger
```

### 3.4 Breadcrumb

| State | Crumb |
|-------|-------|
| List | `Agents` |
| Connect | `Agents / Connect` |
| Detail | `Agents / {agentDisplayName}` |
| Ledger child | `Agents / {name} / Ledger` |

---

## 4. Layout diagrams

### 4.1 Desktop ≥1280 — list

```
┌─ AppShell ──────────────────────────────────────────────────────────────┐
│ Sidebar │ Agents · Ask AI                                               │
│         │ PageHeader: Agents                         [Connect agent]    │
│         │ tabs: List | Fleet                                            │
│         │ Toolbar: Views · Search · Filter · Display · ⋯                │
│         ├───────────────────────────────────────────────────────────────┤
│         │ DataTable / fleet cards                                       │
│         │ name · status · last trace · error rate · $/24h · open issues │
│         │ Row click → /agents/[id] (full navigation OK — not span spam) │
│         └───────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────┘
```

**Fleet tab:** denser ops lens (Braintrust-class table or compact health grid). Still Agents surface — not a top-level `/fleet` leaf.

### 4.2 Agent detail — overview (Laminar agent-home energy)

```
┌─ /agents/[id] ──────────────────────────────────────────────────────────┐
│ Agents / Support Bot                          [Ask AI] [Open traces]    │
│ StatusBadge · gateway key hint · last seen                              │
│ panels: Overview | Traces | Issues | Ledger | Artifacts | Cost | …      │
├─────────────────────────────────────────────────────────────────────────┤
│ Diagnosis strip (Signals-style): top issues / failing rate              │
│ Recent traces (transcript previews — rows, not cards)                   │
│ Open issues peek → /issues?agentId=                                     │
│ Improve peek: latest plan/artifact/PR → /improve?agentId=               │
│ Ledger peek → tab=ledger or /agents/[id]/ledger                        │
│ Cost peek StatCards (Helicone OK here) → /cost?agentId=                 │
│ Guardrails attached policies → /guardrails?agentId=                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Connect first-run

```
┌─ /agents/connect ───────────────────────────────────────────────────────┐
│ Connect an agent                                                        │
│ Segmented: Gateway | SDK                                                │
│ Copy: base URL · API key · sample curl / snippet                        │
│ Checklist: key created → request sent → waiting for first Trace         │
│ Troubleshoot panel: auth, model, CORS                                   │
│ Secondary: external docs quickstart                                     │
│ CTA: I’ve sent a request → poll Traces / Dashboard                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.4 Mobile

```
List full width; detail = full page (agent is primary object — OK)
Connect: single column wizard (kit Wizard)
Bottom nav More → Agents
Touch ≥44px
```

### 4.5 Mermaid — first-run

```mermaid
flowchart TD
  A[Dashboard empty] --> B[/agents/connect]
  B --> C{Gateway or SDK}
  C --> D[Copy credentials]
  D --> E[Send first request]
  E --> F{Trace ingested?}
  F -->|No| G[Troubleshoot]
  G --> E
  F -->|Yes| H[/agents/id + Dashboard pulse]
```

---

## 5. Chrome budget

| Rule | Contract |
|------|----------|
| Bands | ≤2 |
| List toolbar | ≤5: Views, Search, Filter, Display, Connect |
| Detail | Panel tabs in content — not a third global band |
| One solid CTA | List: `Connect agent`; Detail overview: `Open traces` **or** `Create plan` depending on health — only one solid |
| No dual always-on AI rail | Bubble collapsed by default |

---

## 6. States

| State | Behavior |
|-------|----------|
| **Empty / first-run** | No agents: single CTA `Connect agent` → `/agents/connect`. No Analytics tourism |
| **Loading** | Skeleton rows |
| **Error** | Retry |
| **Filtered-empty** | Clear filters |
| **Populated** | List / fleet |
| **Silent agent** | Status `silent` — last seen stale; CTA troubleshoot / gateway settings |
| **Connect waiting** | Live/poll for first Trace; distinguish waiting vs error |
| **Detail no traffic** | Empty recent traces with connect/docs secondary |

---

## 7. Components used (kit only)

| Kit | Use |
|-----|-----|
| `PageHeader`, `Tabs` | List + detail panels |
| `DataTable`, `QueryState`, `QueryFilterBar`, `ViewsMenu` | List/fleet |
| `StatusBadge` | Agent health |
| `StatCard` | Cost/health KPIs on overview **only** |
| `Panel` | Grouping peeks |
| `Button`, `Dialog`, `Sheet`, `Wizard` | Connect + confirms |
| `MetricInline` | Rates, latency on rows |
| `CodeChip` | agentId, gateway headers |
| `CommandPalette` | Agents, Connect, open by name |

**Domain:** `AgentHealthStrip`, `AgentPeekTraces`, `AgentPeekIssues`, `ConnectGatewayPanel`, `ConnectSdkPanel`, `FleetHealthTable`.

**Ban:** Nested full `/traces` or `/improve` page chrome inside detail tabs. Peeks = summary + “View all” link with `agentId` preserved.

---

## 8. Keyboard map

| Key | Action |
|-----|--------|
| `⌘K` | Palette (Agents, Connect) |
| `⌘J` | Ask AI with agent context |
| `/` | Focus search |
| `↑` `↓` `Enter` | List navigate |
| `c` | Connect agent |
| `t` | Open `/traces?agentId=` from detail |
| `i` | Open `/issues?agentId=` |
| `m` | Open `/improve?agentId=` (m = improve / mend) |
| `Esc` | Close dialogs/sheets |

---

## 9. Closed-loop exits

| From | To | Max | Preserve |
|------|----|-----|----------|
| List row | `/agents/[id]` | **1** (C12) | — |
| Detail | `/traces?agentId=` | **1** | filters optional |
| Detail diagnosis | `/issues?agentId=` | **1** | — |
| Detail | `/improve?tab=queue&agentId=` | **1** | — |
| Detail | `/improve?tab=ledger&agentId=` or child ledger | **1** | — |
| Detail | `/cost?agentId=` | **1** | — |
| Detail | `/guardrails?agentId=` | **1** | — |
| Detail | `/evals?agentId=` | **1** | — |
| Connect success | Dashboard + Agent detail | auto | first `traceId` optional deep link |
| Any | AI bubble | **1** | agentId in context |

---

## 10. Anti-patterns banned on this surface

- Agents under Advanced / hidden group
- Titling both `/agent` and `/agents` as “Agent” in the same chrome band
- Hub-of-hubs second headers embedding full Observe/Improve pages
- Top-level Fleet leaf (use `tab=fleet`)
- Sim-runs / test-runs / marketplace / builder resurrection
- Helicone card collage as the **list** default (fleet may use compact health; prefer table)
- Requiring Eval or GitHub before first Trace
- Red-team attach as connect step
- Decorative purple glow; 9–10px labels; sticky sandwich

---

## 11. Acceptance checklist

- [x] `/agents` core sidebar leaf under Agents group; not advanced
- [x] `tab=list|fleet`; `/fleet` redirects
- [x] `/agents/connect` Gateway **and** SDK paths; troubleshoot panel
- [x] First Trace → agent on Dashboard (live or refresh)
- [x] `/agents/[id]` overview: diagnosis strip + peeks with “View all” links
- [x] Detail tabs do **not** mount nested PageHeaders of other hubs
- [ ] Ledger child shares Improve ledger component *(Phase 2: thin local ledger page; full Improve share deferred to Phase 5)*
- [x] Redirects for book/drift/artifacts/sim-runs per IA
- [x] Chrome ≤2 bands; one solid CTA; QueryState complete
- [x] i18n disambiguates Agents vs AI Agent; en+de
- [x] Viewer read-only; Member+ connect/edit; Admin delete *(delete UI omitted — no backend delete API; noted in interview log)*

---

## 12. Object fields (UI)

| Field | Display |
|-------|---------|
| `agentId` | Mono + copy |
| Display name | Primary title |
| Status | StatusBadge |
| Last trace at | Relative + UTC tooltip |
| Error rate / latency / cost | MetricInline when present |
| Open issues count | Link |
| Gateway binding | Settings deep link if missing |

---

## 13. Permissions

| Action | Viewer | Member | Admin |
|--------|--------|--------|-------|
| View list/detail | ✓ | ✓ | ✓ |
| Connect / edit agent | | ✓ | ✓ |
| Delete agent | | | ✓ |

---

*End of surfaces/agents.md*
