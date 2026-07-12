# N16: Intelligence-Aware Tail Sampling

| Field | Value |
|---|---|
| **Feature ID** | N16 |
| **Slug** | `intelligence-aware-tail-sampling` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED (core)** — OTel edge policies + Cat 22 `DEFAULT_KEEP_RATES` + `src/eden/observability/sampling/policy.py`; metrics-only table migrated; portal profile UI deferred |
| **Market hypothesis** | Enterprise buyers want **60–90% ingest cost reduction** without losing failures — deterministic keep rules beat random sampling |
| **Dependencies** | N14 (`detector_keep_rate_loop`), F20, N08 |

---

## 1. Problem

Raw trace ingest is the largest COGS line for observability platforms. Random 10% sampling **drops the failures you need** for agent maintenance.

Eden already has pieces:
- OTel tail sampling: `deploy/otel-collector-config.yaml`
- In-process policy: `supplementaries/cat_22_apm/tail_sampling.py`
- Loop traces always kept: `wiring.py:23–27` (`detector_keep_rate_loop = 1.0`)

**Not productized** as a unified "smart sampling" architecture with Eden intelligence signals.

---

## 2. Target: keep rules (priority order)

| Priority | Keep 100% | Signal source | Cost |
|---|---|---|---|
| P0 | ETEC loop verdict | quality worker step 2 | $0 |
| P0 | StatGate P0 check fail | `phase_6_stat_gate/gate.py` | $0 |
| P0 | Tool error spans | span attributes | $0 |
| P1 | Stumble detected (F28) | issue pipeline | $0 |
| P1 | Judge failure | `judge_scores` | $0 |
| P2 | MCP auth failure | `observability_mcp.py` | $0 |
| P3 | High cost (>3σ) | cost attrs | $0 |
| Default | Sample 5–20% | configurable | $0 |

**Never sample away:** traces with any P0–P1 signal.

---

## 3. Architecture

```
OTel Collector (edge)
    → tail_sampling processor with Eden attribute rules
        keep: eden.keep=true OR eden.loop_verdict=true OR error=true
        sample: 10% if eden.tier=normal

In-process (optional second gate):
    cat_22_apm/tail_sampling.py reads detector_keep_rate_loop

Post-sample:
    Full fidelity for kept traces → F20, N08, F06
    Sampled-out traces → metrics-only row (count, cost, agent_id) — 50 bytes
```

**New module:** `src/eden/observability/sampling/policy.py`

**Portal:** Settings → Sampling → profile (`aggressive` 5%, `balanced` 15%, `full` 100%)

---

## 4. Metrics-only mode for dropped traces

```sql
CREATE TABLE trace_sampling_summaries (
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    agent_id TEXT,
    duration_ms INT,
    cost_usd FLOAT,
    span_count INT,
    dropped_at TIMESTAMPTZ DEFAULT now(),
    drop_reason TEXT DEFAULT 'sampled_out',
    PRIMARY KEY (org_id, trace_id)
);
```

Fleet dashboards (N05) still show volume/cost; issue detection uses kept traces only.

---

## 5. Performance & cost optimization

### Cost model (illustrative)

| Profile | Trace keep rate | Storage vs full | Detection coverage |
|---|---|---|---|
| full | 100% | 1× | 100% |
| balanced | ~18% | ~0.18× | ~99% failures kept |
| aggressive | ~8% | ~0.08× | ~97% failures kept |

Failures kept at high rate because P0/P1 rules capture them **before** random drop.

### Latency

- OTel tail sampling decision: <1ms per trace (collector)
- Attribute tagging on ingest: <2ms (`eden.keep` flags)

### Client experience

- SDK: `eden.sample(mode="balanced")` default for high-volume agents
- Transparent: kept traces identical; dropped traces invisible in UI except aggregate metrics
- **Upgrade prompt:** "12 failures may have been sampled out — switch to balanced+ for 7d"

### Combined with N09 + zstd

```
Raw 100% → N16 keep 18% → N09 dedupe 3× → zstd 15× ≈ 0.04× storage vs naive full JSON
```

Reference: `storage/compression.py` — 15.58× measured on LLM payloads.

### Monitoring

```
eden_sampling_kept_total{tier}
eden_sampling_dropped_total{reason}
eden_sampling_summary_bytes_total
```

---

## 6. Acceptance criteria

- [ ] Loop trace never dropped when `detector_keep_rate_loop=1.0`
- [ ] Aggressive profile reduces storage ≥80% on synthetic workload
- [ ] Tool-error trace always kept
- [ ] Metrics-only row created for dropped traces
- [ ] N05 fleet cost chart reflects true volume via summaries

---

## 7. Stand-out narrative

> "Cut observability spend 80% — **without** going blind to agent failures."

Deterministic keep rules + ETEC/StatGate = Eden moat vs random sampling (Datadog/Langfuse default).

---

*Requires N14 for loop verdict attributes. Pairs with N09, PERFORMANCE-COST-STANDARDS.md.*
