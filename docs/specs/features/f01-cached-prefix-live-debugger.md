# F01: Cached Prefix Live Debugger

| Field | Value |
|---|---|
| **Feature ID** | F01 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | PARTIAL |
| **Competitive source** | Laminar (`LMNR_DEBUG`, debugger caching docs) |
| **Dependencies** | F03 (checkpoint ingest), F48 (portal fix) |
| **Absorbs** | F02 debug session timeline (deleted — sessions built into F01 + F04 MCP) |

---

## 1. Problem

Laminar's debugger lets engineers rerun from step N in **seconds** by serving steps 1..N-1 from recorded LLM responses (cache keyed by input hash, **system messages excluded**). Eden Phase P only supports **hermetic** replay — same recorded output, no validation that a prompt fix actually works.

Eden Cat 20 `TraceReplayer` executes step N live via `AIGateway` but uses a separate fork-based UX and does not implement Laminar-style prefix cache keyed on `(trace_id, input_hash)`.

---

## 2. Eden current state (exact)

| Component | Path | Lines | Status |
|---|---|---|---|
| Hermetic engine | `src/eden/debugger/checkpoints.py` | `ReRunEngine:243`, `CheckpointStore:137` | Shipped |
| Phase P routes | `src/eden/api/routes/debugger.py` | full file | Shipped, ungated |
| Live replayer | `src/eden/time_travel/replayer.py` | `TraceReplayer.replay_from:60` | Cat 20, gated |
| Cache key helper | `src/eden/time_travel/_common.py` | `_step_cache_key` | Cat 20 only |
| Gateway | `src/eden/llmops/ai_gateway.py` | `AIGateway.complete` | Use for live tail |
| Checkpoint ingest | — | — | **Not wired** |
| Prefix cache table | — | — | **Missing** |

**Doc reference:** `docs/docs/observability/39-agent-debugger.md` — explicitly defers real reruns to Phase P.5.

---

## 3. Target behavior

### 3.1 User story

> As an agent engineer, I open trace `abc-123`, jump to step 12, change the system prompt, and click **Rerun (live)**. Eden replays steps 1–11 from cache in under 2 seconds, executes step 12+ against the real model through the gateway, creates trace `def-456`, and shows me a diff highlighting where the trajectory diverged — without re-running expensive tool side effects unless I opt in.

### 3.2 Modes

| Mode | `rerun_mode` | LLM calls | Tool calls | Use case |
|---|---|---|---|---|
| Hermetic | `hermetic` | Recorded | None | Compliance-safe what-if on wording |
| Cached live | `cached_live` | Cache then live | Mock default | **Laminar parity** |
| Full live | `full_live` | All live | Configurable | Full trajectory validation |

### 3.3 Cache algorithm (Laminar parity)

Per `laminar.sh/docs/debugger/caching.md`:

```python
def llm_input_hash(messages: list[dict[str, Any]]) -> str:
    """Hash all messages EXCEPT system role."""
    filtered = [
        m for m in messages
        if m.get("role") != "system"
    ]
    canonical = json.dumps(filtered, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

Lookup key: `(org_id, source_trace_id, step_number, input_hash)`

On replay:
1. For each step `< from_step`: serve from cache (no gateway)
2. At `from_step`: apply `prompt_override` to system message, compute new hash
3. If cache hit and no override → serve cached
4. On first miss → call gateway, mark `live_mode=True`, all subsequent steps live

Env var parity: `EDEN_DEBUG_CACHE_UNTIL=12` → force cache through step 11.

---

## 4. Architecture

```
POST /debugger/rerun
       │
       ▼
┌──────────────────┐
│ DebuggerRouter   │
└────────┬─────────┘
         │ rerun_mode == hermetic → ReRunEngine (existing)
         │
         ▼ cached_live | full_live
┌──────────────────┐     ┌─────────────────────┐
│ CachedPrefix     │────►│ PrefixCacheService  │
│ Replayer         │     │ debugger_llm_cache  │
└────────┬─────────┘     └─────────────────────┘
         │
         ├─► CheckpointStore.list_for_trace()
         ├─► AIGateway.complete()  [live steps]
         ├─► ToolReplayPolicy      [mock | recorded | live]
         └─► DebugSessionService   [optional session attach]
                 │
                 ▼
         New trace_id → telemetry_events ingest
```

### 4.1 New modules

| File | Responsibility |
|---|---|
| `src/eden/debugger/cache.py` | `PrefixCacheService.get/set`, hash fn |
| `src/eden/debugger/live_rerun.py` | `CachedPrefixReplayer` |
| `src/eden/debugger/tool_policy.py` | `ToolReplayPolicy` enum + executor |
| `src/eden/debugger/session.py` | `DebugSessionService` (shared with F02) |

### 4.2 Unify with Cat 20

Extract shared cache from `time_travel/_common.py`:

```python
# eden/debugger/cache.py — single source of truth
from eden.debugger.cache import PrefixCacheService, llm_input_hash
```

Cat 20 `TraceReplayer` imports same service; deprecate duplicate `_step_cache_key` in v2.

---

## 5. Data model

**Migration:** `src/eden/db_migrations/versions/074_debugger_live_rerun.py`

```sql
CREATE TABLE IF NOT EXISTS debugger_llm_cache (
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_trace_id     UUID NOT NULL,
    step_number         INT NOT NULL CHECK (step_number >= 0),
    input_hash          TEXT NOT NULL,
    response            JSONB NOT NULL,
    model               TEXT,
    input_tokens        INT,
    output_tokens       INT,
    cost_usd            NUMERIC(12, 8),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
);

