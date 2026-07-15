"""Eden LLMOps — AI Insights tool registry.

Server-side tools exposed to the AI Insights chat assistant. These
are NOT public HTTP routes — they are direct DB/service calls invoked
from the SSE chat endpoint / unified ChatService.

Data sources (Capture → Analyse → Improve):
  - ``telemetry_events`` — traces / latency / anomalies
  - ``usage_events`` — cost
  - ``judge_scores`` — eval scores
  - ``agent_issues`` — grouped failures
  - ``proposed_patches`` — PR / patch inbox

All queries are scoped to the caller's ``org_id`` / ``tenant_id``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

# Per-process short-TTL cache so identical tool calls in one turn
# (or back-to-back turns) do not re-hit Postgres. Keyed by
# org + tool + args; entries expire after ``_DEDUPE_TTL_S``.
_DEDUPE_TTL_S = 30.0
_dedupe_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_DEDUPE_MAX = 64


def _tool_error_text(exc: BaseException) -> str:
    """Render an exception as a chat-safe diagnostic string."""
    try:
        msg = str(exc)
    except Exception:  # noqa: BLE001 — last-ditch defensive
        return f"{type(exc).__name__}: tool error"
    return msg or f"{type(exc).__name__}: tool error"


def _dedupe_key(org_id: str, name: str, input_json: dict[str, Any]) -> str:
    raw = json.dumps(
        {"org": org_id, "name": name, "args": input_json or {}},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _dedupe_get(key: str) -> dict[str, Any] | None:
    entry = _dedupe_cache.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if time.monotonic() > expires_at:
        _dedupe_cache.pop(key, None)
        return None
    return value


def _dedupe_put(key: str, value: dict[str, Any]) -> None:
    if len(_dedupe_cache) >= _DEDUPE_MAX:
        # Drop oldest by expiry.
        oldest = min(_dedupe_cache.items(), key=lambda kv: kv[1][0])
        _dedupe_cache.pop(oldest[0], None)
    _dedupe_cache[key] = (time.monotonic() + _DEDUPE_TTL_S, value)


# ============================================================================
# Tool registry
# ============================================================================

class InsightsTool:
    """A single server-side tool exposed to the Claude chat assistant."""

    def __init__(
        self,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        handler: Callable[..., Awaitable[Any]],
    ) -> None:
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler

    async def __call__(self, org_id: str, **kwargs: Any) -> Any:
        return await self.handler(org_id=org_id, **kwargs)

    def to_anthropic_tool(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


_REGISTRY: dict[str, InsightsTool] = {}


def insights_tool(
    name: str,
    description: str,
    input_schema: dict[str, Any],
) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
    """Decorator: register a function as an AI Insights tool."""

    def deco(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        tool = InsightsTool(
            name=name,
            description=description,
            input_schema=input_schema,
            handler=fn,
        )
        _REGISTRY[name] = tool
        return fn

    return deco


def get_tool(name: str) -> InsightsTool | None:
    return _REGISTRY.get(name)


def list_tools() -> list[InsightsTool]:
    return list(_REGISTRY.values())


# ============================================================================
# Helpers
# ============================================================================

def _parse_since(since: str) -> datetime:
    """Accept an ISO-8601 timestamp or a relative phrase like '24h' / '7d'."""
    if not since:
        return datetime.now(UTC) - timedelta(hours=24)
    s = since.strip().lower()
    if s.endswith("h") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(hours=int(s[:-1]))
    if s.endswith("d") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(days=int(s[:-1]))
    if s.endswith("m") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(minutes=int(s[:-1]))
    try:
        return datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("insights_tools: unparseable since=%r; defaulting to 24h", since)
        return datetime.now(UTC) - timedelta(hours=24)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _deep_links_for_trace(trace_id: str) -> dict[str, str]:
    return {
        "traces_url": f"/traces?trace_id={trace_id}",
        "inspector_url": f"/observability?trace_id={trace_id}",
        "replay_url": f"/replay?trace={trace_id}",
    }


def _pct(sorted_vals: list[float], p: float) -> float | None:
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    idx = max(0, min(n - 1, int(round((p / 100.0) * (n - 1)))))
    return sorted_vals[idx]


# ============================================================================
# Tools — Capture (traces)
# ============================================================================

@insights_tool(
    name="list_traces",
    description=(
        "List recent observability traces for this org (Capture). "
        "Use for 'what's been running', 'show recent traces', or "
        "'failed traces today'. Returns trace_id, outcome, duration, "
        "cost, and deep links. Default window 24h."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Maximum traces to return (default 25, max 100).",
                "minimum": 1,
                "maximum": 100,
            },
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on timestamp. ISO-8601 or relative "
                    "('24h', '7d', '30m'). Default: 24h."
                ),
            },
            "outcome": {
                "type": "string",
                "description": (
                    "Optional outcome filter, e.g. 'success', 'failure', "
                    "'error', 'partial'."
                ),
            },
            "agent_id": {
                "type": "string",
                "description": "Optional agent_id filter.",
            },
        },
    },
)
async def list_traces(
    org_id: str,
    limit: int = 25,
    since: str = "24h",
    outcome: str | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    clauses = ["tenant_id = $1", "timestamp >= $2"]
    args: list[Any] = [org_id, cutoff]
    if outcome:
        args.append(outcome)
        clauses.append(f"outcome = ${len(args)}")
    if agent_id:
        args.append(agent_id)
        clauses.append(
            f"(agent_id = ${len(args)} OR attributes->>'agent_id' = ${len(args)})"
        )
    args.append(limit)
    limit_idx = len(args)

    rows = await client.fetch(
        f"""
        SELECT trace_id,
               min(timestamp) AS started_at,
               max(realm) AS realm,
               max(COALESCE(agent_id, attributes->>'agent_id')) AS agent_id,
               max(COALESCE(model_name, attributes->>'model')) AS model,
               max(outcome) AS outcome,
               max(error_type) AS error_type,
               count(*) AS span_count,
               max(duration_ms) AS duration_ms,
               coalesce(
                 sum(COALESCE(
                   NULLIF(metrics->>'cost_usd', '')::float,
                   NULLIF(payload->>'cost_usd', '')::float,
                   0
                 )), 0
               ) AS cost_usd
        FROM telemetry_events
        WHERE {' AND '.join(clauses)}
        GROUP BY trace_id
        ORDER BY started_at DESC
        LIMIT ${limit_idx}
        """,
        *args,
    )

    traces = []
    for r in rows:
        tid = r["trace_id"]
        traces.append({
            "trace_id": tid,
            "started_at": _iso(r["started_at"]),
            "realm": r["realm"],
            "agent_id": r["agent_id"],
            "model": r["model"],
            "outcome": r["outcome"],
            "error_type": r["error_type"],
            "span_count": int(r["span_count"] or 0),
            "duration_ms": float(r["duration_ms"] or 0.0),
            "cost_usd": round(float(r["cost_usd"] or 0.0), 6),
            **_deep_links_for_trace(tid),
        })

    return {
        "count": len(traces),
        "since": cutoff.isoformat(),
        "outcome_filter": outcome,
        "agent_id_filter": agent_id,
        "traces": traces,
    }


@insights_tool(
    name="get_trace",
    description=(
        "Fetch detail for one trace by trace_id: span count, duration, "
        "outcome, models, and deep links to Traces / Inspector."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "The trace_id to fetch.",
            },
        },
        "required": ["trace_id"],
    },
)
async def get_trace(org_id: str, trace_id: str) -> dict[str, Any]:
    client = await get_postgres_client()
    row = await client.fetchrow(
        """
        SELECT trace_id,
               min(timestamp) AS started_at,
               max(timestamp) AS ended_at,
               max(realm) AS realm,
               max(COALESCE(agent_id, attributes->>'agent_id')) AS agent_id,
               max(COALESCE(model_name, attributes->>'model')) AS model,
               max(outcome) AS outcome,
               max(error_type) AS error_type,
               count(*) AS span_count,
               max(duration_ms) AS duration_ms,
               coalesce(
                 sum(COALESCE(
                   NULLIF(metrics->>'cost_usd', '')::float,
                   NULLIF(payload->>'cost_usd', '')::float,
                   0
                 )), 0
               ) AS cost_usd,
               sum(COALESCE(usage_prompt_tokens,
                            NULLIF(payload->>'input_tokens', '')::int, 0)) AS input_tokens,
               sum(COALESCE(usage_completion_tokens,
                            NULLIF(payload->>'output_tokens', '')::int, 0)) AS output_tokens
        FROM telemetry_events
        WHERE tenant_id = $1 AND trace_id = $2
        GROUP BY trace_id
        """,
        org_id,
        trace_id,
    )
    if not row:
        return {"found": False, "trace_id": trace_id}
    return {
        "found": True,
        "trace": {
            "trace_id": row["trace_id"],
            "started_at": _iso(row["started_at"]),
            "ended_at": _iso(row["ended_at"]),
            "realm": row["realm"],
            "agent_id": row["agent_id"],
            "model": row["model"],
            "outcome": row["outcome"],
            "error_type": row["error_type"],
            "span_count": int(row["span_count"] or 0),
            "duration_ms": float(row["duration_ms"] or 0.0),
            "cost_usd": round(float(row["cost_usd"] or 0.0), 6),
            "input_tokens": int(row["input_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            **_deep_links_for_trace(trace_id),
        },
    }


@insights_tool(
    name="get_traces_by_filter",
    description=(
        "Ad-hoc filtered trace list. Supports outcome, agent_id, realm, "
        "and since. Same shape as list_traces."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "outcome": {
                "type": "string",
                "description": "Filter by outcome (success, failure, error, …).",
            },
            "agent_id": {
                "type": "string",
                "description": "Filter by agent_id.",
            },
            "realm": {
                "type": "string",
                "description": "Filter by realm (e.g. production, staging).",
            },
            "since": {
                "type": "string",
                "description": "Lower bound. ISO-8601 or '24h'/'7d'. Default: 7d.",
            },
            "limit": {
                "type": "integer",
                "description": "Max traces (default 50, max 100).",
                "minimum": 1,
                "maximum": 100,
            },
        },
    },
)
async def get_traces_by_filter(
    org_id: str,
    since: str = "7d",
    outcome: str | None = None,
    agent_id: str | None = None,
    realm: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    result = await list_traces(
        org_id=org_id,
        limit=limit,
        since=since,
        outcome=outcome,
        agent_id=agent_id,
    )
    if realm:
        filtered = [t for t in result["traces"] if t.get("realm") == realm]
        result = {
            **result,
            "count": len(filtered),
            "traces": filtered,
            "realm_filter": realm,
        }
    else:
        result["realm_filter"] = None
    result["filters"] = {
        "outcome": outcome,
        "agent_id": agent_id,
        "realm": realm,
        "since": result["since"],
    }
    return result


@insights_tool(
    name="search_traces",
    description=(
        "Search traces by free-text against span name / error_type / "
        "model. Use when the user asks to find traces mentioning a topic."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Free-text search query.",
            },
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 7d.",
            },
            "limit": {
                "type": "integer",
                "description": "Max traces (default 25, max 100).",
                "minimum": 1,
                "maximum": 100,
            },
        },
        "required": ["query"],
    },
)
async def search_traces(
    org_id: str,
    query: str,
    since: str = "7d",
    limit: int = 25,
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    limit = max(1, min(int(limit), 100))
    client = await get_postgres_client()
    pattern = f"%{query.strip()}%"
    rows = await client.fetch(
        """
        SELECT trace_id,
               min(timestamp) AS started_at,
               max(outcome) AS outcome,
               max(COALESCE(model_name, attributes->>'model')) AS model,
               max(error_type) AS error_type,
               max(duration_ms) AS duration_ms,
               count(*) AS span_count
        FROM telemetry_events
        WHERE tenant_id = $1
          AND timestamp >= $2
          AND (
            name ILIKE $3
            OR COALESCE(error_type, '') ILIKE $3
            OR COALESCE(model_name, '') ILIKE $3
            OR COALESCE(agent_id, '') ILIKE $3
            OR COALESCE(attributes->>'agent_id', '') ILIKE $3
          )
        GROUP BY trace_id
        ORDER BY started_at DESC
        LIMIT $4
        """,
        org_id,
        cutoff,
        pattern,
        limit,
    )
    traces = [
        {
            "trace_id": r["trace_id"],
            "started_at": _iso(r["started_at"]),
            "outcome": r["outcome"],
            "model": r["model"],
            "error_type": r["error_type"],
            "duration_ms": float(r["duration_ms"] or 0.0),
            "span_count": int(r["span_count"] or 0),
            **_deep_links_for_trace(r["trace_id"]),
        }
        for r in rows
    ]
    return {
        "query": query,
        "since": cutoff.isoformat(),
        "count": len(traces),
        "traces": traces,
    }


# ============================================================================
# Tools — Analyse (latency / cost / evals / anomalies)
# ============================================================================

@insights_tool(
    name="get_latency_p95",
    description=(
        "Compute p50/p95/p99 of per-trace max duration_ms from "
        "telemetry_events. Use for 'how slow are traces' questions."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 7d.",
            },
        },
    },
)
async def get_latency_p95(org_id: str, since: str = "7d") -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT max(duration_ms) AS duration_ms
        FROM telemetry_events
        WHERE tenant_id = $1
          AND timestamp >= $2
          AND duration_ms IS NOT NULL
        GROUP BY trace_id
        """,
        org_id,
        cutoff,
    )
    durations = sorted(
        float(r["duration_ms"]) for r in rows if r["duration_ms"] is not None
    )
    if not durations:
        return {
            "since": cutoff.isoformat(),
            "sample_size": 0,
            "p50_ms": None,
            "p95_ms": None,
            "p99_ms": None,
            "note": "No traces with duration in window",
        }
    return {
        "since": cutoff.isoformat(),
        "sample_size": len(durations),
        "p50_ms": round(_pct(durations, 50) or 0.0, 3),
        "p95_ms": round(_pct(durations, 95) or 0.0, 3),
        "p99_ms": round(_pct(durations, 99) or 0.0, 3),
    }


