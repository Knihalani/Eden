# N02: MCP Toolchain Observability

| Field | Value |
|---|---|
| **Feature ID** | N02 |
| **Slug** | `mcp-toolchain-observability` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **PARTIAL** (ingest shipped; dashboards/tools missing) |
| **Market hypothesis** | Agents increasingly fail at MCP boundaries — auth, latency, wrong tool selection |
| **Dependencies** | Existing `observability_mcp.py`, F04 (Eden MCP self-telemetry), OTel SEP-414 |

---

## 1. Problem

Production agents call dozens of MCP servers (GitHub, Slack, Postgres, Eden itself). Failures at MCP boundaries — expired OAuth, wrong tool args, 30s timeouts — are **invisible** in generic LLM traces. Eden ingests `mcp.*` attributes but does not surface **MCP health as a first-class observability layer**.

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| `wrap_mcp_call()` SDK | No MCP-specific dashboard |
| `GET /v1/traces/{id}/mcp` | No cross-trace MCP analytics |
| `mcp_server_auth_failures` table | No alerting on auth failure spikes |
| SEP-414 attribute extraction | No "which MCP server is slowest" report |

---

## 3. Target behavior

### 3.1 MCP Server Registry (auto-discovered)

From ingested spans, materialize:

```sql
CREATE TABLE mcp_server_registry (
    org_id UUID NOT NULL,
    server_name TEXT NOT NULL,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    tool_names TEXT[],
    transport TEXT,
    call_count_7d BIGINT,
    error_rate_7d FLOAT,
    p95_latency_ms FLOAT,
    auth_failure_count_7d INT,
    PRIMARY KEY (org_id, server_name)
);
```

### 3.2 Dashboards

| View | Metrics |
|---|---|
| MCP Fleet Overview | Top servers by call volume, error rate, latency |
| Tool Heatmap | tool_name × success/failure matrix |
| Auth Failures | Timeline of 401/403 by server (existing hook) |
| Agent → MCP Graph | Which agents call which servers (multi-agent N05 synergy) |

### 3.3 Issues integration

Auto-create stumbles (F28) on:
- MCP auth failure (immediate P0)
- Same tool error ≥3 times in trace (ETEC synergy)
- MCP call p95 > SLA threshold

---

## 4. F04 Eden MCP meta-layer

When engineers use Eden MCP to debug, those calls appear as `server_name=eden` — enabling **"how do we use Eden to fix Eden?"** analytics:

- Most-used Eden MCP tools
- Time-to-fix via MCP vs portal
- Autofix success rate by tool sequence

---

## 5. Implementation

1. **`McpAnalyticsWorker`** — nightly rollup from span attributes
2. **Portal `/observability/mcp`** — fleet dashboard
3. **EQL templates** — `mcp.error_rate > 0.05 by server_name`
4. **F04 tool** — `get_mcp_tool_calls` (already in F04 spec)
5. **Alerts** — F47 Block Kit on auth failure spike

---

## 6. OTel SEP-414 alignment

Standard attributes to index:
- `mcp.server.name`, `mcp.tool.name`, `mcp.resource.uri`
- `mcp.transport`, `mcp.auth.failure_kind`
- `gen_ai.operation.name` when MCP wraps LLM sampling

---

## 7. Acceptance criteria

- [ ] MCP server registry auto-populates from 7d of traces
- [ ] Dashboard shows p95 latency per server/tool
- [ ] Auth failure spike triggers F47 alert within 5 min
- [ ] F28 stumble created on MCP auth failure in trace
- [ ] Eden MCP self-calls visible as `server_name=eden`

---

*Unique Eden angle: observe customer MCP **and** Eden MCP in one pane. See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.2.*
