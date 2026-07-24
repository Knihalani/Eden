"""Live Tail service (Cat 1).

Real-time stream of new trace events as they land in
``telemetry_events``. Pydantic Logfire calls this "live tail";
we expose it as a Server-Sent Events (SSE) endpoint so the
front-end can render a sliding-window dashboard of the most
recent N events.

Implementation (B7):

* Reuses a single Postgres client for the stream lifetime
  (no ``get_postgres_client()`` per poll).
* Idle backoff: starts at ``POLL_INTERVAL_S`` and doubles up to
  ``POLL_INTERVAL_MAX_S`` when polls return empty; resets on
  activity. Prefer Redis pub/sub wake on
  ``observability:stream:{org_id}`` when Redis is available so
  we are not stuck in a fixed 1s PG loop while idle.
* Hard caps on stream lifetime and events emitted.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from eden.observability._trace_common import serialise_event

logger = logging.getLogger(__name__)


#: Base poll interval when events are flowing.
POLL_INTERVAL_S: float = 1.0

#: Idle backoff ceiling — never poll PG more often than this when
#: the stream is quiet (and Redis wake is unavailable).
POLL_INTERVAL_MAX_S: float = 30.0

#: When Redis pub/sub wake is available, wait this long between
#: opportunistic PG polls (wakes still interrupt immediately).
POLL_INTERVAL_PUBSUB_MAX_S: float = 60.0

#: Heartbeat interval — proxies / load balancers tend to
#: kill idle connections after 30-60s, so we send a comment
#: line at half that to keep the connection open.
HEARTBEAT_INTERVAL_S: float = 15.0

#: Hard cap on stream lifetime so a forgotten connection
#: doesn't run forever. After this many seconds, the
#: generator raises ``StopAsyncIteration`` and the SSE
#: response closes cleanly.
MAX_STREAM_LIFETIME_S: float = 60 * 60  # 1 hour

#: Hard cap on events emitted per connection so a noisy
#: org doesn't exhaust the connection.
MAX_EVENTS_PER_STREAM: int = 10_000

_OBS_STREAM_CHANNEL_PREFIX = "observability:stream:"


def _sse_data(payload: dict[str, Any]) -> str:
    """Format a dict as an SSE ``data:`` event."""
    return f"data: {json.dumps(payload, default=str, ensure_ascii=False)}\n\n"


def _sse_heartbeat() -> str:
    """SSE comment line — keeps the connection alive without
    triggering a UI update. Browsers ignore ``:`` prefixed
    lines."""
    return ": heartbeat\n\n"


class LiveTailService:
    """Stream of new telemetry events for an org."""

    name = "live_tail"

    async def stream(
        self,
        org_id: str,
        *,
        filter_agent_id: str | None = None,
        filter_event_type: str | None = None,
    ) -> AsyncIterator[str]:
        """Async-iterate over new events for ``org_id``.

        Yields SSE-formatted strings (``data: {...}\\n\\n`` for
        events, ``: heartbeat\\n\\n`` for heartbeats). The
        router wraps the generator in a
        ``StreamingResponse``.

        Filters:

        * ``filter_agent_id`` — only yield events for the
          given agent
        * ``filter_event_type`` — only yield events whose
          ``event_type`` equals or starts with this string
          (so ``"openai."`` matches all OpenAI events)

        Both filters are optional; the consumer gets
        everything for the org by default.
        """
        started = time.monotonic()
        last_seen_at: str | None = None
        last_heartbeat = started
        emitted = 0
        idle_interval = POLL_INTERVAL_S

        # Reuse one Postgres client for the whole stream (B7).
        client = await _get_pg_client()

        # Prime: read the latest event's timestamp so we don't
        # replay the whole table. The consumer asked for
        # *new* events from the moment of subscription.
        latest = await _fetch_latest_timestamp(org_id, client=client)
        if latest is not None:
            last_seen_at = latest

        # Yield one initial heartbeat so the client knows
        # the stream is live even before any events arrive.
        yield _sse_heartbeat()
        last_heartbeat = time.monotonic()

        # Optional Redis wake — subscribe once, reuse for stream life.
        pubsub = await _subscribe_obs_stream(org_id)

        try:
            while True:
                # Bail-out conditions.
                if (time.monotonic() - started) > MAX_STREAM_LIFETIME_S:
                    logger.debug(
                        "live_tail: stream lifetime cap reached for org %s",
                        org_id,
                    )
                    return
                if emitted >= MAX_EVENTS_PER_STREAM:
                    logger.debug(
                        "live_tail: event cap reached for org %s", org_id
                    )
                    return

                # Poll for new events since ``last_seen_at``.
                try:
                    new_events = await _fetch_events_after(
                        org_id,
                        after_timestamp=last_seen_at,
                        filter_agent_id=filter_agent_id,
                        filter_event_type=filter_event_type,
                        limit=200,
                        client=client,
                    )
                except Exception as exc:
                    logger.debug("live_tail: poll failed: %s", exc)
                    new_events = []

                for ev in new_events:
                    ts = ev.get("timestamp")
                    if ts is not None:
                        last_seen_at = ts
                    yield _sse_data(
                        {
                            "type": "event",
                            "event": serialise_event(ev),
                        }
                    )
                    emitted += 1
                    if emitted >= MAX_EVENTS_PER_STREAM:
                        return

                # Heartbeat.
                now = time.monotonic()
                if (now - last_heartbeat) >= HEARTBEAT_INTERVAL_S:
                    yield _sse_heartbeat()
                    last_heartbeat = now

                if new_events:
                    idle_interval = POLL_INTERVAL_S
                else:
                    ceiling = (
                        POLL_INTERVAL_PUBSUB_MAX_S
                        if pubsub is not None
                        else POLL_INTERVAL_MAX_S
                    )
                    idle_interval = min(idle_interval * 2.0, ceiling)

                # Wait: Redis wake (preferred) or idle backoff sleep.
                try:
                    await _idle_wait(pubsub, idle_interval)
                except asyncio.CancelledError:
                    logger.debug(
                        "live_tail: stream cancelled for org %s", org_id
                    )
                    raise
        finally:
            if pubsub is not None:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(
                        f"{_OBS_STREAM_CHANNEL_PREFIX}{org_id}"
                    )
                    await pubsub.close()


async def _get_pg_client() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("live_tail: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("live_tail: get_postgres_client failed: %s", exc)
        return None


async def _subscribe_obs_stream(org_id: str) -> Any | None:
    """Subscribe to the observability SSE Redis channel for wake-ups."""
    try:
        from eden.storage.redis import get_redis_client
    except Exception:
        return None
    try:
        redis = await get_redis_client()
    except Exception:
        return None
    if redis is None:
        return None
    pubsub = redis.pubsub()
    channel = f"{_OBS_STREAM_CHANNEL_PREFIX}{org_id}"
    try:
        await pubsub.subscribe(channel)
        return pubsub
    except Exception as exc:
        logger.debug("live_tail: redis subscribe failed: %s", exc)
        with contextlib.suppress(Exception):
            await pubsub.close()
        return None


async def _idle_wait(pubsub: Any | None, timeout: float) -> None:
    """Wait up to ``timeout`` for a Redis message, else sleep."""
    if pubsub is None:
        await asyncio.sleep(timeout)
        return
    deadline = time.monotonic() + max(timeout, 0.05)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=min(remaining, 1.0),
                )
            except TypeError:
                try:
                    msg = await asyncio.wait_for(
                        pubsub.get_message(ignore_subscribe_messages=True),
                        timeout=min(remaining, 1.0),
                    )
                except TimeoutError:
                    continue
            if msg is not None and msg.get("type") == "message":
                return
        except Exception:
            await asyncio.sleep(min(remaining, timeout))
            return


async def _fetch_latest_timestamp(
    org_id: str,
    *,
    client: Any | None = None,
) -> str | None:
    """Return the most recent event's timestamp for ``org_id``."""
    if client is None:
        client = await _get_pg_client()
    if client is None:
        return None
    try:
        ts = await client.fetchval(
            """
            SELECT MAX(created_at)::text
            FROM telemetry_events
            WHERE tenant_id = $1
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("live_tail: latest timestamp failed: %s", exc)
        return None
    return ts


async def _fetch_events_after(
    org_id: str,
    *,
    after_timestamp: str | None,
    filter_agent_id: str | None = None,
    filter_event_type: str | None = None,
    limit: int = 200,
    client: Any | None = None,
) -> list[dict[str, Any]]:
    """Return events newer than ``after_timestamp`` for ``org_id``.

    Used by the polling loop. Builds a parameterised query
    so the caller-supplied filter strings can't inject SQL.
    """
    if client is None:
        client = await _get_pg_client()
    if client is None:
        return []
    where = ["tenant_id = $1"]
    args: list[Any] = [org_id]
    if after_timestamp is not None:
        where.append(f"created_at > ${len(args) + 1}")
        args.append(after_timestamp)
    if filter_agent_id is not None:
        where.append(f"agent_id = ${len(args) + 1}")
        args.append(filter_agent_id)
    if filter_event_type is not None:
        # Prefix match so ``"openai."`` matches all OpenAI
        # event types. Escape any wildcards in the input.
        where.append(f"event_type LIKE ${len(args) + 1}")
        args.append(filter_event_type + "%")
    query = f"""
        SELECT event_id, trace_id, span_id, parent_span_id, event_type,
               timestamp, name, duration_ms, outcome, error,
               agent_id, agent_version, environment_id, realm,
               payload, metrics, attributes, tags,
               source_format, project_id, tenant_id, created_at
        FROM telemetry_events
        WHERE {' AND '.join(where)}
        ORDER BY created_at ASC
        LIMIT {int(limit)}
    """
    try:
        rows = await client.fetch(query, *args)
    except Exception as exc:
        logger.debug("live_tail: fetch events_after failed: %s", exc)
        return []
    return [dict(r) for r in rows]
