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
            OR agent_id ILIKE $3
            OR error_type ILIKE $3
            OR model_name ILIKE $3
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
# Tools — Signals / promote / export / analysis (W22)
# ============================================================================

_ANALYSIS_TEMPLATES: dict[str, dict[str, Any]] = {
    "slow_traces": {
        "label": "Slow traces",
        "description": "Top traces by duration in the last 24h",
        "estimated_usd": 0.0,
        "export_format": "csv",
        "filter_q": "latency:>2000",
    },
    "error_traces": {
        "label": "Error traces",
        "description": "Failed / error outcome traces",
        "estimated_usd": 0.0,
        "export_format": "csv",
        "filter_q": "status:error",
    },
    "cost_by_model": {
        "label": "Cost by model",
        "description": "Usage spend grouped by model (7d)",
        "estimated_usd": 0.01,
        "export_format": "csv",
        "tool": "get_cost_breakdown",
    },
    "open_issues": {
        "label": "Open agent issues",
        "description": "Open issues for triage",
        "estimated_usd": 0.0,
        "export_format": "csv",
        "tool": "list_agent_issues",
    },
}


def _estimate_sql_spend(sql: str) -> dict[str, Any]:
    """Heuristic spend / risk preview for read-only SQL (no LLM $)."""
    upper = sql.upper()
    complexity = 1
    if " JOIN " in upper:
        complexity += 2
    if " GROUP BY " in upper:
        complexity += 1
    if " ORDER BY " in upper:
        complexity += 1
    estimated_usd = round(0.002 * complexity, 4)
    return {
        "estimated_usd": estimated_usd,
        "complexity": complexity,
        "message": (
            f"Estimated query cost ~${estimated_usd:.4f} "
            f"(complexity={complexity}). Read-only; org-scoped."
        ),
    }


@insights_tool(
    name="preview_nl_signal",
    description=(
        "Compile a plain-English signal to a structured rule without saving. "
        "Use when the user asks to create a signal. Returns rule preview "
        "for an approval card."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": (
                    "Plain-English signal, e.g. "
                    "'LLM refusal rate above 5% in the last 24 hours'."
                ),
            },
        },
        "required": ["description"],
    },
)
async def preview_nl_signal(
    org_id: str,
    description: str,
) -> dict[str, Any]:
    _ = org_id
    from eden.services.cat2_intel.signals import compile_signal

    rule = compile_signal(description)
    return {
        "approval_required": True,
        "description": description,
        "rule": rule.to_dict(),
        "suggested_name": (description.strip()[:80] or "Signal"),
        "signals_url": "/signals",
    }


@insights_tool(
    name="create_signal",
    description=(
        "Persist an NL signal after the user approves the rule preview. "
        "Admin-gated write."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Plain-English signal description.",
            },
            "enabled": {
                "type": "boolean",
                "description": "Whether the signal is enabled (default true).",
            },
        },
        "required": ["description"],
    },
)
async def create_signal(
    org_id: str,
    description: str,
    enabled: bool = True,
) -> dict[str, Any]:
    import uuid

    from eden.services.cat2_intel.signals import compile_signal, signal_signature

    desc = (description or "").strip()
    if not desc:
        return {"error": "description is required"}
    rule = compile_signal(desc)
    signal_id = str(uuid.uuid4())
    cluster_id = signal_signature(desc)
    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    await client.execute(
        """
        INSERT INTO nl_signals
            (id, org_id, description, rule, enabled, cluster_id)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        """,
        signal_id,
        org_id,
        desc,
        json.dumps(rule.to_dict()),
        enabled,
        cluster_id,
    )
    return {
        "signal_id": signal_id,
        "description": desc,
        "rule": rule.to_dict(),
        "enabled": enabled,
        "signals_url": "/signals",
    }


