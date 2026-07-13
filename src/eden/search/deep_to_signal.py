"""N10 — deep search → persistent signal."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Literal

logger = logging.getLogger(__name__)


async def save_search_as_signal(
    org_id: str,
    *,
    search_query: str,
    trace_ids: list[str],
    mode: Literal["investigator", "classifier"] = "investigator",
    created_by: str | None = None,
) -> dict[str, Any]:
    """Convert a span search result set into a ``signal_definitions`` row."""
    if not search_query.strip():
        raise ValueError("search_query is required")
    if not trace_ids:
        raise ValueError("trace_ids is required")

    signal_id = str(uuid.uuid4())
    name = search_query.strip()[:120]
    description = (
        f"Auto-created from search: {search_query.strip()}. "
        f"Matches traces with similar patterns to {len(trace_ids)} examples."
    )
    output_schema = {"matched": "bool", "evidence": "str"}

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
        INSERT INTO saved_searches
            (id, org_id, query_text, trace_count, signal_id)
        VALUES ($1, $2, $3, $4, $5)
        """,
        saved_id,
        org_id,
        search_query.strip(),
        len(trace_ids),
        signal_id,
    )

    # Backfill investigator events for example traces (cap 50).
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

    return {
        "signal_id": signal_id,
        "saved_search_id": saved_id,
        "mode": mode,
        "trace_count": len(trace_ids),
        "investigated_events": investigated,
        "classifier_id": classifier_id,
        "created_by": created_by,
    }
