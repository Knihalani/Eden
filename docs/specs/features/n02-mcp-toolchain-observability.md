# N02: MCP Toolchain Observability

| Field | Value |
|---|---|
| **Feature ID** | N02 |
| **Slug** | `mcp-toolchain-observability` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **PARTIAL** (ingest shipped; dashboards/tools missing) |
| **Market hypothesis** | Agents increasingly fail at MCP boundaries — auth, latency, wrong tool selection |
| **Dependencies** | `observability_mcp.py`, F04 (Eden MCP self-telemetry), OTel SEP-414, F28, N05, N22 |

---

## 1. Summary

First-class **MCP fleet observability** — auto-discovered server registry, tool heatmaps, auth failure alerting, and issue auto-creation — for both customer MCP servers and Eden MCP (meta-debugging). Agents fail at tool boundaries more than LLM calls; this layer makes MCP the SRE unit of analysis.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| `wrap_mcp_call()` SDK | `src/eden/sdk/mcp.py:46` | No fleet analytics |
| `GET /v1/traces/{id}/mcp` | `api/routes/observability_mcp.py` | Per-trace only |
| `GET /v1/mcp/{org}/auth_failures` | `observability_mcp.py` | No spike alerting |
| SEP-414 attribute extraction | ingest pipeline | No cross-trace rollups |
| `mcp_server_auth_failures` table | migrations | No registry materialization |

**Missing:** `McpAnalyticsWorker`, portal `/observability/mcp`, EQL templates, F47 alerts.

---

## 3. Target behavior

### 3.1 MCP Server Registry (auto-discovered)

From ingested spans (`mcp.server.name`, `mcp.tool.name`), nightly + incremental rollup:

```sql
CREATE TABLE mcp_server_registry (
    org_id UUID NOT NULL,
    server_name TEXT NOT NULL,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    tool_names TEXT[],
    transport TEXT,
    call_count_7d BIGINT DEFAULT 0,
    error_rate_7d FLOAT DEFAULT 0,
    p95_latency_ms FLOAT,
    auth_failure_count_7d INT DEFAULT 0,
    affected_agent_ids TEXT[],
    PRIMARY KEY (org_id, server_name)
);

CREATE TABLE mcp_tool_stats (
    org_id UUID NOT NULL,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    call_count_7d BIGINT,
    error_rate_7d FLOAT,
    p95_latency_ms FLOAT,
    PRIMARY KEY (org_id, server_name, tool_name)
);
```

### 3.2 Dashboards (Portal `/observability/mcp`)

| View | Metrics |
|---|---|
| MCP Fleet Overview | Top servers by volume, error rate, latency |
| Tool Heatmap | `tool_name × success/failure` matrix |
| Auth Failures | Timeline of 401/403 by server |
| Agent → MCP Graph | Which agents call which servers (N05 synergy) |
| Eden MCP Meta | `server_name=eden` — maintenance tool usage |

### 3.3 Issues integration (F28)

Auto-create stumbles when:
- MCP auth failure (immediate **P0**)
- Same tool error ≥3 times in one trace (ETEC synergy)
- MCP call p95 > org SLA for 1h
- Server disappears (was active, 0 calls 24h) — **deprecation drift**

### 3.4 Autonomous maintenance (N22)

| Signal | Autonomous action |
|---|---|
| Auth spike | F47 alert + N17 urgent card; T2+ suggest token rotation runbook |
| Latency SLA breach | N21 `cache_bust` suggestion if semantic cache involved |
| Tool error cluster | N10 deep search → save as signal (operator or T2 auto-propose) |

---

## 4. Architecture

```
span.ingested (mcp.* attributes)
    → McpSpanIndexer (inline, async)
    → Redis counter buffers (1h windows)
    → McpAnalyticsWorker (15min rollup)
    → mcp_server_registry + mcp_tool_stats
    → DriftDetector (compare 7d vs 24h)
    → HookBus → F28 stumble / F47 alert
```

| Component | Path |
|---|---|
| `McpSpanIndexer` | `src/eden/observability/mcp/indexer.py` |
| `McpAnalyticsWorker` | `src/eden/observability/mcp/analytics_worker.py` |
| `McpDriftDetector` | `src/eden/observability/mcp/drift.py` |
| Portal page | `clients/portal/src/app/(portal)/observability/mcp/page.tsx` |

**Reuse:** existing `observability_mcp.py` routes — extend, do not duplicate per-trace logic.

---

## 5. F04 Eden MCP meta-layer

When engineers use Eden MCP to debug, calls appear as `server_name=eden`:

