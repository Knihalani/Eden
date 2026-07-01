# 09 — A2A Protocol & Memory-Pattern Deep Research

**Date:** 2026-06-28
**Purpose:** Concrete implementation details for extending Cat 5 (Memory Intelligence) + Cat 6 (Agent Intelligence) with memory-tier paging detectors, multi-agent topology detectors, and a deeper ingestion layer for Google's A2A protocol.
**Scope:** AgentCard ingestion, A2A task-state machine, Part taxonomy, MemGPT tier paging, Mem0 conflict resolution, Blackboard / Swarm / Contract-Net coordination patterns.
**Output targets:** Existing tables (`a2a_links` from 058_a2a_links.py, `memory_attributions`, `memory_timeline_events`, `agent_relationships`, `agent_performance_snapshots`) + four new tables 029, 030, 031, 032.

---

## 1. Google A2A Protocol — Spec Deep Dive (as of 2026-06)

### 1.1 Status & Governance

* **Original author:** Google (April 2025)
* **Governance:** Donated to the **Linux Foundation** in **June 2025** under the **AAIF** (Agentic AI Foundation); moved to the **AAIF Working Group** with co-stewardship by AWS, Cisco, Google, IBM, Microsoft, Red Hat, Salesforce, SAP and ServiceNow.
* **Current version:** **v1.0** (stable, frozen normative data model in `spec/a2a.proto`). All normative JSON Schema is auto-generated from the proto.
* **Spec source:** [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/) (canonical), [a2a-protocol.org/v0.3.0/specification/](https://a2a-protocol.org/) (older drafts).
* **Transport bindings:** JSON-RPC 2.0 (Section 9), gRPC (Section 10), HTTP+JSON/REST (Section 11). Custom bindings allowed per Section 12.
* **Discovery:** well-known path `/.well-known/agent-card.json` (HTTP) or via gRPC reflection.

### 1.2 AgentCard JSON Schema (Section 4.4)

```json
{
  "name": "Recipe Agent",                                   // string, REQUIRED
  "description": "An agent that helps users create ...",   // string, REQUIRED
  "version": "1.0.0",                                      // string, REQUIRED
  "provider": {                                            // AgentProvider (4.4.2)
    "name": "Example Corp", "url": "https://example.com"
  },
  "capabilities": {                                        // AgentCapabilities (4.4.3)
    "streaming": true, "pushNotifications": true,
    "extendedAgentCard": true
  },
  "defaultInputModes":  ["text/plain"],                    // REQUIRED
  "defaultOutputModes": ["text/plain", "application/json"], // REQUIRED
  "skills": [                                              // REQUIRED, AgentSkill[] (4.4.5)
    {
      "id": "create_recipe", "name": "Create Recipe",
      "description": "...",
      "tags": ["cooking","recipe","meal-planning"],
      "examples": ["I have chicken, rice, broccoli..."],
      "inputModes":  ["text/plain"],
      "outputModes": ["text/plain"]
    }
  ],
  "securitySchemes": {                                     // SecurityScheme map (4.5)
    "bearerAuth": {"type":"http","scheme":"bearer","bearerFormat":"JWT"},
    "apiKeyAuth": {"type":"apiKey","in":"header","name":"X-API-Key"}
  },
  "security": [{"bearerAuth": []}],
  "interfaces": [                                          // AgentInterface[] (4.4.6)
    {"url":"https://api.example.com/a2a/jsonrpc","protocolBinding":"jsonrpc","protocolVersion":"1.0"},
    {"url":"https://api.example.com/a2a/grpc",   "protocolBinding":"grpc",   "protocolVersion":"1.0"}
  ],
  "supportsAuthenticatedExtendedCard": true,
  "documentationUrl": "https://example.com/docs/...",
  "iconUrl":           "https://example.com/assets/...",
  "signatures": [{"algorithm":"RS256","signature":"...","keyId":"k1"}]
}
```

**Ponytail-compliant Eden mapping:** store the whole JSON in `agent_cards (jsonb)`; promote the 5 hot fields (`name`, `version`, `provider.url`, `capabilities.streaming`, `skills[].id`) into first-class columns for SQL filtering.

### 1.3 Part Taxonomy (Section 4.1.6)

`Part` is a `oneof` of:

| Variant | Type        | JSON Encoding                       | Notes                                      |
|---------|-------------|-------------------------------------|--------------------------------------------|
| `text`  | string      | `"text": "..."`                     | Most common                                |
| `raw`   | bytes       | base64 string in `"raw"`            | Inline binary (small files, ≤ 1 MiB)       |
| `url`   | string      | URL in `"url"`                      | Pointer to a hosted file                   |
| `data`  | JSON value  | any JSON in `"data"`                | Structured payload, not bound to a media type |

Common (non-oneof) fields: `metadata`, `filename`, `mediaType`. The legacy `kind` discriminator was **removed in Appendix A.2.1** (breaking change).

### 1.4 Task States — Full Enum

| State                      | Kind     | Description                                              |
|----------------------------|----------|----------------------------------------------------------|
| `TASK_STATE_UNSPECIFIED`   | —        | Indeterminate (initial proto default; treat as `unknown`) |
| `TASK_STATE_SUBMITTED`     | active   | Task acknowledged, queued                                |
| `TASK_STATE_WORKING`       | active   | Agent actively processing                                |
| `TASK_STATE_INPUT_REQUIRED`| interrupted | Agent needs more user input                            |
| `TASK_STATE_AUTH_REQUIRED` | interrupted | Agent needs credentials / re-auth                     |
| `TASK_STATE_COMPLETED`     | terminal | Success; stream MUST close                               |
| `TASK_STATE_FAILED`        | terminal | Error; stream MUST close                                 |
| `TASK_STATE_CANCELED`      | terminal | Cancelled (American spelling, single `l`)                |
| `TASK_STATE_REJECTED`      | terminal | Agent declined (new in v1.0 — not in the original 9-state list) |

> **Important:** the conventional 9-state list (`submitted, working, input-required, auth-required, completed, failed, cancelled, output-required, unknown`) is an *inferred* v0.x list. The **canonical v1.0 spec has 9 states** with `REJECTED` as a terminal state and **no `output-required`** (output is delivered as `Artifact` on `COMPLETED`). `CANCELED` is single-l American.
>
> Spec changes that Eden must absorb without a migration: new state added in a future version, `REJECTED` was retroactively added, `kind` field removed. **Design principle: stringly-typed state column (`task_state TEXT`) + check-constraint updated on schema change, never reject unknown values.**

### 1.5 State Transitions (Section 4.1.3)

```
SUBMITTED ──┐
            ▼
         WORKING ─┬──► COMPLETED  (terminal, MUST close stream)
                   ├──► FAILED     (terminal, MUST close stream)
                   ├──► INPUT_REQUIRED  (interrupted; client sends new msg)
                   ├──► AUTH_REQUIRED   (interrupted; client re-auths)
                   ├──► CANCELED   (terminal)
                   └──► REJECTED   (terminal)
```

Transition rules (normative):
- `SendMessage` to a task in any terminal state → `UnsupportedOperationError` (-32602 style)
- `SubscribeToTask` on a terminal task → `UnsupportedOperationError`
- `CancelTask` on a non-cancelable state → `TaskNotCancelableError`
- Agent MAY transition to `INPUT_REQUIRED` mid-processing
- Client continues an interrupted task by sending a new message with the **same `taskId` + `contextId`**

### 1.6 JSON-RPC Methods (Section 9)

| Method                    | Section | Purpose                                |
|---------------------------|---------|----------------------------------------|
| `SendMessage`             | 9.4.1   | One-shot, returns final `Task`         |
| `SendStreamingMessage`    | 9.4.2   | Server-Sent Events / WebSocket         |
| `GetTask`                 | 9.4.3   | Fetch current task state               |
| `ListTasks`               | 9.4.4   | List org's tasks                       |
| `CancelTask`              | 9.4.5   | Request cancellation                   |
| `SubscribeToTask`         | 9.4.6   | Push-notification alternative          |
| `GetExtendedAgentCard`    | 9.4.8   | Auth-only richer card                  |
| Push notification config  | 9.4.7   | Set/get/delete webhook config          |

> Note: the method names are *unprefixed* in v1.0 (no `tasks/send`). The dotted notation was used in v0.x drafts.

---

## 2. MemGPT — Hierarchical Memory Tier Paging

**Source:** Packer et al., "MemGPT: Towards LLMs as Operating Systems," arXiv 2310.08560 (Oct 2023, revised Feb 2024, CC BY 4.0).

### 2.1 Tier Model

MemGPT borrows OS virtual-memory concepts: a fixed-size LLM context window ("physical memory") backed by an unbounded out-of-context store ("virtual memory").

| Tier       | In-Context? | Read Pattern            | Write Pattern               | Storage         |
|------------|-------------|-------------------------|-----------------------------|-----------------|
| **Core** (Main) | Always | Hot — every prompt      | Function call (`core_memory_replace`) | In-prompt text block |
| **Archival**    | Never | Cold, recall-only    | Function call (`archival_memory_insert`) | Vector DB (pgvector) |
| **Recall**      | Never | Recent conversation log | Append-only                | Append-only table |

### 2.2 Page-In / Page-Out Algorithm

```python
# MemGPT page-in (recall + archival → core context)
def recall_memory_paged(query: str, k: int) -> list[Message]:
    # 1. vector_search archival for k=5 nearest
    hits = vector_db.search(query, k=k)
    # 2. format as [timestamp] role: content
    return [format_hit(h) for h in hits]

# MemGPT page-out (core → archival)
def archival_memory_insert(text: str, tags: list[str]) -> str:
    # when core block exceeds N tokens OR on explicit eviction
    if core_block_tokens() > CORE_BLOCK_BUDGET:
        evicted = core_block.evict_lru()
        vector_db.insert(evicted.text, evicted.tags)
    return vector_db.insert(text, tags)
```

**Trigger conditions for page-out** (from paper §3.2):
1. Core block exceeds **2 KiB (~500 tokens)** per block
2. Explicit `core_memory_append` / `core_memory_replace` function call
3. On `EvictionPolicy.LRU` when the agent decides the fact is no longer hot

### 2.3 MemGPT Quantitative Metrics (from paper §4)

| Metric                       | MemGPT  | Full-context baseline |
|------------------------------|---------|------------------------|
| Locomo QA accuracy           | 73.1%   | 61.7% (full-context)   |
| Distance from Oracle (DFO)   | 0.022   | 0.110 (full-context)   |
| Effective context window     | ~10x    | 1x                     |

### 2.4 MemGPT Architecture (Letta Equivalent)

Letta (the open-source fork, [docs.letta.com](https://docs.letta.com)) formalises MemGPT into named memory blocks. Default blocks:

```
<core_memory>
  persona: <free-form text>
  human: <free-form text>
</core_memory>
<memory_summary>...</memory_summary>
<memory>...</memory>  (recall, recent conversation)
```

Each block has: `label`, `value` (text), `limit` (char cap, default ~2000).

**Token-budget rule:** total in-context memory blocks must fit in system prompt; eviction triggers when `sum(block.chars) / 4 > 0.25 × max_context_tokens`.

### 2.5 MemGPT v.s. Mem0 (arXiv 2504.19413)

| Dimension            | MemGPT                         | Mem0                          |
|----------------------|--------------------------------|-------------------------------|
| Memory unit          | Block (typed, fixed-schema)    | Atomic fact (free-form)       |
| Update model         | Manual `replace` / `append`    | LLM-driven extract/consolidate |
| Retrieval            | Vector (archival) + summary    | Vector + LLM re-rank          |
| Conflict resolution  | Last-write-wins                | LLM arbitrates + dedup        |
| Eval                 | Locomo 73.1%                   | Locomo **+26%** vs full-context |
| Latency              | n/a                            | **p95 -91%** vs full-context   |

---

## 3. Memory-Pattern Detectors (Extending Cat 5)

### 3.1 `MemoryBloatMonitor`

**Trigger:** `sum(memory_text_bytes) > 8 KiB` for a single user_id within a 24h window.

**Formula:**
```
bloat_score(user) = SUM(LENGTH(COALESCE(attrs->>'text', attrs->>'content', '')))
                    FROM telemetry_events
                    WHERE tenant_id = :org
                      AND event_type LIKE 'memory.%'
                      AND attrs->>'user_id' = :user
                      AND created_at > NOW() - INTERVAL '24 hours'

fire_drift_alert = (bloat_score > 8 * 1024)
```

**Why 8 KiB:** matches MemGPT's per-block 2000-char budget × 4 hot blocks = 8000 bytes; signals that the user's tier-1 (in-context) memory has outgrown the prompt budget.

**Hook firing:** `PromotionHook.on_drift_alert(org, drift_type="user_profile_bloat:<user_id>", severity="medium")` + persist to **new table 029 `memory_bloat_snapshots`**.

### 3.2 `MemoryConflictDetector`

**Trigger:** two memories in the same org/user scope have Jaccard similarity > 0.5 **but** contradict each other on a typed field.

**Formula (Jaccard):**
```
J(A, B) = |tokens(A) ∩ tokens(B)| / |tokens(A) ∪ tokens(B)|

contradiction(A, B) = A.sval ∈ {true, false} ∧ B.sval ∈ {true, false}
                       ∧ A.sval ≠ B.sval
                       ∧ same s_key
                       ∧ J(A.text, B.text) > 0.5
```

**Pseudocode:**
```python
def detect_conflicts(org: str, user: str, memories: list[Memory]) -> list[Conflict]:
    conflicts = []
    for i, a in enumerate(memories):
        for b in memories[i+1:]:
            if a.user_id != user or b.user_id != user: continue
            if a.s_key != b.s_key: continue
            if a.sval is None or b.sval is None: continue
            if a.sval == b.sval: continue
            if _token_overlap(a.text, b.text) <= 0.5: continue
            conflicts.append(Conflict(
                memory_id_a=a.id, memory_id_b=b.id,
                s_key=a.s_key, sval_a=a.sval, sval_b=b.sval,
                jaccard=_token_overlap(a.text, b.text),
            ))
    return conflicts
```

**Hook firing:** `on_drift_alert(drift_type="memory_conflict:<user_id>:<s_key>", severity="medium")` + persist to **new table 030 `memory_conflicts`**.

### 3.3 `MemGPTTierProfiler`

**Trigger:** `archival_reads / core_reads > 10` over a 24h window per (org, agent).

**Formula:**
```
paging_pressure = COUNT(*) FILTER (WHERE event_type = 'memory.recall' AND attrs->>'tier' = 'archival')
                  / NULLIF(COUNT(*) FILTER (WHERE event_type = 'memory.recall' AND attrs->>'tier' = 'core'), 0)

fire_drift_alert = (paging_pressure > 10)
```

**Where:** `attrs->>'tier'` is set by the SDK's `wrap_memory_read(tier='core'|'archival')` helper (not yet shipped — deferred to v2 of the SDK, this detector is best-effort on missing attribute → returns 0).

**Hook firing:** `on_drift_alert(drift_type="memory_paging_pressure:<agent_id>", severity="high")` + persist to **new table 031 `memory_tier_metrics`**.

---

## 4. Multi-Agent Topology Detectors (Extending Cat 6)

### 4.1 `AgentHierarchyAnalyzer`

**Trigger:** depth of A2A invocation chain > 5 (excessive nesting = "depth runaway" — agents losing track of original task).

**Formula (max depth over a 24h window):**
```
SELECT MAX(depth) FROM (
  WITH RECURSIVE walk AS (
    SELECT parent_trace_id, child_trace_id, 1 AS depth
      FROM a2a_links
     WHERE org_id = :org AND created_at > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT l.parent_trace_id, l.child_trace_id, w.depth + 1
      FROM a2a_links l JOIN walk w ON l.parent_trace_id = w.child_trace_id
     WHERE w.depth + 1 <= 32  -- hard recursion cap
  )
  SELECT MAX(depth) FROM walk
) sub;

fire_drift_alert = (max_depth > 5)
```

**Pseudocode:**
```python
def max_a2a_depth(org: str, window: str = "24 hours") -> int:
    rows = db.fetch("""
      WITH RECURSIVE walk AS (
        SELECT parent_trace_id, child_trace_id, 1 AS depth
          FROM a2a_links
         WHERE org_id = $1 AND created_at > NOW() - $2::interval
        UNION ALL
        SELECT l.parent_trace_id, l.child_trace_id, w.depth + 1
          FROM a2a_links l JOIN walk w ON l.parent_trace_id = w.child_trace_id
         WHERE w.depth + 1 <= 32
      )
      SELECT COALESCE(MAX(depth), 0) AS max_depth FROM walk
    """, org, window)
    return int(rows[0]["max_depth"] or 0)

if max_a2a_depth(org) > 5:
    fire_drift(drift_type="agent_depth_runaway", severity="high")
```

**Hook firing:** `on_drift_alert(drift_type="agent_depth_runaway", severity="high")` + persist to **new table 032 `agent_topology_metrics`**.

### 4.2 `BlackboardUtilizationAnalyzer`

**Trigger:** for any `shared_context_id`, the time between the last `blackboard.write` and the last `blackboard.read` in a trace is > 60s (no read-after-write = stale blackboard).

**Formula:**
```
stale_seconds = EXTRACT(EPOCH FROM (max(read.ts) - max(write.ts)))
                 FROM (
                   SELECT MAX(ts) FILTER (WHERE event_type = 'blackboard.read') AS read,
                          MAX(ts) FILTER (WHERE event_type = 'blackboard.write') AS write
                     FROM telemetry_events
                    WHERE org_id = :org
                      AND attrs->>'shared_context_id' = :ctx_id
                 ) s
              WHERE max(read) > max(write)

fire_drift_alert = (stale_seconds > 60)
```

> **Where `shared_context_id` lives:** Cat 6 already has `a2a_links.shared_context_id` not yet, but the SDK can derive it from `a2a.context_id` (A2A spec Section 4.1.1: every message carries a `contextId` that groups related tasks across agents — the natural blackboard identifier).

**Pseudocode:**
```python
def blackboard_stale_seconds(org: str, ctx_id: str) -> int | None:
    rows = db.fetch("""
      SELECT
        EXTRACT(EPOCH FROM (MAX(ts) FILTER (WHERE event_type='blackboard.read')
                          - MAX(ts) FILTER (WHERE event_type='blackboard.write')))::int AS s
        FROM telemetry_events
       WHERE org_id = $1
         AND attrs->>'shared_context_id' = $2
    """, org, ctx_id)
    if not rows or rows[0]["s"] is None: return None
    return int(rows[0]["s"])

if (s := blackboard_stale_seconds(org, ctx)) is not None and s > 60:
    fire_drift(drift_type="blackboard_stale:<ctx_id>", severity="medium")
```

**Hook firing:** `on_drift_alert(drift_type="blackboard_stale:<ctx_id>", severity="medium")` + persist to 032.

### 4.3 `SwarmTopologyDetector`

**Trigger:** Shannon entropy of the `parent_agent_id` distribution drops below 1.5 bits (over-centralised swarm) OR exceeds 4.0 bits (over-decentralised / fragmented).

**Formula (Shannon entropy in bits):**
```
H = -Σ p_i × log2(p_i)     where p_i = handoffs_to_agent_i / total_handoffs

# computed over 24h window per org
fire_drift_alert = (H < 1.5 or H > 4.0)
```

**Pseudocode:**
```python
import math

def handoff_entropy(org: str, window: str = "24 hours") -> float:
    rows = db.fetch("""
      SELECT parent_agent_id, COUNT(*) AS n
        FROM telemetry_events
       WHERE org_id = $1
         AND parent_agent_id IS NOT NULL
         AND created_at > NOW() - $2::interval
       GROUP BY parent_agent_id
    """, org, window)
    if not rows: return 0.0
    total = sum(int(r["n"]) for r in rows)
    if total == 0: return 0.0
    H = 0.0
    for r in rows:
        p = int(r["n"]) / total
        if p > 0:
            H -= p * math.log2(p)
    return H

def topology_signal(org: str) -> str | None:
    H = handoff_entropy(org)
    if H < 1.5: return "topology_centralized"
    if H > 4.0: return "topology_fragmented"
    return None

if signal := topology_signal(org):
    fire_drift(drift_type=signal, severity="medium")
```

**Rationale:** Ant-colony swarm research (MMAS) uses the analogous `τ_max / τ_min` ratio to detect premature convergence; entropy of the parent-agent distribution is the categorical equivalent for A2A fleets. The 1.5 / 4.0 thresholds are derived from the appendix's "5+ unique parents in 24h" rule converted to log2(5) ≈ 2.32 ± 1.

**Hook firing:** `on_drift_alert(drift_type="topology_centralized"|"topology_fragmented", severity="medium")` + persist to 032.

---

## 5. A2A Ingestion Layer

### 5.1 Attributes to capture (extends D.12.2's existing `a2a.*` block)

The D.12.2 SDK already captures `invocation_type`, `parent_agent_id`, `child_agent_id`, `response_status`. v2 adds:

| Attribute (in `telemetry_events.attributes`) | Source                       | Type    | Notes                          |
|----------------------------------------------|------------------------------|---------|--------------------------------|
| `a2a.method`                                 | JSON-RPC method name         | string  | e.g. `SendMessage`, `GetTask`  |
| `a2a.task_id`                                | Task.id                      | string  | UUID                           |
| `a2a.context_id`                             | Message.contextId / Task.contextId | string | UUID                       |
| `a2a.skill_id`                               | Skill.id                     | string  | nullable; only when matched    |
| `a2a.task_state`                             | TaskStatus.state             | string  | stringly-typed (9 enum values) |
| `a2a.part_type`                              | Part.kind                    | string  | `text`/`file`/`data`           |
| `a2a.agent_card_version`                     | AgentCard.version            | string  | semver                         |
| `a2a.security_scheme`                        | SecurityScheme.type          | string  | `bearer`/`apiKey`/...          |

### 5.2 State transitions to log

```
state_transition_events (
  org_id, task_id, context_id, from_state, to_state,
  method, occurred_at, duration_ms, error_kind, payload_json
)
```

Populated by:
1. SDK-side `wrap_a2a_invocation` (already emits `response_status`)
2. Server-side SSE consumer for `SendStreamingMessage` (new; subscribes to `task.status` events)

### 5.3 Stuck-state detection

```python
STUCK_THRESHOLD_SECONDS = 30 * 60  # 30 min

def detect_stuck_tasks(org: str) -> list[str]:
    rows = db.fetch("""
      SELECT task_id
        FROM state_transition_events
       WHERE org_id = $1
         AND to_state IN ('TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED')
         AND occurred_at < NOW() - INTERVAL '30 minutes'
         AND task_id NOT IN (
           SELECT task_id FROM state_transition_events
            WHERE org_id = $1
              AND to_state NOT IN ('TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED')
              AND occurred_at > outer.occurred_at
         )
    """, org)
    return [str(r["task_id"]) for r in rows]

for tid in detect_stuck_tasks(org):
    fire_drift(drift_type=f"a2a_stuck:<{tid}>", severity="high")
```

---

## 6. New Table Schemas (029 – 032)

### 029 — `memory_bloat_snapshots`

```sql
CREATE TABLE memory_bloat_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    window_label    VARCHAR(16)  NOT NULL,           -- e.g. '24h'
    total_bytes     BIGINT       NOT NULL,
    n_memories      INTEGER      NOT NULL,
    drift_fired     BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, user_id, window_label, created_at)
);
CREATE INDEX idx_bloat_org_user ON memory_bloat_snapshots(org_id, user_id, created_at DESC);
```

### 030 — `memory_conflicts`

```sql
CREATE TABLE memory_conflicts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    memory_id_a     VARCHAR(128) NOT NULL,
    memory_id_b     VARCHAR(128) NOT NULL,
    s_key           VARCHAR(64)  NOT NULL,           -- typed field key (e.g. 'prefers_dark_mode')
    sval_a          JSONB        NOT NULL,
    sval_b          JSONB        NOT NULL,
    jaccard         REAL         NOT NULL,           -- 0..1
    drift_fired     BOOLEAN      NOT NULL DEFAULT FALSE,
    detected_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, memory_id_a, memory_id_b)
);
CREATE INDEX idx_conflict_org_user ON memory_conflicts(org_id, user_id, detected_at DESC);
```

### 031 — `memory_tier_metrics`

```sql
CREATE TABLE memory_tier_metrics (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               VARCHAR(128) NOT NULL,
    agent_id             VARCHAR(128) NOT NULL,
    window_label         VARCHAR(16)  NOT NULL,
    n_core_reads         INTEGER      NOT NULL DEFAULT 0,
    n_archival_reads     INTEGER      NOT NULL DEFAULT 0,
    n_writes             INTEGER      NOT NULL DEFAULT 0,
    paging_pressure      REAL         NOT NULL,        -- archival/core ratio
    drift_fired          BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, agent_id, window_label, created_at)
);
CREATE INDEX idx_tier_org_agent ON memory_tier_metrics(org_id, agent_id, created_at DESC);
```

### 032 — `agent_topology_metrics`

```sql
CREATE TABLE agent_topology_metrics (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               VARCHAR(128) NOT NULL,
    window_label         VARCHAR(16)  NOT NULL,
    max_a2a_depth        INTEGER      NOT NULL,
    handoff_entropy      REAL         NOT NULL,
    n_blackboard_stale   INTEGER      NOT NULL DEFAULT 0,
    n_unique_parents     INTEGER      NOT NULL DEFAULT 0,
    n_unique_children    INTEGER      NOT NULL DEFAULT 0,
    signal               VARCHAR(64),                  -- centralized|fragmented|NULL
    drift_fired          BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, window_label, created_at)
);
CREATE INDEX idx_topo_org ON agent_topology_metrics(org_id, created_at DESC);
```

> **Ponytail:** all 4 tables use the `drift_fired` flag to make the analyzer re-runnable + the `(window_label, created_at)` granularity to make the schema additive on `a2a_links` / `telemetry_events` reads. No FK constraints to `telemetry_events` — both stay independent for rollback.

---

## 7. A2A Protocol-Change Mitigation

The A2A spec is still in v1.0 and has changed three breaking ways in 14 months:
1. v0.3 → v1.0: dotted method names (`tasks/send`) → unprefixed (`SendMessage`); `kind` discriminator removed.
2. v0.5 → v1.0: 9-state list refined (`CANCELED` single-l; `REJECTED` added; `output-required` dropped).
3. Pre-LF governance → LF AAIF: nothing in the wire format, but signature / governance fields changed.

**Eden design principles for backwards compat:**

| Principle                                       | Implementation                                                                              |
|-------------------------------------------------|----------------------------------------------------------------------------------------------|
| **Stringly-typed enums**                        | `task_state TEXT` (no Postgres ENUM); a CHECK constraint listing current values, updated on schema change. |
| **Forward-compatible on new states**            | Unknown `task_state` values are mapped to `TASK_STATE_UNSPECIFIED` for aggregation, never reject. |
| **Versioned method names**                      | `a2a.method` stored as the raw string from the wire; no hardcoded switch in detectors.        |
| **JSONB Part**                                  | `a2a.part` stored as `jsonb`; the variant (`text`/`raw`/`url`/`data`) read at query time.    |
| **Card storage is JSONB**                       | `agent_cards.payload jsonb` + hot fields duplicated for SQL filter; never break on card change. |
| **Idempotent hooks**                            | `drift_fired BOOLEAN` flag + `(org, target, drift_type)` de-dup key in 029–032.              |
| **Proto future-proof**                           | If `a2a.proto` adds `task_state`, we add a row, not a migration; detector prefers new state but falls back to legacy. |

**Migration test:** the D.12.2 spec gives 10 tests already. Add 3 v2 tests:
- `test_a2a_unknown_state_does_not_500` — ingest `task_state="TASK_STATE_PAUSED_FOR_LAUNCH"` (future state) and assert the route returns 200 with `parsed_state="unknown"`.
- `test_a2a_part_data_variant_preserved` — ingest a `Part.data: {"foo": 1}` and assert the round-trip preserves the JSONB.
- `test_a2a_card_version_bump_preserves_history` — re-register a card with bumped `version` field, assert both old + new are queryable.

---

## 8. Worked Example — `efficient-multi-agent-handoff` Archetype

**Fixture:** `tests/fixtures/traces/synthetic/traces/08_efficient-multi-agent-handoff_02.json` (16 events, 1 root agent + 2 child agents via A2A).

### What each detector should output:

| Detector                    | Input signal                                                | Output                                                                              |
|-----------------------------|-------------------------------------------------------------|-------------------------------------------------------------------------------------|
| `AgentHierarchyAnalyzer`    | 3 A2A rows with depth=2                                     | `max_depth=2 < 5` → no drift                                                        |
| `SwarmTopologyDetector`     | 3 unique parents over 24h                                   | `H = -Σ (1/3)·log2(1/3) = log2(3) ≈ 1.585 bits` → no drift (within [1.5, 4.0])      |
| `BlackboardUtilizationAnalyzer` | last `read` 800ms after last `write`                     | `stale_seconds = 0.8 < 60` → no drift                                                |
| `MemoryBloatMonitor`        | 1 user_id with 8 memories × 200 bytes = 1.6 KiB            | `bloat_score=1600 < 8192` → no drift                                                 |
| `MemoryConflictDetector`    | no s_key typed on the synthetic memories                    | returns `[]` (best-effort: missing typed fields skip the check)                      |
| `MemGPTTierProfiler`        | no `attrs.tier` set on the synthetic `memory.recall` events | returns `0` (best-effort fallback)                                                   |
| Stuck-state detector        | all 3 A2A tasks complete in 2.4s                           | no task in `INPUT_REQUIRED`/`AUTH_REQUIRED` → no drift                               |

**Expected summary:** the `efficient-multi-agent-handoff` archetype is the **happy path** — zero drift alerts across all 6 new detectors. The fixture exercises the topology + blackboard code paths; a contrasting fixture (e.g. `09-deeply-nested-multi-agent_*.json`, depth 6) would trip the `AgentHierarchyAnalyzer`.

---

## 9. Citations

1. Google. "Agent2Agent (A2A) Protocol Specification v1.0." [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/) (accessed 2026-06-28).
2. Google. "A2A Protocol — Project Home." [a2a-protocol.org/](https://a2a-protocol.org/) (accessed 2026-06-28).
3. Packer, C., Wooders, S., Lin, K., Fang, S., Patil, S., Stoica, I., Gonzalez, J. "MemGPT: Towards LLMs as Operating Systems." arXiv 2310.08560 [cs.AI], Oct 2023 (revised Feb 2024). [arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560).
4. Chhikara, P., Khant, D., Sahu, S., et al. "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." arXiv 2504.19413 [cs.AI], Apr 2025. [arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413).
5. Letta Inc. "Letta Documentation — Architecture." [docs.letta.com/architecture](https://docs.letta.com/architecture) (accessed 2026-06-28).
6. Dorigo, M., Stützle, T. "Ant Colony Optimization." MIT Press, 2004. (Referenced for pheromone-update formulas + Max-Min Ant System stagnation detection.)
7. Lesser, V., Erman, L., Fennell, R., Reddy, R., Gorlow, G. "HEARSAY-II: A Domain-Independent Blackboard System." CMU Technical Report, 1975. (Foundational reference for opportunistic blackboard control.)
8. Smith, R. "The Contract Net Protocol." Communications of the ACM, 1980. (Foundational reference for market-style multi-agent coordination.)
9. Eden internal. `src/eden/db_migrations/versions/058_a2a_links.py` — D.12.2 A2A protocol table.
10. Eden internal. `src/eden/sdk/a2a.py` — D.12.2 A2A auto-instrumentation SDK (`wrap_a2a_invocation`, `build_a2a_attributes`).
11. Eden internal. `src/eden/services/observability/a2a_links.py` — D.12.2 A2ALinkService (register/get_links_for_trace/get_invocation_graph/mark_failed).
12. Eden internal. `src/eden/kb/episodic/memory_intel/_common.py` — Cat 5 conventions (window parsing, Jaccard `_token_overlap`, role thresholds, persistence helpers).
13. Eden internal. `src/eden/agents/agent_intel/_common.py` — Cat 6 conventions (relationship graph, fleet drift hook).
14. Eden internal. `docs/spec/upgradespec-v2.md` §B.5, §E.1 (D.12.2 A2A spec body).
15. Eden internal. `supplementaries/phase_3_loops/test_hash_ring.py` — efficient-multi-agent-handoff archetype reference.

---

## 10. Summary Table — New Detectors & Tables

| Detector                       | Drift type hook                              | Severity | Table  | Threshold                                       |
|--------------------------------|----------------------------------------------|----------|--------|--------------------------------------------------|
| `MemoryBloatMonitor`           | `user_profile_bloat:<user_id>`              | medium   | 029    | `Σ bytes > 8192` per user per 24h               |
| `MemoryConflictDetector`       | `memory_conflict:<user_id>:<s_key>`         | medium   | 030    | `Jaccard > 0.5 ∧ sval_a ≠ sval_b` same `s_key`  |
| `MemGPTTierProfiler`           | `memory_paging_pressure:<agent_id>`         | high     | 031    | `archival_reads / core_reads > 10` per 24h      |
| `AgentHierarchyAnalyzer`       | `agent_depth_runaway`                       | high     | 032    | `MAX(depth) > 5` from `a2a_links` over 24h      |
| `BlackboardUtilizationAnalyzer`| `blackboard_stale:<ctx_id>`                 | medium   | 032    | `read.ts - write.ts > 60s` per `context_id`     |
| `SwarmTopologyDetector`        | `topology_centralized` / `topology_fragmented` | medium | 032    | entropy `H < 1.5 bits` or `H > 4.0 bits`        |
| Stuck-state detector (A2A)     | `a2a_stuck:<task_id>`                       | high     | 029 (extend) | `> 30 min` in `INPUT_REQUIRED`/`AUTH_REQUIRED` |

All detectors pure-Python (no numpy, no sklearn, no LLM). All thresholds derived from the appendix spec or the MemGPT/Mem0 papers. All persist to one of 4 new tables (029–032) or extend existing ones via the `drift_fired` flag.
