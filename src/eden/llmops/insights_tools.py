"""Eden LLMOps — AI Insights tool registry.

Server-side tools exposed to the AI Insights chat assistant. These
are NOT exposed as public HTTP routes — they are direct DB/service
calls invoked from the SSE chat endpoint.

Each tool is a Python async function decorated with ``@insights_tool``
so the route layer can both:

  1. Render the tool in an Anthropic ``tools`` array (name +
     description + JSON schema), and
  2. Dispatch the tool by name when Claude emits a ``tool_use``
     block.

The data sources come from the worktree's existing PostgreSQL
schema: ``jobs`` (the main workload table), ``code_references``
(the org's reference library), and ``graph_entities`` /
``skills`` / ``exploits`` (the KB layers). All are scoped to the
caller's ``org_id`` so we never leak across tenants.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


# ============================================================================
# Tool registry
# ============================================================================

class InsightsTool:
    """A single server-side tool exposed to the Claude chat assistant.

    The ``input_schema`` follows the Anthropic tool schema spec:
    JSON Schema with ``type: object``, ``properties`` and ``required``.
    """

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
        """Render this tool as the Anthropic API expects it."""
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
    """Accept an ISO-8601 timestamp or a relative phrase like '24h' / '7d'.

    The relative parser keeps the model from having to compute dates
    itself (which is a known source of timezone / off-by-one bugs).
    """
    if not since:
        return datetime.now(UTC) - timedelta(hours=24)
    s = since.strip().lower()
    if s.endswith("h") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(hours=int(s[:-1]))
    if s.endswith("d") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(days=int(s[:-1]))
    if s.endswith("m") and s[:-1].isdigit():
        return datetime.now(UTC) - timedelta(minutes=int(s[:-1]))
    # Fall back to ISO-8601; accept a trailing 'Z'.
    try:
        return datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError:
        # Default to last 24h if the input is unparseable — fail safe.
        logger.warning(f"insights_tools: unparseable since={since!r}; defaulting to 24h")
        return datetime.now(UTC) - timedelta(hours=24)


# ============================================================================
# Tools
# ============================================================================

@insights_tool(
    name="list_jobs",
    description=(
        "List recent Eden jobs in this org. Use for questions like "
        "'what's been running today' or 'how many jobs are pending'. "
        "Returns job_id, status, outcome_tier, environment_class, and "
        "created_at. Limited to the most recent ``limit`` rows "
        "(default 25, max 200)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Maximum number of jobs to return (default 25, max 200).",
                "minimum": 1,
                "maximum": 200,
            },
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or a "
                    "relative phrase like '24h', '7d', '30m'. Default: 24h."
                ),
            },
            "status": {
                "type": "string",
                "description": (
                    "Optional status filter — e.g. 'running', 'completed', "
                    "'failed', 'pending', 'human_review'."
                ),
            },
        },
    },
)
async def list_jobs(
    org_id: str,
    limit: int = 25,
    since: str = "24h",
    status: str | None = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    if status:
        rows = await client.fetch(
            """
            SELECT job_id, status, outcome_tier, environment_class, created_at, updated_at
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2 AND status = $3
            ORDER BY created_at DESC
            LIMIT $4
            """,
            org_id, cutoff, status, limit,
        )
    else:
        rows = await client.fetch(
            """
            SELECT job_id, status, outcome_tier, environment_class, created_at, updated_at
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            org_id, cutoff, limit,
        )

    return {
        "count": len(rows),
        "since": cutoff.isoformat(),
        "status_filter": status,
        "jobs": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "environment_class": r["environment_class"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ],
    }