@insights_tool(
    name="promote_artifact",
    description=(
        "Promote an artifact/nudge through EvidenceGate after operator "
        "approval. Admin-gated write — never auto-executes."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "artifact_id": {
                "type": "string",
                "description": "Artifact / nudge id to promote.",
            },
        },
        "required": ["artifact_id"],
    },
)
async def promote_artifact(
    org_id: str,
    artifact_id: str,
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    aid = (artifact_id or "").strip()
    if not aid:
        return {"error": "artifact_id is required"}
    gate = EvidenceGate()
    candidates = await gate.list_queue(org_id, status=None, limit=200)
    candidate = next(
        (
            c
            for c in candidates
            if str(c.get("ref_id")) == aid and c.get("status") != "demoted"
        ),
        None,
    )
    if not candidate:
        cid = await gate.enqueue(org_id, kind="nudge", ref_id=aid, status="shadow")
        if not cid:
            return {"error": "Failed to enqueue promotion candidate"}
        candidate = await gate.get_candidate(org_id, cid)
    if not candidate:
        return {"error": "Promotion candidate not found"}
    report = await gate.promote_if_passed(org_id, str(candidate["id"]))
    return {
        "artifact_id": aid,
        "candidate_id": str(candidate["id"]),
        "promoted": bool(getattr(report, "passed", False)),
        "report": getattr(report, "__dict__", {}),
        "promotions_url": "/promotions",
    }


@insights_tool(
    name="export_table",
    description=(
        "Export tabular rows as CSV or XLSX for client download. "
        "Pass rows from a prior tool, or use template='slow_traces' "
        "to fetch and export slow traces. Returns a client_action."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "rows": {
                "type": "array",
                "description": "Array of row objects to export.",
                "items": {"type": "object"},
            },
            "format": {
                "type": "string",
                "enum": ["csv", "xlsx"],
                "description": "Download format (default csv).",
            },
            "filename": {
                "type": "string",
                "description": "Suggested download filename.",
            },
            "template": {
                "type": "string",
                "description": (
                    "Optional analysis template id "
                    "(slow_traces, error_traces) to fetch rows."
                ),
            },
            "confirm_spend": {
                "type": "boolean",
                "description": "Acknowledge spend preview for large exports.",
            },
        },
    },
)
async def export_table(
    org_id: str,
    rows: list[dict[str, Any]] | None = None,
    format: str = "csv",  # noqa: A002 — tool schema name
    filename: str | None = None,
    template: str | None = None,
    confirm_spend: bool = False,
) -> dict[str, Any]:
    fmt = (format or "csv").lower().strip()
    if fmt not in ("csv", "xlsx"):
        return {"error": f"unsupported format: {fmt!r}"}

    out_rows: list[dict[str, Any]] = list(rows or [])
    if template and not out_rows:
        tmpl = _ANALYSIS_TEMPLATES.get(template)
        if not tmpl:
            return {"error": f"unknown template: {template!r}"}
        if template in ("slow_traces", "error_traces"):
            outcome = "error" if template == "error_traces" else None
            fetched = await list_traces(
                org_id,
                limit=50,
                since="24h",
                outcome=outcome,
            )
            out_rows = list(fetched.get("traces") or [])
            if template == "slow_traces":
                out_rows = sorted(
                    out_rows,
                    key=lambda r: float(r.get("duration_ms") or 0),
                    reverse=True,
                )

    if not out_rows:
        return {"error": "no rows to export"}

    n = len(out_rows)
    spend = {
        "estimated_usd": round(0.0001 * max(n, 1), 4),
        "row_count": n,
        "message": f"Export {n} rows as {fmt.upper()}.",
    }
    if n > 500 and not confirm_spend:
        return {
            "approval_required": True,
            "spend_preview": spend,
            "tool": "export_table",
            "args": {
                "format": fmt,
                "filename": filename,
                "template": template,
                "confirm_spend": True,
                # Re-fetch on confirm when template set; otherwise pass a cap.
                **(
                    {"rows": out_rows}
                    if not template
                    else {}
                ),
                "_row_count": n,
            },
            "message": (
                f"Large export ({n} rows). Confirm to download "
                f"(est. ${spend['estimated_usd']:.4f})."
            ),
        }

    safe_name = (filename or f"eden-export.{fmt}").strip()
    if not safe_name.endswith(f".{fmt}"):
        safe_name = f"{safe_name}.{fmt}"
    return {
        "client_action": "download",
        "format": fmt,
        "filename": safe_name,
        "rows": out_rows[:5000],
        "row_count": min(n, 5000),
        "spend_preview": spend,
        "message": f"Downloading {min(n, 5000)} rows as {fmt.upper()}.",
    }


