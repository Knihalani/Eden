# Laminar Gap Implementation Specs

Competitor: **Laminar** (YC S24) — https://laminar.sh  
Competitive reference docs: `laminar.sh/docs/debugger/*`, `laminar.sh/docs/signals/*`

---

## Gap 1.1 — Real Agent Debugger with Cached Prefix Replay {#gap-11}

**Severity:** 🔴 Critical  
**Effort:** XL  
**Closes:** Laminar Debugger + caching (`LMNR_DEBUG`, `LMNR_DEBUG_CACHE_UNTIL`)

### 1. Problem statement

Eden Phase P (`src/eden/debugger/checkpoints.py`) only supports **hermetic reruns** — recorded LLM responses, no live model calls, no tool re-execution. Laminar serves cached prefix responses keyed by `(trace_id, input_hash)` where **system messages are excluded from hash** so prompt iteration does not bust the entire cache.

Eden already has **Cat 20 live replay** (`src/eden/time_travel/replayer.py`) but it requires fork creation, uses a different API surface, and is not unified with Phase P debugger UX.

### 2. Eden current state

| Component | Path | Status |
|---|---|---|
| Hermetic engine | `src/eden/debugger/checkpoints.py` → `ReRunEngine` | Shipped |
| Phase P routes | `src/eden/api/routes/debugger.py` | Shipped, ungated |
| Live replay | `src/eden/time_travel/replayer.py` → `TraceReplayer` | Shipped (Cat 20) |
| Checkpoint ingestion | — | **Missing** — `CheckpointStore.save()` never called from ingest |
| Portal | `clients/portal/src/app/(portal)/debugger/page.tsx` | **Broken API contract** |
| Tables | `telemetry_events` (checkpoints), `time_travel_forks`, `trace_replay_steps` | Partial |

### 3. Target behavior

**User story:** Operator opens trace T, selects step 12, edits system prompt, clicks "Rerun from here (live)". Eden serves steps 1–11 from cache (<100ms), executes step 12+ live via gateway, records new trace T′ in same debug session, shows side-by-side diff.

**Modes:**

| Mode | `rerun_mode` | Behavior |
|---|---|---|
| Hermetic | `hermetic` | Current Phase P (default for prod traces with PII) |
| Cached live | `cached_live` | Laminar parity — prefix cache + live tail |
| Full live | `full_live` | No cache; budget-capped |

**Cache key algorithm (Laminar parity):**

```python
def llm_input_hash(messages: list[dict], *, exclude_system: bool = True) -> str:
    filtered = [m for m in messages if not (exclude_system and m.get("role") == "system")]
    canonical = json.dumps(filtered, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
```

Lookup: `(source_trace_id, step_number, input_hash)` → cached response blob in `debugger_llm_cache`.

### 4. Architecture

```
Portal / CLI / MCP
       │
       ▼
POST /debugger/rerun  (mode=cached_live)
       │
       ├─► CheckpointLoader ← telemetry_events + span normalization
       │
       ├─► PrefixCacheService ← debugger_llm_cache table
       │      hit → return recorded response
       │      miss → AIGateway.complete() + record to cache
       │
       ├─► ToolReplayPolicy
       │      cached_live: mock tools until from_step, then live OR recorded (config)
       │
       └─► DebugSessionWriter → debug_sessions + new trace_id
```

**Unification decision:** Extend Phase P routes; delegate live path to extracted `CachedPrefixReplayer` service shared with Cat 20.

### 5. Data model

**Migration `074_debugger_live_rerun.sql`:**

```sql
CREATE TABLE debug_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE debug_session_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES debug_sessions(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    parent_trace_id UUID,
    rerun_mode TEXT NOT NULL CHECK (rerun_mode IN ('hermetic','cached_live','full_live')),
    from_step INT NOT NULL DEFAULT 0,
    prompt_override TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE debugger_llm_cache (
    org_id UUID NOT NULL,
    source_trace_id UUID NOT NULL,
    step_number INT NOT NULL,
    input_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
);

CREATE INDEX idx_debugger_cache_trace ON debugger_llm_cache (source_trace_id);
```