@insights_tool(
    name="summarize_jobs",
    description=(
        "Aggregate job counts by status and outcome_tier over a time "
        "window. Use for 'how are jobs going today' or 'how many "
        "Gold-tier environments did we ship this week'."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or a "
                    "relative phrase like '24h', '7d', '30m'. Default: 7d."
                ),
            },
        },
    },
)
async def summarize_jobs(
    org_id: str,
    since: str = "7d",
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    by_status = await client.fetch(
        """
        SELECT status, COUNT(*) AS n
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY status
        ORDER BY n DESC
        """,
        org_id, cutoff,
    )
    by_outcome = await client.fetch(
        """
        SELECT outcome_tier, COUNT(*) AS n
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2 AND outcome_tier IS NOT NULL
        GROUP BY outcome_tier
        ORDER BY n DESC
        """,
        org_id, cutoff,
    )

    return {
        "since": cutoff.isoformat(),
        "by_status": [{"status": r["status"], "count": r["n"]} for r in by_status],
        "by_outcome": [{"outcome_tier": r["outcome_tier"], "count": r["n"]} for r in by_outcome],
    }


@insights_tool(
    name="get_job",
    description=(
        "Fetch the full record for a single job by job_id, including "
        "status, outcome, latest quality metrics, and timestamps. Use "
        "this when the user wants details on a specific run."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "job_id": {
                "type": "string",
                "description": "The job_id (e.g. 'job_abc123') to fetch.",
            },
        },
        "required": ["job_id"],
    },
)
async def get_job(
    org_id: str,
    job_id: str,
) -> dict[str, Any]:
    client = await get_postgres_client()
    row = await client.fetchrow(
        """
        SELECT job_id, status, outcome_tier, environment_class,
               created_at, updated_at, completed_at, quality_metrics
        FROM jobs
        WHERE org_id = $1 AND job_id = $2
        """,
        org_id, job_id,
    )
    if not row:
        return {"found": False, "job_id": job_id}
    return {
        "found": True,
        "job": {
            "job_id": row["job_id"],
            "status": row["status"],
            "outcome_tier": row["outcome_tier"],
            "environment_class": row["environment_class"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
            "quality_metrics": row["quality_metrics"],
        },
    }


@insights_tool(
    name="list_recent_references",
    description=(
        "List the most recently uploaded code references in this org. "
        "References are short code samples the org has saved to its "
        "library (auth patterns, API conventions, etc.)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Maximum number of references to return (default 20).",
                "minimum": 1,
                "maximum": 100,
            },
            "language": {
                "type": "string",
                "description": "Optional language filter (e.g. 'python', 'typescript').",
            },
        },
    },
)
async def list_recent_references(
    org_id: str,
    limit: int = 20,
    language: str | None = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    client = await get_postgres_client()

    if language:
        rows = await client.fetch(
            """
            SELECT name, description, language, purpose, filename, created_at
            FROM code_references
            WHERE org_id = $1 AND language = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            org_id, language, limit,
        )
    else:
        rows = await client.fetch(
            """
            SELECT name, description, language, purpose, filename, created_at
            FROM code_references
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id, limit,
        )

    return {
        "count": len(rows),
        "language_filter": language,
        "references": [
            {
                "name": r["name"],
                "description": r["description"],
                "language": r["language"],
                "purpose": r["purpose"],
                "filename": r["filename"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ],
    }


@insights_tool(
    name="search_jobs",
    description=(
        "Full-text search over Eden job descriptions for this org. "
        "Use when the user wants to find jobs mentioning a topic — "
        "e.g. 'cartpole jobs' or 'multi-agent jobs last week'."
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
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or a "
                    "relative phrase like '24h', '7d', '30m'. Default: 30d."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of jobs to return (default 25).",
                "minimum": 1,
                "maximum": 100,
            },
        },
        "required": ["query"],
    },
)
async def search_jobs(
    org_id: str,
    query: str,
    since: str = "30d",
    limit: int = 25,
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    limit = max(1, min(int(limit), 100))
    client = await get_postgres_client()

    # ``request`` is JSONB; we cast to text for the FTS index.
    rows = await client.fetch(
        """
        SELECT job_id, status, outcome_tier, created_at,
               ts_rank(to_tsvector('english', request::text),
                       plainto_tsquery('english', $2)) AS rank
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $3
          AND to_tsvector('english', request::text)
              @@ plainto_tsquery('english', $2)
        ORDER BY rank DESC, created_at DESC
        LIMIT $4
        """,
        org_id, query, cutoff, limit,
    )

    return {
        "query": query,
        "since": cutoff.isoformat(),
        "count": len(rows),
        "jobs": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "rank": float(r["rank"]) if r["rank"] is not None else 0.0,
            }
            for r in rows
        ],
    }