@insights_tool(
    name="list_analysis_templates",
    description=(
        "List built-in analysis templates (slow traces, errors, cost, issues) "
        "with spend previews. Use run_analysis_template to execute one."
    ),
    input_schema={"type": "object", "properties": {}},
)
async def list_analysis_templates(org_id: str) -> dict[str, Any]:
    _ = org_id
    items = [
        {
            "id": tid,
            "label": meta["label"],
            "description": meta["description"],
            "spend_preview": {
                "estimated_usd": meta["estimated_usd"],
                "message": f"Est. ${meta['estimated_usd']:.4f}",
            },
            "export_format": meta.get("export_format", "csv"),
        }
        for tid, meta in _ANALYSIS_TEMPLATES.items()
    ]
    return {"templates": items, "count": len(items)}


@insights_tool(
    name="run_analysis_template",
    description=(
        "Run a built-in analysis template and optionally prepare a CSV "
        "export (client_action download). Includes spend_preview."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "template_id": {
                "type": "string",
                "description": "Template id from list_analysis_templates.",
            },
            "export": {
                "type": "boolean",
                "description": "If true, also return a download client_action.",
            },
            "confirm_spend": {
                "type": "boolean",
                "description": "Acknowledge spend when estimated_usd > 0.",
            },
        },
        "required": ["template_id"],
    },
)
async def run_analysis_template(
    org_id: str,
    template_id: str,
    export: bool = False,
    confirm_spend: bool = False,
) -> dict[str, Any]:
    meta = _ANALYSIS_TEMPLATES.get(template_id)
    if not meta:
        return {"error": f"unknown template: {template_id!r}"}
    est = float(meta.get("estimated_usd") or 0)
    spend = {
        "estimated_usd": est,
        "message": f"Template '{template_id}' est. ${est:.4f}",
    }
    if est > 0 and not confirm_spend:
        return {
            "approval_required": True,
            "spend_preview": spend,
            "tool": "run_analysis_template",
            "args": {
                "template_id": template_id,
                "export": export,
                "confirm_spend": True,
            },
            "message": (
                f"This analysis may cost ~${est:.4f}. "
                "Confirm to run."
            ),
        }

    data: dict[str, Any]
    if template_id in ("slow_traces", "error_traces"):
        outcome = "error" if template_id == "error_traces" else None
        data = await list_traces(org_id, limit=50, since="24h", outcome=outcome)
        if template_id == "slow_traces":
            traces = list(data.get("traces") or [])
            traces.sort(
                key=lambda r: float(r.get("duration_ms") or 0),
                reverse=True,
            )
            data = {**data, "traces": traces}
    elif meta.get("tool") == "get_cost_breakdown":
        data = await get_cost_breakdown(org_id, since="7d")
    elif meta.get("tool") == "list_agent_issues":
        data = await list_agent_issues(org_id)
    else:
        data = {"error": "template not implemented"}

    result: dict[str, Any] = {
        "template_id": template_id,
        "label": meta["label"],
        "spend_preview": spend,
        "data": data,
    }
    if export and meta.get("filter_q"):
        result["client_action"] = "propose_filter"
        result["q"] = meta["filter_q"]
        result["href"] = f"/traces?q={meta['filter_q']}"
    if export:
        rows: list[dict[str, Any]] = []
        if "traces" in data:
            rows = list(data["traces"] or [])
        elif "by_model" in data:
            rows = list(data["by_model"] or [])
        elif "issues" in data:
            rows = list(data["issues"] or [])
        if rows:
            result["download"] = {
                "client_action": "download",
                "format": "csv",
                "filename": f"{template_id}.csv",
                "rows": rows[:5000],
                "row_count": min(len(rows), 5000),
            }
    return result