| Metric | Maintenance value |
|---|---|
| Most-used Eden MCP tools | Prioritize F04 tool polish |
| Time-to-fix MCP vs portal | Prove coding-agent-first ROI |
| Autofix success by tool sequence | Train N19 KB playbooks |
| Failed MCP calls during incident | N02 self-telemetry quality |

MCP tool `get_mcp_tool_calls(trace_id)` already in F04 spec — extend with `get_mcp_fleet_summary(org_id)`.

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{id}/observability/mcp/servers` | Registry list |
| `GET` | `/orgs/{id}/observability/mcp/servers/{name}/tools` | Tool stats |
| `GET` | `/orgs/{id}/observability/mcp/graph` | Agent→server edges |
| `GET` | `/orgs/{id}/observability/mcp/auth-failures` | Existing route — add time range |
| `POST` | `/orgs/{id}/observability/mcp/servers/{name}/silence` | Snooze alerts 24h |

**EQL templates (new):**
- `mcp.error_rate > 0.05 by server_name last 1h`
- `mcp.auth_failure_count > 10 by server_name last 15m`
- `mcp.p95_latency_ms > 5000 by tool_name`

**MCP (F04):** `get_mcp_fleet_health`, `get_mcp_tool_calls`

---

## 7. Implementation plan

1. **Phase 1:** `McpSpanIndexer` on ingest hot path (counter increment only, <1ms)
2. **Phase 2:** `McpAnalyticsWorker` 15min cron — merge Redis → Postgres
3. **Phase 3:** Portal dashboard + graph component
4. **Phase 4:** F28 auto-stumble rules + F47 Block Kit auth spike
5. **Phase 5:** N05 fleet widget consumes same registry

---

## 8. OTel SEP-414 alignment

Standard attributes to index (required on SDK docs):

| Attribute | Indexed | Alert use |
|---|---|---|
| `mcp.server.name` | yes | Registry PK |
| `mcp.tool.name` | yes | Tool heatmap |
| `mcp.resource.uri` | yes | Resource drift |
| `mcp.transport` | yes | stdio vs HTTP |
| `mcp.auth.failure_kind` | yes | Auth timeline |
| `gen_ai.operation.name` | optional | MCP-wrapped LLM sampling |

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `mcp_observability_v1` | off |
| `mcp_auto_stumble_auth` | on when v1 |
| `mcp_eden_meta_dashboard` | on |

---

## 10. Test plan

- Fixture traces with MCP spans → registry populated
- Auth failure span → F28 stumble within 1 ingest batch
- 7d rollup math matches manual SQL on fixture
- Eden MCP self-calls visible with `server_name=eden`
- Dashboard p95 load <2s for 50 servers

---

## 11. Acceptance criteria

- [ ] MCP server registry auto-populates from 7d of traces
- [ ] Dashboard shows p95 latency per server/tool
- [ ] Auth failure spike triggers F47 alert within 5 min
- [ ] F28 stumble created on MCP auth failure in trace
- [ ] Eden MCP self-calls visible as `server_name=eden`
- [ ] MCP `get_mcp_fleet_health` returns ranked servers by error rate
- [ ] N05 fleet graph consumes registry edges

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Span indexer (inline) | 0.5ms | 2ms | 5ms |
| Registry API | 30ms | 150ms | 400ms |
| Graph API (20 agents) | 80ms | 300ms | 800ms |
| Rollup worker batch | 5s | 30s | 60s |

### Cost model

- **LLM tier:** 0 — deterministic aggregation only
- **Est. $/1k traces indexed:** $0 ingest overhead (<0.1ms CPU)
- **Storage:** ~500 bytes/server/org + 200 bytes/tool

### Caching strategy

- Registry API: Redis 60s per org
- Graph: Redis 120s; invalidate on rollup complete
- Auth failure timeline: no cache (real-time)

### Degradation modes

- Indexer overload → sample 10% MCP spans, flag `mcp_index_degraded`
- Worker lag >1h → dashboard shows stale badge
- Missing attributes → bucket as `server_name=unknown`

### Monitoring

```
eden_mcp_indexer_duration_seconds
eden_mcp_registry_servers_total
eden_mcp_auth_failure_spike_total
eden_mcp_rollup_lag_seconds
eden_mcp_auto_stumble_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F04 | MCP tools + Eden self-telemetry |
| F28 | Auto-stumble on MCP failures |
| F47 | Auth spike alerts |
| N05 | Fleet MCP graph widget |
| N08 | StatGate escalation on P0 MCP auth |

---

*Unique Eden angle: observe customer MCP **and** Eden MCP in one pane. See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.2.*
