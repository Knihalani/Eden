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
| **Dependencies** | F06, F35, N10, F28, N16 |

---

## 1. Summary

Train small per-org classifiers on labeled traces — **10–100× cheaper** than F06 investigator at scale. Raindrop trained signals; Eden path via N10 save-as-classifier + F06 label export. Critical for cost-efficient maintenance at high trace volume.

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| F06 investigator spec | No classifier training pipeline |
| Signal definitions | No `signal_classifiers` table |
| N10 search→signal | Classifier mode spec only |

**Greenfield:** `src/eden/signals/classifier_pipeline.py`, inference worker

---

## 3. Target behavior

```
≥50 labeled examples (F06 events, manual labels, N10 search save)
    → Export feature vectors (embeddings + StatGate numeric features)
    → Train logistic/XGBoost classifier (async job)
    → Validate holdout F1 ≥0.8
    → Deploy inference worker on trace.finalized
    → p95 inference <10ms vs $0.03/trace investigator
    → On fire: F28 stumble + optional F06 investigator confirm (borderline)
```

### Lifecycle
- **Shadow mode (7d):** classifier + investigator parallel; compare precision
- **Promote:** disable investigator for signal when shadow precision ≥ investigator
- **Retrain:** weekly or on 20 new labels

---

## 4. Architecture

| Component | Path |
|---|---|
| `ClassifierTrainingPipeline` | `signals/classifier_pipeline.py` |
| `FeatureExtractor` | `signals/features.py` |
| `ClassifierInferenceWorker` | `signals/classifier_worker.py` |
| `ShadowComparator` | `signals/shadow_compare.py` |

**Features:**
- Trace embedding (text-embedding-3-small)
- StatGate: step_count, tool_call_counts, loop_score, cost_usd
- Signal-specific structured fields from F06 output

**Models:** logistic regression default; XGBoost if ≥500 samples.

---

## 5. Data model

```sql
CREATE TABLE signal_classifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id),
    model_type TEXT NOT NULL CHECK (model_type IN ('logistic','xgboost')),
    model_blob BYTEA NOT NULL,
    metrics JSONB NOT NULL,  -- precision, recall, f1, holdout_size
    shadow_mode BOOLEAN DEFAULT true,
    investigator_disabled BOOLEAN DEFAULT false,
    trained_at TIMESTAMPTZ DEFAULT now(),
    sample_count INT NOT NULL,
    version INT DEFAULT 1
);

CREATE TABLE classifier_predictions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    classifier_id UUID NOT NULL,
    score FLOAT NOT NULL,
    fired BOOLEAN NOT NULL,
    shadow_investigator_agree BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{id}/signals/{signal_id}/classifier/train` | Enqueue train |
| `GET` | `/orgs/{id}/signals/{signal_id}/classifier` | Status + metrics |
| `POST` | `/orgs/{id}/signals/{signal_id}/classifier/promote` | Disable investigator |
| `POST` | `/orgs/{id}/signals/{signal_id}/classifier/shadow-report` | Compare 7d |

**MCP (F04):** `train_signal_classifier(signal_id)`, `get_classifier_metrics(signal_id)`

---

## 7. Implementation plan

1. Migration + training job queue
2. `FeatureExtractor` from trace store
3. Train + evaluate pipeline
4. Inference worker (N14 quality pipeline)
5. Shadow comparison dashboard
6. N10 integration (auto-train on save)
7. Promote flow + F06 disable flag

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `signal_classifiers_v1` | off |
| `classifier_shadow_days` | 7 |
| `classifier_min_f1` | 0.8 |

---

## 9. Test plan

- 5k example fixture → train <1h
- Holdout F1 ≥0.8 on golden dataset
- Inference p95 <10ms (1000 sequential)
- Shadow mode: agreement rate logged
- Promote: investigator skipped for signal

---

## 10. Acceptance criteria

- [ ] Train completes <1h async for 5k examples
- [ ] F1 ≥0.8 on holdout fixture
- [ ] Inference p95 <10ms
- [ ] N10 can create classifier from search
- [ ] Shadow report before investigator disable
- [ ] Retrain on 20 new labels debounced 24h

---

## 11. Performance & cost optimization

### Cost comparison

| Mode | Cost/1k traces | Latency |
|---|---|---|
| F06 investigator | $30–300 | 2–10s async |
| F34 classifier | ~$0.10 embed + $0 CPU | <10ms |

### When to use which

| Stage | Mode |
|---|---|
| New signal | F06 investigator + backfill |
| ≥50 labels + stable | Train F34, enter shadow |
| Shadow pass 7d | Disable investigator |

### Training limits

- Max 1 concurrent train/org
- Max 50k samples/train — sample if larger
- N16: classifier traces still subject to tail retention policy

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Inference | 2ms | 10ms |
| Feature extract | 20ms | 80ms |
| Train job (5k) | 10min | 45min |

### Monitoring

```
eden_classifier_train_duration_seconds
eden_classifier_inference_duration_seconds
eden_classifier_fired_total{signal_id}
eden_classifier_shadow_disagreement_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| F06 | Labels + investigator baseline |
| N10 | Search→classifier entry |
| F35 | Default signals feed labels |
| F28 | Stumble on fire |
| N16 | Retention policy |

---

*Cost optimization path for F06 at scale — essential for maintenance COGS.*
