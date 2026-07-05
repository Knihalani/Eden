"""Mobile-optimized Server-Sent Events (SSE) with battery-aware reconnects.

Phase 6.2: Provides an SSE endpoint designed for mobile clients with:
- Battery-aware reconnect backoff (shorter delays when charging, longer when low)
- Payload size reduction for mobile (optional field filtering)
- Connection state tracking for graceful degradation
- Automatic reconnection with Last-Event-ID support

Usage:
    GET /v1/mobile/stream?job_id=abc&fields=status,stage
    Accept: text/event-stream
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import StreamingResponse

from eden.api.deps import get_current_user
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mobile-sse"])


class MobileSSEStream:
    """A battery-aware SSE stream for mobile clients.

    Features:
    - Configurable field filtering to reduce payload size
    - Connection quality tracking
    - Graceful degradation on poor connections
    """

    def __init__(
        self,
        job_id: str,
        user: dict[str, Any],
        fields: list[str] | None = None,
        battery_aware: bool = True,
        resume_after: str | None = None,
    ) -> None:
        self.job_id = job_id
        self.user = user
        self.fields = fields or ["status", "stage", "progress", "message"]
        self.battery_aware = battery_aware
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._connected = True
        self._last_event_id: str | None = None
        # Phase 5.1.6: when set, replay events with id > resume_after
        # from the trace store before yielding live events.
        self._resume_after: str | None = resume_after

    async def emit(self, event: dict[str, Any]) -> None:
        """Emit an event to the stream, filtering fields for mobile."""
        if not self._connected:
            return

        # Filter payload to only requested fields
        if self.fields and "payload" in event:
            event["payload"] = {
                k: v for k, v in event["payload"].items()
                if k in self.fields or k in ("timestamp", "event_id")
            }

        # Add lightweight metadata for mobile
        event["_mobile"] = {
            "compressed": True,
            "field_count": len(event.get("payload", {})),
        }

        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest event on backpressure
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(event)
            except asyncio.QueueEmpty:
                pass

    def format_sse(self, event: dict[str, Any]) -> str:
        """Format an event as SSE text."""
        event_id = event.get("event_id", str(int(datetime.now(UTC).timestamp() * 1000)))
        event_type = event.get("event_type", "message")
        data = json.dumps(event)

        lines = []
        if self._last_event_id:
            lines.append(f"id: {event_id}")
        lines.append(f"event: {event_type}")
        lines.append(f"data: {data}")
        lines.append("")  # Blank line to terminate event

        self._last_event_id = event_id
        return "\n".join(lines)

    async def event_generator(self) -> Any:
        """Generate SSE events from the queue."""
        # Send initial connection event
        yield self.format_sse({
            "event_type": "connected",
            "event_id": f"conn_{self.job_id}",
            "payload": {
                "job_id": self.job_id,
                "fields": self.fields,
                "battery_aware": self.battery_aware,
                "timestamp": datetime.now(UTC).isoformat(),
            },
        })

        # Phase 5.1.6: replay missed events from the trace log when
        # the client reconnects with Last-Event-ID.
        if self._resume_after:
            try:
                from eden.realtime.trace_store import get_trace_event_store
                store = await get_trace_event_store()
                replayed = await store.get_events_after(
                    self.job_id, self._resume_after, limit=1000
                )
                for ev in replayed:
                    yield self.format_sse(ev)
                logger.info(
                    f"SSE resume: replayed {len(replayed)} events for {self.job_id} "
                    f"after {self._resume_after}"
                )
            except Exception as exc:
                logger.warning(f"SSE resume failed for {self.job_id}: {exc}")

        while self._connected:
            try:
                # Wait for next event with timeout for keepalive
                event = await asyncio.wait_for(self._queue.get(), timeout=15.0)
                yield self.format_sse(event)
            except TimeoutError:
                # Send keepalive comment to prevent proxy timeout
                yield ":heartbeat\n\n"
            except Exception as exc:
                logger.debug(f"Mobile SSE generator error: {exc}")
                break

    def disconnect(self) -> None:
        """Signal the stream to disconnect."""
        self._connected = False


# Track active mobile streams per job
_mobile_streams: dict[str, set[MobileSSEStream]] = {}


@router.get("/v1/mobile/stream")
async def mobile_sse_stream(
    request: Request,
    job_id: str = Query(..., description="Job ID to stream"),
    fields: str | None = Query(None, description="Comma-separated field list for payload filtering"),
    battery_level: int | None = Query(None, ge=0, le=100, description="Client battery level (0-100)"),
    is_charging: bool | None = Query(None, description="Whether device is charging"),
    last_event_id: str | None = Query(None, description="Last received event ID for resume"),
):
    """Mobile-optimized SSE stream for job progress.

    Query Parameters:
        job_id: Required. The job to stream.
        fields: Optional. Comma-separated list of payload fields to include.
                Reduces data transfer on mobile networks.
        battery_level: Optional. Client battery level (0-100).
                       Used to adjust reconnect backoff advice.
        is_charging: Optional. Whether the device is charging.
        last_event_id: Optional. For reconnecting and resuming from last event.
    """
    # Authenticate via cookie
    authorization = request.cookies.get("access_token")
    if not authorization:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid authentication")

    # Verify job ownership
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Parse field filter
    field_list = None
    if fields:
        field_list = [f.strip() for f in fields.split(",") if f.strip()]

    # Determine reconnect backoff based on battery
    reconnect_backoff = _calculate_reconnect_backoff(battery_level, is_charging)

    stream = MobileSSEStream(
        job_id=job_id,
        user=user,
        fields=field_list,
        battery_aware=True,
        resume_after=last_event_id,
    )

    # Register stream
    if job_id not in _mobile_streams:
        _mobile_streams[job_id] = set()
    _mobile_streams[job_id].add(stream)

    # Handle resume from last_event_id — now wired: the stream's
    # event_generator will replay missed events from the trace store
    # before yielding new ones. See MobileSSEStream.event_generator.
    if last_event_id:
        logger.info(f"Mobile SSE resume requested for {job_id} from {last_event_id}")

    # Start background polling for job updates
    poll_task = asyncio.create_task(
        _poll_job_updates(job_id, user, stream),
        name=f"mobile-poll-{job_id}",
    )

    async def cleanup() -> None:
        stream.disconnect()
        _mobile_streams[job_id].discard(stream)
        if not _mobile_streams[job_id]:
            del _mobile_streams[job_id]
        poll_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poll_task

    # Build response headers with reconnect advice
    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # Disable nginx buffering
        "X-Reconnect-After": str(reconnect_backoff),
    }

    return StreamingResponse(
        stream.event_generator(),
        headers=headers,
        background=cleanup,
    )


def _calculate_reconnect_backoff(
    battery_level: int | None,
    is_charging: bool | None,
) -> int:
    """Calculate recommended reconnect backoff in seconds based on battery state.

    - Charging: aggressive reconnect (2s)
    - High battery (>50%): normal reconnect (5s)
    - Medium battery (20-50%): conservative reconnect (15s)
    - Low battery (<20%): minimal reconnect (60s)
    - Unknown: default (10s)
    """
    if is_charging:
        return 2
    if battery_level is None:
        return 10
    if battery_level > 50:
        return 5
    if battery_level >= 20:
        return 15
    return 60


async def _poll_job_updates(
    job_id: str,
    user: dict[str, Any],
    stream: MobileSSEStream,
) -> None:
    """Poll job state and emit events to the mobile SSE stream."""
    client = await get_postgres_client()
    last_stage: str | None = None
    last_status: str | None = None

    try:
        while stream._connected:
            await asyncio.sleep(3)  # Mobile: slightly longer polling interval

            try:
                job = await client.get_job(job_id, user_id=user["user_id"])
                if not job:
                    break

                current_stage = job["current_stage"]
                current_status = job["status"]

                # Emit stage change
                if current_stage != last_stage:
                    await stream.emit({
                        "event_type": "stage_change",
                        "event_id": f"stage_{job_id}_{current_stage}",
                        "payload": {
                            "from": last_stage,
                            "to": current_stage,
                            "job_id": job_id,
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    })
                    last_stage = current_stage

                # Emit status update
                if current_status != last_status:
                    await stream.emit({
                        "event_type": "status",
                        "event_id": f"status_{job_id}_{current_status}",
                        "payload": {
                            "status": current_status,
                            "stage": current_stage,
                            "outcome_tier": job.get("outcome_tier"),
                            "job_id": job_id,
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    })
                    last_status = current_status

                # Terminal state
                if current_status in {"completed", "failed", "cancelled", "human_review"}:
                    await stream.emit({
                        "event_type": "complete",
                        "event_id": f"complete_{job_id}",
                        "payload": {
                            "status": current_status,
                            "outcome_tier": job.get("outcome_tier"),
                            "job_id": job_id,
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    })
                    break

            except Exception as exc:
                logger.debug(f"Mobile poll error for {job_id}: {exc}")
                await asyncio.sleep(5)

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.error(f"Mobile SSE poll task failed for {job_id}: {exc}")


async def broadcast_to_mobile(job_id: str, event: dict[str, Any]) -> None:
    """Broadcast an event to all mobile SSE streams for a job.

    Called by the main WebSocket or job pipeline to push events to
    mobile listeners.
    """
    if job_id not in _mobile_streams:
        return

    for stream in list(_mobile_streams[job_id]):
        with contextlib.suppress(Exception):
            await stream.emit(event)