@insights_tool(
    name="query_sql",
    description=(
        "Run a hardened read-only SQL SELECT/WITH against org telemetry. "
        "Rejects writes and multi-statements. Returns spend_preview. "
        "Prefer analysis templates for common questions."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "sql": {
                "type": "string",
                "description": "Read-only SELECT or WITH query.",
            },
            "confirm_spend": {
                "type": "boolean",
                "description": "Acknowledge spend for complex queries.",
            },
        },
        "required": ["sql"],
    },
)
async def query_sql_insights(
    org_id: str,
    sql: str,
    confirm_spend: bool = False,
) -> dict[str, Any]:
    """Insights-registered query_sql; agent registry keeps its own hardened copy."""
    cleaned = (sql or "").strip()
    if not cleaned:
        return {"error": "sql is required"}
    # Strip trailing semicolons; reject multi-statement.
    if ";" in cleaned.rstrip(";"):
        return {"error": "multiple SQL statements are not allowed"}
    cleaned = cleaned.rstrip(";").strip()
    head = cleaned.split(None, 1)[0].upper() if cleaned else ""
    if head not in ("SELECT", "WITH"):
        return {"error": f"only SELECT/WITH queries are allowed, got {head!r}"}
    banned = (
        " INSERT ",
        " UPDATE ",
        " DELETE ",
        " DROP ",
        " ALTER ",
        " CREATE ",
        " GRANT ",
        " REVOKE ",
        " TRUNCATE ",
        " COPY ",
        " EXECUTE ",
        " CALL ",
        " INTO ",
    )
    padded = f" {cleaned.upper()} "
    for token in banned:
        if token in padded:
            return {"error": f"forbidden SQL keyword:{token.strip()}"}

    spend = _estimate_sql_spend(cleaned)
    if spend["estimated_usd"] >= 0.01 and not confirm_spend:
        return {
            "approval_required": True,
            "spend_preview": spend,
            "tool": "query_sql",
            "args": {"sql": cleaned, "confirm_spend": True},
            "message": (
                f"Query spend preview ~${spend['estimated_usd']:.4f}. "
                "Confirm to run."
            ),
        }

    from eden.columnar.query import ColumnarQueryEngine

    engine = ColumnarQueryEngine()
    try:
        rows = await engine.execute(cleaned, params={"org_id": org_id})
        rows = rows[:500]
        return {
            "rows": rows,
            "row_count": len(rows),
            "spend_preview": spend,
            "org_id": org_id,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc), "spend_preview": spend}


# ============================================================================
# Tools — Navigate / filters (client-executed actions)
# ============================================================================

_PORTAL_PATH_PREFIXES: tuple[str, ...] = (
    "/traces",
    "/issues",
    "/alerts",
    "/sessions",
    "/debugger-sessions",
    "/artifacts",
    "/experiments",
    "/datasets",
    "/playgrounds",
    "/dashboard",
    "/improve",
    "/agents",
    "/evals",
    "/signals",
    "/promotions",
    "/debugger",
    "/ledger",
    "/fleet",
    "/synthetic",
    "/prompts",
    "/optimization",
    "/observability",
    "/labeling",
    "/settings",
    "/studio",
    "/audit-trail",
    "/analytics",
    "/guardrails",
)

# Removed portal surfaces — soft-land via next.config; never AI-navigate.
_REMOVED_PORTAL_PATH_PREFIXES: tuple[str, ...] = (
    "/marketplace",
    "/multi-agent",
    "/builder",
    "/jobs",
    "/eval-harnesses",
    "/sandbox",
    "/finops",
)


def _safe_portal_href(path: str) -> str | None:
    """Allow only relative portal paths (no scheme / open redirect)."""
    if not path or not isinstance(path, str):
        return None
    href = path.strip()
    if not href.startswith("/") or href.startswith("//"):
        return None
    if "://" in href or "\\" in href:
        return None
    base = href.split("?", 1)[0].split("#", 1)[0]
    if base == "/":
        return href
    if any(base == p or base.startswith(p + "/") for p in _REMOVED_PORTAL_PATH_PREFIXES):
        return None
    if any(base == p or base.startswith(p + "/") for p in _PORTAL_PATH_PREFIXES):
        return href
    return None


@insights_tool(
    name="navigate",
    description=(
        "Navigate the portal to a path (e.g. /traces, /issues, /alerts). "
        "Returns a client_action the UI executes. Prefer open_trace / "
        "open_issue when targeting a specific entity."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Portal path, optionally with query string.",
            },
        },
        "required": ["path"],
    },
)
async def navigate(org_id: str, path: str) -> dict[str, Any]:
    _ = org_id
    href = _safe_portal_href(path)
    if not href:
        return {"error": f"invalid or disallowed path: {path!r}"}
    return {
        "client_action": "navigate",
        "href": href,
        "message": f"Navigating to {href}",
    }


