---
title: "06 — Agent Intelligence (Cat 6, incl. Fleet)"
status: ✅ IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.2
---

# 06 — Agent Intelligence (Cat 6, incl. Fleet)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11).
> The 5 services (`AgentPerformanceScorer`,
> `AgentRelationshipGraph`, `HandoffAnalyzer`,
> `AgentBenchmarkRunner`, `AgentFleetService`) are
> real implementations in
> `src/eden/agents/agent_intel/performance.py`, backed by
> the 5 Cat 6 tables (`agent_performance_snapshots`,
> `agent_relationships`, `agent_benchmark_runs`,
> `agent_fleet_identities`, `agent_fleet_permissions`)
> already migrated in 020. Includes the **Agent Fleet**
> sub-feature (LangSmith Fleet parity for agent identity,
> permissions, dedicated Slack identities) and the
> closed-loop `PromotionHook.on_drift_alert(
> drift_type="fleet_deprecation:<agent_id>",
> severity="medium")` hook that fires on identity
> re-registration (matches the Cat 2 RCA + Cat 8 cost
> anomaly pattern). 89% of organisations have
> observability in place but most lack centralised
> governance for their agent portfolios (per LangChain's
> 2026 State of Agent Engineering report) — this cat is
> the **governance** answer to the multi-agent era.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

Multi-agent architectures are the default for production
LLM apps in 2026. Cat 6 is the **agent portfolio**
view: per-agent performance scoring, handoff analysis,
benchmarking, and the Fleet identity / permissions /
inbox governance surface.

The user story (the **platform team** conversation):

> "We have 12 agents in production. Agent A is the slow
> one. Agent B's handoffs to Agent C have a 3× higher
> error rate than the median. Agent D was deprecated 3
> months ago but is still being invoked by Agent E. We
> need a Fleet inventory of every agent, every permission,
> every credential, and a central inbox for human-in-the-
> loop approvals."

## Source articles & research

* **Article 1 §6**: "Agent Explorer (browse/search/filter
  by owner/deployment/SLA), Agent Handoff (visualise
  between agents), Agent Health (latency/success/cost
  trends), Agent Comparison (which agent is best for
  task X)."
* **Article 2 (LangSmith)**: "Fleet for agent identity,
  permissions, dedicated Slack identities."
* **LangSmith Fleet blog (Mar 2026)**: per the announcement,
  Fleet ships 6 primitives — credentials, permissions,
  agent identity, sharing, Inbox (human-in-the-loop),
  observability. The blog explicitly cites the LangChain
  State of Agent Engineering report: "89% of
  organizations have observability in place, but most
  lack centralized governance for their agent portfolios."
* **LangGraph overview (2026)**: durable execution,
  streaming, human-in-the-loop, persistence, multi-agent
  state. Eden Cat 6 surfaces the LangGraph state
  via the `AgentPerformanceScorer` and `HandoffAnalyzer`.

## What's already in Eden

* `src/eden/agents/agent_intel/performance.py` — the 5
  real v1 services:
  * `AgentPerformanceScorer.score` — per-agent
    success / cost / latency / judge average over a time
    window. Reads `telemetry_events` + `usage_events` +
    `judge_scores`, persists one row per
    `(org, agent, window)` tuple to
    `agent_performance_snapshots` (delete-then-insert).
  * `AgentRelationshipGraph.build` — the multi-agent
    handoff graph builder. Groups
    `telemetry_events` by `(parent_agent_id, agent_id)`
    and persists one row per pair to
    `agent_relationships` (clear-then-insert).
  * `HandoffAnalyzer.analyze` — bottleneck / error-
    hotspot / drift classifier on the persisted
    relationship graph. The drift signal is a fresh
    7d-vs-previous-7d read from `telemetry_events`; the
    bottleneck and error-hotspot signals are derived from
    the persisted graph.
  * `AgentBenchmarkRunner.run` — deterministic synthetic
    benchmark runner. v0 ships a tiny
    `synthetic_default` suite of 10 tasks; the score is
    a pure function of `(agent_id, dataset_id)` (hash-
    based) so re-runs are idempotent. The real AgentBench
    / SWE-bench / τ-bench / GAIA suites ship in a later
    phase.
  * `AgentFleetService.register_agent_identity` —
    LangSmith-Fleet-style identity registration. Insert
    or update `agent_fleet_identities`. On
    re-registration, fires
    `PromotionHook.on_drift_alert(
    drift_type="fleet_deprecation:<agent_id>",
    severity="medium")` — matches the Cat 2 RCA + Cat 8
    cost anomaly pattern.
  * `AgentFleetService.assign_permissions` — insert one
    `agent_fleet_permissions` row per permission. v0
    supports up to 16 permissions per agent
    (LangSmith-Fleet RBAC parity). Returns a `not_found`
    envelope if the identity isn't registered first.
