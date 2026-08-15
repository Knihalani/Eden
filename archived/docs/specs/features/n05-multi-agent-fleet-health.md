# N05: Multi-Agent Fleet Health Dashboard

| Field | Value |
|---|---|
| **Feature ID** | N05 |
| **Slug** | `multi-agent-fleet-health` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Enterprises deploy 5–50 agents; they need fleet-level SRE view, not per-trace debugging |
| **Dependencies** | F29 (issues), N03 (production eval), N02 (MCP), F20, F42, N17, N22 |

---

## 1. Summary

**Fleet SRE dashboard** for multi-agent platforms — auto-discovered agent registry, health cards, issue heatmaps, MCP dependency graphs, delegation maps, and SLA alerting. Answers "which agent is degrading?" in <3s. Feeds N17 cockpit prioritization and autonomous escalation (N22).

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Trace metadata `agent_id` | ingest | No registry materialization |
| Insights detector loop | `insights/detector_loop.py` | Fleet-level, not agent-scoped UX |
| DriftAlertHook | `promotion_hooks.py:1550` | No portal consumer |
| Cat 22 delegation spans | partial | No delegation graph UI |
| Portal | trace-centric | No `/fleet` route |

---

## 3. Target behavior

**Portal `/fleet`** — single pane:

| Widget | Data source | Drill-down |
|---|---|---|
| Agent health cards | N03 pass rate + F29 open issues + cost/traffic | Agent-scoped N17 queue |
| Issue heatmap | `agent_id × stumble_kind`, 7d | F29 issue list filtered |
| MCP dependency graph | N02 server registry + call edges | N02 MCP dashboard |
| Delegation map | parent trace → sub-agent spans (Cat 22) | Session timeline N12 |
| SLA breaches | Configured SLOs per agent tier | F47 alert history |
| Autonomy status | N22 effective policy per agent | Settings → Autonomy |

**Ranked severity score (for MCP + N17):**

```
severity = w1*open_p0_issues + w2*slo_breach_hours + w3*eval_fail_rate_delta + w4*mcp_error_spike
```

### Operator vs autonomous

| Mode | Fleet behavior |
|---|---|
| **Normal** | Operator scans dashboard, clicks into agents |
| **Assisted (T2)** | N17 pre-sorted by severity score; daily F47 digest |
| **Autonomous (T3)** | Auto-snooze experimental tier alerts; auto-escalate critical tier SLO breaches to N21 heal suggest |

---

## 4. Architecture

```
trace.finalized + issue.updated + production_eval_hourly + mcp_registry
    → FleetRollupWorker (15min)
    → agent_registry + agent_health_daily MV
    → FleetSeverityScorer
    → Redis cache fleet:summary:{org_id}
    → Portal /fleet + MCP get_fleet_health
```

| Component | Path |
|---|---|
| `FleetRollupWorker` | `src/eden/fleet/rollup_worker.py` |
| `AgentRegistryDiscoverer` | `src/eden/fleet/registry.py` |
| `FleetSeverityScorer` | `src/eden/fleet/severity.py` |
| Portal | `clients/portal/src/app/(portal)/fleet/page.tsx` |

---

## 5. Data model

```sql
CREATE TABLE agent_registry (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    display_name TEXT,
    tier TEXT CHECK (tier IN ('critical','standard','experimental')),
    owner_team TEXT,
    slo_config JSONB DEFAULT '{
      "p95_latency_ms": 5000,
      "max_error_rate": 0.05,
      "min_eval_pass_rate": 0.90
    }'::jsonb,
    autonomy_policy_id UUID,  -- N22 override link
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    PRIMARY KEY (org_id, agent_id)
);

CREATE MATERIALIZED VIEW agent_health_daily AS
SELECT
    r.org_id,
    r.agent_id,
    date_trunc('day', t.day) AS date,
    t.trace_count,
    t.stumble_count,
    i.open_issues,
    e.avg_eval_score,
    e.fail_rate AS eval_fail_rate,
    t.total_cost_usd,
    t.p95_latency_ms,
    t.error_rate
FROM agent_registry r
LEFT JOIN trace_agent_daily t USING (org_id, agent_id)
LEFT JOIN issue_agent_daily i USING (org_id, agent_id)
LEFT JOIN production_eval_agent_daily e USING (org_id, agent_id);

CREATE TABLE agent_delegation_edges (
    org_id UUID NOT NULL,
    parent_agent_id TEXT NOT NULL,
    child_agent_id TEXT NOT NULL,
    call_count_7d BIGINT DEFAULT 0,
    error_rate_7d FLOAT DEFAULT 0,
    PRIMARY KEY (org_id, parent_agent_id, child_agent_id)
);
```