@insights_tool(
    name="propose_filter",
    description=(
        "Propose and apply a U08 query-language filter on a list page "
        "(typically /traces). Pass q like 'latency:>2 status:error "
        "agent:support'. Returns client_action propose_filter."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "q": {
                "type": "string",
                "description": "U08 filter string (agent:, status:, latency:, …).",
            },
            "path": {
                "type": "string",
                "description": "List path to apply on (default /traces).",
            },
        },
        "required": ["q"],
    },
)
async def propose_filter(
    org_id: str,
    q: str,
    path: str = "/traces",
) -> dict[str, Any]:
    from urllib.parse import quote

    _ = org_id
    query = (q or "").strip()
    if not query:
        return {"error": "q must be a non-empty filter string"}
    base = (path or "/traces").strip() or "/traces"
    if "?" in base:
        base = base.split("?", 1)[0]
    href = _safe_portal_href(f"{base}?q={quote(query)}")
    if not href:
        return {"error": f"invalid path for filter: {path!r}"}
    return {
        "client_action": "propose_filter",
        "q": query,
        "href": href,
        "path": base,
        "message": f"Applying filter on {base}: {query}",
    }


@insights_tool(
    name="find_similar",
    description=(
        "Find traces similar to a seed trace_id or free-text query "
        "(by error_type / agent / model). Returns matching traces and "
        "optionally a propose_filter client_action to browse them."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "Seed trace to find similars for.",
            },
            "query": {
                "type": "string",
                "description": "Free-text topic when no trace_id.",
            },
            "since": {
                "type": "string",
                "description": "Lower bound. Default: 7d.",
            },
            "limit": {
                "type": "integer",
                "description": "Max traces (default 15, max 50).",
                "minimum": 1,
                "maximum": 50,
            },
            "apply_filter": {
                "type": "boolean",
                "description": "If true, also return propose_filter client_action.",
            },
        },
    },
)
async def find_similar(
    org_id: str,
    trace_id: str | None = None,
    query: str | None = None,
    since: str = "7d",
    limit: int = 15,
    apply_filter: bool = True,
) -> dict[str, Any]:
    from urllib.parse import quote

    limit = max(1, min(int(limit), 50))
    seed: dict[str, Any] = {}
    search_q = (query or "").strip()

    if trace_id:
        client = await get_postgres_client()
        row = await client.fetchrow(
            """
            SELECT trace_id,
                   max(outcome) AS outcome,
                   max(COALESCE(model_name, attributes->>'model')) AS model,
                   max(error_type) AS error_type,
                   max(COALESCE(agent_id, attributes->>'agent_id')) AS agent_id
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            GROUP BY trace_id
            LIMIT 1
            """,
            org_id,
            trace_id,
        )
        if row:
            seed = {
                "trace_id": row["trace_id"],
                "outcome": row["outcome"],
                "model": row["model"],
                "error_type": row["error_type"],
                "agent_id": row["agent_id"],
            }
            if not search_q:
                search_q = (
                    (row["error_type"] or row["agent_id"] or row["model"] or "")
                    or ""
                ).strip()

    if not search_q and not seed:
        return {"error": "provide trace_id or query"}

    result = await search_traces(
        org_id=org_id,
        query=search_q or (seed.get("error_type") or "error"),
        since=since,
        limit=limit,
    )
    traces = [
        t
        for t in (result.get("traces") or [])
        if not trace_id or t.get("trace_id") != trace_id
    ]
    filter_parts: list[str] = []
    if seed.get("error_type"):
        filter_parts.append(f'text:"{seed["error_type"]}"')
    elif seed.get("agent_id"):
        filter_parts.append(f"agent:{seed['agent_id']}")
    elif search_q:
        filter_parts.append(f'text:"{search_q}"')
    filter_q = " ".join(filter_parts)
    out: dict[str, Any] = {
        "seed": seed or None,
        "query": search_q,
        "count": len(traces),
        "traces": traces,
    }
    if apply_filter and filter_q:
        href = f"/traces?q={quote(filter_q)}"
        out["client_action"] = "propose_filter"
        out["q"] = filter_q
        out["href"] = href
        out["message"] = f"Found {len(traces)} similar traces; applying filter."
    return out


