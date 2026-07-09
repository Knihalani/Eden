# F06: Per-Trace Signal Investigation Agent

| Field | Value |
|---|---|
| **Feature ID** | F06 |
| **Slug** | `per-trace-signal-investigator` |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar, Bento |
| **Absorbs** | F07 signal cluster lifecycle, F08 historical backfill (deleted — deferred P2 within this spec) |
| **Closes gap** | 1.3, 5.4 |

---

## 1. Summary

Natural-language signal definitions + JSON output schema → **ReAct investigation agent** reads each trace → structured `signal_events`. Replaces Phase Q regex-only metric compiler (`services/cat2_intel/signals.py`).

**Market need:** Buyers want "ask questions of your traces" without writing EQL. Laminar signals + Bento classifiers validate this pattern.

---

## 2. Eden current state

| Component | Path | Status |
|---|---|---|
| Phase Q compiler | `services/cat2_intel/signals.py` | Regex → 8 metric rules only |
| Investigation agent | `investigation.py` | Single-shot, not signal-scoped |
| Signal routes | `routes/signals.py` | Compile-on-create only |
| Cluster/backfill | — | **Missing** (was F07/F08) |

---

## 3. Target behavior

```
Operator creates signal: "User expressed frustration after agent loop"
    → JSON schema: {frustrated: bool, evidence_quote: str, step: int}
    → Worker on trace.finalized:
        Compressor (trace → ≤4k tokens)
        → SignalInvestigator ReAct (read spans, tool results)
        → Insert signal_event if matched
    → Optional: cluster similar events (§7, absorbed F07)
    → On signal create/change: backfill window (§8, absorbed F08)
```

---

## 4. Architecture

```
trace.finalized (Redis)
    → SignalWorker
        → TraceCompressor
        → SignalInvestigator (LLM + span tools)
        → signal_events INSERT
        → SignalClusterer (async, optional)
```

**New modules:** `src/eden/signals/{compressor,investigator,worker,clusterer,backfill}.py`

---

## 5. Data model

```sql
CREATE TABLE signal_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,  -- NL prompt for investigator
    output_schema JSONB NOT NULL,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE signal_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    matched BOOLEAN NOT NULL,
    payload JSONB NOT NULL,
    investigator_confidence FLOAT,
    detected_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE signal_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id),
    name TEXT,  -- AI-generated cluster label
    status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved','reopened')),
    event_count INT DEFAULT 0,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    embedding VECTOR(1536)
);

CREATE TABLE signal_backfill_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'pending',
    traces_total INT,
    traces_done INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/orgs/{org_id}/signals` | CRUD definitions |
| `GET` | `/orgs/{org_id}/signals/{id}/events` | List events |
| `GET` | `/orgs/{org_id}/signal-clusters` | Cluster tree |
| `POST` | `/orgs/{org_id}/signal-clusters/{id}/resolve` | Resolve cluster |
| `POST` | `/orgs/{org_id}/signals/{id}/backfill` | Enqueue historical window |
| `GET` | `/orgs/{org_id}/signals/{id}/backfill/{job_id}` | Job progress |

**Portal:** Signals v2 tab with definition editor, event stream, cluster tree.

**MCP (F04):** `search_signals`, `get_signal_events` — Phase 2 tools.

---

## 7. Cluster lifecycle (absorbed F07 — P2)

Deferred to Phase 2 within F06; not a separate spec.

- Batch worker embeds event summaries (text-embedding-3-small)
- HDBSCAN or cosine threshold clustering
- AI-generated cluster names via one-shot LLM
- Auto-resolve cluster after 7d quiet; reopen on new event matching embedding

---

## 8. Historical backfill (absorbed F08 — P2)

On signal create or definition change:
- Default: backfill last 7 days (configurable)
- Rate-limited worker: max 100 traces/min/org
- Progress bar in portal; MCP poll via backfill job ID

---

## 9. Cost controls

| Guard | Value |
|---|---|
| Investigator model | SLM default (Haiku-class) |
| Max traces/min/org | 100 |
| Compressor token budget | 4k tokens/trace |
| Skip if trace <3 steps | Yes |

---

## 10. Feature flags

| Flag | Default |
|---|---|
| `per_trace_signals_v1` | false |
| `signal_clusters_v1` | false (Phase 2) |
| `signal_backfill_v1` | true when signals enabled |

---

## 11. Test plan

- Fixture loop trace → frustration signal fires
- Backfill 1k traces completes <30 min with rate limit
- Cluster naming deterministic on fixture set
- Phase Q regression: existing metric signals unchanged

---

## 12. Acceptance criteria

- [ ] NL signal definition → event on matching synthetic trace
- [ ] Non-matching trace → `matched=false` or no row
- [ ] Backfill job shows progress in portal
- [ ] Cluster resolves after 7d quiet (Phase 2)
- [ ] COGS within org daily signal budget

---

*Dependencies: F35 default library seeds definitions. See [DELETED-FEATURES.md](./DELETED-FEATURES.md) for F07/F08 merge rationale.*
