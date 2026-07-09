# N05: Multi-Agent Fleet Health Dashboard

| Field | Value |
|---|---|
| **Feature ID** | N05 |
| **Slug** | `multi-agent-fleet-health` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Enterprises deploy 5–50 agents; they need fleet-level SRE view, not per-trace debugging |
| **Dependencies** | F29 (issues), N03 (production eval), N02 (MCP), F20 |

---

## 1. Problem

Eden portal is trace-centric. Platform teams running **agent fleets** (support bot, sales bot, internal copilot, sub-agents) need:
- Which agent is degrading this week?
- Cross-agent issue correlation (shared tool/MCP failure)?
- SLA compliance by agent tier?

Sentrial session view and Raindrop issues help single-product teams; **fleet ops** is underserved.

---

## 2. Target behavior

**Portal `/fleet`** — single pane:

| Widget | Data source |
|---|---|
| Agent health cards | N03 pass rate + F29 open issues + cost/traffic |
| Issue heatmap | agent_id × stumble_kind, 7d |
| MCP dependency graph | N02 server registry + call edges |
| Delegation map | parent trace → sub-agent spans (Cat 22) |
| SLA breaches | Configured SLOs: p95 latency, error rate, eval pass rate |

**Drill-down:** Click agent card → agent-scoped issues, traces, nudges (F39).

---

## 3. Data model

```sql
CREATE TABLE agent_registry (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    display_name TEXT,
    tier TEXT CHECK (tier IN ('critical','standard','experimental')),
    owner_team TEXT,
    slo_config JSONB,  -- {p95_latency_ms, max_error_rate, min_eval_pass_rate}
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    PRIMARY KEY (org_id, agent_id)
);

CREATE MATERIALIZED VIEW agent_health_daily AS
SELECT org_id, agent_id, date,
       trace_count, stumble_count, open_issues,
       avg_eval_score, total_cost_usd, p95_latency_ms
FROM ... -- rollup job
```

---

## 4. Alerting

Fleet-level alerts (F47):
- Any **critical** tier agent: eval pass rate < SLO for 1h
- Shared MCP server error rate >5% affecting ≥3 agents
- New P0 issue on critical agent

---

## 5. MCP tool (F04)

`get_fleet_health` → JSON summary for coding agent: "Which agents need attention?"

---

## 6. Acceptance criteria

- [ ] Auto-discover agents from trace metadata (no manual registry required)
- [ ] Fleet dashboard loads in <3s for org with 20 agents
- [ ] Critical agent SLO breach triggers F47 alert
- [ ] MCP `get_fleet_health` returns ranked agent list by severity
- [ ] Delegation edges visible for multi-agent traces

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.5.*