@insights_tool(
    name="get_cost_breakdown",
    description=(
        "Cost breakdown from usage_events for this org (Analyse). "
        "Groups by model and day. Use for budget / spend questions."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 30d.",
            },
        },
    },
)
async def get_cost_breakdown(org_id: str, since: str = "30d") -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()
    by_model = await client.fetch(
        """
        SELECT COALESCE(model, 'unknown') AS model,
               SUM(COALESCE(cost_usd, 0)) AS cost_usd,
               COUNT(*) AS event_count
        FROM usage_events
        WHERE org_id::text = $1 AND created_at >= $2
        GROUP BY 1
        ORDER BY cost_usd DESC
        LIMIT 50
        """,
        org_id,
        cutoff,
    )
    by_day = await client.fetch(
        """
        SELECT date_trunc('day', created_at) AS day,
               SUM(COALESCE(cost_usd, 0)) AS cost_usd,
               COUNT(*) AS event_count
        FROM usage_events
        WHERE org_id::text = $1 AND created_at >= $2
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 60
        """,
        org_id,
        cutoff,
    )
    total = sum(float(r["cost_usd"] or 0.0) for r in by_model)
    series = [
        {
            "day": _iso(r["day"]),
            "cost_usd": round(float(r["cost_usd"] or 0.0), 4),
            "event_count": int(r["event_count"] or 0),
        }
        for r in by_day
    ]
    return {
        "since": cutoff.isoformat(),
        "currency": "USD",
        "estimated_total": round(total, 4),
        "by_model": [
            {
                "model": r["model"],
                "cost_usd": round(float(r["cost_usd"] or 0.0), 4),
                "event_count": int(r["event_count"] or 0),
            }
            for r in by_model
        ],
        "series": series,
    }


