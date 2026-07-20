"""N10 — deep search → persistent signal."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Literal

logger = logging.getLogger(__name__)

_COST_PER_TRACE_USD = 0.01


def _definition_from_search(
    search_query: str, trace_ids: list[str]
) -> tuple[str, str, dict[str, Any]]:
    name = search_query.strip()[:120]
    description = (
        f"Auto-created from search: {search_query.strip()}. "
        f"Matches traces with similar patterns to {len(trace_ids)} examples."
    )
    output_schema = {"matched": "bool", "evidence": "str"}
    return name, description, output_schema


async def preview_save_as_signal(
    org_id: str,
    *,
    search_query: str,
    trace_ids: list[str],
    mode: Literal["investigator", "classifier"] = "investigator",
    backfill_days: int = 0,
) -> dict[str, Any]:
    """Preview proposed signal definition + backfill cost (N10)."""
    if not search_query.strip():
        raise ValueError("search_query is required")
    if not trace_ids:
        raise ValueError("trace_ids is required")

    name, description, output_schema = _definition_from_search(
        search_query, trace_ids
    )
    backfill_days = max(0, min(30, backfill_days))
    backfill_traces = 0
    if backfill_days > 0:
        from eden.signals.backfill import count_traces_in_window

        backfill_traces = await count_traces_in_window(
            org_id, window_days=backfill_days
        )

    classifier_ready = mode == "classifier" and len(trace_ids) >= 50
    return {
        "proposed": {
            "name": name,
            "description": description,
            "output_schema": output_schema,
            "mode": mode,
        },
        "trace_count": len(trace_ids),
        "classifier_ready": classifier_ready,
        "backfill_days": backfill_days,
        "backfill_trace_estimate": backfill_traces,
        "estimated_backfill_cost_usd": round(
            backfill_traces * _COST_PER_TRACE_USD, 4
        ),
        "example_trace_ids": trace_ids[:5],
    }


async def save_search_as_signal(
    org_id: str,
    *,
    search_query: str,
    trace_ids: list[str],
    mode: Literal["investigator", "classifier"] = "investigator",
    created_by: str | None = None,
    backfill_days: int = 0,
) -> dict[str, Any]:
    """Convert a span search result set into a ``signal_definitions`` row."""
    if not search_query.strip():
        raise ValueError("search_query is required")
    if not trace_ids:
        raise ValueError("trace_ids is required")

    signal_id = str(uuid.uuid4())
    name, description, output_schema = _definition_from_search(
        search_query, trace_ids
    )

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception as exc:
        raise RuntimeError("database unavailable") from exc
    if pg is None:
        raise RuntimeError("database unavailable")

    await pg.execute(
        """
        INSERT INTO signal_definitions
            (id, org_id, name, description, output_schema, enabled,
             source_search_query)
        VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)
        """,
        signal_id,
        org_id,
        name,
        description,
        json.dumps(output_schema, separators=(",", ":")),
        search_query.strip(),
    )

    saved_id = str(uuid.uuid4())
    await pg.execute(
        """
        INSERT INTO saved_search_signal_links
            (id, org_id, query_text, trace_count, signal_id)
        VALUES ($1, $2, $3, $4, $5)
        """,
        saved_id,
        org_id,
        search_query.strip(),
        len(trace_ids),
        signal_id,
    )

    job_id = str(uuid.uuid4())
    await pg.execute(
        """
        INSERT INTO search_to_signal_jobs
            (id, org_id, saved_search_id, signal_id, status)
        VALUES ($1, $2, $3, $4, 'running')
        """,
        job_id,
        org_id,
        saved_id,
        signal_id,
    )

    investigated = 0
    try:
        from eden.signals.investigator import investigate_trace

        for tid in trace_ids[:50]:
            events = await investigate_trace(org_id, tid)
            if events:
                investigated += len(events)
    except Exception as exc:
        logger.debug("deep_to_signal: investigate backfill failed: %s", exc)

    classifier_id: str | None = None
    if mode == "classifier" and len(trace_ids) >= 5:
        try:
            from eden.signals.classifier_pipeline import ClassifierTrainingPipeline

            result = await ClassifierTrainingPipeline().train(
                org_id, signal_id, trace_ids=trace_ids[:200]
            )
            if result.trained:
                classifier_id = result.classifier_id
        except Exception as exc:
            logger.debug("deep_to_signal: classifier train failed: %s", exc)

    backfill_job: dict[str, Any] | None = None
    if backfill_days > 0:
        try:
            from eden.signals.backfill import enqueue_backfill

            backfill_job = await enqueue_backfill(
                org_id, signal_id, window_days=backfill_days
            )
        except Exception as exc:
            logger.debug("deep_to_signal: backfill enqueue failed: %s", exc)

    await pg.execute(
        """
        UPDATE search_to_signal_jobs
        SET status = 'complete', completed_at = NOW()
        WHERE id = $1
        """,
        job_id,
    )

    return {
        "signal_id": signal_id,
        "saved_search_id": saved_id,
        "job_id": job_id,
        "mode": mode,
        "trace_count": len(trace_ids),
        "investigated_events": investigated,
        "classifier_id": classifier_id,
        "backfill_job": backfill_job,
        "created_by": created_by,
    }