**Checkpoint ingestion hook:** On LLM span finalize in `src/eden/observability/ingestion/`, call:

```python
await checkpoint_store.save_from_span(org_id, trace_id, step_number, span_payload)
```

Populate `debugger_llm_cache` on every ingested LLM span (async, best-effort).

### 6. API changes

**Extend `RerunRequest` in `debugger.py`:**

```python
class RerunRequest(BaseModel):
    trace_id: str
    from_step: int = 0
    prompt_override: str | None = None
    rerun_mode: Literal["hermetic", "cached_live", "full_live"] = "hermetic"
    session_id: UUID | None = None  # attach to debug session
    cache_until_step: int | None = None  # LMNR_DEBUG_CACHE_UNTIL parity
    max_live_steps: int = Field(default=10, le=50)
    budget_usd_cap: float = Field(default=1.0, le=10.0)
```

**Extend `RerunResponse`:**

```python
class RerunResponse(BaseModel):
    # ... existing fields ...
    new_trace_id: str | None
    session_id: UUID | None
    cache_hits: int
    cache_misses: int
    live_steps_executed: int
    cost_usd: float
    tokens_saved: int
```

**New routes:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{org_id}/debugger/sessions` | Start debug session |
| `GET` | `/orgs/{org_id}/debugger/sessions/{session_id}` | Session timeline (runs + evals) |
| `POST` | `/orgs/{org_id}/debugger/sessions/{session_id}/notes` | Coding-agent notes |

### 7. Implementation steps

1. **Extract** `src/eden/debugger/cache.py` — `PrefixCacheService`, hash function, get/set.
2. **Extract** `src/eden/debugger/live_rerun.py` — `CachedPrefixReplayer.replay(trace_id, from_step, ...)`.
3. **Wire** `TraceReplayer` cache key logic to share `PrefixCacheService` (deprecate duplicate in `_step_cache_key` over time).
4. **Add** ingest hook in `src/eden/observability/ingestion/framework.py` after span commit.
5. **Extend** `POST /debugger/rerun` to branch on `rerun_mode`.
6. **Fix portal** `debuggerApi` — path `/checkpoints/{traceId}`, align types to `CheckpointResponse`.
7. **Portal UX** — mode toggle, cache hit/miss badges, link to new trace.
8. **Budget guard** — enforce `budget_usd_cap` via existing org budget service.

### 8. Feature flags

| Flag | Default | Purpose |
|---|---|---|
| `debugger_live_rerun_v1` | `false` | Gates `cached_live` / `full_live` |
| `debugger_checkpoint_ingest_v1` | `true` | Gates ingest hook |

Org policy: `organizations.features.debugger_allow_live_rerun` (default false for HIPAA).

### 9. Tests

| Test | File |
|---|---|
| Hash excludes system messages | `tests/unit/debugger/test_cache_hash.py` |
| Cache hit serves recorded, no gateway call | `tests/unit/debugger/test_live_rerun.py` |
| Miss triggers gateway once, then live mode | same |
| Budget cap aborts with 402 | `tests/integration/test_debugger_live_rerun.py` |
| Portal contract e2e | `tests/e2e/test_debugger_page.py` |

### 10. Acceptance criteria

- [ ] Rerun from step N on 50-step trace completes prefix in <2s (p95) with ≥90% cache hit when prompt-only change at step N
- [ ] System prompt edit at step 12 does not invalidate cache for steps 1–11
- [ ] New trace appears in debug session timeline
- [ ] Hermetic mode unchanged (regression 24 tests in `test_debugger.py`)
- [ ] Live mode blocked when org policy disables

### 11. Risks

- Tool side effects on live tail — mitigate with `tool_execution_mode: mock|live` default `mock`
- PII in live reruns — require gateway PII redaction path (already on `AIGateway`)

---

## Gap 1.2 — Coding-Agent Iteration Loop (CLI + MCP + Skill) {#gap-12}

**Severity:** 🔴 | **Effort:** L

### Target

Ship `eden-cli debug` and MCP **query server** so Claude Code/Cursor can: run agent → query traces → rerun → create eval — without portal.

### Current state

- MCP **ingest** only: `observability_mcp.py`, `sdk/mcp.py`
- Agent tools in `autonomous/agent.py`: `search_spans`, `get_trace_messages`, `create_pr_suggestion` — portal SSE only
- No `eden-cli` debug subcommands

### Architecture

New package: `src/eden/mcp_server/` (separate from ingest SDK)

**MCP tools (stdio + HTTP):**

| Tool | Maps to |
|---|---|
| `eden_search_traces` | Typesense / EQL |
| `eden_get_trace_transcript` | replay messages API |
| `eden_list_checkpoints` | `GET /debugger/checkpoints/{id}` |
| `eden_rerun_debugger` | `POST /debugger/rerun` |
| `eden_create_signal` | `POST /signals` |
| `eden_list_incidents` | RCA routes |
| `eden_run_eval` | Cat 3 eval run |

**CLI (`sdk/cli/` or extend existing):**

```bash
eden debug session start --project $PROJECT
eden debug session run -- cmd "python agent.py"  # sets EDEN_DEBUG=1
eden debug trace show $TRACE_ID
eden debug rerun --trace $ID --from-step 12 --prompt-file prompt.txt --mode cached_live
eden debug sql "SELECT count(*) FROM spans WHERE ..."
```

**Skill file:** `.cursor/skills/eden-debug/SKILL.md` + `CLAUDE.md` snippet — documents env vars `EDEN_DEBUG=1`, `EDEN_DEBUG_CACHE_UNTIL=12`.

### Implementation steps

1. Create `src/eden/mcp_server/server.py` using `mcp` Python SDK
2. Auth: project API key in `Authorization: Bearer`
3. Wire 8 tools to internal route handlers (no HTTP roundtrip in monolith)
4. Add `eden-cli debug` Click group
5. Write session file `.eden/debug-session.json` (Laminar parity)
6. Publish skill to `docs/docs/how-to/coding-agent-debug-loop.md`

### Acceptance criteria

- [ ] Claude Code can list traces and trigger cached_live rerun via MCP only
- [ ] CLI `eden debug rerun` returns JSON diff on stdout
- [ ] Documented in README quickstart

---

## Gap 1.3 — Per-Trace Signals (Investigation Agent) {#gap-13}

**Severity:** 🔴 | **Effort:** XL

### Target

Replace metric-only Phase Q with **Laminar-style Signals**: NL prompt + JSON schema → per-trace investigation agent → `signal_events`.

### Current state

- `src/eden/services/cat2_intel/signals.py` — regex → 8 metrics
- `nl_signals` table — no `signal_events`
- No trace compression pipeline

### Data model — Migration `075_signal_events.sql`

```sql
CREATE TABLE signal_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    output_schema JSONB NOT NULL,
    trigger_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
    mode TEXT NOT NULL DEFAULT 'realtime' CHECK (mode IN ('realtime','backfill','both')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE signal_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
    summary TEXT NOT NULL,
    payload JSONB NOT NULL,
    span_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE signal_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL,
    parent_id UUID REFERENCES signal_clusters(id),
    name TEXT NOT NULL,
    level INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','reopened')),
    event_count INT NOT NULL DEFAULT 0,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ
);