* `src/eden/agents/agent_intel/_common.py` — the shared
  helper module (envelope shape, window parsing,
  fetchers, persistence, closed-loop hook). Mirrors the
  layout of Cat 4 / Cat 5 / Cat 8.
* `src/eden/agents/agent_intel/__init__.py` — lazy
  re-exports of the 5 service classes.
* `src/eden/api/routes/intelligence_agents.py` — the 6
  live routes. All gated by the `intelligence_gap_v0`
  feature flag and `get_current_user`.
* `src/eden/multi_agent/planning.py` — the multi-agent
  trajectory surface (consumed by `AgentTrajectoryAnalyzer`
  in Cat 16). Provides per-agent event ordering.
* `src/eden/observability/realtime/` (Cat 1) — the
  real-time event stream; the Fleet Inbox subscribes
  to this.
* `org_audit_log` — the substrate for Fleet
  audit-trail.
* The Cat 6 tables (agent_performance_snapshots,
  agent_relationships, agent_benchmark_runs,
  agent_fleet_identities, agent_fleet_permissions) are
  already migrated in 020.

## Ship log (2026-06-11)

The first v1 implementation of Cat 6. 5 service classes
+ 1 shared helper module in
`src/eden/agents/agent_intel/`, reading from
`telemetry_events` + `usage_events` + `judge_scores` and
persisting to the 5 Cat 6 tables in migration 020.

- [x] **Build green:** all 5 services importable from
  `eden.agents.agent_intel` via lazy re-export
  (`AgentPerformanceScorer`, `AgentRelationshipGraph`,
  `HandoffAnalyzer`, `AgentBenchmarkRunner`,
  `AgentFleetService`).
- [x] **6 routes registered:** `GET /performance`,
  `GET /relationships`, `POST /handoffs/analyze`,
  `POST /benchmark/run`, `POST /fleet/identity`,
  `POST /fleet/permissions`. All 6 return the live
  envelope (`status: "ok"`, `live: true`) on success;
  missing data returns the well-formed empty envelope;
  validation failures return `_bad_request_envelope`;
  missing-fleet-identity returns `_not_found_envelope`.
- [x] **Persistence to all 5 Cat 6 tables:**
  `agent_performance_snapshots` (one row per
  `(org, agent, window)` tuple, delete-then-insert),
  `agent_relationships` (one row per
  `(org, parent, child)` pair, clear-then-insert per
  org), `agent_benchmark_runs` (one row per
  `(org, agent, dataset)` tuple, delete-then-insert),
  `agent_fleet_identities` (insert-or-update via Python
  branch), `agent_fleet_permissions` (one row per
  permission, append-only).
- [x] **Handoff analyzer:** the 3 categories from the
  appendix are all wired — ``bottleneck_handoffs`` (high
  volume + low success rate, or volume-only when
  success_rate is missing),
  ``error_hotspots`` (success_rate below
  ``1 - HOTSPOT_ERROR_RATE``), and
  ``drift_indicators`` (current-7d vs. previous-7d drop
  ≥ 10% on baseline ≥ 5 calls).
- [x] **Closed-loop hook fires on identity
  re-registration:** ``PromotionHook.on_drift_alert(
  drift_type="fleet_deprecation:<agent_id>",
  severity="medium")`` fires from
  ``AgentFleetService.register_agent_identity`` when the
  ``_fetch_existing_fleet_identity`` lookup returns a
  row. The hook is the no-op logger in v1; becomes
  actionable in Phase 5 (Cat 17).
- [x] **Determinism:**
  * Benchmark score is a pure function of
    ``(agent_id, dataset_id)`` — re-runs produce the
    same output.
  * Relationship graph nodes are sorted
    (deterministic order across calls).
  * Drift / bottleneck classifications are
    deterministic given the same input.