@insights_tool(
    name="open_trace",
    description="Open a trace in the traces hub (client navigate).",
    input_schema={
        "type": "object",
        "properties": {
            "trace_id": {"type": "string", "description": "Trace id to open."},
        },
        "required": ["trace_id"],
    },
)
async def open_trace(org_id: str, trace_id: str) -> dict[str, Any]:
    _ = org_id
    tid = (trace_id or "").strip()
    if not tid:
        return {"error": "trace_id required"}
    from urllib.parse import quote

    href = f"/traces?traceId={quote(tid)}&trace_id={quote(tid)}"
    return {
        "client_action": "navigate",
        "href": href,
        "trace_id": tid,
        "message": f"Opening trace {tid}",
    }


@insights_tool(
    name="open_issue",
    description="Open an issue detail or issues hub (client navigate).",
    input_schema={
        "type": "object",
        "properties": {
            "issue_id": {"type": "string", "description": "Issue id to open."},
        },
        "required": ["issue_id"],
    },
)
async def open_issue(org_id: str, issue_id: str) -> dict[str, Any]:
    _ = org_id
    iid = (issue_id or "").strip()
    if not iid:
        return {"error": "issue_id required"}
    from urllib.parse import quote

    href = f"/issues/{quote(iid)}"
    return {
        "client_action": "navigate",
        "href": href,
        "issue_id": iid,
        "message": f"Opening issue {iid}",
    }


@insights_tool(
    name="open_session",
    description="Open a session timeline (client navigate).",
    input_schema={
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Session id."},
        },
        "required": ["session_id"],
    },
)
async def open_session(org_id: str, session_id: str) -> dict[str, Any]:
    _ = org_id
    sid = (session_id or "").strip()
    if not sid:
        return {"error": "session_id required"}
    from urllib.parse import quote

    href = f"/sessions/{quote(sid)}"
    return {
        "client_action": "navigate",
        "href": href,
        "session_id": sid,
        "message": f"Opening session {sid}",
    }


@insights_tool(
    name="open_alert",
    description="Open alerts hub, optionally focusing an alert id.",
    input_schema={
        "type": "object",
        "properties": {
            "alert_id": {
                "type": "string",
                "description": "Optional alert id to select.",
            },
        },
    },
)
async def open_alert(org_id: str, alert_id: str | None = None) -> dict[str, Any]:
    _ = org_id
    from urllib.parse import quote

    if alert_id and alert_id.strip():
        href = f"/alerts?alertId={quote(alert_id.strip())}"
    else:
        href = "/alerts"
    return {
        "client_action": "navigate",
        "href": href,
        "alert_id": (alert_id or "").strip() or None,
        "message": f"Opening {href}",
    }


@insights_tool(
    name="open_artifact",
    description="Open artifacts hub, optionally focusing an artifact id.",
    input_schema={
        "type": "object",
        "properties": {
            "artifact_id": {
                "type": "string",
                "description": "Optional artifact id.",
            },
        },
    },
)
async def open_artifact(
    org_id: str,
    artifact_id: str | None = None,
) -> dict[str, Any]:
    _ = org_id
    from urllib.parse import quote

    if artifact_id and artifact_id.strip():
        href = f"/artifacts?artifactId={quote(artifact_id.strip())}"
    else:
        href = "/artifacts"
    return {
        "client_action": "navigate",
        "href": href,
        "artifact_id": (artifact_id or "").strip() or None,
        "message": f"Opening {href}",
    }


# ============================================================================
# Tools — Datasets / experiments / playgrounds (W23)
# ============================================================================


@insights_tool(
    name="list_datasets",
    description="List org datasets (id, name, row/version counts).",
    input_schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Max rows (default 20, max 50).",
            },
        },
    },
)
async def list_datasets(org_id: str, limit: int = 20) -> dict[str, Any]:
    from eden.datasets.hub import DatasetHub

    lim = max(1, min(int(limit or 20), 50))
    hub = DatasetHub()
    rows = await hub.list_datasets(org_id, limit=lim)
    return {
        "datasets": [r.to_dict() for r in rows],
        "total": len(rows),
        "href": "/datasets",
    }


