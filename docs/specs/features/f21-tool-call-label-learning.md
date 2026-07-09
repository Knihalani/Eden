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
| **Dependencies** | F29, N13 (transcript UI) |

---

## 1. Summary

Engineers mark tool calls ✓/✗ in transcript → embedding classifier learns per-agent misuse patterns → flags similar calls on new traces. Sentrial differentiator for tool-heavy agents.

---

## 2. Target behavior

```
User labels span as bad + reason "wrong SQL table"
    → store tool_call_labels row + embedding
    → after ≥5 labels: train ToolCallCalibrator (small classifier)
    → new traces: inference on tool spans → stumble if confidence >0.85
```

---

## 3. Data model

```sql
CREATE TABLE tool_call_labels (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    span_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    agent_id TEXT,
    label TEXT CHECK (label IN ('good','bad')),
    reason TEXT,
    tool_name TEXT,
    embedding VECTOR(1536),
    labeled_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tool_call_calibrators (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    tool_name TEXT,
    model_blob BYTEA,
    precision FLOAT,
    sample_count INT,
    trained_at TIMESTAMPTZ
);
```

---

## 4. API

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/tool-calls/{span_id}/label` |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/tool-calibrators` |

**Portal/N13:** Tool row ✓/✗ buttons

**MCP (F04):** `label_tool_call(span_id, label, reason)`

---

## 5. Performance & cost optimization

### Training cost

- Embedding: text-embedding-3-small ~$0.0001/label
- Classifier: sklearn logistic on CPU — $0, <1s train for 100 labels
- Retrain debounce: max 1/hour/agent

### Inference

- p95 <5ms per tool span (local model)
- Skip inference if <5 labels (cold start)
- Batch embed on trace.finalized only for agents with calibrator

### Storage

- model_blob typically <100KB/agent/tool

---

## 6. Acceptance criteria

- [ ] 10 labels → 8/10 similar misuses flagged on test set
- [ ] Inference p95 <5ms
- [ ] Label UI in transcript (N13)
- [ ] Bad label creates F28 stumble when confidence high

---

*Sentrial parity; enhances N13 transcript UX.*
