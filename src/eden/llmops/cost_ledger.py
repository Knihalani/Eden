"""Customer CostEvent ledger — write-through for tagged LLM exits (SOTA W7).

Every customer-visible LLM path should call :func:`record_cost_event` (or
rely on OpenRouterClient/_log_usage write-through under :func:`cost_context`).

Attribution dimensions: org, feature, model, tokens, cost_usd, request_id,
optional trace_id / agent_id / session_id / user_id.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.util.jsonx import dumps as json_dumps

logger = logging.getLogger(__name__)

KNOWN_FEATURES: frozenset[str] = frozenset(
    {
        "judges",
        "triage",
        "evolution",
        "promote",
        "online_slm",
        "online_llm",
        "chat_sidebar",
        "patches",
        "embeddings",
        "gateway",
        "nudge_author",
        "autonomy",
        "signal_classifier",
        "signal_investigator",
        "playground",
        "unknown",
    }
)

_org_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_org_id", default=None
)
_feature: contextvars.ContextVar[str] = contextvars.ContextVar(
    "cost_ledger_feature", default="unknown"
)
_trace_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_trace_id", default=None
)
_agent_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_agent_id", default=None
)
_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_session_id", default=None
)
_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_user_id", default=None
)
_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "cost_ledger_request_id", default=None
)


@dataclass
class CostEvent:
    """Durable customer cost attribution row."""

    org_id: str
    feature: str
    model: str
    cost_usd: float
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    request_id: str | None = None
    trace_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    recorded_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def normalized_feature(self) -> str:
        f = (self.feature or "unknown").strip().lower()
        return f if f in KNOWN_FEATURES else "unknown"


@contextmanager
def cost_context(
    org_id: str | None = None,
    feature: str = "unknown",
    *,
    trace_id: str | None = None,
    agent_id: str | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    request_id: str | None = None,
) -> Iterator[None]:
    """Bind attribution context for nested OpenRouter / ModelRouter calls."""
    tokens: list[tuple[contextvars.ContextVar[Any], Any]] = []
    if org_id is not None:
        tokens.append((_org_id, _org_id.set(org_id)))
    tokens.append((_feature, _feature.set((feature or "unknown").lower())))
    if trace_id is not None:
        tokens.append((_trace_id, _trace_id.set(trace_id)))
    if agent_id is not None:
        tokens.append((_agent_id, _agent_id.set(agent_id)))
    if session_id is not None:
        tokens.append((_session_id, _session_id.set(session_id)))
    if user_id is not None:
        tokens.append((_user_id, _user_id.set(user_id)))
    if request_id is not None:
        tokens.append((_request_id, _request_id.set(request_id)))
    try:
        yield
    finally:
        for var, tok in reversed(tokens):
            var.reset(tok)


def current_cost_context() -> dict[str, Any]:
    return {
        "org_id": _org_id.get(),
        "feature": _feature.get() or "unknown",
        "trace_id": _trace_id.get(),
        "agent_id": _agent_id.get(),
        "session_id": _session_id.get(),
        "user_id": _user_id.get(),
        "request_id": _request_id.get(),
    }


def schedule_record_from_usage(
    *,
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    cost_usd: float | None = None,
    org_id: str | None = None,
    feature: str | None = None,
) -> None:
    """Best-effort fire-and-forget from sync OpenRouter ``_log_usage``."""
    ctx = current_cost_context()
    oid = org_id or ctx.get("org_id")
    if not oid:
        return
    feat = (feature or ctx.get("feature") or "unknown").lower()
    event = CostEvent(
        org_id=str(oid),
        feature=feat,
        model=model or "unknown",
        cost_usd=float(cost_usd or 0.0),
        input_tokens=int(prompt_tokens or 0),
        output_tokens=int(completion_tokens or 0),
        total_tokens=int(total_tokens or (prompt_tokens + completion_tokens)),
        request_id=ctx.get("request_id"),
        trace_id=ctx.get("trace_id"),
        agent_id=ctx.get("agent_id"),
        session_id=ctx.get("session_id"),
        user_id=ctx.get("user_id"),
    )
    try:
        # Presence check only — bounded_create_task below needs a running
        # loop, and there is nothing to schedule onto without one.
        asyncio.get_running_loop()
    except RuntimeError:
        return
    from eden.async_tasks import bounded_create_task

    bounded_create_task(_safe_record(event), name="cost-ledger-record")


async def _safe_record(event: CostEvent) -> None:
    try:
        await record_cost_event(event)
    except Exception as exc:
        logger.debug("cost_ledger: schedule record failed: %s", exc)


async def record_cost_event(event: CostEvent) -> bool:
    """Persist a CostEvent to Postgres and align budget_consumption.

    Returns True when the ledger row was written. Best-effort: never raises
    to callers on the LLM hot path.
    """
    if not event.org_id:
        return False
    feature = event.normalized_feature()
    cost = float(event.cost_usd or 0.0)
    total_tokens = int(
        event.total_tokens
        or (int(event.input_tokens or 0) + int(event.output_tokens or 0))
    )
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("cost_ledger: postgres unavailable: %s", exc)
        return False
    if client is None:
        return False

    row_id = uuid.uuid4()
    try:
        await client.execute(
            """
            INSERT INTO customer_cost_events (
                id, org_id, feature, model, cost_usd,
                input_tokens, output_tokens, total_tokens,
                request_id, trace_id, agent_id, session_id, user_id,
                metadata, recorded_at
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11, $12, $13,
                $14::jsonb, NOW()
            )
            """,
            row_id,
            event.org_id,
            feature,
            event.model or "unknown",
            cost,
            int(event.input_tokens or 0),
            int(event.output_tokens or 0),
            total_tokens,
            event.request_id,
            event.trace_id,
            event.agent_id,
            event.session_id,
            event.user_id,
            json_dumps(event.metadata or {}),
        )
    except Exception as exc:
        logger.debug("cost_ledger: insert failed: %s", exc)
        return False

    # $0 events do not change budget consumption — skip usage + alert
    # round-trips on the LLM hot path.
    if cost > 0:
        try:
            from eden.services.budget_service import record_usage

            await record_usage(event.org_id, cost)
        except Exception as exc:
            logger.debug("cost_ledger: budget record_usage failed: %s", exc)

        try:
            from eden.services.budget_service import evaluate_budget_alerts

            await evaluate_budget_alerts(event.org_id)
        except Exception as exc:
            logger.debug("cost_ledger: alert eval failed: %s", exc)

    return True


async def sum_feature_spend_today(
    org_id: str,
    *,
    features: tuple[str, ...] = ("patches", "autonomy"),
) -> float:
    """Sum today's customer_cost_events for the given feature tags (N20 budgets)."""
    if not features:
        return 0.0
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return 0.0
        rows = await client.fetch(
            """
            SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
            FROM customer_cost_events
            WHERE org_id = $1
              AND feature = ANY($2::text[])
              AND recorded_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
            """,
            org_id,
            list(features),
        )
        if not rows:
            return 0.0
        return float(rows[0]["cost_usd"] or 0)
    except Exception as exc:
        logger.debug("cost_ledger: sum_feature_spend_today failed: %s", exc)
        return 0.0


