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
import uuid
from datetime import UTC, datetime
from typing import Any

from ._common import _get_client

logger = logging.getLogger(__name__)


class AppEventsUnavailableError(RuntimeError):
    """The write path is broken server-side; the caller should retry.

    Raised instead of reporting rows as ``rejected``. A rejected row
    means "your event was malformed, do not resend"; an unavailable
    database means "we lost it, please resend". Conflating the two is
    what kept this table empty and silent.
    """


_INSERT_SQL = """
    INSERT INTO app_events (
        id, org_id, session_id, user_id, trace_id,
        name, source, ts, properties
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
"""


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
            raise AppEventsUnavailableError("postgres unavailable")

        rows: list[tuple[Any, ...]] = []
        rejected = 0
        for event in events:
            err = _validate(event)
            if err is not None:
                logger.warning("[app_events] rejecting event: %s", err)
                rejected += 1
                continue
            rows.append(_row_tuple(org_id, event))

        accepted = await self._insert_rows(client, rows)
        return {"accepted": accepted, "rejected": rejected, "total": len(events)}

    async def _insert_rows(
        self,
        client: Any,
        rows: list[tuple[Any, ...]],
    ) -> int:
        """Insert validated rows, batched.

        One round-trip per event would cost 50 Neon round-trips per
        browser flush, so the happy path is a single ``executemany``.
        asyncpg wraps that in one implicit transaction, which would
        let a single poisoned row discard the whole batch — hence the
        per-row retry, which preserves the documented per-row
        semantics without paying for them when nothing is wrong.
        """
        if not rows:
            return 0
        try:
            await client.executemany(_INSERT_SQL, rows)
            return len(rows)
        except Exception as exc:
            logger.warning(
                "[app_events] batch insert failed (%s); retrying row-by-row",
                exc,
            )

        accepted = 0
        failed = 0
        for row in rows:
            try:
                await client.execute(_INSERT_SQL, *row)
                accepted += 1
            except Exception as row_exc:
                logger.error("[app_events] row insert failed: %s", row_exc)
                failed += 1

        if failed and accepted == 0:
            # Nothing landed. Never report this as a clean 200.
            raise AppEventsUnavailableError(f"all {failed} rows failed to insert")
        return accepted


def _coerce_ts(value: Any) -> datetime:
    """Return a tz-aware ``datetime`` for a TIMESTAMPTZ bind.

    asyncpg does not accept strings for TIMESTAMPTZ, and the route
    hands us ``model_dump(mode="json")`` output — i.e. always a
    string. Coercing here is what makes the insert land at all.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    text = str(value).strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _row_tuple(org_id: str, event: dict[str, Any]) -> tuple[Any, ...]:
    """Build the bind tuple for one validated event."""
    properties = event.get("properties")
    return (
        # app_events.id is UUID NOT NULL. The prefixed-string helper
        # previously used here produced "app_<32 hex>", which Postgres
        # rejects outright — so every insert raised.
        uuid.uuid4(),
        org_id,
        event.get("session_id"),
        event.get("user_id"),
        event.get("trace_id"),
        event["name"],
        event.get("source", "browser"),
        _coerce_ts(event["ts"]),
        json.dumps(properties) if properties is not None else None,
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
    if not isinstance(ts, str | datetime):
        return "ts must be an ISO 8601 timestamp"
    try:
        # Parse here, not at insert time: a bad timestamp is a client
        # error (reject the row) rather than a server fault (retry).
        _coerce_ts(ts)
    except Exception:
        return "ts must be an ISO 8601 timestamp"
    source = event.get("source", "browser")
    if source not in {"browser", "server", "mobile"}:
        return "source must be browser|server|mobile"
    return None
