"""In-process TelemetryCollector (Phase 7.0 stub).

The real collector:
  * maintains a bounded in-memory ring + per-tenant caps
  * deduplicates on ``event_id``
  * fans out to the bronze sink, ClickHouse, and any OTel exporters
  * exposes ``ingest_batch(events)`` for high-throughput callers and
    ``ingest(event)`` for one-at-a-time callers

For Batch A1 we only need the import surface to exist. The gateway
and the test suite import these names; the actual fan-out is
covered by Phase 7.0's ingestion layer (units A4+).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class TelemetryEvent(BaseModel):
    """A single telemetry event in Eden's normalized shape.

    Mirrors the OTel GenAI spec (event_type / trace_id / span_id / name /
    payload / metrics / attributes) with two Eden-specific fields:
    ``source_format`` (e.g. ``"openai_gateway"``) and ``outcome``
    (``"success"`` / ``"failure"`` / ``"partial"``).
    """

    event_id: str
    tenant_id: str
    project_id: str = "default"
    trace_id: str
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    realm: str = "production"
    event_type: str = "llm_completion"
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    name: str
    duration_ms: Optional[float] = None
    payload: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, float] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    outcome: str = "success"
    source_format: str = "eden_native"
    request_body: Optional[dict[str, Any]] = None
    response_body: Optional[dict[str, Any]] = None
    model_version: Optional[str] = None


_collector: Optional["TelemetryCollector"] = None
_collector_lock = threading.Lock()


class TelemetryCollector:
    """The singleton in-process collector.

    Methods:
        ``ingest(event)``  — accept one event, return bool.
        ``ingest_batch(events)``  — accept many, return a small stats dict.
    """

    def __init__(self) -> None:
        self._events: list[TelemetryEvent] = []
        self._seen_ids: set[str] = set()
        self._lock = asyncio.Lock()

    async def ingest(self, event: TelemetryEvent) -> bool:
        async with self._lock:
            if event.event_id in self._seen_ids:
                return False
            self._seen_ids.add(event.event_id)
            self._events.append(event)
        return True

    async def ingest_batch(self, events: list[TelemetryEvent]) -> dict[str, int]:
        accepted = 0
        rejected = 0
        deduplicated = 0
        async with self._lock:
            for ev in events:
                if ev.event_id in self._seen_ids:
                    deduplicated += 1
                    continue
                self._seen_ids.add(ev.event_id)
                self._events.append(ev)
                accepted += 1
        return {
            "accepted": accepted,
            "rejected": rejected,
            "deduplicated": deduplicated,
            "total": len(events),
        }

    def all_events(self) -> list[TelemetryEvent]:
        """Return a snapshot of the events seen so far (test helper)."""
        return list(self._events)


async def get_telemetry_collector() -> TelemetryCollector:
    """Return the singleton collector, creating it on first call."""
    global _collector
    if _collector is None:
        with _collector_lock:
            if _collector is None:
                _collector = TelemetryCollector()
    return _collector