@insights_tool(
    name="get_traces_by_filter",
    description=(
        "Ad-hoc query: list jobs matching arbitrary filters. Use for "
        "questions that don't fit a more specific tool. Returns the "
        "same shape as list_jobs. Supports status, environment_class, "
        "and outcome_tier filters."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "description": (
                    "Filter to jobs in this status, e.g. 'running', "
                    "'completed', 'failed', 'pending', 'human_review'."
                ),
            },
            "environment_class": {
                "type": "string",
                "description": (
                    "Filter to jobs of this environment class, e.g. "
                    "'rl_training', 'code_eval', 'agentic', 'bench'."
                ),
            },
            "outcome_tier": {
                "type": "string",
                "description": (
                    "Filter to jobs with this outcome tier, e.g. "
                    "'Gold', 'Silver', 'Bronze', 'Partial', 'Failed'."
                ),
            },
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or a "
                    "relative phrase like '24h', '7d', '30m'. Default: 7d."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of jobs to return (default 50, max 200).",
                "minimum": 1,
                "maximum": 200,
            },
        },
    },
)
async def get_traces_by_filter(
    org_id: str,
    since: str = "7d",
    status: str | None = None,
    environment_class: str | None = None,
    outcome_tier: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    limit = max(1, min(int(limit), 200))

    clauses = ["org_id = $1", "created_at >= $2"]
    args: list[Any] = [org_id, cutoff]
    if status:
        args.append(status)
        clauses.append(f"status = ${len(args)}")
    if environment_class:
        args.append(environment_class)
        clauses.append(f"environment_class = ${len(args)}")
    if outcome_tier:
        args.append(outcome_tier)
        clauses.append(f"outcome_tier = ${len(args)}")
    args.append(limit)
    limit_idx = len(args)

    sql = f"""
        SELECT job_id, status, outcome_tier, environment_class, created_at, updated_at
        FROM jobs
        WHERE {' AND '.join(clauses)}
        ORDER BY created_at DESC
        LIMIT ${limit_idx}
    """

    client = await get_postgres_client()
    rows = await client.fetch(sql, *args)
    return {
        "count": len(rows),
        "filters": {
            "status": status,
            "environment_class": environment_class,
            "outcome_tier": outcome_tier,
            "since": cutoff.isoformat(),
        },
        "jobs": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "environment_class": r["environment_class"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ],
    }


# ============================================================================
# Tool dispatch
# ============================================================================

@insights_tool(
    name="get_latency_p95",
    description=(
        "Compute the 95th-percentile of Eden job durations in this org. "
        "Durations are derived from created_at → completed_at for jobs "
        "that have completed. Use for 'how slow is the pipeline' or "
        "'what's the p95 of the last 7d'."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or "
                    "'24h', '7d', '30m'. Default: 7d."
                ),
            },
        },
    },
)
async def get_latency_p95(
    org_id: str,
    since: str = "7d",
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT
            EXTRACT(EPOCH FROM (completed_at - created_at)) AS duration_s
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND completed_at IS NOT NULL
        """,
        org_id, cutoff,
    )
    durations = sorted(
        float(r["duration_s"]) for r in rows
        if r["duration_s"] is not None
    )
    if not durations:
        return {
            "since": cutoff.isoformat(),
            "sample_size": 0,
            "p50_s": None,
            "p95_s": None,
            "p99_s": None,
            "note": "No completed jobs in window",
        }
    n = len(durations)

    def _pct(p: float) -> float:
        if n == 1:
            return durations[0]
        idx = max(0, min(n - 1, int(round((p / 100.0) * (n - 1)))))
        return durations[idx]

    return {
        "since": cutoff.isoformat(),
        "sample_size": n,
        "p50_s": round(_pct(50), 3),
        "p95_s": round(_pct(95), 3),
        "p99_s": round(_pct(99), 3),
    }


@insights_tool(
    name="get_cost_breakdown",
    description=(
        "Estimate cost breakdown for Eden jobs in this org, broken "
        "down by environment_class and outcome_tier. Costs are "
        "derived from a heuristic cost-per-job table since Eden "
        "doesn't bill directly; this is best-effort for budget "
        "conversations."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or "
                    "'24h', '7d', '30m'. Default: 30d."
                ),
            },
        },
    },
)
async def get_cost_breakdown(
    org_id: str,
    since: str = "30d",
) -> dict[str, Any]:
    # Heuristic cost per job in USD. Tune with the finance team; this
    # is intentionally simple so the model has a number to cite.
    cost_per_env: dict[str, float] = {
        "rl_training": 12.0,
        "code_eval": 0.85,
        "agentic": 4.50,
        "bench": 1.20,
    }
    default_cost = 2.0
    cutoff = _parse_since(since)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT environment_class, outcome_tier, COUNT(*) AS n
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY environment_class, outcome_tier
        """,
        org_id, cutoff,
    )
    by_env: dict[str, float] = {}
    by_outcome: dict[str, float] = {}
    total = 0.0
    for r in rows:
        env = r["environment_class"] or "unknown"
        tier = r["outcome_tier"] or "unknown"
        n = int(r["n"])
        cost = cost_per_env.get(env, default_cost) * n
        by_env[env] = by_env.get(env, 0.0) + cost
        by_outcome[tier] = by_outcome.get(tier, 0.0) + cost
        total += cost
    return {
        "since": cutoff.isoformat(),
        "currency": "USD",
        "estimated_total": round(total, 2),
        "by_environment_class": {k: round(v, 2) for k, v in by_env.items()},
        "by_outcome_tier": {k: round(v, 2) for k, v in by_outcome.items()},
        "note": (
            "Heuristic cost model — actual billing may differ. "
            "Use for relative comparisons, not invoices."
        ),
    }


