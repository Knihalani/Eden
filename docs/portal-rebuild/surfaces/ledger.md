# Surface: Ledger

> **Status:** Authoritative surface contract  
> **Decision date:** 2026-07-21  
> **Phase:** P5 Improve (ledger tab + agent-scoped page)  
> **Companions:** [improve.md](./improve.md) · [agents.md](./agents.md) · [../01-product-bible.md](../01-product-bible.md) · [../02-information-architecture.md](../02-information-architecture.md) · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md)

---

## 1. Purpose

**One decision this page owns:** What changed for this Agent (or org) over time — promotions, shipped PRs, artifact versions — and can I trust that institutional memory when asking “did our last fix help?”

Ledger is a **product noun** (bible): append-only memory of Improve outcomes. It is **not** a core sidebar leaf. Canonical host: `/improve?tab=ledger`. Optional thin page: `/agents/[id]/ledger`.

---

## 2. Primary user + JTBD

| | |
|--|--|
| **Primary** | Mira — verify a fix landed after overnight PR |
| **Secondary** | Jordan — leadership-ready change history per agent |
| **JTBD** | J8 Promote / record outcome; supports “did last fix help?” trigger |
| **Done when** | Entry visible for Promote and merged/opened PR; deep-links to Artifact/Plan/PR/Trace evidence |

---

## 3. URL + query grammar

### 3.1 Canonical entry points

| Route | Role |
|-------|-------|
| `/improve?tab=ledger` | **Canonical** org/agent-filterable ledger |
| `/agents/[id]/ledger` | Agent-scoped; **same component** + locked `agentId` |
| `/ledger` | **Redirect** → `/improve?tab=ledger` |

### 3.2 Query params

| Param | Values | Notes |
|-------|--------|-------|
| `tab=ledger` | required on Improve hub | |
| `agentId` | id | Scope; locked on agent child route |
| `entryId` | id | Master–detail selection |
| `kind` | `promotion` \| `pr` \| `artifact` \| `rollback` \| `note` | Filter |
| `q` / `filter` / `viewId` | | |
| `pastHours` / `from` / `to` | | Time window |
| `planId` / `artifactId` / `promotionId` / `prId` | | Cross-link focus |

### 3.3 Example URLs

```
/improve?tab=ledger
/improve?tab=ledger&agentId=agent_support
/improve?tab=ledger&kind=pr&pastHours=168
/improve?tab=ledger&entryId=led_88
/agents/agent_support/ledger
/ledger  →  /improve?tab=ledger
```

### 3.4 Breadcrumb

| Entry | Crumb |
|-------|-------|
| Improve tab | `Improve` (header title region may say Ledger) |
| Agent page | `Agents / {name} / Ledger` |

---

## 4. Layout diagrams

### 4.1 Desktop ≥1280

```
┌─ Improve · tab=ledger ──────────────────────────────────────────────────┐
│ PageHeader inherits Improve; tab=Ledger active                          │
│ Toolbar: Views · Search · Kind filter · Time · Display · ⋯              │
│ (Agent child page: no Improve tabs — PageHeader Ledger + back to agent) │
├──────────────────────────────┬──────────────────────────────────────────┤
│ Timeline / DataTable (~55%)  │ Entry detail (~45%)                      │
│ time · kind · title · agent  │ Summary                                  │
│ actor · status               │ Links: Plan · Artifact · Promotion · PR  │
│                              │ Evidence refs (Issue/Experiment/Traces)  │
│                              │ Diff peek / Show Code (read-only)        │
│                              │ CTA: Open Plan | Open PR | Open Traces   │
└──────────────────────────────┴──────────────────────────────────────────┘
```

### 4.2 Timeline row anatomy (ASCII)

```
│ 2026-07-21 18:04Z  PR        Support Bot   “Fix refund tool schema”     │
│                    merged    art_3 → pr#142   mira                      │
│ 2026-07-21 17:50Z  Promote   Support Bot   Artifact art_3               │
│                    success   plan pl_91                                 │
│ 2026-07-20 09:12Z  Rollback  Support Bot   Reverted art_2               │
```

Hairline separators; **no card-per-entry** spam. Kind via StatusBadge / Tag — not color alone.

### 4.3 Mobile

```
Full-width timeline → Sheet detail
Kind + time filters in Overflow / Sheet
≥44px rows
```

### 4.4 Mermaid — write path

```mermaid
flowchart LR
  PRO[Promotion created] --> L[Ledger entry kind=promotion]
  PR[PR opened / merged / failed] --> L2[Ledger entry kind=pr]
  RB[Rollback] --> L3[Ledger entry kind=rollback]
  L --> UI[/improve?tab=ledger]
  L2 --> UI
  L3 --> UI
  UI --> A[/agents/id/ledger peek]
  UI --> DB[Dashboard health memory]
```

---

## 5. Chrome budget

| Context | Budget |
|---------|--------|
| As Improve tab | Shares Improve ≤2 bands; pane toolbar ≤5 actions |
| As `/agents/[id]/ledger` | Band 1 identity; band 2 toolbar only — **no** duplicate Improve hub tabs |
| Primary CTA | Contextual: `Open plan` or `Open PR` — one solid |
| Related strip | Plan · Artifact · Improve queue · Traces — links only |

