"""Bronze layer raw event ingestion sink.

Buffers events in memory and flushes to:
- PostgreSQL usage_events table (always)
- Optional S3 Parquet sink (when bronze_s3_bucket is configured)

Designed for high-throughput ingestion with minimal latency overhead.
Events are buffered and flushed asynchronously in batches.

Usage:
    from eden.data_platform.bronze_sink import get_bronze_sink
    sink = await get_bronze_sink()
    await sink.ingest({
        "org_id": "...",
        "event_type": "llm_call",
        "resource": "tokens",
        "quantity": 1500,
        "unit": "tokens",
        "model": "claude-sonnet-4.6",
    })
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

from eden.api.middleware.correlation_id import get_correlation_id
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class RawEvent:
    """A single raw Bronze-layer event."""

    org_id: str
    event_type: str  # llm_call, job_start, job_complete, storage, sandbox, api_request
    resource: str  # tokens, jobs, storage_mb, sandbox_seconds, requests
    quantity: float
    unit: str
    user_id: str | None = None
    model: str | None = None
    cost_usd: float | None = None
    metadata: dict = field(default_factory=dict)
    correlation_id: str | None = None
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_db_row(self) -> tuple:
        """Convert to asyncpg parameter tuple for bulk insert."""
        return (
            self.org_id,
            self.user_id,
            self.event_type,
            self.resource,
            self.quantity,
            self.unit,
            self.model,
            self.cost_usd,
            json.dumps(self.metadata),
            self.correlation_id or get_correlation_id(),
            self.timestamp,
        )

    def to_dict(self) -> dict:
        return {
            "org_id": self.org_id,
            "user_id": self.user_id,
            "event_type": self.event_type,
            "resource": self.resource,
            "quantity": self.quantity,
            "unit": self.unit,
            "model": self.model,
            "cost_usd": self.cost_usd,
            "metadata": self.metadata,
            "correlation_id": self.correlation_id,
            "timestamp": self.timestamp,
        }


class BronzeEventSink:
    """In-memory buffer + async flusher for Bronze-layer events.

    Features:
    - Configurable batch size and flush interval
    - Automatic retry with exponential backoff on DB failure
    - Graceful flush on shutdown (drains buffer)
    - Optional S3 Parquet offload for cold storage
    """

    def __init__(
        self,
        batch_size: int = 100,
        flush_interval_seconds: float = 5.0,
        max_retries: int = 3,
    ):
        self.batch_size = batch_size
        self.flush_interval = flush_interval_seconds
        self.max_retries = max_retries
        self._buffer: list[RawEvent] = []
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task | None = None
        self._running = False
        self._s3_enabled = bool(getattr(settings, "bronze_s3_bucket", ""))
        self._total_ingested = 0
        self._total_flushed = 0
        self._flushing = False  # guard against concurrent flushes
        self._s3_client = None  # lazy-init boto3 client

    async def start(self) -> None:
        """Start the background flush loop."""
        if self._running:
            return
        self._running = True
        self._flush_task = asyncio.create_task(self._flush_loop())
        logger.info(
            f"BronzeEventSink started (batch={self.batch_size}, "
            f"interval={self.flush_interval}s, s3={self._s3_enabled})"
        )

    async def stop(self) -> None:
        """Stop the background loop and drain the buffer."""
        self._running = False
        if self._flush_task:
            self._flush_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._flush_task
        await self._flush_buffer()
        logger.info(
            f"BronzeEventSink stopped (ingested={self._total_ingested}, "
            f"flushed={self._total_flushed})"
        )

    async def ingest(self, event: RawEvent | dict) -> None:
        """Buffer an event for async flush.

        Accepts either a RawEvent dataclass or a dict with matching fields.
        """
        if isinstance(event, dict):
            event = RawEvent(**event)

        should_flush = False
        async with self._lock:
            self._buffer.append(event)
            self._total_ingested += 1
            should_flush = len(self._buffer) >= self.batch_size

        # Opportunistic flush if buffer is full (outside lock to avoid deadlock)
        if should_flush and not self._flushing:
            asyncio.create_task(self._flush_buffer())

    async def _flush_loop(self) -> None:
        """Background task that periodically flushes the buffer."""
        while self._running:
            try:
                await asyncio.sleep(self.flush_interval)
                await self._flush_buffer()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(f"BronzeEventSink flush loop error: {exc}")

    async def _flush_buffer(self) -> None:
        """Flush buffered events to PostgreSQL (and optionally S3)."""
        if self._flushing:
            return
        self._flushing = True
        try:
            async with self._lock:
                if not self._buffer:
                    return
                batch = self._buffer[: self.batch_size]
                self._buffer = self._buffer[self.batch_size :]

            if not batch:
                return

            # ── PostgreSQL bulk insert via executemany ──
            for attempt in range(1, self.max_retries + 1):
                try:
                    client = await get_postgres_client()
                    rows = [e.to_db_row() for e in batch]
                    query = """
                        INSERT INTO usage_events (
                            org_id, user_id, event_type, resource, quantity, unit,
                            model, cost_usd, metadata, correlation_id, created_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    """
                    # asyncpg executemany requires Connection, not Pool.
                    # We use the internal pool acquire pattern.
                    async with client.acquire() as conn:
                        await conn.executemany(query, rows)
                    self._total_flushed += len(batch)
                    break
                except Exception as exc:
                    logger.warning(f"BronzeEventSink DB flush attempt {attempt} failed: {exc}")
                    if attempt < self.max_retries:
                        await asyncio.sleep(2 ** attempt)
                    else:
                        logger.error(f"BronzeEventSink dropped {len(batch)} events after {self.max_retries} retries")

            # ── Optional S3 Parquet offload ──
            if self._s3_enabled:
                await self._flush_s3(batch)
        finally:
            self._flushing = False

    async def _flush_s3(self, batch: list[RawEvent]) -> None:
        """Offload a batch to S3 as newline-delimited JSON (NDJSON).

        In production this would write Parquet via pyarrow; NDJSON is a
        pragmatic starting point that requires no extra dependencies.
        """
        try:
            import boto3

            bucket = settings.bronze_s3_bucket
            prefix = getattr(settings, "bronze_s3_prefix", "bronze/events")
            ts = datetime.now(UTC)
            key = f"{prefix}/year={ts.year}/month={ts.month:02d}/day={ts.day:02d}/hour={ts.hour:02d}/{int(time.time() * 1000)}.ndjson"

            body = "\n".join(json.dumps(e.to_dict(), default=str) for e in batch)

            if self._s3_client is None:
                self._s3_client = boto3.client("s3")
            # boto3 is synchronous — offload to thread pool to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: self._s3_client.put_object(
                    Bucket=bucket, Key=key, Body=body, ContentType="application/x-ndjson"
                ),
            )
            logger.debug(f"BronzeEventSink flushed {len(batch)} events to s3://{bucket}/{key}")
        except Exception as exc:
            logger.warning(f"BronzeEventSink S3 flush failed: {exc}")

    @property
    def stats(self) -> dict:
        """Return ingestion statistics."""
        return {
            "total_ingested": self._total_ingested,
            "total_flushed": self._total_flushed,
            "buffered": len(self._buffer),
            "s3_enabled": self._s3_enabled,
        }


# Singleton instance
_bronze_sink: BronzeEventSink | None = None


async def get_bronze_sink() -> BronzeEventSink:
    """Get the singleton BronzeEventSink, starting it if necessary."""
    global _bronze_sink
    if _bronze_sink is None:
        _bronze_sink = BronzeEventSink(
            batch_size=getattr(settings, "bronze_batch_size", 100),
            flush_interval_seconds=getattr(settings, "bronze_flush_interval_seconds", 5.0),
        )
        await _bronze_sink.start()
    return _bronze_sink


async def close_bronze_sink() -> None:
    """Gracefully shut down the BronzeEventSink."""
    global _bronze_sink
    if _bronze_sink:
        await _bronze_sink.stop()
        _bronze_sink = None


@asynccontextmanager
async def bronze_sink_context():
    """Async context manager for the BronzeEventSink."""
    sink = await get_bronze_sink()
    try:
        yield sink
    finally:
        await close_bronze_sink()