@insights_tool(
    name="create_dataset",
    description=(
        "Create a dataset (approval-gated write). Pass name + optional "
        "description / source_ref."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Dataset name."},
            "description": {"type": "string"},
            "source_type": {"type": "string"},
            "source_ref": {"type": "string"},
        },
        "required": ["name"],
    },
)
async def create_dataset(
    org_id: str,
    name: str,
    description: str = "",
    source_type: str = "manual",
    source_ref: str | None = None,
) -> dict[str, Any]:
    from eden.datasets.hub import DatasetHub

    hub = DatasetHub()
    rec = await hub.create_dataset(
        org_id,
        name=(name or "").strip() or "Untitled dataset",
        description=description or "",
        source_type=source_type or "manual",
        source_ref=source_ref,
    )
    return {
        "dataset": rec.to_dict(),
        "href": f"/datasets/{rec.id}",
        "message": f"Created dataset {rec.name}",
    }


@insights_tool(
    name="promote_trace_to_dataset",
    description=(
        "Append a production trace into a dataset (approval-gated). "
        "Creates the dataset when dataset_id is omitted."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "trace_id": {"type": "string"},
            "dataset_id": {"type": "string"},
            "dataset_name": {"type": "string"},
        },
        "required": ["trace_id"],
    },
)
async def promote_trace_to_dataset(
    org_id: str,
    trace_id: str,
    dataset_id: str | None = None,
    dataset_name: str | None = None,
) -> dict[str, Any]:
    from eden.datasets.hub import DatasetHub

    hub = DatasetHub()
    result = await hub.promote_trace(
        org_id,
        (trace_id or "").strip(),
        dataset_id=dataset_id,
        dataset_name=dataset_name,
    )
    return {"status": "ok", "data": result, "href": "/datasets"}


@insights_tool(
    name="list_experiments",
    description="List offline experiments for the org (F51).",
    input_schema={
        "type": "object",
        "properties": {
            "limit": {"type": "integer"},
        },
    },
)
async def list_experiments(org_id: str, limit: int = 20) -> dict[str, Any]:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    lim = max(1, min(int(limit or 20), 50))
    runner = OfflineExperimentRunner()
    exps = await runner.list_experiments(org_id, limit=lim)
    return {"experiments": exps, "total": len(exps), "href": "/experiments"}


@insights_tool(
    name="summarize_experiment",
    description=(
        "Summarize experiment deltas vs baseline (compare grid). "
        "Pass experiment_id and optional baseline_id."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "experiment_id": {"type": "string"},
            "baseline_id": {"type": "string"},
        },
        "required": ["experiment_id"],
    },
)
async def summarize_experiment(
    org_id: str,
    experiment_id: str,
    baseline_id: str | None = None,
) -> dict[str, Any]:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    runner = OfflineExperimentRunner()
    try:
        result = await runner.compare(
            org_id, experiment_id, baseline_id=baseline_id
        )
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}
    return {
        "status": "ok",
        "compare": result,
        "href": f"/experiments?id={experiment_id}",
    }


@insights_tool(
    name="create_experiment",
    description=(
        "Create an offline experiment bound to a dataset (approval-gated)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "dataset_id": {"type": "string"},
            "config": {"type": "object"},
            "baseline_experiment_id": {"type": "string"},
            "source_issue_id": {"type": "string"},
        },
        "required": ["name", "dataset_id"],
    },
)
async def create_experiment(
    org_id: str,
    name: str,
    dataset_id: str,
    config: dict[str, Any] | None = None,
    baseline_experiment_id: str | None = None,
    source_issue_id: str | None = None,
) -> dict[str, Any]:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    runner = OfflineExperimentRunner()
    exp = await runner.create(
        org_id,
        name=(name or "").strip() or "Untitled experiment",
        dataset_id=dataset_id,
        config=config or {},
        baseline_experiment_id=baseline_experiment_id,
        source_issue_id=source_issue_id,
    )
    return {
        "experiment": exp.to_dict(),
        "href": "/experiments",
        "message": f"Created experiment {exp.name}",
    }


@insights_tool(
    name="list_playgrounds",
    description="List prompt playgrounds for the org (F49).",
    input_schema={
        "type": "object",
        "properties": {
            "limit": {"type": "integer"},
        },
    },
)
async def list_playgrounds(org_id: str, limit: int = 20) -> dict[str, Any]:
    from eden.playground.service import PlaygroundService

    lim = max(1, min(int(limit or 20), 50))
    svc = PlaygroundService()
    items = await svc.list(org_id, limit=lim)
    return {
        "playgrounds": [p.to_dict() for p in items],
        "total": len(items),
        "href": "/playgrounds",
    }


