# F28: Agent Stumbles (Single Failure Unit)

| Field | Value |
|---|---|
| **Feature ID** | F28 |
| **Slug** | `agent-stumbles` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop 2.0 (Stumbles) |
| **Closes gap** | 3.1 |
| **Dependencies** | F20 (auto-detection), F29 (promotion) |

---

## 1. Summary

A **Stumble** is the atomic unit of agent failure — one detectable bad event in one trace. Raindrop uses stumbles before Sentry-style issue grouping. Eden jumps straight to `incident_clusters`; F28 adds the missing layer that powers F29, F30, F39, and N08.

---

## 2. Eden current state

| Exists | Gap |
|---|---|
| ETEC loop detection | Not persisted as stumble |
| `IncidentClusterer` | Different abstraction, no per-trace atomic record |
| Trace quality API | Read-only reports |
| `InvestigationAgent` | On-demand, not stumble writer |

---

## 3. Stumble kinds

```python
class StumbleKind(str, Enum):
    TOOL_ERROR = "tool_error"
    LOOP = "loop"
    HALLUCINATION = "hallucination"
    TASK_FAILURE = "task_failure"
    USER_FRUSTRATION = "user_frustration"
    TIMEOUT = "timeout"
    SELF_DIAGNOSTIC = "self_diagnostic"  # agent logged own failure
    MCP_AUTH_FAILURE = "mcp_auth_failure"  # N02
    STATGATE_P0 = "statgate_p0"            # N08
    CUSTOM = "custom"
```

---

## 4. Target behavior

```
Detector (F20, N08, F06, SDK) → StumbleWriter.create()
    → INSERT agent_stumbles
    → IssuePromoter.upsert(fingerprint)  [F29]
    → on_stumble_created hooks (Slack F47, triage queue F30)
```

**Dedup:** Max one stumble per `(trace_id, kind, fingerprint)` — subsequent identical hits update `detail` only.

---

## 5. Architecture

**`src/eden/issues/stumble_writer.py`**

```python
@dataclass
class StumbleCreate:
    org_id: str
    trace_id: str
    kind: StumbleKind
    title: str
    detail: dict
    severity: Literal["p0","p1","p2","p3"]
    detected_by: str  # auto_scanner, statgate, sdk, signal_f06
    session_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    span_id: str | None = None

class StumbleWriter:
    async def create(self, req: StumbleCreate) -> UUID:
        fingerprint = compute_fingerprint(req.kind, req.agent_id, req.detail)
        # INSERT ... ON CONFLICT (trace_id, kind, fingerprint) DO UPDATE
        stumble_id = await self._repo.insert(...)
        await self._promoter.on_stumble(stumble_id)
        return stumble_id
```

---

## 6. Data model

See F29 migration `077_agent_issues.sql` — `agent_stumbles` table.

Additional index for list views:

```sql
CREATE INDEX idx_stumbles_trace ON agent_stumbles (org_id, trace_id, detected_at DESC);
CREATE INDEX idx_stumbles_agent ON agent_stumbles (org_id, agent_id, kind, detected_at DESC);
```

---

## 7. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/stumbles` | List with filters: kind, agent_id, since, trace_id |
| `GET` | `/orgs/{org_id}/stumbles/{id}` | Detail + link to trace |
| `GET` | `/orgs/{org_id}/traces/{trace_id}/stumbles` | All stumbles on trace |

**Internal:** `StumbleWriter.create()` — primary write path.

**MCP (F04):** `get_trace_stumbles(trace_id)`

---

## 8. SDK surface

```python
# Explicit stumble from agent self-diagnostic
eden.record_stumble(
    kind="self_diagnostic",
    title="KB search returned empty",
    detail={"tool": "search_kb", "query": "..."},
)
```

Enables Raindrop-style agent-reported failures.

---

## 9. Performance & cost optimization

### Latency budgets

| Operation | p95 |
|---|---|
| StumbleWriter.create (DB) | <30ms |
| End-to-end detect→stumble (F20) | <60s from trace.finalized |
| GET stumbles by trace_id | <50ms |

### Cost model

- **$0 LLM** for deterministic detectors (F20 tool_error, N08 StatGate)
- **Storage:** ~500 bytes/stumble row
- **1M stumbles/mo:** ~500MB — index dominates; partition by month optional

### Write optimization

- Batch promote to F29: debounce 100ms per fingerprint (coalesce bursts)
- Use Redis `SETNX stumble:{trace}:{kind}:{fp}` to skip duplicate writes in same second

### Degradation

- DB slow → write to Redis buffer, flush async
- Org over stumble rate limit (10k/hr) → sample + alert (abuse protection)

### Monitoring

```
eden_stumble_created_total{kind,detected_by}
eden_stumble_write_duration_seconds
eden_stumble_deduped_total
```

---

## 10. Feature flags

| Flag | Default |
|---|---|
| `agent_stumbles_v1` | true with F20 |
| `sdk_self_diagnostic_stumbles_v1` | true |

---

## 11. Test plan

- Each F20 detector produces correct stumble kind
- Dedup: 2 identical loops → 1 stumble row
- N08 StatGate P0 → stumble without LLM
- Promotion hook calls F29 IssuePromoter (mock)

---

## 12. Acceptance criteria

- [ ] Tool error span → stumble <60s via F20
- [ ] Dedup works per trace/kind/fingerprint
- [ ] SDK self_diagnostic creates stumble
- [ ] Trace detail shows stumble badges
- [ ] Write p95 <30ms under 100 concurrent scans/org

---

*Foundation for F29 issues. See [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).*