@insights_tool(
    name="get_judge_scores",
    description=(
        "Aggregate judge / verifier scores for Eden jobs in this org. "
        "Eden stores critic decisions, verifier reports, and tester "
        "results in JSONB columns on the jobs table. This tool surfaces "
        "a summary (count of jobs with critiques, pass/fail ratios, "
        "top issue tags)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or "
                    "'24h', '7d', '30m'. Default: 7d."
                ),
            },
        },
    },
)
async def get_judge_scores(
    org_id: str,
    since: str = "7d",
) -> dict[str, Any]:
    cutoff = _parse_since(since)
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT
            job_id,
            critic_decisions,
            verifier_report,
            tester_results
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        """,
        org_id, cutoff,
    )
    total = len(rows)
    with_critique = 0
    verifier_pass = 0
    verifier_fail = 0
    tester_pass = 0
    tester_fail = 0
    for r in rows:
        if r["critic_decisions"]:
            with_critique += 1
        v = r["verifier_report"]
        if v and isinstance(v, dict):
            if v.get("passed") is True:
                verifier_pass += 1
            elif v.get("passed") is False:
                verifier_fail += 1
        t = r["tester_results"]
        if t and isinstance(t, dict):
            if t.get("passed") is True:
                tester_pass += 1
            elif t.get("passed") is False:
                tester_fail += 1
    return {
        "since": cutoff.isoformat(),
        "sample_size": total,
        "critic_coverage": {
            "with_critique": with_critique,
            "without_critique": total - with_critique,
        },
        "verifier": {"pass": verifier_pass, "fail": verifier_fail},
        "tester": {"pass": tester_pass, "fail": tester_fail},
    }


@insights_tool(
    name="get_anomalies",
    description=(
        "Heuristically flag anomalous jobs in the recent window. "
        "Anomalies are: (a) jobs that ran much longer than the org's "
        "median duration, (b) jobs whose status is stuck (no update "
        "in >1h), (c) jobs with a non-null outcome_tier but no "
        "verifier_report. Returns the most suspicious N rows."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or "
                    "'24h', '7d', '30m'. Default: 24h."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "Max anomalies to return (default 20, max 100).",
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

    # Slow jobs: top decile by duration.
    slow = await client.fetch(
        """
        SELECT job_id, status, outcome_tier, created_at, completed_at,
               EXTRACT(EPOCH FROM (completed_at - created_at)) AS duration_s
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND completed_at IS NOT NULL
        ORDER BY duration_s DESC
        LIMIT $3
        """,
        org_id, cutoff, limit,
    )

    # Stuck jobs: status not in (completed, failed) and updated_at < now-1h.
    stuck = await client.fetch(
        """
        SELECT job_id, status, outcome_tier, created_at, updated_at,
               EXTRACT(EPOCH FROM (NOW() - updated_at)) AS stale_s
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND status NOT IN ('completed', 'failed', 'cancelled')
          AND updated_at < NOW() - INTERVAL '1 hour'
        ORDER BY updated_at ASC
        LIMIT $3
        """,
        org_id, cutoff, limit,
    )

    # Outcome-without-verifier: quality_reports present but no verifier_report.
    missing_verify = await client.fetch(
        """
        SELECT job_id, status, outcome_tier, created_at
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND outcome_tier IS NOT NULL
          AND (verifier_report IS NULL
               OR (verifier_report::text = 'null')
               OR (verifier_report::text = '{}'))
        ORDER BY created_at DESC
        LIMIT $3
        """,
        org_id, cutoff, limit,
    )

    return {
        "since": cutoff.isoformat(),
        "slow": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "duration_s": float(r["duration_s"]) if r["duration_s"] else None,
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in slow
        ],
        "stuck": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "stale_s": float(r["stale_s"]) if r["stale_s"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in stuck
        ],
        "missing_verification": [
            {
                "job_id": r["job_id"],
                "status": r["status"],
                "outcome_tier": r["outcome_tier"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in missing_verify
        ],
    }


@insights_tool(
    name="get_insights",
    description=(
        "High-level health summary for this org: job counts, outcome "
        "distribution, average quality, p95 latency. Use this as a "
        "default first call when the user asks an open-ended 'how is "
        "Eden doing' question."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Lower bound on created_at. Accepts ISO-8601 or "
                    "'24h', '7d', '30m'. Default: 7d."
                ),
            },
        },
    },
)
async def get_insights(
    org_id: str,
    since: str = "7d",
) -> dict[str, Any]:
    """Compose the answer from the lower-level tools, with a single
    DB round-trip per query."""
    cutoff = _parse_since(since)
    client = await get_postgres_client()

    by_status_rows = await client.fetch(
        """
        SELECT status, COUNT(*) AS n
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2
        GROUP BY status
        ORDER BY n DESC
        """,
        org_id, cutoff,
    )
    by_outcome_rows = await client.fetch(
        """
        SELECT outcome_tier, COUNT(*) AS n
        FROM jobs
        WHERE org_id = $1 AND created_at >= $2 AND outcome_tier IS NOT NULL
        GROUP BY outcome_tier
        ORDER BY n DESC
        """,
        org_id, cutoff,
    )
    durations = await client.fetch(
        """
        SELECT EXTRACT(EPOCH FROM (completed_at - created_at)) AS d
        FROM jobs
        WHERE org_id = $1
          AND created_at >= $2
          AND completed_at IS NOT NULL
        """,
        org_id, cutoff,
    )
    duration_list: list[float] = sorted(
        float(r["d"]) for r in durations if r["d"] is not None
    )
    n = len(duration_list)

    def _pct(p: float) -> float | None:
        if n == 0:
            return None
        if n == 1:
            return duration_list[0]
        idx = max(0, min(n - 1, int(round((p / 100.0) * (n - 1)))))
        return duration_list[idx]

    return {
        "since": cutoff.isoformat(),
        "job_counts_by_status": {
            r["status"]: int(r["n"]) for r in by_status_rows
        },
        "job_counts_by_outcome": {
            r["outcome_tier"]: int(r["n"]) for r in by_outcome_rows
        },
        "latency_s": {
            "sample_size": n,
            "p50": round(float(p50), 3) if (p50 := _pct(50)) is not None else None,
            "p95": round(float(p95), 3) if (p95 := _pct(95)) is not None else None,
        },
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

    The shape mirrors what the chat route puts in the SSE stream's
    ``tool_result`` event: ``{tool, status, output, duration_ms}``.
    Errors are caught and turned into a non-throwing error envelope
    so Claude can react to them mid-conversation.
    """
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
        # ``result`` is a JSON-serializable dict from every tool above.
        # If a tool returns something exotic, fall back to a string repr
        # so the chat route's ``json.dumps`` doesn't blow up.
        try:
            json.dumps(result)
            output = result
        except (TypeError, ValueError):
            output = {"text": str(result)}
        return {"tool": name, "status": "ok", "output": output, "duration_ms": duration_ms}
    except Exception as exc:  # noqa: BLE001 — top-level guard
        duration_ms = int((time.perf_counter() - started) * 1000)
        logger.exception(f"insights tool {name!r} failed: {exc}")
        return {
            "tool": name,
            "status": "error",
            "output": f"{type(exc).__name__}: {exc}",
            "duration_ms": duration_ms,
        }