CREATE INDEX idx_signal_events_trace ON signal_events (trace_id);
CREATE INDEX idx_signal_events_signal ON signal_events (signal_id, created_at DESC);
```

### Core services

**`src/eden/signals/compressor.py`**

- Input: list of spans for trace
- Output: compact transcript string (~10% tokens)
- Rules: dedupe system prompts, drop framework plumbing spans (`isInternalFrameworkSpan` parity), keep LLM + TOOL spans, attach `[ref:span_id]` markers

**`src/eden/signals/investigator.py`**

- ReAct agent with tools: `search_span_content`, `fetch_span_full`, `submit_findings`
- Model: org-configured SLM (judge-v2 Qwen 4B) with GPT-4o fallback
- Max steps: 8, timeout: 30s per trace

**`src/eden/signals/worker.py`**

- Consumer: Redis stream `trace.finalized`
- For each enabled signal matching trigger_filter → run investigator → insert signal_events → enqueue clustering

**`src/eden/signals/clusterer.py`**

- Embed event summaries (BGE-small)
- Hierarchical clustering (agglomerative, max depth 3)
- LLM naming bottom-up
- Resolve/reopen: if 0 events in 7d → resolved; new event → reopened

### API

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/signal-definitions` |
| `POST` | `/orgs/{org_id}/signal-definitions/{id}/backfill` `{since, until}` |
| `GET` | `/orgs/{org_id}/signal-events` |
| `GET` | `/orgs/{org_id}/signal-clusters` |
| `POST` | `/orgs/{org_id}/signal-clusters/{id}/resolve` |