- [x] **36 new tests pass:** 4 performance + 2
  relationship-graph + 4 handoff-analyzer + 4
  benchmark-runner + 6 fleet-service + 3 package-
  contract + 5 envelope-helpers + 6 route-smoke + 2
  misc. Total: 36 tests, ~1.0s.
- [x] **No regressions in adjacent suites:** full
  ``tests/intelligence/`` = 492 passed (1 pre-existing
  live-tail skip); ``tests/unit/llmops/`` +
  ``tests/unit/observability/`` = 264/264 pass.
- [x] **Migration unchanged:** the 5 Cat 6 tables were
  already in ``020_intelligence_gap_tables.py``; no
  new migration required.
- [x] **Cat 6 appendix updated:** this doc now reads
  ``status: ✅ IMPLEMENTED v1`` and the ship log above
  documents the v1 services + verification.
- [x] **Master roadmap updated:** status matrix now
  shows Cat 1, 2, 3, 4, 5, 6, 8, 16, 21 as IMPLEMENTED
  (9/22). Cat 6 is the second of the Phase 2
  (Aggregation layer) cats to ship after Cat 8.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `AgentPerformanceScorer.score` | `src/eden/services/agent_intel/performance.py` | 1 | L |
| `AgentRelationshipGraph.build` | `src/eden/services/agent_intel/graph.py` | 1 | L |
| `HandoffAnalyzer.analyze` | `src/eden/services/agent_intel/handoff.py` | 1 | M |
| `AgentBenchmarkRunner.run` | `src/eden/services/agent_intel/benchmark.py` | 1 | M |
| `AgentFleetService.register_agent_identity` | `src/eden/services/agent_intel/fleet.py` | 1 | M |
| `AgentFleetService.assign_permissions` | same | 1 | M |
| **v2 additions:** | | | |
| `AgentFleetService.list_agents` (org-wide) | same | 1 | S |
| `AgentFleetService.share_agent` (cross-team) | same | 1 | M |
| `AgentFleetService.revoke_agent` | same | 1 | S |
| `AgentFleetService.list_credentials` | same | 1 | S |
| `AgentFleetService.credential_inbox` (HITL) | same | 2 | L |
| `AgentFleetService.aggregated_metrics` | same | 1 | M |
| `AgentBenchmarkRunner.schedule` (cron) | same | 1 | M |

**v0 surface:** 5 services, 6 routes. **v2 surface:**
12 services, 12 routes. v2 ships the **Fleet inventory
+ Inbox** (the LangSmith Fleet parity).

## API contracts

### `POST /orgs/{org_id}/intelligence/agents/{agent_id}/performance/score`

```json
body: { "window": "7d" }
→ {
    "data": {
      "agent_id": "customer_service_v1",
      "n_traces": 12453,
      "success_rate": 0.94,
      "p50_latency_ms": 850,
      "p95_latency_ms": 3200,
      "cost_per_call_usd": 0.012,
      "judge_score_median": 0.83,
      "handoffs_in": 4123,
      "handoffs_out": 4012
    }
  }
```

### `GET /orgs/{org_id}/intelligence/agents/relationship-graph`

```json
→ {
    "data": {
      "nodes": [
        { "id": "router", "type": "router", "n_calls": 12000 },
        { "id": "customer_service_v1", "type": "agent", "n_calls": 8000 },
        { "id": "knowledge_retrieval", "type": "tool", "n_calls": 6500 },
        { "id": "escalation_v2", "type": "agent", "n_calls": 200 }
      ],
      "edges": [
        { "from": "router", "to": "customer_service_v1", "n": 8000, "error_rate": 0.04, "p95_ms": 3200 },
        { "from": "customer_service_v1", "to": "knowledge_retrieval", "n": 6500, "error_rate": 0.01, "p95_ms": 150 },
        { "from": "customer_service_v1", "to": "escalation_v2", "n": 200, "error_rate": 0.15, "p95_ms": 5000, "alert": "high_error_rate" }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/agents/{agent_id}/handoff/analyze`

