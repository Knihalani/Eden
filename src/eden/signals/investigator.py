"""F06 — per-trace signal investigator (v1 heuristic + optional LLM).

Runs enabled ``signal_definitions`` for one finalized trace and writes
``signal_events``. Wired from ``trace_finalized_consumer``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_MIN_STEPS = 3


def _s(v: Any) -> str:
    return "" if v is None else str(v)


def compress_trace(events: list[dict[str, Any]], *, max_chars: int = 4000) -> str:
    """Linearize trace events into a short text summary."""
    parts: list[str] = []
    for e in events[:80]:
        et = _s(e.get("event_type"))
        name = _s(e.get("name"))
        outcome = _s(e.get("outcome"))
        text = _s(
            e.get("output_text")
            or e.get("input_text")
            or e.get("content")
            or (e.get("attributes") or {}).get("text")
        )[:300]
        parts.append(f"[{et}|{name}|{outcome}] {text}")
        if sum(len(p) for p in parts) >= max_chars:
            break
    return "\n".join(parts)[:max_chars]


def _heuristic_match(
    description: str, events: list[dict[str, Any]]
) -> tuple[bool, dict[str, Any], float]:
    """Cheap keyword/heuristic matcher when LLM is unavailable."""
    desc = description.lower()
    summary = compress_trace(events).lower()
    matched = False
    payload: dict[str, Any] = {"method": "heuristic"}

    if "frustrat" in desc:
        matched = any(
            kw in summary
            for kw in ("try again", "wrong", "not helpful", "frustrated")
        )
        payload["frustrated"] = matched
    elif "hallucin" in desc:
        matched = "found" in summary and ("empty" in summary or "{}" in summary)
        payload["hallucinated"] = matched
    elif "loop" in desc or "repeat" in desc:
        tools = [_s(e.get("name")) for e in events if "tool" in _s(e.get("event_type"))]
        matched = len(tools) >= 3 and len(set(tools)) < len(tools)
        payload["loop"] = matched
    elif "forget" in desc:
        matched = "contradict" in summary or "earlier" in summary and "ignore" in summary
        payload["forgot"] = matched
    else:
        # Generic: any overlap between description tokens and trace text.
        tokens = [t for t in desc.split() if len(t) > 4][:8]
        hits = [t for t in tokens if t in summary]
        matched = len(hits) >= 2
        payload["matched_tokens"] = hits

    return matched, payload, 0.6 if matched else 0.2


async def investigate_trace(
    org_id: str,
    trace_id: str,
    events: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Evaluate enabled signal definitions for one trace."""
    if events is None:
        try:
            from eden.insights.rca._common import _fetch_trace_events

            events = await _fetch_trace_events(org_id, trace_id)
        except Exception as exc:
            logger.debug("signal_investigator: fetch failed: %s", exc)
            events = []

    if len(events) < _MIN_STEPS:
        return []

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []

    try:
        rows = await pg.fetch(
            """
            SELECT id, name, description, output_schema
            FROM signal_definitions
            WHERE org_id = $1 AND enabled = TRUE
            ORDER BY created_at ASC
            LIMIT 20
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("signal_investigator: list definitions failed: %s", exc)
        return []

    written: list[dict[str, Any]] = []
    for row in rows:
        signal_id = str(row["id"])
        matched, payload, confidence = _heuristic_match(
            _s(row["description"]), events
        )
        event_id = str(uuid.uuid4())
        try:
            await pg.execute(
                """
                INSERT INTO signal_events
                    (id, org_id, signal_id, trace_id, matched, payload,
                     investigator_confidence)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                """,
                event_id,
                org_id,
                signal_id,
                trace_id,
                matched,
                json.dumps(payload, default=str, separators=(",", ":")),
                confidence,
            )
            written.append(
                {
                    "id": event_id,
                    "signal_id": signal_id,
                    "trace_id": trace_id,
                    "matched": matched,
                    "confidence": confidence,
                }
            )
        except Exception as exc:
            logger.debug("signal_investigator: insert failed: %s", exc)
    return written