**Migration path:** Keep Phase Q `nl_signals` for metric alerts; new UI tab "Trace Signals" for v2.

### Acceptance criteria

- [ ] Signal "agent stuck in retry loop" fires on synthetic loop trace with ≥1 event
- [ ] Backfill 1000 traces completes <30 min with 4 workers
- [ ] Cluster tree visible in portal with resolve/reopen
- [ ] SQL: `SELECT * FROM signal_events WHERE payload->>'tool_name' = 'bash'`

---

## Gap 1.4 — Browser Session Recording (RRWeb Sync) {#gap-14}

**Severity:** 🔴 | **Effort:** L

### Current state

- Backend only: `src/eden/replay/events.py` (in-memory `SessionRecorder`)
- Computer-use screenshots: `observability_computer_use.py` (shipped)
- No RRWeb client, no routes

### Target

Browser agents record DOM sessions synced to trace timeline (Laminar shared trace parity).

### Implementation

**JS package:** `sdk/browser-recorder/` 

```typescript
import { record } from '@eden-ai/browser-recorder';
record({ traceId, apiUrl, orgId, apiKey, onEvent: batchUpload });
```

Uses `rrweb` → maps to Eden `SessionEvent` types (`dom_mutation`, `user_input`, `navigation`, `console`).

**Backend routes** (Phase O.5):

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/browser-sessions` |
| `POST` | `/orgs/{org_id}/browser-sessions/{id}/events` (batch) |
| `GET` | `/orgs/{org_id}/browser-sessions/{id}` |
| `GET` | `/orgs/{org_id}/browser-sessions/by-trace/{trace_id}` |

**Migration `076_browser_sessions.sql`:**

```sql
CREATE TABLE browser_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    viewport JSONB,
    UNIQUE (org_id, trace_id)
);