---

## 6. States

| State | Behavior |
|-------|----------|
| **Empty / first-run** | “No ledger entries yet.” CTA: `Go to Improve queue` — explain entries appear on Promote/PR |
| **Loading** | Skeleton timeline |
| **Error** | Retry |
| **Filtered-empty** | Clear filters / widen time |
| **Populated** | Timeline + detail |
| **Live** | Optional append when PR status changes — Display opt-in; polite live region |
| **Agent locked empty** | Same empty; still show Connect/Improve CTAs if agent new |

**Invariant:** Clearing Improve queue must **not** delete Ledger entries (append-only product rule).

---

## 7. Components used (kit only)

| Kit | Use |
|-----|-----|
| `PageHeader` | Agent ledger page title |
| `Tabs` | Only when hosted under Improve |
| `DataTable` or virtualized timeline list | Entries |
| `QueryState`, `QueryFilterBar`, `ViewsMenu` | Required |
| `DetailPanelShell` | Entry inspector |
| `StatusBadge` / `Tag` | kind + status |
| `Button`, `Sheet`, `Dialog` | Actions / mobile |
| `CodeChip` | entryId, SHAs, PR numbers |
| `MetricInline` | Optional impact deltas if stored |
| `Panel` | Detail grouping |

**Domain:** `LedgerTimeline`, `LedgerEntryDetail`, `LedgerKindFilter` — **one implementation** imported by Improve tab and Agents child route.

---

## 8. Keyboard map

| Key | Action |
|-----|--------|
| `⌘K` | Palette → Ledger |
| `/` | Search |
| `↑` `↓` `Enter` | Select entry |
| `Esc` | Clear `entryId` / close Sheet |
| `o` | Open primary linked object (Plan or PR) |
| `t` | Open related Traces if evidence present |
| `1`–`5` | Kind filters (when focused in filter group) |

---

## 9. Closed-loop exits

| From | To | Max |
|------|----|-----|
| Entry (promotion) | Artifact / Promotion detail in Improve | **1** |
| Entry (pr) | External provider PR **and/or** Plan `panel=pr` | **1** |
| Entry | Plan detail | **1** |
| Entry evidence | Trace / Issue / Experiment | **1** |
| Agent ledger | `/improve?tab=queue&agentId=` | **1** |
| Ledger | Dashboard (implicit memory — no special route) | — |
| Any | Ask AI “summarize ledger for agent” | **1** |

Ledger is typically a **destination** of the closed loop, not the start — but must deep-link back into evidence.

---

## 10. Anti-patterns banned on this surface

- Top-level `/ledger` as a core sidebar leaf (redirect only)
- Editable history that silently rewrites past promotions (append-only; corrections = new entries)
- Embedding full Improve Queue page inside ledger detail (hub-of-hubs)
- Duplicate divergent ledger UIs for Agents vs Improve
- Decorative KPI card walls (this is a timeline, not Helicone Cost)
- False “success” entries without Promotion/PR backing
- Mixing Cost forecasts into Ledger rows
- Red-team campaign history
- Unmount list on select ≥1280

---

## 11. Acceptance checklist

- [ ] Canonical `/improve?tab=ledger`; `/ledger` redirects
- [ ] `/agents/[id]/ledger` reuses same ledger component; `agentId` locked
- [ ] Promote creates `kind=promotion` entry visible without refresh dead-end
- [ ] PR open/merge creates/updates `kind=pr` entry
- [ ] Queue clear does not remove ledger rows
- [ ] Master–detail ≥1280; Sheet &lt;1280; Esc clears `entryId`
- [ ] Filters: kind, agent, time, search; saved `viewId`
- [ ] Detail links Plan, Artifact, PR, evidence ids
- [ ] Chrome budget respected; one solid CTA; QueryState complete
- [ ] en+de i18n; kit only; Viewer can read; Member+ write via Improve actions only (no ad-hoc ledger forge for Viewer)

---

## 12. Entry model (UI)

| Field | Notes |
|-------|-------|
| `entryId` | Stable, copyable mono |
| `kind` | promotion \| pr \| artifact \| rollback \| note |
| `agentId` | Required when known |
| `title` | Human summary |
| `actor` | User / system / Eden AI |
| `status` | success \| failed \| pending \| merged \| open |
| `refs` | planId, artifactId, promotionId, prUrl/prId, issueId, experimentId, traceIds[] |
| `createdAt` | UTC store; local display rules |
| `payload` | Optional diff summary / metrics snapshot |

---

## 13. Permissions

| Action | Viewer | Member | Admin |
|--------|--------|--------|-------|
| Read ledger | ✓ | ✓ | ✓ |
| Create entries | via Promote/PR only | ✓ | ✓ |
| Manual note entry | | ✓ | ✓ |
| Delete / redact | | | ✓ (audited; prefer tombstone entry) |

---

*End of surfaces/ledger.md*