**Auto-discovery:** Insert/update `agent_registry` on first trace with new `agent_id`; default tier `standard`.

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{id}/fleet/summary` | Health cards + severity ranking |
| `GET` | `/orgs/{id}/fleet/heatmap` | stumble_kind matrix |
| `GET` | `/orgs/{id}/fleet/delegation` | Graph edges |
| `GET/PATCH` | `/orgs/{id}/fleet/agents/{agent_id}` | Registry metadata + SLO |
| `GET` | `/orgs/{id}/fleet/sla-breaches` | Active breaches |

**MCP (F04):** `get_fleet_health(window=7d)` → ranked JSON for coding agent

---

## 7. Alerting (F47)

Fleet-level alerts:
- Any **critical** tier agent: eval pass rate < SLO for 1h
- Shared MCP server error rate >5% affecting ≥3 agents
- New P0 issue on critical agent
- Fleet-wide cost spike >3σ (links F42)

**Digest:** Daily Slack Block Kit summary — top 5 agents by severity.

---

## 8. Implementation plan

1. `AgentRegistryDiscoverer` on trace ingest (async, lightweight)
2. `FleetRollupWorker` — join trace/issue/eval/MCP stats
3. Portal `/fleet` with health cards + heatmap
4. Delegation edge extractor from Cat 22 span attributes
5. F47 SLA breach rules
6. N17: sort improvement queue by fleet severity score

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `fleet_health_v1` | off |
| `fleet_auto_discover` | on |
| `fleet_sla_alerts` | on when v1 |

---

## 10. Test plan

- 20 agents fixture → dashboard load p95 <3s
- Critical agent eval drop → F47 alert within 5min
- MCP shared failure → cross-agent edge highlighted
- MCP `get_fleet_health` matches portal ranking
- Tier override → SLO thresholds applied

---

## 11. Acceptance criteria

- [ ] Auto-discover agents from trace metadata (no manual registry required)
- [ ] Fleet dashboard loads in <3s for org with 20 agents
- [ ] Critical agent SLO breach triggers F47 alert
- [ ] MCP `get_fleet_health` returns ranked agent list by severity
- [ ] Delegation edges visible for multi-agent traces
- [ ] N17 queue respects fleet severity ordering
- [ ] N22 autonomy tier shown per agent card

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Fleet summary API | 80ms | 300ms | 800ms |
| Heatmap API | 50ms | 200ms | 500ms |
| Delegation graph | 100ms | 400ms | 1s |
| Rollup worker (20 agents) | 5s | 20s | 45s |

### Cost model

- **LLM tier:** 0 — SQL rollups only
- **Est. $/1k API calls:** $0
- **Storage:** ~1KB/agent/day in MV

### Caching strategy

- `fleet:summary:{org_id}` Redis 60s
- Heatmap Redis 120s
- Invalidate on rollup complete or issue P0 create

### Degradation modes

- Rollup lag >1h → stale badge on dashboard
- Missing N03 data → eval card shows "not configured"
- >100 agents → paginate cards, top 20 by traffic default

### Monitoring

```
eden_fleet_rollup_duration_seconds
eden_fleet_sla_breach_total{tier}
eden_fleet_agents_discovered_total
eden_fleet_api_duration_seconds
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F29 | Open issue counts |
| N03 | Eval pass rate |
| N02 | MCP dependency graph |
| F42 | Drift context on cards |
| N17 | Severity-sorted queue |
| N22 | Autonomy tier display |
| F47 | SLA alerts |

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.5.*