```json
body: { "window": "30d" }
→ {
    "data": {
      "bottleneck_handoffs": [
        { "from": "customer_service_v1", "to": "knowledge_retrieval",
          "n": 6500, "p95_ms": 150, "alert": "high_volume_low_latency",
          "recommendation": "agent_response_streaming" }
      ],
      "error_hotspots": [
        { "from": "customer_service_v1", "to": "escalation_v2",
          "n": 200, "error_rate": 0.15, "alert": "high_error_rate",
          "recommendation": "investigate the prompt_version on escalation_v2" }
      ],
      "drift_indicators": [
        { "from": "router", "to": "customer_service_v1",
          "n_baseline": 8000, "n_current": 7200, "delta_pct": -0.10,
          "alert": "router now sends 10% fewer to v1, check if router drift" }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/agents/fleet/register`

```json
body: {
  "name": "legal_contract_reviewer_v2",
  "description": "Reviews vendor contracts against company policy",
  "owner_user_id": "u_123",
  "permissions": ["viewers:team_legal", "editors:team_legal_lead", "deployers:ml_platform"],
  "credentials": ["oauth:sharepoint:read"],
  "initial_version": "1.0.0"
}
→ { "data": { "agent_id": "agent_abc" } }
```

### `GET /orgs/{org_id}/intelligence/agents/fleet/inbox`

The human-in-the-loop inbox. Every credential
request + every deprecation + every cross-team
share lands here.

```json
→ {
    "data": {
      "pending": [
        { "request_id": "req_abc", "type": "credential_grant", "agent": "legal_contract_reviewer_v2",
          "requested_by": "u_456", "requested_at": "2026-06-11T10:00:00Z",
          "summary": "SharePoint read access for /legal/contracts/"},
        { "request_id": "req_def", "type": "agent_share", "agent": "marketing_copywriter_v3",
          "requested_by": "u_789", "requested_at": "2026-06-11T11:00:00Z",
          "summary": "Share with team_sales" }
      ],
      "in_progress": [
        { "agent_id": "customer_service_v1", "version": "1.4.2",
          "deployer": "ml_platform_team", "started_at": "2026-06-10T15:00:00Z" }
      ]
    }
  }
```

## Data model

```sql
-- 1. Agent performance snapshots (one per agent per day)
CREATE TABLE agent_performance_snapshots (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    agent_id            VARCHAR(128) NOT NULL,
    snapshot_at         TIMESTAMPTZ NOT NULL,
    n_traces            INT NOT NULL DEFAULT 0,
    success_rate        DOUBLE PRECISION,
    p50_latency_ms      DOUBLE PRECISION,
    p95_latency_ms      DOUBLE PRECISION,
    cost_per_call_usd   DOUBLE PRECISION,
    judge_score_median  DOUBLE PRECISION,
    handoffs_in         INT NOT NULL DEFAULT 0,
    handoffs_out        INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_perf_snapshots_agent
    ON agent_performance_snapshots (org_id, agent_id, snapshot_at DESC);

-- 2. Agent relationships (the handoff graph)
CREATE TABLE agent_relationships (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    from_agent_id   VARCHAR(128) NOT NULL,
    to_agent_id     VARCHAR(128) NOT NULL,
    n_calls         BIGINT NOT NULL DEFAULT 0,
    error_rate      DOUBLE PRECISION,
    p95_latency_ms  DOUBLE PRECISION,
    last_call_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_relationships_from
    ON agent_relationships (org_id, from_agent_id);
CREATE INDEX idx_agent_relationships_to
    ON agent_relationships (org_id, to_agent_id);

-- 3. Agent benchmark runs
CREATE TABLE agent_benchmark_runs (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    agent_id        VARCHAR(128) NOT NULL,
    benchmark_name  VARCHAR(64) NOT NULL,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    score           DOUBLE PRECISION NOT NULL,
    metadata_json   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_benchmark_runs_agent
    ON agent_benchmark_runs (org_id, agent_id, run_at DESC);

-- 4. Agent Fleet identities (LangSmith Fleet parity)
CREATE TABLE agent_fleet_identities (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    agent_id            VARCHAR(128) NOT NULL UNIQUE,
    name                VARCHAR(128) NOT NULL,
    description         TEXT,
    owner_user_id       VARCHAR(128) NOT NULL,
    version             VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    status              VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|deprecated|archived
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deprecated_at       TIMESTAMPTZ
);
CREATE INDEX idx_agent_fleet_identities_owner
    ON agent_fleet_identities (org_id, owner_user_id);
CREATE INDEX idx_agent_fleet_identities_status
    ON agent_fleet_identities (org_id, status);

-- 5. Agent Fleet permissions
CREATE TABLE agent_fleet_permissions (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    agent_id        VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    role            VARCHAR(16) NOT NULL,  -- viewer|editor|deployer|admin
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by      VARCHAR(128) NOT NULL
);
CREATE INDEX idx_agent_fleet_permissions_user
    ON agent_fleet_permissions (org_id, user_id);
```