CREATE INDEX idx_debugger_cache_trace ON debugger_llm_cache (org_id, source_trace_id);

CREATE TABLE IF NOT EXISTS debug_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id  UUID,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS debug_session_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES debug_sessions(id) ON DELETE CASCADE,
    trace_id        UUID NOT NULL,
    parent_trace_id UUID,
    rerun_mode      TEXT NOT NULL CHECK (rerun_mode IN ('hermetic','cached_live','full_live')),
    from_step       INT NOT NULL DEFAULT 0,
    prompt_override TEXT,
    cache_hits      INT NOT NULL DEFAULT 0,
    cache_misses    INT NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(12, 8) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Population: F03 ingest hook writes both `telemetry_events` checkpoints AND `debugger_llm_cache` on every LLM span.

---

## 6. API specification

### 6.1 Extend `RerunRequest`

```python
class RerunRequest(BaseModel):
    trace_id: str
    from_step: int = Field(default=0, ge=0)
    prompt_override: str | None = None
    rerun_mode: Literal["hermetic", "cached_live", "full_live"] = "hermetic"
    session_id: UUID | None = None
    cache_until_step: int | None = Field(default=None, ge=0)
    max_live_steps: int = Field(default=10, ge=1, le=50)
    budget_usd_cap: float = Field(default=1.0, gt=0, le=10.0)
    tool_execution_mode: Literal["mock", "recorded", "live"] = "mock"
```

### 6.2 Extend `RerunResponse`

```python
class RerunResponse(BaseModel):
    source_trace_id: str
    new_trace_id: str | None = None
    from_step: int
    to_step: int
    rerun_mode: str
    prompt_override: str | None = None
    checkpoints: list[CheckpointResponse]
    diff: list[dict[str, Any]]
    cache_hits: int = 0
    cache_misses: int = 0
    live_steps_executed: int = 0
    tokens_saved: int = 0
    cost_usd: float = 0.0
    session_id: UUID | None = None
```

### 6.3 Error codes

| Code | Condition |
|---|---|
| 402 | `budget_usd_cap` exceeded mid-rerun |
| 403 | Org policy `debugger_allow_live_rerun=false` |
| 404 | No checkpoints for trace (F03 not enabled) |
| 422 | `from_step` > max step |

---

## 7. Implementation steps (ordered)

1. **F48** — Fix portal API contracts
2. **Migration 074** — Create tables
3. **`cache.py`** — Implement hash + CRUD with tests
4. **F03** — Ingest hook populates cache
5. **`live_rerun.py`** — Core replay loop with gateway integration
6. **`tool_policy.py`** — Mock tools by default
7. **Extend `debugger.py`** — Wire new request/response fields
8. **Budget integration** — Check org budget before each live gateway call
9. **Portal** — Mode selector, cache stats, link to new trace
10. **Feature flag** — `debugger_live_rerun_v1` default false
11. **Docs** — Update `39-agent-debugger.md`, add env var reference

---

## 8. Performance budgets

| Metric | Target |
|---|---|
| Cache lookup p95 | <10ms |
| Prefix replay (40 cached steps) p95 | <2s |
| Live step via gateway | Model latency + <50ms Eden overhead |
| Cache write on ingest | Async, non-blocking; <5ms amortized |

---

## 9. Security

- Live rerun requires `debugger_allow_live_rerun` org feature (default false for HIPAA)
- All live calls through `AIGateway` (PII redaction, audit log)
- `full_live` + `tool_execution_mode=live` requires admin role
- Cached responses may contain PII — same RBAC as source trace

---

## 10. Test plan

| Test | Path |
|---|---|
| Hash excludes system | `tests/unit/debugger/test_cache_hash.py` |
| Cache hit no gateway mock | `tests/unit/debugger/test_live_rerun.py` |
| Override busts cache at step | same |
| Budget abort | `tests/integration/test_debugger_live_rerun.py` |
| Hermetic regression | existing `tests/unit/test_debugger.py` |

**Fixtures:** Extend `tests/fixtures/traces/synthetic/` with 50-step agent trace.

---

## 11. Acceptance criteria

- [ ] Cached live rerun from step 40 of 50-step trace: p95 <2s for prefix, 1 live gateway call
- [ ] System prompt edit at step 12 does not invalidate cache for steps 1–11
- [ ] `cache_hits` + `cache_misses` accurate in response
- [ ] New trace ingested and visible in portal
- [ ] Hermetic mode unchanged
- [ ] Flag off → `cached_live` returns 403

---

---

## 12. Debug sessions (absorbed F02)

Debug sessions group multiple reruns, eval scores, and agent notes into one investigation timeline — previously spec'd as F02, now **part of F01** (portal) and **F04** (MCP).

### 12.1 Behavior

- First `cached_live` or `hermetic` rerun optionally creates `debug_session_id`
- Subsequent reruns attach to same session (portal or MCP `create_debug_session`)
- Portal `/debugger/sessions/[id]` shows vertical timeline: run traces, cache stats, diffs, linked issues
- MCP: `create_debug_session`, `list_debug_sessions` (see F04)

### 12.2 Tables

Already defined in §4: `debug_sessions`, `debug_session_runs`.

### 12.3 Local session file (optional)

For offline IDE sync, write `.eden/debug-session.json` (similar to Laminar `.lmnr/debug-session.json`) — **optional**; MCP session APIs are canonical.

---

*See also: F03 ingest, F04 Eden MCP `rerun_debugger` / `create_debug_session` tools.*
