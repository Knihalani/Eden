"""Per-catalog query helpers for the export runner.

Each function returns a list of asyncpg-shaped rows that the
runner converts to plain dicts. The functions are intentionally
small — they exist to keep the runner readable and to give tests
a single place to monkey-patch.
"""

from __future__ import annotations

from eden.storage.postgres import get_postgres_client


async def fetch_traces(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT trace_id, realm, agent_id, started_at, outcome,
               span_count, duration_ms
        FROM telemetry_events
        WHERE tenant_id = $1
        ORDER BY started_at DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]


async def fetch_judge_scores(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT judge_run_id, trace_id, judge_name, judge_version,
               score, rationale, model, scored_at, latency_ms
        FROM judge_scores
        WHERE tenant_id = $1
        ORDER BY scored_at DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]


async def fetch_audit_log(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT id, user_id, action, target_type, target_id,
               metadata, ip_address, user_agent, created_at
        FROM org_audit_log
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]


async def fetch_usage_events(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT id, event_type, resource, quantity, unit, cost_cents,
               correlation_id, created_at
        FROM usage_events
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]


async def fetch_insights(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT insight_id, detector, severity, confidence, summary,
               affected_trace_ids, recommended_action, created_at
        FROM insights
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]


async def fetch_telemetry_events(org_id: str) -> list[dict]:
    client = await get_postgres_client()
    if not client:
        return []
    rows = await client.fetch(
        """
        SELECT event_id, project_id, trace_id, realm, event_type,
               timestamp, agent_id, duration_ms, outcome
        FROM telemetry_events
        WHERE tenant_id = $1
        ORDER BY timestamp DESC
        LIMIT 10000
        """,
        org_id,
    )
    return [dict(r) for r in rows]
