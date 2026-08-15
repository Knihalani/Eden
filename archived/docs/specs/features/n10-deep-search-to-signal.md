# N10: Deep Search → Signal & Classifier Pipeline

| Field | Value |
|---|---|
| **Feature ID** | N10 |
| **Slug** | `deep-search-to-signal` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** — F12 search shipped; save-as-signal UX stretch deferred |
| **Restores** | Deleted F36 (deep search → classifier) |
| **Market hypothesis** | Raindrop's NL search → persistent detector is high-conversion maintenance UX |
| **Dependencies** | F12 search, F06 signals, F34 classifiers, F28, N22, F04 |

---

## 1. Summary

Convert natural-language trace searches into **persistent production signals** — investigator (F06) or trained classifier (F34) — with optional backfill. Closes the gap between "I found bad traces" and "Eden now detects this automatically." Core operator maintenance workflow; T2 autonomy can auto-propose signals from recurring search patterns.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Typesense span search | F12 / `columnar/` | No save-as-signal path |
| AI sidebar search | portal partial | No persistence |
| F06 signal investigator | spec | No search→signal bridge |
| F34 classifiers | spec | No training trigger from search |
| EQL generation | partial | Not linked to saved searches |

---

## 3. Target behavior

```
User: "traces where user wrote in Chinese and agent ignored language"
    → DeepSearch runs EQL + semantic rerank (F12)
    → Results capped at 500 traces
    → User clicks "Save as Signal"
    → Pipeline:
        1. Cluster result traces by embedding
        2. LLM generates signal definition + output schema
        3. Optional: train F34 classifier if ≥50 examples
        4. Enable on new traces + optional 7d backfill (F06)
    → F28 stumble when signal fires (configurable)
    → N17 "Learned" column links saved search
```

### Autonomous variant (N22 T2+)

```
Insight/search cluster recurring 3× in 7d (same embedding centroid)
    → Auto-propose signal draft in N17 "Proposed"
    → Operator approve → same pipeline
    → T3: auto-enable shadow mode (log-only F06) if F41 shadow pass
```

---

## 4. Architecture

**`src/eden/search/deep_to_signal.py`**

```python
async def save_search_as_signal(
    org_id: str,
    search_query: str,
    trace_ids: list[str],
    mode: Literal["investigator", "classifier"],
    backfill_days: int = 0,
    actor: ActorContext,
) -> SignalDefinitionId:
    clusters = await embed_and_cluster(trace_ids, max_clusters=5)
    definition = await SignalAuthorLLM.generate(clusters, search_query)
    eql_fallback = await EqlGenerator.from_traces(trace_ids)
    definition.eql = definition.eql or eql_fallback

    signal_id = await signal_service.create(definition)

    if mode == "classifier" and len(trace_ids) >= 50:
        await classifier_pipeline.train(signal_id, trace_ids)

    if backfill_days > 0:
        await f06_backfill.enqueue(signal_id, days=backfill_days, budget_cap=...)

    await agent_audit_ledger.write("signal_created_from_search", ...)
    return signal_id
```

| Component | Path |
|---|---|
| `DeepSearchService` | `search/deep_search.py` |
| `SignalAuthorLLM` | `search/signal_author.py` |
| `EmbedCluster` | `search/cluster.py` |
| Portal button | ChatSidebar + search results |

---

## 5. Data model

```sql
CREATE TABLE saved_searches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    user_id UUID,
    actor_type TEXT DEFAULT 'user',
    query_text TEXT NOT NULL,
    eql_generated TEXT,
    trace_count INT,
    cluster_summary JSONB,
    signal_id UUID REFERENCES signal_definitions(id),
    classifier_id UUID REFERENCES signal_classifiers(id),
    backfill_job_id UUID,
    estimated_backfill_cost_usd FLOAT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE search_to_signal_jobs (
    id UUID PRIMARY KEY,
    saved_search_id UUID NOT NULL,
    status TEXT NOT NULL,  -- pending, running, complete, failed
    error TEXT,
    completed_at TIMESTAMPTZ
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{id}/search/deep` | NL + semantic search |
| `POST` | `/orgs/{id}/search/saved` | Save search query |
| `POST` | `/orgs/{id}/search/saved/{id}/to-signal` | Convert to signal |
| `GET` | `/orgs/{id}/search/saved/{id}/preview` | Preview definition + cost |

**MCP (F04):** `save_search_as_signal(query, trace_ids[], mode, backfill_days?)`

---

## 7. Portal UX

- ChatSidebar search results → **Save as Signal** button
- Preview modal: proposed NL definition + 5 example matches + EQL
- Toggle: investigator (F06) vs classifier (F34)
- Backfill: slider 0–30d with **cost estimate** before confirm
- Link to signal detail after creation

---

## 8. Implementation plan

1. `DeepSearchService` — wrap F12 + embedding rerank
2. `SignalAuthorLLM` prompt + schema validation
3. `save_search_as_signal` API + job queue
4. F34 training hook when ≥50 examples
5. F06 backfill integration with budget cap
6. Portal UX + MCP tool
7. N17 proposed cards for auto-detected recurring searches

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `deep_search_to_signal_v1` | off |
| `search_auto_propose_signal` | off (T2) |
| `search_backfill_max_days` | 30 |

---

## 10. Test plan

- NL query fixture → ≥80% precision on labeled set
- Save as investigator → fires on new matching trace
- 50+ traces → classifier trains, F1 ≥0.75 on holdout
- LLM author failure → EQL-only fallback signal created
- Backfill cost estimate within 20% of actual

---

## 11. Acceptance criteria

- [ ] NL search → Save as Signal → fires on new matching trace
- [ ] Classifier mode trains when ≥50 examples
- [ ] Saved search linked in signal definition metadata
- [ ] Backfill cost shown before confirm
- [ ] EQL fallback when LLM author fails
- [ ] MCP tool works from Cursor maintenance workflow
- [ ] N06 audit logs signal creation with actor

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Deep search | 150ms | 400ms | 800ms |
| Embed cluster (100 traces) | 2s | 8s | 15s |
| Signal author LLM | 3s | 10s | 20s |
| Save-as-signal API ack | 500ms | 2s | 5s |
| F34 train (async) | 5min | 30min | 1h |

### Cost model

| Step | Cost |
|---|---|
| Search (F12) | $0 |
| Embedding cluster | ~$0.01 per 100 traces |
| Signal author LLM | ~$0.02/save (single Sonnet) |
| F06 backfill | ~$0.03/trace (investigator) — user capped |
| F34 train | ~$0.10 + $0 CPU |

**Cap:** 500 search results; backfill requires explicit budget confirm.

### Caching strategy

- Search results: no cache (fresh)
- Generated EQL: store on `saved_searches` for reproducibility

### Degradation modes

- LLM author fails → EQL-only metric signal (Phase Q fallback)
- Cluster fails → single-cluster definition from top 10 traces
- Backfill budget exceeded → partial backfill + notify

### Monitoring

```
eden_search_to_signal_total{mode}
eden_search_author_llm_failures_total
eden_search_backfill_cost_usd_total
eden_search_auto_propose_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F12 | Search backend |
| F06 | Investigator signals |
| F34 | Classifier path |
| F28 | Stumble on fire |
| N22 | Auto-propose tier |
| N06 | Audit trail |

---

*Restored from deleted F36. Raindrop 3.8 parity + Eden EQL advantage.*