@insights_tool(
    name="create_playground",
    description="Create a prompt playground (approval-gated write).",
    input_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "config": {"type": "object"},
        },
        "required": ["name"],
    },
)
async def create_playground(
    org_id: str,
    name: str,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from eden.playground.service import PlaygroundService

    svc = PlaygroundService()
    rec = await svc.create(
        org_id, name=(name or "").strip() or "Untitled playground", config=config or None
    )
    return {
        "playground": rec.to_dict(),
        "href": f"/playgrounds?id={rec.id}",
        "message": f"Created playground {rec.name}",
    }


@insights_tool(
    name="playground_from_span",
    description=(
        "Open a playground seeded from a trace/span (approval-gated write)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "trace_id": {"type": "string"},
            "span_id": {"type": "string"},
            "model": {"type": "string"},
        },
        "required": ["trace_id"],
    },
)
async def playground_from_span(
    org_id: str,
    trace_id: str,
    span_id: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    from eden.playground.service import PlaygroundService

    svc = PlaygroundService()
    rec = await svc.from_span(
        org_id,
        trace_id=(trace_id or "").strip(),
        span_id=span_id,
        messages=[],
        model=model,
        tools=[],
    )
    return {
        "playground": rec.to_dict(),
        "href": f"/playgrounds?id={rec.id}",
        "message": f"Playground from span on {trace_id}",
    }


@insights_tool(
    name="estimate_chat_cost",
    description=(
        "Estimate USD cost for a ChatSidebar turn given model + token sizes. "
        "Call before long / multi-tool runs."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "model": {"type": "string"},
            "prompt_tokens": {"type": "integer"},
            "completion_tokens": {"type": "integer"},
            "tier": {"type": "string", "description": "ignored — chat is always t2"},
        },
    },
)
async def estimate_chat_cost(
    org_id: str,
    model: str | None = None,
    prompt_tokens: int = 2500,
    completion_tokens: int = 800,
    tier: str = "t2",
) -> dict[str, Any]:
    _ = org_id, model, tier
    from eden.llmops.chat_sota import (
        estimate_turn_cost_usd,
        model_for_tier,
        ttft_budget_ms,
    )
    from eden.optimization.model_router import ModelTier

    chosen = model_for_tier(ModelTier.T2)
    used_tier = "t2"
    est = estimate_turn_cost_usd(
        chosen,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
    est["tier"] = used_tier
    est["ttft_budget_ms"] = ttft_budget_ms(used_tier)
    est["spend_preview"] = {
        "estimated_usd": est["estimated_usd"],
        "model": chosen,
        "tier": used_tier,
    }
    return est


@insights_tool(
    name="tail_live_trace",
    description=(
        "N11 — open a live session in the traces hub and report recent "
        "buffered live events (portal Live badge / SSE)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "session_id": {
                "type": "string",
                "description": "Live session id (or in-flight trace id).",
            },
            "from_event_id": {
                "type": "integer",
                "description": "Resume after this event id.",
            },
            "max_events": {"type": "integer"},
        },
        "required": ["session_id"],
    },
)
async def tail_live_trace(
    org_id: str,
    session_id: str,
    from_event_id: int = 0,
    max_events: int = 40,
) -> dict[str, Any]:
    from urllib.parse import quote

    sid = (session_id or "").strip()
    if not sid:
        return {"error": "session_id required"}

    events: list[dict[str, Any]] = []
    try:
        from eden.observability.live.publisher import LiveTracePublisher

        buffered = await LiveTracePublisher().drain_buffer(org_id, sid)
        events = [
            e
            for e in buffered
            if int(e.get("event_id") or 0) > int(from_event_id or 0)
        ][: max(1, min(int(max_events or 40), 200))]
    except Exception as exc:
        logger.debug("tail_live_trace buffer: %s", exc)

    href = f"/traces?traceId={quote(sid)}&live=1&session={quote(sid)}"
    return {
        "session_id": sid,
        "events": events,
        "count": len(events),
        "feature": "live_trace_streaming",
        "client_action": "navigate",
        "href": href,
        "message": (
            f"Opened live tail for session {sid} "
            f"({len(events)} buffered events)."
        ),
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
