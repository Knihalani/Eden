# F34: Per-Org Trained Signal Classifiers

| Field | Value |
|---|---|
| **Feature ID** | F34 |
| **Slug** | `trained-signal-classifiers` |
| **Priority** | P2 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.6 |
| **Dependencies** | F06, F35, N10 |

---

## 1. Summary

Train small per-org classifiers on labeled traces — cheaper inference than F06 investigator at scale. Raindrop trained signals; Eden path via N10 save-as-classifier.

---

## 2. Pipeline

```
≥50 labeled examples (from F06 events or manual labels)
    → Export feature vectors (embeddings + StatGate features)
    → Train logistic/XGBoost classifier
    → Deploy inference worker on trace.finalized
    → p95 inference <10ms vs $0.03/trace investigator
```

---

## 3. Data model

```sql
CREATE TABLE signal_classifiers (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    signal_id UUID REFERENCES signal_definitions(id),
    model_type TEXT NOT NULL,
    model_blob BYTEA NOT NULL,
    metrics JSONB NOT NULL,  -- precision, recall, f1
    trained_at TIMESTAMPTZ DEFAULT now(),
    sample_count INT NOT NULL
);
```

---

## 4. Performance & cost optimization

| Mode | Cost/1k traces | Latency |
|---|---|---|
| F06 investigator | $30–300 | 2–10s async |
| F34 classifier | ~$0.10 embed | <10ms |

**When to use which:**
- New signal → F06 investigator + backfill
- ≥50 labels + stable → train F34, disable investigator for that signal

**Training:** Async job queue; max 1 concurrent train/org

---

## 5. Acceptance criteria

- [ ] Train completes <1h async for 5k examples
- [ ] F1 ≥0.8 on holdout fixture
- [ ] Inference p95 <10ms
- [ ] N10 can create classifier from search

---

*Cost optimization path for F06 at scale.*