async def sum_by_dimension(
    org_id: str,
    *,
    dimension: str = "feature",
    window_hours: int = 24,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Roll up cost_usd by feature|model|agent_id|session_id|user_id."""
    col_map = {
        "feature": "feature",
        "model": "model",
        "agent": "agent_id",
        "agent_id": "agent_id",
        "session": "session_id",
        "session_id": "session_id",
        "user": "user_id",
        "user_id": "user_id",
        "day": "date_trunc('day', recorded_at)",
    }
    if dimension not in col_map:
        dimension = "feature"
    expr = col_map[dimension]
    select_key = "key" if dimension != "day" else "day"
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        if dimension == "day":
            rows = await client.fetch(
                """
                SELECT date_trunc('day', recorded_at) AS day,
                       COALESCE(SUM(cost_usd), 0) AS cost_usd,
                       COUNT(*)::int AS events,
                       COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM customer_cost_events
                WHERE org_id = $1
                  AND recorded_at > NOW() - ($2 || ' hours')::interval
                GROUP BY 1
                ORDER BY 1 DESC
                LIMIT $3
                """,
                org_id,
                str(window_hours),
                limit,
            )
            return [
                {
                    "day": r["day"].isoformat() if r["day"] else None,
                    "cost_usd": float(r["cost_usd"] or 0),
                    "events": int(r["events"] or 0),
                    "tokens": int(r["tokens"] or 0),
                }
                for r in rows
            ]
        rows = await client.fetch(
            f"""
            SELECT COALESCE({expr}::text, '(none)') AS key,
                   COALESCE(SUM(cost_usd), 0) AS cost_usd,
                   COUNT(*)::int AS events,
                   COALESCE(SUM(total_tokens), 0)::bigint AS tokens
            FROM customer_cost_events
            WHERE org_id = $1
              AND recorded_at > NOW() - ($2 || ' hours')::interval
            GROUP BY 1
            ORDER BY cost_usd DESC
            LIMIT $3
            """,
            org_id,
            str(window_hours),
            limit,
        )
        return [
            {
                select_key: r["key"],
                "cost_usd": float(r["cost_usd"] or 0),
                "events": int(r["events"] or 0),
                "tokens": int(r["tokens"] or 0),
            }
            for r in rows
        ]
    except Exception as exc:
        logger.debug("cost_ledger: sum_by_dimension failed: %s", exc)
        return []


def _empty_explorer_summary() -> dict[str, Any]:
    return {
        "total_cost_usd": 0.0,
        "previous_cost_usd": 0.0,
        "delta_usd": 0.0,
        "delta_pct": None,
        "by_feature": [],
        "by_model": [],
        "by_agent": [],
        "by_session": [],
        "by_day": [],
        "untagged_events": 0,
        "classifier_savings_usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "events": 0,
    }


async def gateway_ledger_overview(
    org_id: str,
    *,
    window_hours: int = 24,
    include_sessions: bool = False,
    include_classifier: bool = False,
) -> dict[str, Any]:
    """Single-scan FinOps payload for the Gateway page.

    One CTE over ``customer_cost_events`` drives totals, prior-window
    compare, and model/feature/agent/day rollups — avoids the prior
    7+ sequential Neon round-trips on the hot portal path.
    """
    empty = _empty_explorer_summary()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        client = None
    if client is None:
        return empty

    try:
        row = await client.fetchrow(
            """
            WITH bounds AS (
              SELECT
                NOW() - ($2 || ' hours')::interval AS start_at,
                NOW() - ($2 || ' hours')::interval * 2 AS prev_start
            ),
            windowed AS (
              SELECT *
              FROM customer_cost_events
              WHERE org_id = $1
                AND recorded_at > (SELECT start_at FROM bounds)
            ),
            totals AS (
              SELECT
                COALESCE(SUM(cost_usd), 0)::float AS cost,
                COUNT(*)::int AS events,
                COUNT(*) FILTER (WHERE feature = 'unknown')::int AS untagged,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
              FROM windowed
            ),
            prev AS (
              SELECT COALESCE(SUM(cost_usd), 0)::float AS cost
              FROM customer_cost_events
              WHERE org_id = $1
                AND recorded_at <= (SELECT start_at FROM bounds)
                AND recorded_at > (SELECT prev_start FROM bounds)
            ),
            by_model AS (
              SELECT COALESCE(json_agg(t ORDER BY t.cost_usd DESC), '[]'::json) AS data
              FROM (
                SELECT COALESCE(model::text, '(none)') AS key,
                       COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                       COUNT(*)::int AS events,
                       COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM windowed
                GROUP BY 1
                ORDER BY cost_usd DESC
                LIMIT 25
              ) t
            ),
            by_feature AS (
              SELECT COALESCE(json_agg(t ORDER BY t.cost_usd DESC), '[]'::json) AS data
              FROM (
                SELECT COALESCE(feature::text, '(none)') AS key,
                       COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                       COUNT(*)::int AS events,
                       COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM windowed
                GROUP BY 1
                ORDER BY cost_usd DESC
                LIMIT 25
              ) t
            ),
            by_agent AS (
              SELECT COALESCE(json_agg(t ORDER BY t.cost_usd DESC), '[]'::json) AS data
              FROM (
                SELECT COALESCE(agent_id::text, '(none)') AS key,
                       COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                       COUNT(*)::int AS events,
                       COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM windowed
                GROUP BY 1
                ORDER BY cost_usd DESC
                LIMIT 25
              ) t
            ),
            by_day AS (
              SELECT COALESCE(json_agg(t ORDER BY t.day ASC), '[]'::json) AS data
              FROM (
                SELECT date_trunc('day', recorded_at) AS day,
                       COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                       COUNT(*)::int AS events,
                       COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
                       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
                FROM windowed
                GROUP BY 1
                ORDER BY 1 ASC
                LIMIT 90
              ) t
            )
            SELECT
              totals.cost,
              totals.events,
              totals.untagged,
              totals.input_tokens,
              totals.output_tokens,
              totals.total_tokens,
              prev.cost AS previous_cost,
              by_model.data AS by_model,
              by_feature.data AS by_feature,
              by_agent.data AS by_agent,
              by_day.data AS by_day
            FROM totals, prev, by_model, by_feature, by_agent, by_day
            """,
            org_id,
            str(window_hours),
        )
    except Exception as exc:
        logger.debug("cost_ledger: gateway_ledger_overview failed: %s", exc)
        return empty

    if row is None:
        return empty

    cost = float(row["cost"] or 0)
    prev_cost = float(row["previous_cost"] or 0)
    delta = cost - prev_cost
    delta_pct = round((delta / prev_cost) * 100, 2) if prev_cost else None

    def _parse_rows(raw: Any) -> list[dict[str, Any]]:
        if raw is None:
            return []
        if isinstance(raw, str):
            raw = json.loads(raw)
        out: list[dict[str, Any]] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            day = item.get("day")
            if day is not None and hasattr(day, "isoformat"):
                day = day.isoformat()
            key = item.get("key")
            out.append(
                {
                    **({"key": str(key)} if key is not None else {}),
                    **({"day": day} if day is not None else {}),
                    "cost_usd": float(item.get("cost_usd") or 0),
                    "events": int(item.get("events") or 0),
                    "tokens": int(item.get("tokens") or 0),
                    **(
                        {
                            "input_tokens": int(item.get("input_tokens") or 0),
                            "output_tokens": int(item.get("output_tokens") or 0),
                        }
                        if "input_tokens" in item or "output_tokens" in item
                        else {}
                    ),
                }
            )
        return out

    by_session: list[dict[str, Any]] = []
    classifier_savings = 0.0
    if include_sessions or include_classifier:
        tasks: list[Any] = []
        if include_sessions:
            tasks.append(
                sum_by_dimension(
                    org_id, dimension="session", window_hours=window_hours
                )
            )
        if include_classifier:
            tasks.append(classifier_savings_usd(org_id, window_hours=window_hours))
        results = await asyncio.gather(*tasks)
        idx = 0
        if include_sessions:
            by_session = results[idx]
            idx += 1
        if include_classifier:
            classifier_savings = float(results[idx] or 0)

    return {
        "total_cost_usd": cost,
        "previous_cost_usd": prev_cost,
        "delta_usd": delta,
        "delta_pct": delta_pct,
        "by_feature": _parse_rows(row["by_feature"]),
        "by_model": _parse_rows(row["by_model"]),
        "by_agent": _parse_rows(row["by_agent"]),
        "by_session": by_session,
        "by_day": _parse_rows(row["by_day"]),
        "untagged_events": int(row["untagged"] or 0),
        "classifier_savings_usd": classifier_savings,
        "input_tokens": int(row["input_tokens"] or 0),
        "output_tokens": int(row["output_tokens"] or 0),
        "total_tokens": int(row["total_tokens"] or 0),
        "events": int(row["events"] or 0),
    }


async def explorer_summary(
    org_id: str,
    *,
    window_hours: int = 24,
) -> dict[str, Any]:
    """FinOps explorer payload: totals + breakdowns + compare_previous."""
    # Prefer the single-scan path; keep sessions + classifier for Settings.
    return await gateway_ledger_overview(
        org_id,
        window_hours=window_hours,
        include_sessions=True,
        include_classifier=True,
    )


async def classifier_savings_usd(org_id: str, *, window_hours: int = 24) -> float:
    """F34 — estimated $ avoided when classifiers skip F06 investigator."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return 0.0
        # Prefer persisted prediction savings; fall back to metadata on
        # signal_classifier cost events.
        try:
            row = await client.fetchrow(
                """
                SELECT COALESCE(SUM(estimated_savings_usd), 0)::float AS saved
                FROM classifier_predictions
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' hours')::interval
                  AND investigator_skipped IS TRUE
                """,
                org_id,
                str(window_hours),
            )
            saved = float(row["saved"] or 0) if row else 0.0
            if saved > 0:
                return round(saved, 6)
        except Exception:
            pass
        row = await client.fetchrow(
            """
            SELECT COALESCE(SUM((metadata->>'estimated_savings_usd')::float), 0)
                   AS saved
            FROM customer_cost_events
            WHERE org_id = $1
              AND feature = 'signal_classifier'
              AND recorded_at > NOW() - ($2 || ' hours')::interval
            """,
            org_id,
            str(window_hours),
        )
        return round(float(row["saved"] or 0), 6) if row else 0.0
    except Exception as exc:
        logger.debug("cost_ledger: classifier_savings failed: %s", exc)
        return 0.0


def event_to_dict(event: CostEvent) -> dict[str, Any]:
    d = asdict(event)
    d["feature"] = event.normalized_feature()
    return d