## Algorithm / pseudo-code

### `AgentPerformanceScorer.score`

```python
def score(org_id, agent_id, window="7d"):
    sql = """
        SELECT
            count(*) as n_traces,
            sum(CASE WHEN t.outcome = 'success' THEN 1 ELSE 0 END)::float
                / count(*) as success_rate,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_ms) as p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY t.duration_ms) as p95,
            sum(ue.cost_usd) / count(*) as cost_per_call_usd,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY js.score) as judge_score_median
        FROM telemetry_events t
        LEFT JOIN usage_events ue ON ue.trace_id = t.trace_id
        LEFT JOIN judge_scores js ON js.trace_id = t.trace_id
        WHERE t.org_id = ? AND t.agent_id = ? AND t.created_at > now() - make_interval(days => ?)
    """
    return await db.fetch(sql, org_id, agent_id, window_days=int(window[:-1]))
```

### `HandoffAnalyzer.analyze` — the bottleneck detector

```python
def analyze(org_id, window_days=30):
    bottlenecks = []
    error_hotspots = []
    drift_indicators = []
    handoffs = SELECT * FROM agent_relationships
                WHERE org_id = ? AND last_call_at > now() - INTERVAL '30 days'
    for h in handoffs:
        # Bottleneck: high volume + high latency
        if h.n_calls > 1000 and h.p95_latency_ms > 2000:
            bottlenecks.append(h)
        # Error hotspot: high error rate
        if h.error_rate and h.error_rate > 0.10:
            error_hotspots.append(h)
        # Drift: compare current 7d to previous 7d
        current = get_count(h, window="7d")
        baseline = get_count(h, window="14d", exclude_last="7d")
        if baseline > 1000 and (current - baseline) / baseline < -0.10:
            drift_indicators.append(h)
    return bottlenecks, error_hotspots, drift_indicators
```

### `AgentFleetService.register_agent_identity` (LangSmith Fleet parity)

```python
def register_agent_identity(org_id, name, owner_user_id, permissions, credentials):
    # 1. Create the agent identity
    agent_id = f"agent_{uuid4()}"
    await db.insert_agent_identity(org_id, agent_id, name, owner_user_id, ...)
    # 2. Assign the initial permissions (per LangSmith Fleet RBAC)
    for user_id, role in permissions.items():
        await db.insert_agent_permission(org_id, agent_id, user_id, role)
    # 3. Set up the credentials (per-agent OAuth, per-user OAuth, or shared service account)
    for cred in credentials:
        await db.insert_agent_credential(org_id, agent_id, cred)
    # 4. Audit log
    await audit_log.record(org_id, "fleet.register", actor=owner_user_id,
                          target=agent_id, after_state=...)
    return agent_id
```

### `AgentBenchmarkRunner.run`

