# F21: Tool Call Label Learning

| Field | Value |
|---|---|
| **Feature ID** | F21 |
| **Slug** | `tool-call-label-learning` |
| **Priority** | P2 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Sentrial |
| **Closes gap** | 2.2 |
| **Dependencies** | F29, N13 (transcript UI), F28, F06, F04, N22 |

---

## 1. Summary

Engineers mark tool calls ✓/✗ in transcript with reasons → embedding classifier learns per-agent misuse patterns → flags similar calls on new traces as F28 stumbles. **Human-in-the-loop maintenance** that compounds: each label improves detection. Sentrial differentiator; Eden adds StatGate confirmation + autonomous propose at T2.

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| Tool spans in trace store | No label table |
| F28 stumble detection | No learned tool patterns |
| N13 transcript | No label UI |

**Greenfield:** `src/eden/learning/tool_call_labels.py`, `ToolCallCalibrator`

---

## 3. Target behavior

```
User labels span as bad + reason "wrong SQL table"
    → store tool_call_labels row + embedding (text-embedding-3-small)
    → after ≥5 labels per (agent_id, tool_name): train ToolCallCalibrator
    → new traces: inference on tool spans at span_end
    → confidence >0.85 + StatGate corroboration → F28 stumble kind=tool_misuse
    → N17 card: "Learned pattern: wrong SQL table"
```

### Autonomous assist (N22 T2+)
- Cluster unlabeled bad tool outcomes from F28 → propose labels for operator confirm
- Never auto-label as `good` without human

---

## 4. Architecture

| Component | Path |
|---|---|
| `ToolCallLabelService` | `learning/tool_call_labels.py` |
| `ToolCallCalibrator` | `learning/tool_call_calibrator.py` |
| Inference hook | `trace_quality/hooks.py` (post span_end) |
| Portal UI | N13 ToolBlock label buttons |

**Feature vector:** `embed(tool_name + args_summary + result_preview + agent_id)`

**Model:** sklearn LogisticRegression on embeddings — CPU, <100KB blob per agent/tool.

---

## 5. Data model

```sql
CREATE TABLE tool_call_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    span_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    agent_id TEXT,
    label TEXT NOT NULL CHECK (label IN ('good','bad')),
    reason TEXT,
    tool_name TEXT NOT NULL,
    args_hash TEXT,
    embedding VECTOR(1536),
    labeled_by UUID,
    actor_type TEXT DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tool_call_calibrators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    tool_name TEXT,
    model_blob BYTEA NOT NULL,
    precision FLOAT,
    recall FLOAT,
    sample_count INT NOT NULL,
    trained_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id, tool_name)
);

CREATE TABLE tool_call_predictions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    span_id UUID NOT NULL,
    calibrator_id UUID NOT NULL,
    confidence FLOAT NOT NULL,
    predicted_label TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{org_id}/tool-calls/{span_id}/label` | Create label |
| `DELETE` | `/orgs/{org_id}/tool-calls/{span_id}/label` | Remove label (retrain) |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/tool-calibrators` | List models + metrics |
| `POST` | `/orgs/{org_id}/agents/{agent_id}/tool-calibrators/retrain` | Force retrain |

**MCP (F04):** `label_tool_call(span_id, label, reason)`, `get_tool_calibrator_stats(agent_id)`

---

## 7. Implementation plan

1. Migration + label API
2. Embedding on label create (async)
3. `ToolCallCalibrator.train()` — debounced 1/hour/agent
4. Inference hook on tool span_end
5. F28 stumble creation when confidence + StatGate agree
6. N13 UI integration
7. MCP tools + N06 audit on label

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `tool_call_label_learning_v1` | off |
| `tool_call_inference_v1` | off |
| `tool_call_min_labels` | 5 |

---

## 9. Test plan

- 10 labels same pattern → 8/10 similar misuses flagged (fixture)
- Inference p95 <5ms (local model load)
- Label delete → retrain excludes sample
- Cold start <5 labels → no inference
- N22 T0 → inference off, labels stored only

---

## 10. Acceptance criteria

- [ ] 10 labels → 8/10 similar misuses flagged on test set
- [ ] Inference p95 <5ms
- [ ] Label UI in transcript (N13)
- [ ] Bad label creates F28 stumble when confidence high
- [ ] MCP label_tool_call works from Cursor
- [ ] Calibrator metrics visible in portal agent settings

---

## 11. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Label API | 30ms | 150ms | 400ms |
| Embed on label | 100ms | 400ms | 800ms |
| Train (100 labels) | 500ms | 2s | 5s |
| Inference per span | 1ms | 5ms | 10ms |

### Cost model

| Step | Cost |
|---|---|
| Embedding | ~$0.0001/label |
| Classifier train | $0 CPU |
| Inference | $0 |
| **$/1k labels** | **~$0.10** |

Retrain debounce: max 1/hour/agent — prevents churn COGS.

### Storage

- `model_blob` typically <100KB/agent/tool
- Predictions retained 30d for calibration review

### Degradation modes

- Embed API down → queue label, retry embed
- Model load fail → skip inference, log metric
- Precision <0.6 on holdout → disable auto-stumble, notify operator

### Monitoring

```
eden_tool_label_created_total{label}
eden_tool_calibrator_train_duration_seconds
eden_tool_inference_total{predicted}
eden_tool_auto_stumble_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| N13 | Label UI |
| F28 | Stumble on high-confidence bad |
| F29 | Link stumbles to issues |
| N17 | Learned pattern cards |
| N06 | Label audit trail |

---

*Sentrial parity; enhances N13 transcript + autonomous maintenance learning loop.*
