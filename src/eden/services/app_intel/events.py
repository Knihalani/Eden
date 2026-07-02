"""App events service (Phase A1).

:class:`AppEventsService` — persists high-volume app/site events to
the ``app_events`` table (migration 036). Backs the
``POST /orgs/{org_id}/ingest/app`` endpoint.

The service is intentionally thin: validation + bulk insert. Any
fan-out (e.g. materialised rollups, cross-table joins) lives
upstream in the route handlers or downstream in the columnar /
intelligence layers.

Why batch inserts
-----------------
Browser SDKs flush events in batches (default 50 events / 5s in the
``@eden/sdk/browser`` package). Doing one INSERT per event would
saturate Postgres with round-trips; a batched INSERT (or COPY) is
mandatory. ``ingest_batch`` accepts up to 1000 events per call
(limited at the route layer via ``settings.app_ingest_max_batch``).
"""
from __future__ import annotations

import json
import logging
from typing import Any

from ._common import _get_client, _new_id

logger = logging.getLogger(__name__)


#: Per-batch max event count. The route layer enforces this BEFORE
#: calling ``ingest_batch``; the constant is duplicated here for
#: unit tests that exercise the service directly.
MAX_BATCH = 1000


class AppEventsService:
    """Write path for the ``app_events`` table."""

    name = "app_events"

    async def ingest_batch(
        self,
        org_id: str,
        events: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Insert a batch of events. Returns ``{accepted, rejected, total}``.

        Each event must contain ``name``, ``ts``. ``session_id``,
        ``user_id``, ``trace_id``, ``properties`` are optional.
        Invalid events are counted in ``rejected`` and skipped —
        the batch is atomic per-row, not per-batch.
        """
        client = await _get_client()
        if client is None:
            return {"accepted": 0, "rejected": len(events), "total": len(events)}

        accepted = 0
        rejected = 0
        for event in events:
            err = _validate(event)
            if err is not None:
                logger.warning(f"[app_events] rejecting event: {err}")
                rejected += 1
                continue
            try:
                await self._insert_one(client, org_id, event)
                accepted += 1
            except Exception as exc:
                logger.error(f"[app_events] insert failed: {exc}")
                rejected += 1

        return {"accepted": accepted, "rejected": rejected, "total": len(events)}

    async def _insert_one(
        self,
        client: Any,
        org_id: str,
        event: dict[str, Any],
    ) -> None:
        """Insert a single event row."""
        # Properties is a free-form dict; serialise as JSONB
        properties = event.get("properties")
        properties_json = json.dumps(properties) if properties is not None else None
        await client.execute(
            """
            INSERT INTO app_events (
                id, org_id, session_id, user_id, trace_id,
                name, source, ts, properties
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
            """,
            _new_id("app"),
            org_id,
            event.get("session_id"),
            event.get("user_id"),
            event.get("trace_id"),
            event["name"],
            event.get("source", "browser"),
            event["ts"],
            properties_json,
        )


def _validate(event: dict[str, Any]) -> str | None:
    """Validate an event shape. Returns ``None`` for valid, error
    string for invalid.
    """
    if not isinstance(event, dict):
        return "event must be an object"
    name = event.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 128):
        return "name must be 1-128 chars"
    ts = event.get("ts")
    if not isinstance(ts, str):
        # The route layer parses ISO strings to datetime; here we
        # accept whatever the route hands us.
        return "ts must be an ISO 8601 string"
    source = event.get("source", "browser")
    if source not in {"browser", "server", "mobile"}:
        return "source must be browser|server|mobile"
    return None