```python
def run(org_id, agent_id, benchmark_name):
    benchmark = benchmarks[benchmark_name]  # agentbench|swebench|tau_bench|gaia
    if benchmark_name == "agentbench":
        tasks = load_agentbench_tasks()
        # Run the agent against each task, score the trajectory
        scores = []
        for task in tasks[:100]:  # 100-task sample
            trajectory = await run_agent(org_id, agent_id, task)
            score = benchmark.scorer.score(trajectory)
            scores.append(score)
        avg = sum(scores) / len(scores)
        await db.insert_benchmark_run(org_id, agent_id, benchmark_name, avg, ...)
        return avg
    # ... other benchmarks
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Deprecation cascade | When `agent_fleet_identities.status = 'deprecated'`, the `AgentRelationshipGraph` flags every edge INTO the deprecated agent as a "dead-end" warning; the Fleet Inbox surfaces a "this agent is still being called" alert |
| Cross-team credential leak | `AgentFleetService.assign_permissions` is `require_org_admin` only; credential grants require admin + audit log + 7-day grace period for the credential owner to revoke |
| Agent identity collision | `agent_id` is `agent_<uuid4()>`; uniqueness enforced at the DB level |
| Performance snapshot is stale (cache) | `snapshot_at` field is exposed in the response; staleness > 1h triggers a refresh |
| Benchmark run is expensive | v0 caps at 100 tasks per run; the full benchmark (AgentBench 1000 tasks) is scheduled nightly via `AgentBenchmarkRunner.schedule` |

## Telemetry

* `intelligence_agent_performance_score` (counter, tagged by `agent_id`)
* `intelligence_agent_handoff_recorded` (counter, tagged by `from` and `to`)
* `intelligence_agent_benchmark_run` (counter, tagged by `benchmark`)
* `intelligence_agent_fleet_registered` (counter)
* `intelligence_agent_fleet_deprecated` (counter)
* `intelligence_agent_fleet_inbox_pending` (gauge)

## Test plan

* Performance scorer: matches a hand-rolled SQL on a
  10k-trace fixture
* Relationship graph: roundtrips the node/edge JSON
* Handoff analyzer: correctly identifies the bottleneck
  on a synthetic 3-agent fixture
* Benchmark runner: AgentBench 100-task sample completes
  in < 5 min
* Fleet register: idempotent (re-registering the same
  name is a no-op)
* Fleet permission: viewer cannot edit; editor cannot
  deploy; deployer cannot admin (per LangSmith Fleet
  RBAC)
* Fleet deprecation: 30-day grace period before
  archiving
* Fleet Inbox: pending requests expire after 30d
* RLS: a different org's agent is never returned

Target: **~25 tests, ~1.0s.**

## Acceptance criteria

- [ ] All 5 v0 services + 7 v2 Fleet services implemented
- [ ] Performance scorer matches hand-rolled SQL
- [ ] Relationship graph roundtrips
- [ ] Handoff analyzer identifies bottleneck + error
  hotspot + drift indicator correctly
- [ ] Benchmark runner completes a 100-task sample in
  < 5 min
- [ ] Fleet register is idempotent
- [ ] Fleet permission respects the LangSmith Fleet
  RBAC (viewer < editor < deployer < admin)
- [ ] Fleet deprecation has 30-day grace period
- [ ] Fleet Inbox pending requests expire at 30d
- [ ] All 25 tests pass
- [ ] RLS verified

## Open questions

* **Drift detection algorithm** — the 7d-vs-previous-7d
  ratio is a heuristic. **Recommendation: ship heuristic
  in v0; layer Prophet or similar time-series library in
  v2.1.** (Owner: Cat 6 lead)
* **Per-agent sampling rate** — at 1M traces/mo, scoring
  every agent every 5 min is expensive. **Recommendation:
  1% sampling with reservoir for the rest; the snapshot
  is recomputed nightly at full fidelity.** (Owner: Cat 6
  lead)
* **Inbox expiry** — 30d feels right, but enterprise
  customers may want 90d or 1y. **Recommendation:
  configurable per org via `organizations.features`.**
  (Owner: Cat 6 lead)
* **Multi-region Fleet** — when Eden goes multi-region,
  the Fleet identity spans regions. **Recommendation:
  v0 ships single-region only; v2.1 ships
  cross-region identity federation.** (Owner: Cat 6 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 6
* Stub envelope: `src/eden/intelligence_envelope.py`
* Existing agent registry: `src/eden/api/routes/agents.py`
* Multi-agent trajectory: `src/eden/multi_agent/planning.py`
* Cat 7 (Tool — the `HandoffAnalyzer` consumes tool
  attribution): [`07-tool-intelligence.md`](./07-tool-intelligence.md)
* Cat 16 (Decision — Cat 16 trajectory analyzer provides
  the per-step data): [`16-decision-intelligence.md`](./16-decision-intelligence.md)
* Research: LangSmith Fleet blog (Mar 2026); LangGraph
  overview (2026); LangChain State of Agent Engineering
  2026
