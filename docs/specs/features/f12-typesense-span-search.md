# F12: Typesense Full-Text Span Search

| Field | Value |
|---|---|
| **Feature ID** | F12 |
| **Slug** | `typesense-span-search` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **SHIPPED (v0)** — self-hosted Typesense + EQL fallback |
| **Competitive source** | Laminar |
| **Closes gap** | 1.6 |
| **Dependencies** | Ingest pipeline, N09 (optional blob refs) |

---

## 1. Summary

Sub-200ms full-text search across all span inputs/outputs — powers portal search bar, F04 `search_traces`, N10 deep search. Laminar parity; critical for operator UX at scale.

---

## 2. Eden current state

| Component | Path | Status |
|---|---|---|
| Typesense config | `config.py:130` | Config exists |
| Search stub | `observability.py:514` | Phase B stub |
| `typesense_client.py` | partial | Not wired to ingest |

---

## 3. Target behavior

- On span ingest: index `{org_id, trace_id, span_id, step, role, text, ts}`
- Query: `GET /orgs/{org_id}/observability/search?q=...&limit=50`
- Facets: agent_id, date range, has_stumble, span_kind
- Highlight snippets in results

---

## 4. Architecture

```
ingest.span.finalize → SearchIndexer.enqueue(doc)
    → Typesense collection: eden_spans_{org_id}
    → Async bulk import every 1s or 100 docs

Query API → Typesense multi_search → merge with trace metadata
```

**Module:** wire `src/eden/search/typesense_client.py`

---

## 5. Index schema

```json
{
  "name": "eden_spans_{org_id}",
  "fields": [
    {"name": "trace_id", "type": "string", "facet": false},
    {"name": "span_id", "type": "string"},
    {"name": "agent_id", "type": "string", "facet": true},
    {"name": "text", "type": "string"},
    {"name": "ts", "type": "int64", "sort": true},
    {"name": "has_error", "type": "bool", "facet": true}
  ],
  "default_sorting_field": "ts"
}
```

**Text extraction:** LLM messages (user/assistant), tool names, error strings. Truncate to 8KB/field.

---

## 6. API specification

| Method | Path | Params |
|---|---|---|
| `GET` | `/orgs/{org_id}/observability/search` | `q`, `limit`, `agent_id`, `since`, `until` |
| `GET` | `/orgs/{org_id}/observability/search/suggest` | prefix autocomplete |

**MCP (F04):** `search_traces` uses this when `q` is natural language; EQL for structured.

---

## 7. Performance & cost optimization

### Latency budgets (Laminar parity)

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Search query | <30ms | <200ms | <500ms |
| Index enqueue | <2ms | <5ms | — |
| Bulk index batch | — | <500ms/100 docs | — |

### Cost model

| Scale | Typesense cost driver |
|---|---|
| 10M spans indexed | ~20GB RAM (managed ~$200/mo) |
| Per org collection | Isolate noisy neighbor; delete on churn |

**Optimizations:**
- Index only last 90d by default (TTL job)
- Skip indexing spans <20 chars (noise)
- N09 blob refs: index resolved text at ingest time once

### Caching

- Redis: popular queries `search:{org}:{hash(q)}` 30s TTL
- Portal: debounce input 300ms

### Degradation

- Typesense down → fallback EQL with 10s timeout + banner
- Index lag >5min → show "results may be incomplete"

### Monitoring

```
eden_search_duration_seconds
eden_search_index_lag_seconds
eden_search_fallback_total
```

---

## 8. Feature flags

`typesense_search_v1` — default false until load tested

---

## 9. Acceptance criteria

- [ ] 10M span index search p95 <200ms
- [ ] Ingest index lag p95 <60s
- [ ] Portal search bar uses API
- [ ] EQL fallback works when Typesense unavailable
- [ ] PII redacted before index (Cat 10)

---

*Powers N10 deep search. See [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).*