CREATE TABLE browser_session_events (
    id TEXT PRIMARY KEY,  -- content hash
    session_id UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    sequence INT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    timestamp_ms BIGINT NOT NULL
);
```

**Portal:** `BrowserReplayPanel.tsx` — rrweb Replayer in sandboxed iframe; scrubber synced to trace step via `timestamp_ms`.

**PII:** Wire `MultiLangPIIMasker` in ingest path (replace regex-only v1).

### Acceptance criteria

- [ ] Stagehand/Browser Use trace shows side-by-side transcript + browser replay
- [ ] RTBF tombstone deletes session events for trace

---

## Gap 1.5 — Platform UI + Local Dev Server {#gap-15}

**Severity:** 🟠 | **Effort:** L

### Target

`eden debug serve` starts local proxy on `:9477` that:
- Sets trace context headers
- Streams spans to Eden cloud (or local Postgres in dev)
- Opens portal deep link on run complete

Optional: portal "Run agent" form that SSH-execs via Runloop integration (future).

### Implementation

1. `src/eden/debugger/local_server.py` — FastAPI minimal proxy wrapping user command
2. Env: `EDEN_DEBUG=1`, `EDEN_DEBUG_SESSION=<uuid>`
3. Portal page `/debugger/sessions/{id}` — live run list (WebSocket)

### Acceptance criteria

- [ ] `eden debug serve -- python agent.py` creates trace visible in portal <5s

---

## Gap 1.6 — Trace Compression + Search Performance {#gap-16}

**Severity:** 🟠 | **Effort:** XL

### Target

Content-addressed dedupe store for repeated span payloads → ~5–20× storage reduction.

### Architecture

**`src/eden/observability/compression/blob_store.py`**

- On ingest: SHA-256 of `input`/`output` JSON
- Store once in `span_content_blobs(hash, content)`
- Span row stores `input_ref`, `output_ref` hashes only

**Typesense:** Finish Phase B in `observability.py` — index denormalized transcript field.

**Optional phase 2:** Evaluate Rust sidecar for ingest (only if >1M spans/day per org).

### Acceptance criteria

- [ ] Duplicate system prompts stored once per org
- [ ] Full-text search p95 <200ms on 10M spans (Typesense)

---

## Gap 1.7 — Browser/Computer-Use Framework Integrations {#gap-17}

**Severity:** 🟠 | **Effort:** M

### Target integrations (priority order)

1. Browser Use — `@eden.trace_agent` wrapper + docs
2. Stagehand — TS SDK middleware
3. Playwright — CDP hook → computer_use steps
4. OpenHands — span attributes for sandbox/file tools
5. Pydantic AI, Mastra — Python/TS one-liner

### Implementation per integration

Template: `docs/docs/integrations/{name}.md` + `sdk/python/eden/integrations/{name}.py`

```python
# browser_use example
from eden.integrations.browser_use import instrument_browser_use
instrument_browser_use()  # patches BrowserSession → emits computer_use spans
```

Register in `src/eden/observability/ingestion/framework.py` decoder list.

### Acceptance criteria

- [ ] Each integration: 1 doc page + 1 integration test with recorded trace fixture

---

## Gap 1.8 — Sessions Multi-Turn Timeline {#gap-18}

**Severity:** 🟡 | **Effort:** M

### Target

Portal `/sessions/{session_id}` shows cards `1/N` with input/output preview per trace.

### Data model

Use existing `session_id` on trace metadata (OTel attribute). Add materialized view:

```sql
CREATE MATERIALIZED VIEW session_trace_timeline AS
SELECT org_id, attributes->>'session_id' AS session_id,
       trace_id, started_at,
       first_value(input) AS preview_input,
       last_value(output) AS preview_output
FROM telemetry_events
WHERE attributes->>'session_id' IS NOT NULL
GROUP BY org_id, session_id, trace_id, started_at;
```

Portal: horizontal card scroller.

---

## Gap 1.9 — Custom Render Templates + Labeling UI {#gap-19}

**Severity:** 🟡 | **Effort:** M

### Target

Org-defined Jinja2/HTML templates for trace span rendering in labeling queue.

### Implementation

- Table `render_templates(org_id, name, template_html, span_filter_jsonb)`
- Portal labeling queue: dropdown template selector
- Sandboxed render via `iframe` + DOMPurify

---

## Gap 1.10 — LangGraph Visualization {#gap-110}

**Severity:** 🟡 | **Effort:** S

### Target

Detect LangGraph spans (`langgraph.node`, `langgraph.edge`) and render native graph view.

### Implementation

- Extend `TranscriptView` or add `LangGraphView.tsx`
- Parse span attributes `langgraph.node.name`, edges from parent links
- Reuse Cytoscape from trace replay workflow graph

### Acceptance criteria

- [ ] LangGraph example trace renders node graph matching execution order
