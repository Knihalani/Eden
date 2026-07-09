# N10: Deep Search → Signal & Classifier Pipeline

| Field | Value |
|---|---|
| **Feature ID** | N10 |
| **Slug** | `deep-search-to-signal` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Restores** | Deleted F36 (deep search → classifier) |
| **Market hypothesis** | Raindrop's "Chinese user frustration" story — NL search → persistent detector is high-conversion UX |
| **Dependencies** | F12 search, F06 signals, F34 classifiers |

---

## 1. Problem

Operators find problematic traces via search but must manually create signals. Raindrop lets users **save search as classifier**. Eden has AI sidebar search but no persistence path to production detection.

---

## 2. Target behavior

```
User: "traces where user wrote in Chinese and agent ignored language"
    → DeepSearch runs EQL + semantic rerank
    → User clicks "Save as Signal"
    → Pipeline:
        1. Cluster result traces by embedding
        2. LLM generates signal definition + output schema
        3. Optional: train F34 classifier if ≥50 examples
        4. Enable on new traces + optional 7d backfill (F06)
```

---

## 3. Architecture

**`src/eden/search/deep_to_signal.py`**

```python
async def save_search_as_signal(
    org_id: str,
    search_query: str,
    trace_ids: list[str],
    mode: Literal["investigator", "classifier"],
) -> SignalDefinitionId:
    clusters = await embed_and_cluster(trace_ids)
    definition = await SignalAuthorLLM.generate(clusters, search_query)
    if mode == "classifier" and len(trace_ids) >= 50:
        await classifier_pipeline.train(definition, trace_ids)
    return await signal_service.create(definition)
```

---

## 4. Data model

```sql
CREATE TABLE saved_searches (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    user_id UUID NOT NULL,
    query_text TEXT NOT NULL,
    eql_generated TEXT,
    trace_count INT,
    signal_id UUID REFERENCES signal_definitions(id),
    classifier_id UUID REFERENCES signal_classifiers(id),
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. Portal UX

- ChatSidebar search results → **Save as Signal** button
- Preview: proposed NL definition + 5 example matches
- Toggle: investigator (F06) vs classifier (F34)
- Cost estimate before backfill

---

## 6. Performance & cost optimization

| Step | Cost control |
|---|---|
| Search | F12 Typesense p95 <200ms; cap 500 results |
| Embedding cluster | Batch 100 traces/call; text-embedding-3-small |
| Signal author LLM | Single Sonnet call (~$0.02) per save |
| Backfill | F06 rate limit; user confirms budget |

**Latency:** Save as Signal UI response <5s (excluding backfill).

**Degradation:** If LLM fails → save EQL-only metric signal (Phase Q fallback).

---

## 7. MCP (F04)

`save_search_as_signal(query, trace_ids[])` — coding agent persists investigation.

---

## 8. Acceptance criteria

- [ ] NL search → Save as Signal → fires on new matching trace
- [ ] Classifier mode trains when ≥50 examples
- [ ] Saved search linked in signal definition metadata
- [ ] Backfill cost shown before confirm
- [ ] EQL fallback when LLM author fails

---

*Restored from deleted F36. Raindrop 3.8 parity + Eden EQL advantage.*
