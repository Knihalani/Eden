# Eden Performance & Cost Standards (Cross-Cutting)

> **Applies to:** All F-features and N-features  
> **Goal:** Every Eden surface must feel fast to humans and cheap at scale for the business and the customer.

---

## 1. Client experience SLAs (defaults)

| Surface | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| Portal page load (issues list) | <300ms | <800ms | <1.5s | SSR + indexed queries |
| Trace detail / transcript | <400ms | <1.2s | <2s | Progressive load steps |
| MCP tool response (read) | <200ms | <800ms | <2s | Exclude upstream LLM |
| MCP tool (debugger rerun prefix) | <500ms | <2s | <5s | F01 cache hits |
| Issue created after trace | — | <60s | <120s | Async worker |
| Slack alert after P0 | — | <60s | <120s | F47 |
| Search (Typesense) | <50ms | <200ms | <500ms | F12 |
| StatGate checks (N08) | <20ms | <80ms | <150ms | No LLM |

---

## 2. Cost optimization principles

### 2.1 LLM spend hierarchy (cheapest first)

```
1. Deterministic rules (StatGate, ETEC, regex)     → $0
2. Embeddings + vector search                       → ~$0.0001/call
3. SLM (Haiku, GPT-4o-mini)                         → ~$0.001/call
4. Full LLM investigator (Sonnet)                   → ~$0.01–0.05/trace
5. Live gateway rerun (debugger)                      → model cost only
```

**Rule:** Never use tier 4 when tier 1–3 suffices. Cascade up only on low confidence.

### 2.2 Async by default

| Pattern | Use when |
|---|---|
| `trace.finalized` Redis stream | Detection, signals, eval sampling |
| Batch workers (nightly) | Drift reports, eval slices, Book generation |
| Sync API | User-initiated read, MCP get_transcript |
| Background job + poll | Backfill, impact preview, env gen |

**Rule:** Ingest hot path adds **<5ms p99** overhead. Heavy work always async.

### 2.3 Caching layers

| Layer | TTL | Examples |
|---|---|---|
| Redis | 30s–5min | Issue counts, fleet health cards, nudge triggers |
| Materialized views | 1h refresh | Hourly eval scores, agent health daily |
| Prefix cache (F01) | Permanent per trace | Debugger LLM responses |
| Content blob store (N09) | Permanent dedupe | Span payloads |
| CDN | 1h | Static portal assets, RRWeb replay bundles |

### 2.4 Sampling & budgets

Every LLM-powered feature MUST expose:
- `max_cost_usd_per_day` org setting
- `sample_rate` for production workloads
- Priority bypass: stumbles/P0 traces always processed
- Kill switch feature flag

---

## 3. Database & query patterns

```sql
-- Always index filter + sort columns together
CREATE INDEX idx_issues_list ON agent_issues (org_id, status, severity, last_seen DESC);

-- Use keyset pagination, not OFFSET for large tables
-- WHERE (last_seen, id) < ($cursor_last_seen, $cursor_id)

-- HyperLogLog for user_count on issues (not COUNT DISTINCT on every write)
-- Redis PFADD issue:{id}:users {user_id}
```

**Hot paths to avoid:**
- `SELECT *` on telemetry_events for list views
- N+1 transcript step fetches — batch by trace_id
- Full trace JSON in API responses — return digests + lazy-load steps

---

## 4. Ingest path budget

```
Span finalize → checkpoint hook (F03)     ≤ 2ms async enqueue
             → stumble detector (F20)    ≤ 0ms (stream only)
             → Typesense index (F12)     ≤ 5ms async
             → blob dedupe (N09)         ≤ 3ms hash + ref
             → quality pipeline          existing budget
─────────────────────────────────────────────────────────
Total hot-path sync overhead target:     ≤ 5ms p99
```

Use `asyncio.create_task` or Redis XADD — never block ingest on LLM.

---

## 5. Per-feature section template

Every spec MUST include **§ Performance & cost optimization** with:

1. **Latency budgets** — table with p50/p95 targets
2. **Cost model** — $/1k traces or $/1k operations estimate
3. **Caching strategy** — what is cached, TTL, invalidation
4. **Degradation modes** — what happens when budget exceeded
5. **Monitoring** — Prometheus metrics + alerts

---

## 6. Degradation modes (standard)

| Mode | Trigger | Behavior |
|---|---|---|
| `budget_exceeded` | Daily LLM cap hit | Stop sampling; deterministic-only |
| `queue_backlog` | Worker lag >5min | Shed low-priority jobs; alert ops |
| `db_slow` | Query p95 >1s | Serve stale cache; show banner |
| `typesense_down` | Search fail | Fall back to EQL with 10s timeout |

---

## 7. Metrics naming convention

```
eden_{feature}_{operation}_duration_seconds  (histogram)
eden_{feature}_{operation}_total             (counter)
eden_{feature}_cost_usd_total                (counter)
eden_{feature}_cache_hit_total               (counter)
eden_{feature}_budget_exceeded_total         (counter)
```

---

*Referenced by all feature specs. Update when platform SLAs change.*