@insights_tool(
    name="get_judge_scores",
    description=(
        "Aggregate judge / eval scores from judge_scores (Analyse). "
        "Returns average score per judge and recent low-scoring traces."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 7d.",
            },
            "limit": {
                "type": "integer",
                "description": "Max low-score examples (default 10).",
                "minimum": 1,
                "maximum": 50,
            },
        },
    },
)
async def get_judge_scores(
    org_id: str,
    since: str = "7d",
    limit: int = 10,
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    limit = max(1, min(int(limit), 50))
    client = await get_postgres_client()
    by_judge = await client.fetch(
        """
        SELECT judge_name,
               COUNT(*) AS n,
               AVG(score) AS avg_score,
               MIN(score) AS min_score,
               MAX(score) AS max_score
        FROM judge_scores
        WHERE tenant_id = $1 AND scored_at >= $2
        GROUP BY judge_name
        ORDER BY n DESC
        """,
        org_id,
        cutoff,
    )
    low = await client.fetch(
        """
        SELECT judge_run_id, judge_name, trace_id, score, scored_at, rationale
        FROM judge_scores
        WHERE tenant_id = $1 AND scored_at >= $2
        ORDER BY score ASC, scored_at DESC
        LIMIT $3
        """,
        org_id,
        cutoff,
        limit,
    )
    return {
        "since": cutoff.isoformat(),
        "by_judge": [
            {
                "judge_name": r["judge_name"],
                "count": int(r["n"]),
                "avg_score": round(float(r["avg_score"]), 4) if r["avg_score"] is not None else None,
                "min_score": float(r["min_score"]) if r["min_score"] is not None else None,
                "max_score": float(r["max_score"]) if r["max_score"] is not None else None,
            }
            for r in by_judge
        ],
        "low_scores": [
            {
                "judge_run_id": str(r["judge_run_id"]),
                "judge_name": r["judge_name"],
                "trace_id": r["trace_id"],
                "score": float(r["score"]),
                "scored_at": _iso(r["scored_at"]),
                "rationale": (r["rationale"] or "")[:240] or None,
                **_deep_links_for_trace(r["trace_id"]),
            }
            for r in low
        ],
    }


@insights_tool(
    name="get_anomalies",
    description=(
        "Flag anomalous traces: slow (top duration), errored outcomes, "
        "and high cost. Returns the most suspicious rows with deep links."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 24h.",
            },
            "limit": {
                "type": "integer",
                "description": "Max anomalies per bucket (default 20).",
                "minimum": 1,
                "maximum": 100,
            },
        },
    },
)
async def get_anomalies(
    org_id: str,
    since: str = "24h",
    limit: int = 20,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    slow = await client.fetch(
        """
        SELECT trace_id,
               max(duration_ms) AS duration_ms,
               max(outcome) AS outcome,
               min(timestamp) AS started_at
        FROM telemetry_events
        WHERE tenant_id = $1 AND timestamp >= $2 AND duration_ms IS NOT NULL
        GROUP BY trace_id
        ORDER BY duration_ms DESC
        LIMIT $3
        """,
        org_id,
        cutoff,
        limit,
    )
    errored = await client.fetch(
        """
        SELECT trace_id,
               max(outcome) AS outcome,
               max(error_type) AS error_type,
               min(timestamp) AS started_at,
               max(duration_ms) AS duration_ms
        FROM telemetry_events
        WHERE tenant_id = $1
          AND timestamp >= $2
          AND (
            outcome ILIKE ANY (ARRAY['fail%', 'error%', 'timeout%', 'crash%'])
            OR error_type IS NOT NULL
          )
        GROUP BY trace_id
        ORDER BY started_at DESC
        LIMIT $3
        """,
        org_id,
        cutoff,
        limit,
    )
    costly = await client.fetch(
        """
        SELECT trace_id,
               coalesce(
                 sum(COALESCE(
                   NULLIF(metrics->>'cost_usd', '')::float,
                   NULLIF(payload->>'cost_usd', '')::float,
                   0
                 )), 0
               ) AS cost_usd,
               min(timestamp) AS started_at,
               max(outcome) AS outcome
        FROM telemetry_events
        WHERE tenant_id = $1 AND timestamp >= $2
        GROUP BY trace_id
        HAVING coalesce(
                 sum(COALESCE(
                   NULLIF(metrics->>'cost_usd', '')::float,
                   NULLIF(payload->>'cost_usd', '')::float,
                   0
                 )), 0
               ) > 0
        ORDER BY cost_usd DESC
        LIMIT $3
        """,
        org_id,
        cutoff,
        limit,
    )

    def _rows(rows: Any, extra: Callable[[Any], dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for r in rows:
            item = {
                "trace_id": r["trace_id"],
                "started_at": _iso(r["started_at"]),
                **extra(r),
                **_deep_links_for_trace(r["trace_id"]),
            }
            out.append(item)
        return out

    return {
        "since": cutoff.isoformat(),
        "slow": _rows(
            slow,
            lambda r: {
                "duration_ms": float(r["duration_ms"]) if r["duration_ms"] is not None else None,
                "outcome": r["outcome"],
            },
        ),
        "errored": _rows(
            errored,
            lambda r: {
                "outcome": r["outcome"],
                "error_type": r["error_type"],
                "duration_ms": float(r["duration_ms"]) if r["duration_ms"] is not None else None,
            },
        ),
        "costly": _rows(
            costly,
            lambda r: {
                "cost_usd": round(float(r["cost_usd"] or 0.0), 6),
                "outcome": r["outcome"],
            },
        ),
    }


@insights_tool(
    name="get_insights",
    description=(
        "High-level org health: trace counts by outcome, p95 latency, "
        "open issues, open patches. Default first call for open-ended "
        "'how is Eden doing' questions (Capture/Analyse/Improve snapshot)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 7d.",
            },
        },
    },
)
async def get_insights(org_id: str, since: str = "7d") -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    by_outcome = await client.fetch(
        """
        SELECT COALESCE(outcome, 'unknown') AS outcome, COUNT(DISTINCT trace_id) AS n
        FROM telemetry_events
        WHERE tenant_id = $1 AND timestamp >= $2
        GROUP BY 1
        ORDER BY n DESC
        """,
        org_id,
        cutoff,
    )
    durations = await client.fetch(
        """
        SELECT max(duration_ms) AS d
        FROM telemetry_events
        WHERE tenant_id = $1 AND timestamp >= $2 AND duration_ms IS NOT NULL
        GROUP BY trace_id
        """,
        org_id,
        cutoff,
    )
    duration_list = sorted(float(r["d"]) for r in durations if r["d"] is not None)

    open_issues = 0
    open_patches = 0
    try:
        open_issues = int(
            await client.fetchval(
                """
                SELECT COUNT(*) FROM agent_issues
                WHERE org_id = $1 AND status IN ('open', 'triaged', 'fix_pending', 'verifying', 'regressed')
                """,
                org_id,
            )
            or 0
        )
    except Exception as exc:  # noqa: BLE001 — table may be absent in older envs
        logger.debug("get_insights: agent_issues unavailable: %s", exc)
    try:
        open_patches = int(
            await client.fetchval(
                """
                SELECT COUNT(*) FROM proposed_patches
                WHERE org_id = $1 AND status IN ('proposed', 'approved')
                """,
                org_id,
            )
            or 0
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("get_insights: proposed_patches unavailable: %s", exc)

    p95 = _pct(duration_list, 95)
    return {
        "since": cutoff.isoformat(),
        "trace_counts_by_outcome": {r["outcome"]: int(r["n"]) for r in by_outcome},
        "latency_ms": {
            "sample_size": len(duration_list),
            "p50": round(_pct(duration_list, 50), 3) if duration_list else None,
            "p95": round(p95, 3) if p95 is not None else None,
        },
        "open_agent_issues": open_issues,
        "open_proposed_patches": open_patches,
    }


# ============================================================================
# Tools — Improve (issues + patches)
# ============================================================================

@insights_tool(
    name="list_agent_issues",
    description=(
        "List open agent issues (Improve). Grouped stumbles with "
        "severity, status, and link to /issues/{id}."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "description": (
                    "Optional status filter. Default: open statuses "
                    "(open, triaged, fix_pending, verifying, regressed)."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "Max issues (default 25, max 100).",
                "minimum": 1,
                "maximum": 100,
            },
        },
    },
)
async def list_agent_issues(
    org_id: str,
    status: str | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    client = await get_postgres_client()
    if status:
        rows = await client.fetch(
            """
            SELECT id, fingerprint, kind, title, status, severity, agent_id,
                   first_seen, last_seen, stumble_count
            FROM agent_issues
            WHERE org_id = $1 AND status = $2
            ORDER BY last_seen DESC
            LIMIT $3
            """,
            org_id,
            status,
            limit,
        )
    else:
        rows = await client.fetch(
            """
            SELECT id, fingerprint, kind, title, status, severity, agent_id,
                   first_seen, last_seen, stumble_count
            FROM agent_issues
            WHERE org_id = $1
              AND status IN ('open', 'triaged', 'fix_pending', 'verifying', 'regressed')
            ORDER BY last_seen DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    issues = [
        {
            "issue_id": str(r["id"]),
            "fingerprint": r["fingerprint"],
            "kind": r["kind"],
            "title": r["title"],
            "status": r["status"],
            "severity": r["severity"],
            "agent_id": r["agent_id"],
            "first_seen": _iso(r["first_seen"]),
            "last_seen": _iso(r["last_seen"]),
            "stumble_count": int(r["stumble_count"] or 0),
            "issues_url": f"/issues/{r['id']}",
        }
        for r in rows
    ]
    return {"count": len(issues), "status_filter": status, "issues": issues}


@insights_tool(
    name="list_proposed_patches",
    description=(
        "List proposed code patches in the Improve inbox "
        "(proposed_patches). Use for 'what PRs are pending' questions."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "description": "Optional status filter (proposed, approved, merged, …).",
            },
            "limit": {
                "type": "integer",
                "description": "Max patches (default 25, max 100).",
                "minimum": 1,
                "maximum": 100,
            },
        },
    },
)
async def list_proposed_patches(
    org_id: str,
    status: str | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    client = await get_postgres_client()
    if status:
        rows = await client.fetch(
            """
            SELECT id, repo_id, trace_id, rca_id, description, status,
                   quality_score, cost_usd, created_at, updated_at
            FROM proposed_patches
            WHERE org_id = $1 AND status = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            org_id,
            status,
            limit,
        )
    else:
        rows = await client.fetch(
            """
            SELECT id, repo_id, trace_id, rca_id, description, status,
                   quality_score, cost_usd, created_at, updated_at
            FROM proposed_patches
            WHERE org_id = $1 AND status IN ('proposed', 'approved')
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    patches = []
    for r in rows:
        tid = r["trace_id"]
        item = {
            "patch_id": r["id"],
            "repo_id": r["repo_id"],
            "trace_id": tid,
            "rca_id": r["rca_id"],
            "description": (r["description"] or "")[:280],
            "status": r["status"],
            "quality_score": float(r["quality_score"]) if r["quality_score"] is not None else None,
            "cost_usd": float(r["cost_usd"]) if r["cost_usd"] is not None else None,
            "created_at": _iso(r["created_at"]),
            "updated_at": _iso(r["updated_at"]),
            "inbox_url": "/closed-loop",
        }
        if tid:
            item.update(_deep_links_for_trace(tid))
        patches.append(item)
    return {"count": len(patches), "status_filter": status, "patches": patches}


# ============================================================================
# Tools — Alerts (F81 + F70)
# ============================================================================

@insights_tool(
    name="preview_nl_alert",
    description=(
        "Compile a natural-language alert rule to EQL without saving. "
        "Use when the user asks to create or preview an alert in English. "
        "Returns editable EQL and warnings for an approval card."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "nl_text": {
                "type": "string",
                "description": "Plain-English alert, e.g. 'cost exceeds $0.30/hr'.",
            },
            "context": {
                "type": "object",
                "description": "Optional page_context (filters, trace_id).",
            },
        },
        "required": ["nl_text"],
    },
)
async def preview_nl_alert(
    org_id: str,
    nl_text: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from eden.alerts.compiler import AlertCompiler

    result = await AlertCompiler().compile(org_id, nl_text, context=context)
    return {
        "approval_required": True,
        "nl_text": nl_text,
        "eql": result.get("eql", ""),
        "warnings": list(result.get("warnings") or []),
        "suggested_name": result.get("suggested_name", ""),
        "rule": result.get("rule", {}),
        "alerts_url": "/alerts",
    }


@insights_tool(
    name="create_alert_rule",
    description=(
        "Persist an NL alert rule after the user approves the EQL preview. "
        "Admin-gated write. Requires name and nl_text; optional eql_override."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Human-readable rule name."},
            "nl_text": {"type": "string", "description": "Original English rule."},
            "eql_override": {
                "type": "string",
                "description": "Edited EQL from the approval card.",
            },
            "triage_enabled": {
                "type": "boolean",
                "description": "Run real/benign judge on fire (default true).",
            },
        },
        "required": ["name", "nl_text"],
    },
)
async def create_alert_rule(
    org_id: str,
    name: str,
    nl_text: str,
    eql_override: str | None = None,
    triage_enabled: bool = True,
) -> dict[str, Any]:
    from eden.alerts.compiler import AlertCompiler
    from eden.alerts import repo
    from eden.dsl import AlertAsCode

    compiled = await AlertCompiler().compile(
        org_id,
        nl_text,
        eql_override=eql_override,
    )
    eql = (eql_override or compiled.get("eql") or "").strip()
    if not eql:
        return {"error": "compiled EQL is empty"}
    rule = await repo.create_nl_rule(
        org_id=org_id,
        name=name,
        nl_text=nl_text,
        compiled_eql=eql,
        triage_enabled=triage_enabled,
        channels={"in_app": True, "slack": True},
        enabled=True,
    )
    dsl = await AlertAsCode().compile(
        org_id,
        name=name,
        eql_query=eql,
        interval_seconds=3600,
        severity="warning",
    )
    return {
        "rule_id": rule["id"],
        "name": name,
        "eql": eql,
        "warnings": compiled.get("warnings", []),
        "dsl_status": dsl.get("status"),
        "alerts_url": "/alerts",
    }


# ============================================================================
# Tool dispatch
# ============================================================================

async def dispatch_tool_call(
    org_id: str,
    name: str,
    input_json: dict[str, Any],
) -> dict[str, Any]:
    """Execute a tool call and return the result envelope.

    Identical (org, name, args) calls within ``_DEDUPE_TTL_S`` reuse
    the prior envelope so a single chat turn does not spam Postgres.
    """
    cache_key = _dedupe_key(org_id, name, input_json or {})
    cached = _dedupe_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    tool = get_tool(name)
    if not tool:
        return {
            "tool": name,
            "status": "error",
            "output": f"Unknown tool: {name!r}",
            "duration_ms": 0,
        }

    started = time.perf_counter()
    try:
        result = await tool(org_id=org_id, **(input_json or {}))
        duration_ms = int((time.perf_counter() - started) * 1000)
        try:
            json.dumps(result)
            output = result
        except (TypeError, ValueError):
            output = {"text": str(result)}
        envelope = {
            "tool": name,
            "status": "ok",
            "output": output,
            "duration_ms": duration_ms,
        }
        _dedupe_put(cache_key, envelope)
        return envelope
    except Exception as exc:  # noqa: BLE001 — top-level guard
        duration_ms = int((time.perf_counter() - started) * 1000)
        logger.exception("insights tool %r failed: %s", name, exc)
        return {
            "tool": name,
            "status": "error",
            "output": _tool_error_text(exc),
            "duration_ms": duration_ms,
        }
